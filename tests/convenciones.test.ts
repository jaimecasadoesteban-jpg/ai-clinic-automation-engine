import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Convenciones que se comprueban en vez de recordarse.
 *
 * **`as` sobre un objeto literal desactiva justo la comprobación que hace falta.**
 * Al añadir `horaExacta` como campo obligatorio de `Preferencia`, tres tests
 * siguieron compilando y reventaron en ejecución con «cannot read properties of
 * undefined»: el `as` decía que aquello ya era una `Preferencia` y TypeScript se
 * calló. Con `satisfies` habrían fallado al compilar, que es cuando sirve.
 *
 * Es la tercera vez que aparece el mismo patrón de fondo —algo que parece
 * cubierto y no lo está— así que la convención se vigila. `as const` es otra
 * cosa y sí vale.
 */

const RAIZ = new URL('..', import.meta.url).pathname;

function ficherosDe(directorio: string, extension: string): string[] {
  const salida: string[] = [];
  for (const entrada of readdirSync(directorio)) {
    const ruta = join(directorio, entrada);
    if (statSync(ruta).isDirectory()) {
      salida.push(...ficherosDe(ruta, extension));
    } else if (ruta.endsWith(extension)) {
      salida.push(ruta);
    }
  }
  return salida;
}

/**
 * Un `as` pegado al cierre de un objeto literal.
 *
 * Deja fuera tres cosas que no son el problema:
 * - `as const`, que es lo contrario: estrecha en vez de mentir.
 * - `as unknown as X`, el doble casting explícito. Es el que se usa para
 *   fabricar el doble de un SDK externo, y nadie lo confunde con una
 *   comprobación: se ve a la legua que se está saltando el sistema de tipos.
 * - `algo['x'] as T`, que no castea un literal sino el resultado `unknown` de
 *   un índice; ahí no hay ninguna forma que TypeScript pudiera haber revisado.
 */
const CIERRE_CON_AS = /\}\s*as\s+(?!const\b)(?!unknown\s+as\b)/;

/** Comentarios: hablar del patrón no es cometerlo. */
const ES_COMENTARIO = /^\s*(?:\/\/|\/?\*)/;

describe('nada de `as` sobre literales en los tests', () => {
  const ficheros = [
    ...ficherosDe(join(RAIZ, 'tests'), '.ts'),
    ...ficherosDe(join(RAIZ, 'scripts'), '.ts'),
  ];

  it('hay ficheros que revisar (si no, este test no vigila nada)', () => {
    expect(ficheros.length).toBeGreaterThan(10);
  });

  it.each(ficheros.map((f) => [f.slice(RAIZ.length), f] as const))(
    '%s usa satisfies, no as',
    (_nombre, ruta) => {
      const infractoras: string[] = [];

      readFileSync(ruta, 'utf-8')
        .split('\n')
        .forEach((linea, indice) => {
          if (ES_COMENTARIO.test(linea)) return;
          if (CIERRE_CON_AS.test(linea)) {
            infractoras.push(`${indice + 1}: ${linea.trim()}`);
          }
        });

      if (infractoras.length > 0) {
        throw new Error(
          `Usa \`satisfies\` en vez de \`as\`; \`as\` apaga la comprobación de tipos:\n` +
            infractoras.map((l) => `  ${l}`).join('\n'),
        );
      }
    },
  );
});

/**
 * **El puerto de la agenda no tiene ni tendrá un método de escritura.**
 *
 * Con el modo `automatica`, el núcleo sí provoca escrituras en la agenda de la
 * clínica — pero las provoca emitiendo un efecto que ejecuta n8n, no llamando a
 * nadie. La diferencia no es cosmética:
 *
 * - `/mensaje-entrante` corre entero dentro de una transacción de Postgres. Una
 *   escritura a Google desde ahí dentro se quedaría hecha si la transacción
 *   revierte, y un evento en el calendario de un cliente no se deshace con un
 *   `rollback`. Quedaría una cita que existe para la clínica y no para nosotros.
 * - Y mantendría abierta una transacción con cerrojos mientras se espera a un
 *   tercero por HTTP, que es justo lo que el resto del código se cuida de evitar.
 *
 * Que el puerto no tenga el método es lo que hace que esto se sostenga solo. Este
 * test existe para que dentro de seis meses nadie lo añada «sólo para esto».
 */
describe('el núcleo no puede escribir en la agenda', () => {
  const PUERTOS = readFileSync(join(RAIZ, 'src/service/ports.ts'), 'utf8');
  const INTERFAZ = PUERTOS.slice(
    PUERTOS.indexOf('export interface Agenda {'),
    PUERTOS.indexOf('/** Textos de cara al paciente'),
  );

  it('la interfaz Agenda existe y se ha encontrado', () => {
    expect(INTERFAZ).toContain('ocupacion(');
    expect(INTERFAZ).toContain('sigueLibre(');
  });

  it.each([
    'crear',
    'crearEvento',
    'escribir',
    'insertar',
    'guardar',
    'borrar',
    'eliminar',
    'actualizar',
    'mover',
  ])('no expone un método «%s»', (metodo) => {
    expect(INTERFAZ).not.toMatch(new RegExp(`\\b${metodo}\\s*\\(`, 'i'));
  });
});

/**
 * **Un cron materializa el estado; no lo define.**
 *
 * Sin crons, el agente ofreció como disponibles huecos propuestos en agosto y
 * recordó tres veces una cita del 28 de agosto como si fuera futura: las filas
 * decían `propuesta` y `pendiente_recepcion` y las consultas se lo creían.
 *
 * Toda consulta que lea huecos en un estado «vivo» tiene que recibir una
 * `Vigencia` —el instante y las reglas con que se juzga— y filtrar con
 * `sigueVivo`. Las excepciones están aquí, con su motivo, y una nueva tiene que
 * venir a explicarse.
 */
describe('ninguna lectura da por vivo lo que sólo el cron puede matar', () => {
  const QUERIES = readFileSync(join(RAIZ, 'src/db/queries.ts'), 'utf8');

  /** Cada función exportada de `queries.ts`, con su cuerpo. */
  const funciones = QUERIES.split(/\nexport async function /)
    .slice(1)
    .map((trozo) => ({ nombre: trozo.slice(0, trozo.indexOf('(')), cuerpo: trozo }));

  const EXCEPCIONES: Readonly<Record<string, string>> = {
    // Tiene que decir lo mismo que `holds_slot_unico` y `holds_hueco_ocupado`,
    // que miran el estado y no pueden mirar el tiempo: si descontara un hueco
    // vencido que la base sigue bloqueando, proponerlo chocaría con el trigger
    // y el paciente leería «no hay disponibilidad». Su error es de más
    // ocupación, nunca de menos: le quita un hueco a la clínica hasta que pase
    // el cron, no le dice nada falso a nadie.
    ocupacionPropia: 'coherente con las restricciones de la base',
    // La pregunta el cron que está materializando esos mismos vencimientos: una
    // propuesta vencida que todavía no ha procesado tiene que contar como viva,
    // para que el aviso de «tu propuesta ha caducado» lo dé la última en caer y
    // no la primera. Con Vigencia, las tres se verían muertas y avisarían las tres.
    quedaAlgoVivoEnLaConversacion: 'la usa el cron que materializa, y necesita ver lo no materializado',
  };

  const leenVivos = funciones.filter(
    (f) =>
      /\.select\(/.test(f.cuerpo) &&
      /\.from\(holds\)/.test(f.cuerpo) &&
      /'propuesta'|'pendiente_recepcion'|'retenida'/.test(f.cuerpo),
  );

  it('encuentra las consultas que leen huecos vivos (si no, no vigila nada)', () => {
    expect(leenVivos.map((f) => f.nombre)).toEqual(
      expect.arrayContaining(['huecosPropuestos', 'citasVivas', 'sustitutoDe']),
    );
  });

  it('todas reciben una Vigencia y filtran con ella, salvo las excepciones', () => {
    const sinVigencia = leenVivos
      .filter((f) => !(f.nombre in EXCEPCIONES))
      .filter((f) => !/Vigencia/.test(f.cuerpo) || !/vivos\(/.test(f.cuerpo))
      .map((f) => f.nombre);
    expect(sinVigencia).toEqual([]);
  });

  it('el SQL a mano sobre huecos vivos sólo vive en el cron y en la verificación', () => {
    // El cron ES quien materializa; la verificación sólo mira confirmadas
    // futuras, que no vencen por tiempo.
    const PERMITIDOS = ['vencimientos.ts', 'verificacion.ts'];
    const infractores = ficherosDe(join(RAIZ, 'src/service'), '.ts')
      .filter((ruta) => !PERMITIDOS.some((p) => ruta.endsWith(p)))
      .filter((ruta) => {
        const texto = readFileSync(ruta, 'utf8');
        return /from motor\.holds[\s\S]{0,200}state\s*(=|in)\s*\(?'(propuesta|retenida|pendiente_recepcion)/.test(
          texto,
        );
      });
    expect(infractores).toEqual([]);
  });
});

/**
 * **Un escalado que se crea y no se emite no le llega a nadie.**
 *
 * `/verificar-citas` creaba la fila en `escalations` y devolvía sólo
 * `colisiones: 1`. Sin el efecto, n8n no tiene a quién avisar: una cita
 * confirmada que no estaba en la agenda de la clínica se habría descubierto el
 * día de la cita. La fila daba la impresión de que alguien lo sabía.
 *
 * Así que toda función de `src/service` que llama a `crearEscalado` tiene que
 * emitir `escalar_a_humano` en su propio cuerpo.
 */
describe('todo escalado que se crea se emite', () => {
  const DIR = join(RAIZ, 'src/service');
  const funciones = readdirSync(DIR)
    .filter((f) => f.endsWith('.ts'))
    .flatMap((fichero) =>
      readFileSync(join(DIR, fichero), 'utf8')
        .split(/\n(?:export )?(?:async )?function /)
        .slice(1)
        .map((cuerpo) => ({ nombre: `${fichero}:${cuerpo.slice(0, cuerpo.indexOf('('))}`, cuerpo })),
    );
  const crean = funciones.filter((f) => /\bq\.crearEscalado\(/.test(f.cuerpo));

  it('encuentra los sitios que crean escalados (si no, no vigila nada)', () => {
    expect(crean.length).toBeGreaterThanOrEqual(8);
  });

  it('y cada uno emite el efecto', () => {
    expect(crean.filter((f) => !f.cuerpo.includes("'escalar_a_humano'")).map((f) => f.nombre)).toEqual([]);
  });
});

/**
 * La guarda de aislamiento sólo protege si el arranque la llama, y antes de
 * levantar el servidor. Quitarla no rompería ningún otro test: el núcleo
 * arrancaría igual, también con el rol propietario.
 */
describe('el arranque comprueba el aislamiento antes de atender a nadie', () => {
  it('index.ts llama a comprobarAislamiento antes de buildServer, y no arranca si falla', () => {
    const indice = readFileSync(join(RAIZ, 'src/index.ts'), 'utf8');
    const guarda = indice.indexOf('core.comprobarAislamiento()');
    expect(guarda).toBeGreaterThan(-1);
    expect(guarda).toBeLessThan(indice.indexOf('buildServer('));
    expect(indice).toMatch(
      /if \(fallosDeAislamiento\.length > 0\) \{[^}]{0,80}throw new AislamientoRotoError\(fallosDeAislamiento\)/,
    );
  });
});
