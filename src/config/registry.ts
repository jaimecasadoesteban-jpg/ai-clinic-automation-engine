import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { isPair, isScalar, isSeq, parseDocument, visit, type ScalarTag } from 'yaml';

import { DomainError } from '../core/errors.js';
import { clienteConfigSchema, type ClienteConfig } from './cliente.js';

/**
 * Carga y cachea la configuración de cada clínica.
 *
 * ## Falla al arrancar, no a mitad de una conversación
 *
 * Si el YAML de una sola clínica es inválido, el proceso **no arranca**. Es
 * deliberado: un error de configuración que se descubre a mitad de una
 * conversación deja a un paciente esperando y a nadie mirando. Descubrirlo en el
 * despliegue es incómodo; descubrirlo en producción es un fallo del sistema.
 *
 * ## Qué pasa si un YAML cambia mientras hay conversaciones vivas
 *
 * **La versión vigente gana siempre, y la recarga es atómica por clínica.**
 *
 * Se consideró fijar la versión al inicio de cada conversación y mantenerla
 * hasta que termine. Se descartó: significaría seguir citando un precio que la
 * clínica ya ha cambiado, y ése es exactamente el error que la validación de
 * salida existe para evitar. Si la clínica sube el precio a las 11:00, a las
 * 11:05 no podemos seguir diciendo el de las 10:00.
 *
 * La consecuencia asumida es que un paciente puede ver un precio distinto al de
 * hace un rato. Es un problema de la clínica, no un fallo del sistema, y se
 * puede reconstruir: **cada turno registra en `messages.validation_result` la
 * versión de configuración con la que se respondió.**
 *
 * Atómico por clínica: o la nueva configuración es válida entera y sustituye a
 * la anterior, o se rechaza y sigue la de antes. Una recarga fallida nunca deja
 * a una clínica sin configuración.
 */

export class ConfiguracionDeClienteInvalida extends DomainError {
  readonly code = 'configuracion_de_cliente_invalida';
  readonly httpStatus = 500;

  constructor(
    readonly fichero: string,
    readonly problemas: readonly string[],
  ) {
    super(`Configuración inválida en ${fichero}:\n- ${problemas.join('\n- ')}`);
  }
}

export class ClienteSinConfiguracion extends DomainError {
  readonly code = 'cliente_sin_configuracion';
  readonly httpStatus = 500;

  constructor(readonly slug: string) {
    super(`No hay configuración cargada para la clínica «${slug}».`);
  }
}

/**
 * **Datos de ejemplo: se marcan en el valor, no en el esquema.**
 *
 * `ejemplo.yaml` es la plantilla de alta, y su dirección, aparcamiento, formas
 * de pago o preparación previa son inventados. Se dicen al paciente tal cual,
 * sin modelo ni validación, así que una clínica que copie la plantilla y se deje
 * uno le daría a un paciente una dirección falsa con el nombre de la clínica.
 *
 * La marca es una etiqueta de YAML sobre el valor —`direccion: !ejemplo …`—:
 * el valor sigue siendo una cadena y el esquema no se entera, de modo que no hay
 * un campo de configuración que sólo existe para avisar. La marca viaja con el
 * dato: al copiar la plantilla se copia, y al sustituir el texto por el real se
 * borra con él.
 *
 * Avisa en el arranque y no impide arrancar: con datos de ejemplo se puede
 * probar la composición, y eso es legítimo. Lo que no puede es pasar sin verse.
 */
const ETIQUETA_DE_EJEMPLO = '!ejemplo';

const etiquetaDeEjemplo: ScalarTag = {
  tag: ETIQUETA_DE_EJEMPLO,
  resolve: (valor: string) => valor,
};

/** Las rutas de los valores marcados, legibles: `servicios[0].preparacion`. */
function datosDeEjemploEn(documento: ReturnType<typeof parseDocument>): string[] {
  const rutas: string[] = [];
  visit(documento, {
    Scalar(_clave, nodo, camino) {
      if (nodo.tag !== ETIQUETA_DE_EJEMPLO) return;
      const partes: string[] = [];
      const cadena = [...camino, nodo];
      for (let i = 0; i < cadena.length; i++) {
        const actual = cadena[i];
        const siguiente = cadena[i + 1];
        if (isPair(actual) && isScalar(actual.key)) partes.push(String(actual.key.value));
        if (isSeq(actual) && siguiente !== undefined) {
          partes.push(`[${actual.items.findIndex((item) => item === siguiente)}]`);
        }
      }
      rutas.push(partes.join('.').replace(/\.\[/g, '['));
    },
  });
  return rutas;
}

export interface ConfigVersionada {
  readonly config: ClienteConfig;
  /**
   * Valores marcados `!ejemplo`: inventados, y que no pueden llegar a un
   * paciente de verdad. Vacío en una clínica dada de alta como toca.
   */
  readonly datosDeEjemplo: readonly string[];
  /** Hash del contenido del YAML. Es lo que va a `clients.config_version`. */
  readonly version: string;
  readonly cargadaEn: Date;
}

function versionDe(contenido: string): string {
  return createHash('sha256').update(contenido).digest('hex').slice(0, 12);
}

function parsearUno(fichero: string, contenido: string): ConfigVersionada {
  const documento = parseDocument(contenido, { customTags: [etiquetaDeEjemplo] });
  // Una etiqueta desconocida es un aviso para la librería y un fallo aquí:
  // `!ejmplo` dejaría el dato inventado sin marcar y sin que nada lo dijera,
  // que es la errata silenciosa que el esquema estricto existe para impedir.
  const problemas = [...documento.errors, ...documento.warnings];
  if (problemas.length > 0) {
    throw new ConfiguracionDeClienteInvalida(
      fichero,
      problemas.map((p) => `YAML mal formado: ${p.message}`),
    );
  }
  const crudo: unknown = documento.toJS();

  const resultado = clienteConfigSchema.safeParse(crudo);
  if (!resultado.success) {
    throw new ConfiguracionDeClienteInvalida(
      fichero,
      resultado.error.issues.map((i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`),
    );
  }

  return {
    config: resultado.data,
    datosDeEjemplo: datosDeEjemploEn(documento),
    version: versionDe(contenido),
    cargadaEn: new Date(),
  };
}

export class RegistroDeConfiguracion {
  private readonly porSlug = new Map<string, ConfigVersionada>();

  constructor(private readonly directorio: string) {}

  /**
   * Carga todos los YAML. Si alguno falla, **no se aplica ninguno**: no se queda
   * el sistema medio cargado.
   */
  cargarTodo(): void {
    const ficheros = readdirSync(this.directorio).filter(
      (f) => f.endsWith('.yaml') || f.endsWith('.yml'),
    );

    const cargados = new Map<string, ConfigVersionada>();
    for (const fichero of ficheros) {
      const ruta = join(this.directorio, fichero);
      const versionada = parsearUno(fichero, readFileSync(ruta, 'utf8'));

      const previo = cargados.get(versionada.config.slug);
      if (previo !== undefined) {
        throw new ConfiguracionDeClienteInvalida(fichero, [
          `el slug «${versionada.config.slug}» está repetido en dos ficheros`,
        ]);
      }
      cargados.set(versionada.config.slug, versionada);
    }

    this.porSlug.clear();
    for (const [slug, versionada] of cargados) this.porSlug.set(slug, versionada);
  }

  /** Recarga una sola clínica. Atómica: si el YAML nuevo es inválido, sigue el anterior. */
  recargar(slug: string): ConfigVersionada {
    const ruta = join(this.directorio, `${slug}.yaml`);
    const versionada = parsearUno(`${slug}.yaml`, readFileSync(ruta, 'utf8'));
    if (versionada.config.slug !== slug) {
      throw new ConfiguracionDeClienteInvalida(`${slug}.yaml`, [
        `el slug del fichero («${versionada.config.slug}») no coincide con su nombre`,
      ]);
    }
    this.porSlug.set(slug, versionada);
    return versionada;
  }

  obtener(slug: string): ConfigVersionada {
    const versionada = this.porSlug.get(slug);
    if (versionada === undefined) throw new ClienteSinConfiguracion(slug);
    return versionada;
  }

  /** Las clínicas cargadas que tienen datos marcados `!ejemplo`, con cuáles. */
  conDatosDeEjemplo(): { slug: string; campos: readonly string[] }[] {
    return [...this.porSlug]
      .filter(([, v]) => v.datosDeEjemplo.length > 0)
      .map(([slug, v]) => ({ slug, campos: v.datosDeEjemplo }))
      .sort((a, b) => a.slug.localeCompare(b.slug));
  }

  slugs(): string[] {
    return [...this.porSlug.keys()].sort();
  }

  /**
   * El slug de la clínica cuya línea de WhatsApp es ésta.
   *
   * `undefined` si no hay ninguna, **y nunca una por defecto**: devolver «la
   * primera» ante un remitente desconocido mandaría la conversación de un
   * paciente a la clínica equivocada, que es la regla 1 rota por la puerta de
   * entrada.
   */
  porRemitente(remitenteId: string): string | undefined {
    for (const [slug, versionada] of this.porSlug) {
      if (versionada.config.canal.remitenteId === remitenteId) return slug;
    }
    return undefined;
  }

  /**
   * Las clínicas en modo `automatica`. Sin escritor de agenda, el núcleo no
   * puede arrancar con ninguna: el paciente elegiría y la confirmación no
   * llegaría nunca, porque sale cuando el evento existe.
   */
  enModoAutomatico(): string[] {
    return [...this.porSlug].filter(([, v]) => v.config.agenda.confirmacion === 'automatica').map(([slug]) => slug);
  }

  /** Lo mismo para Chatwoot: la clínica de un inbox. Nunca una por defecto. */
  porInboxDeChatwoot(cuentaId: number, inboxId: number): string | undefined {
    for (const [slug, versionada] of this.porSlug) {
      const chatwoot = versionada.config.canal.chatwoot;
      if (chatwoot?.cuentaId === cuentaId && chatwoot.inboxId === inboxId) return slug;
    }
    return undefined;
  }
}

/** Arranque: carga todo y revienta si algo no cuadra. */
export function cargarConfiguracion(directorio = 'config/clientes'): RegistroDeConfiguracion {
  const registro = new RegistroDeConfiguracion(directorio);
  registro.cargarTodo();
  return registro;
}
