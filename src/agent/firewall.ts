import { CATALOGO, PRIORIDAD, type Categoria, type Patron } from './firewall-patterns.js';

/**
 * Cortafuegos determinista. Etapa 2 del pipeline, **antes de cualquier llamada
 * al modelo**. Corta la conversación, devuelve una respuesta fija aprobada por
 * la clínica y escala. No reformula nada: el contenido clínico no lo decide el
 * modelo (regla 5).
 *
 * Es la pieza cuyo fallo puede hacer daño a una persona. De ahí las tres
 * decisiones de diseño que la gobiernan:
 *
 * ## 1. Se calibra hacia el falso positivo
 *
 * Un falso positivo cuesta una molestia: alguien de la clínica lee un mensaje
 * que no hacía falta escalar. Un falso negativo cuesta que un mensaje de
 * urgencia acabe en el modelo, que conteste un horario de apertura a quien está
 * sangrando. **No son comparables, y los patrones están escritos anchos a
 * propósito.** Si dudas al ajustar un patrón, deja que corte de más.
 *
 * Consecuencia asumida: «no me duele nada, solo preguntaba» corta. No se
 * intenta interpretar negaciones — hacerlo es exactamente el tipo de matiz que
 * convierte un cortafuegos determinista en un clasificador con falsos negativos.
 *
 * ### Por qué la señal de escalado de `extraccion.ts` se calibra al REVÉS
 *
 * Leído en frío parece una incoherencia: aquí ante la duda se corta, y allí ante
 * la duda no se escala. **Las dos protegen lo mismo: que recepción siga mirando
 * los avisos.**
 *
 * La diferencia está en qué cuesta cada falso positivo. Aquí cuesta un mensaje
 * derivado a la clínica que no hacía falta, y el suelo es que un mensaje de
 * urgencia acabe en el modelo. Allí cuesta un aviso más en la bandeja de
 * recepción por algo que no lo requería, y el suelo es que dejen de mirarla.
 * Cortar de más aquí protege a un paciente; escalar de más allí gasta la
 * atención que hará falta el día que llegue el caso de verdad.
 *
 * ## 2. Se evalúa una ventana reciente, no el mensaje suelto
 *
 * En WhatsApp la gente parte lo que escribe: «me duele» en un mensaje y «la
 * zona del laser» en el siguiente. Evaluando sólo el mensaje que acaba de
 * llegar, ese caso es un falso negativo garantizado, y es el caso normal, no el
 * raro.
 *
 * Así que se evalúa el mensaje **y** la concatenación de los entrantes
 * recientes de la misma conversación. El coste es más falsos positivos, porque
 * la ventana puede unir cosas que no iban juntas — y ése es justo el coste que
 * la decisión 1 dice que estamos dispuestos a pagar.
 *
 * ## 3. Los patrones viven en código; la configuración sólo puede añadir
 *
 * Las dos opciones puras son malas. En código, cada ajuste es un despliegue. En
 * configuración, un error de edición desactiva el cortafuegos en silencio — y
 * un YAML mal editado que deja de detectar «sangrando» no da ningún síntoma
 * hasta que alguien sale herido.
 *
 * La asimetría de la decisión 1 resuelve el empate: el catálogo vive en código,
 * versionado, revisable y cubierto por los tests adversariales; la
 * configuración por clínica puede **añadir** patrones, nunca quitar ni
 * sustituir. Así, el peor error posible en un YAML es que se corte de más.
 * Ningún error de edición puede provocar un falso negativo.
 *
 * Lo que sí vive en el YAML es el **texto** de la respuesta fija, porque tiene
 * que estar aprobado por la clínica. Aquí se devuelve una clave de plantilla y
 * hay un texto por defecto para que la falta de una traducción no produzca
 * silencio (regla 4).
 */

export type { Categoria } from './firewall-patterns.js';

export type PlantillaDeCorte =
  | 'urgencia_derivar'
  | 'clinico_derivar'
  | 'baja_confirmada'
  | 'menor_no_atendemos'
  | 'derechos_acuse';

export type MotivoEscalado =
  | 'urgencia_clinica'
  | 'contenido_clinico'
  | 'peticion_paciente'
  | 'menor_de_edad'
  | 'derechos_rgpd';

export type EfectoDeCorte =
  | { readonly tipo: 'mensaje_al_paciente'; readonly plantilla: PlantillaDeCorte }
  | { readonly tipo: 'escalar_a_humano'; readonly motivo: MotivoEscalado; readonly severidad: number }
  | { readonly tipo: 'registrar_baja' };

export interface Corte {
  readonly corta: true;
  /** La categoría de mayor prioridad de las que dispararon. */
  readonly categoria: Categoria;
  /** Todas las que dispararon, por si más de una necesita acción. */
  readonly categorias: readonly Categoria[];
  /** Identificadores de los patrones que dispararon. Va a `messages.firewall_rule`. */
  readonly patrones: readonly string[];
  /** `true` si disparó por la ventana y no por el mensaje suelto. */
  readonly porVentana: boolean;
  readonly plantilla: PlantillaDeCorte;
  /** Marca `messages.is_clinical`: acorta la retención a 90 días. */
  readonly esClinico: boolean;
  readonly efectos: readonly EfectoDeCorte[];
}

export type ResultadoDelCortafuegos = Corte | { readonly corta: false };

interface Respuesta {
  readonly plantilla: PlantillaDeCorte;
  readonly motivoEscalado: MotivoEscalado;
  readonly severidad: number;
  readonly esClinico: boolean;
}

const RESPUESTA_POR_CATEGORIA: Readonly<Record<Categoria, Respuesta>> = {
  urgencia_clinica: {
    plantilla: 'urgencia_derivar',
    motivoEscalado: 'urgencia_clinica',
    severidad: 3,
    esClinico: true,
  },
  contenido_clinico: {
    plantilla: 'clinico_derivar',
    motivoEscalado: 'contenido_clinico',
    severidad: 2,
    esClinico: true,
  },
  minoria_de_edad: {
    plantilla: 'menor_no_atendemos',
    motivoEscalado: 'menor_de_edad',
    severidad: 2,
    // No es dato de salud, pero marcarlo como clínico acorta su retención a 90
    // días, y con un menor de por medio el lado seguro es guardar menos.
    esClinico: true,
  },
  baja: {
    plantilla: 'baja_confirmada',
    motivoEscalado: 'peticion_paciente',
    severidad: 1,
    esClinico: false,
  },
  /**
   * Severidad 2 y motivo propio: **no va a recepción**, va a quien la clínica
   * haya designado para protección de datos. Y el reloj de las 48 h del contrato
   * de encargo empieza a correr en el momento en que esto se registra.
   */
  derechos_rgpd: {
    plantilla: 'derechos_acuse',
    motivoEscalado: 'derechos_rgpd',
    severidad: 2,
    // No es dato de salud, pero la solicitud suele venir con contexto clínico y
    // el lado seguro es guardar menos: 90 días.
    esClinico: true,
  },
};

/**
 * Textos por defecto. El texto real sale del YAML de la clínica, aprobado por
 * ella; esto existe para que una plantilla ausente no acabe en un silencio.
 */
export const RESPUESTAS_POR_DEFECTO: Readonly<Record<PlantillaDeCorte, string>> = {
  urgencia_derivar:
    'Por lo que nos cuentas necesitas atención médica ahora, y por aquí no podemos dártela. ' +
    'Llama a la clínica o, si es grave, al 112. Avisamos ya a una persona del equipo.',
  derechos_acuse:
    'Hemos registrado tu solicitud sobre tus datos y se la trasladamos al equipo de la clínica, ' +
    'que es quien la resuelve. Se pondrán en contacto contigo para darte respuesta.',
  clinico_derivar:
    'Esto tiene que valorarlo el personal sanitario de la clínica, no podemos responderlo por aquí. ' +
    'Le pasamos tu mensaje a una persona del equipo y te contestan.',
  baja_confirmada:
    'Hecho: no volverás a recibir mensajes nuestros. Si algún día quieres retomarlo, escríbenos.',
  menor_no_atendemos:
    'Para tratamientos en menores de edad necesitamos hablar con su madre, padre o tutor legal. ' +
    'Le pasamos el mensaje a una persona de la clínica.',
};

/** Ventana por defecto. Sale del YAML de la clínica si quiere otra. */
export const VENTANA_POR_DEFECTO = { mensajes: 5, segundos: 180 } as const;

export interface MensajeReciente {
  readonly texto: string;
  readonly recibidoEn: Date;
}

export interface EntradaDelCortafuegos {
  readonly texto: string;
  /** Entrantes anteriores de la misma conversación, del más antiguo al más nuevo. */
  readonly recientes?: readonly MensajeReciente[];
  readonly ahora?: Date;
  readonly ventana?: { readonly mensajes: number; readonly segundos: number };
  /**
   * Patrones extra de la clínica. Sólo pueden AÑADIR: no hay forma de que esto
   * desactive un patrón del catálogo.
   */
  readonly patronesAdicionales?: readonly Patron[];
}

/**
 * Minúsculas, sin tildes, sin puntuación, repeticiones colapsadas.
 *
 * La `ñ` se convierte en `n` como efecto de quitar tildes, y viene bien: así
 * «años» y «anos» son el mismo texto, que es como la gente escribe de verdad.
 */
export function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/(.)\1{2,}/g, '$1$1')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function coincidencias(texto: string, patrones: readonly Patron[]): Patron[] {
  return patrones.filter((patron) => patron.regex.test(texto));
}

function porPrioridad(categorias: readonly Categoria[]): Categoria[] {
  return PRIORIDAD.filter((c) => categorias.includes(c));
}

/** Los entrantes recientes que siguen dentro de la ventana. */
export function ventanaReciente(
  recientes: readonly MensajeReciente[],
  ahora: Date,
  ventana: { mensajes: number; segundos: number },
): MensajeReciente[] {
  const desde = ahora.getTime() - ventana.segundos * 1000;
  return recientes.filter((m) => m.recibidoEn.getTime() >= desde).slice(-ventana.mensajes);
}

export function evaluar(entrada: EntradaDelCortafuegos): ResultadoDelCortafuegos {
  const patrones = [...CATALOGO, ...(entrada.patronesAdicionales ?? [])];
  const ahora = entrada.ahora ?? new Date();
  const ventana = entrada.ventana ?? VENTANA_POR_DEFECTO;

  const solo = normalizar(entrada.texto);
  let encontrados = coincidencias(solo, patrones);
  let porVentana = false;

  if (encontrados.length === 0 && entrada.recientes !== undefined) {
    // El mensaje suelto no dice nada, pero puede que venga partido del anterior.
    const previos = ventanaReciente(entrada.recientes, ahora, ventana);
    if (previos.length > 0) {
      const conjunto = normalizar([...previos.map((m) => m.texto), entrada.texto].join(' '));
      encontrados = coincidencias(conjunto, patrones);
      porVentana = encontrados.length > 0;
    }
  }

  if (encontrados.length === 0) return { corta: false };

  const categorias = porPrioridad([...new Set(encontrados.map((p) => p.categoria))]);
  const categoria = categorias[0];
  if (categoria === undefined) return { corta: false };

  const respuesta = RESPUESTA_POR_CATEGORIA[categoria];
  const efectos: EfectoDeCorte[] = [
    { tipo: 'mensaje_al_paciente', plantilla: respuesta.plantilla },
    {
      tipo: 'escalar_a_humano',
      motivo: respuesta.motivoEscalado,
      severidad: respuesta.severidad,
    },
  ];
  // Una baja se honra aunque no sea la categoría principal: si alguien pide la
  // baja y además describe una urgencia, se atiende la urgencia y se registra
  // la baja igualmente.
  if (categorias.includes('baja')) {
    efectos.push({ tipo: 'registrar_baja' });
  }

  return {
    corta: true,
    categoria,
    categorias,
    patrones: encontrados.map((p) => p.id),
    porVentana,
    plantilla: respuesta.plantilla,
    esClinico: categorias.some((c) => RESPUESTA_POR_CATEGORIA[c].esClinico),
    efectos,
  };
}
