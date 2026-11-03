import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Extraccion } from '../../src/agent/extraccion.js';
import { createCore, type Core } from '../../src/db/client.js';
import { procesarMensajeEntrante, type SalidaDeMensaje } from '../../src/service/pipeline.js';
import type { FabricaDeAgente } from '../../src/service/ports.js';
import {
  AgendaFalsa,
  AgenteFalso,
  ClasificadorFalso,
  dependenciasDePrueba,
  RedactorFalso,
} from '../support/fakes.js';
import { APP_URL, conexionAdmin, prepararBaseDeDatos } from '../support/db.js';

/**
 * La primera sesión real por WhatsApp, con la agenda de Google conectada.
 *
 * Dos turnos salieron mal, y son el mismo agujero visto desde los dos lados: la
 * decisión de reproponer se tomaba mirando la etiqueta del clasificador y no el
 * estado del sistema.
 *
 * 1. **«Gracias!»** — el clasificador lo etiquetó `agendar`. El sistema caducó
 *    las dos opciones que le quedaban vivas, creó tres huecos nuevos de los que
 *    el paciente no supo nunca nada, y el redactor —al que se le enseñaban esos
 *    tres— nombró las 11:00, que eran las que el paciente acababa de coger. Como
 *    al elegirlas dejaron de estar `propuesta`, la validación las trató como
 *    inventadas: `franja_no_propuesta`, regeneración, segundo bloqueo y
 *    escalado. Lo que leyó fue «prefiero que esto te lo confirme una persona del
 *    equipo». Por dar las gracias.
 *
 * 2. **«¿Y por la tarde tienes alguna hora?»** — salió como `horario`, así que
 *    nadie miró la tarde, y el modelo contestó «por la tarde no me aparece nada
 *    libre, sólo esos tres de la mañana». La validación lo dejó pasar porque las
 *    únicas horas del mensaje eran las tres propuestas: lo falso no era ninguna
 *    hora, era el «no hay».
 */

const CLINICA = '11112222-1111-4111-8111-1111beef0000';
const TELEFONO = '+34600555444';
const AHORA = new Date('2026-09-14T10:00:00.000Z');

const admin = conexionAdmin();
let core: Core;
let agenda: AgendaFalsa;
let contador = 0;

function extraccion(extra: Partial<Extraccion> = {}): Extraccion {
  return {
    intencion: 'otro',
    servicio: null,
    opcion: null,
    preferencia: null,
    escalar: null,
    cita: null,
    sustitucion: null,
    tema: null,
    ...extra,
  };
}

function preferencia(extra: Partial<NonNullable<Extraccion['preferencia']>> = {}) {
  return {
    dias: [],
    diasExcluidos: [],
    franjas: [],
    desde: null,
    horaExacta: null,
    cuantoAntes: false,
    ...extra,
  };
}

function agenteGuionado(
  extracciones: readonly Extraccion[],
  textos: readonly string[] = [],
): FabricaDeAgente {
  return new AgenteFalso(new ClasificadorFalso(extracciones), new RedactorFalso(textos));
}

async function enviar(
  texto: string,
  agente: FabricaDeAgente,
): Promise<SalidaDeMensaje> {
  contador += 1;
  const deps = dependenciasDePrueba({ core, agenda, reloj: () => AHORA });
  const { cuerpo } = await procesarMensajeEntrante(
    { ...deps, agente },
    {
      idempotencyKey: `gracias-${contador}`,
      clientId: CLINICA,
      telefono: TELEFONO,
      nombre: 'Marta',
      texto,
    },
  );
  return cuerpo;
}

async function huecos(): Promise<Array<{ hora: string; state: string }>> {
  const filas = await admin`
    select slot_start, state from motor.holds
     where client_id = ${CLINICA} order by slot_start
  `;
  const dtf = new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return filas.map((f) => ({
    hora: dtf.format(new Date(String(f['slot_start']))),
    state: String(f['state']),
  }));
}

beforeAll(async () => {
  await prepararBaseDeDatos(admin);
  core = createCore(APP_URL);
}, 60_000);

afterAll(async () => {
  await core.close();
  await admin.end();
});

beforeEach(async () => {
  for (const tabla of [
    'audit_log',
    'idempotency_keys',
    'job_runs',
    'rights_requests',
    'appointments',
    'escalations',
    'messages',
    'holds',
    'conversations',
    'suppression',
    'patients',
  ]) {
    await admin.unsafe(`delete from motor.${tabla} where client_id = $1`, [CLINICA]);
  }
  await admin`delete from motor.clients where id = ${CLINICA}`;
  await admin`
    insert into motor.clients (id, slug, name, config, config_version)
    values (${CLINICA}, 'clinica-de-pruebas', 'Clínica Sesión Real', '{}'::jsonb, 'test')
  `;
  agenda = new AgendaFalsa();
  contador = 0;
});

/** Los dos primeros turnos de la sesión: se le proponen tres y coge uno. */
async function conHoraCogida(): Promise<{ elegida: string; sobrantes: string[] }> {
  await enviar(
    'quiero depilacion laser de axilas',
    agenteGuionado([extraccion({ intencion: 'agendar', servicio: 'laser-axilas' })]),
  );
  const eleccion = await enviar(
    'la primera',
    agenteGuionado([extraccion({ intencion: 'elegir_hueco', opcion: 1 })]),
  );
  expect(eleccion.holdId).toBeDefined();

  const estado = await huecos();
  const elegida = estado.find((h) => h.state === 'pendiente_recepcion')?.hora ?? '';
  expect(elegida).not.toBe('');

  return {
    elegida,
    sobrantes: estado.filter((h) => h.state === 'propuesta').map((h) => h.hora),
  };
}

describe('dar las gracias después de coger hora', () => {
  it('no destruye ni crea nada, aunque el clasificador diga «agendar»', async () => {
    const { elegida, sobrantes } = await conHoraCogida();
    expect(sobrantes.length).toBe(2);

    // Tal cual pasó: «Gracias!» clasificado como agendar, con el servicio ya
    // determinado en la conversación.
    await enviar(
      'Gracias!',
      agenteGuionado([extraccion({ intencion: 'agendar', servicio: 'laser-axilas' })]),
    );

    const despues = await huecos();
    // Su hora sigue donde estaba.
    expect(despues.filter((h) => h.state === 'pendiente_recepcion').map((h) => h.hora)).toEqual([
      elegida,
    ]);
    // Y las dos que dejó sin elegir siguen vivas, ni caducadas ni sustituidas:
    // son la alternativa si el hueco choca.
    expect(despues.filter((h) => h.state === 'propuesta').map((h) => h.hora)).toEqual(sobrantes);
    // Nada de tres huecos nuevos que el paciente no ha visto.
    expect(despues.filter((h) => h.state === 'caducada')).toEqual([]);
    expect(despues.length).toBe(3);
  });

  it('no acaba en un escalado', async () => {
    await conHoraCogida();

    const gracias = await enviar(
      'Gracias!',
      agenteGuionado([extraccion({ intencion: 'agendar', servicio: 'laser-axilas' })]),
    );

    expect(gracias.efectos.some((e) => e.tipo === 'escalar_a_humano')).toBe(false);
    expect(gracias.respuesta).not.toContain('alguien del equipo');
    expect(gracias.estadoConversacion).toBe('abierta');
  });

  /**
   * El redactor nombra la hora que el paciente tiene. Antes eso era imposible:
   * al elegirla dejaba de estar `propuesta` y la validación la trataba como
   * inventada.
   */
  it('puede despedirse nombrando la hora que el paciente tiene', async () => {
    const { elegida } = await conHoraCogida();

    const gracias = await enviar(
      'Gracias!',
      agenteGuionado(
        [extraccion({ intencion: 'agendar', servicio: 'laser-axilas' })],
        [`¡A ti! La tienes pedida para las ${elegida}.`],
      ),
    );

    expect(gracias.respuesta).toBe(`¡A ti! La tienes pedida para las ${elegida}.`);
    expect(gracias.efectos.some((e) => e.tipo === 'escalar_a_humano')).toBe(false);
  });

  /**
   * Pero **no puede darla por hecha**. De la segunda sesión real: «A ti, Marta,
   * nos vemos el miércoles» sobre un hueco en `pendiente_recepcion`. La hora era
   * la suya de verdad, así que no había nada inventado que cazar; lo falso era el
   * «nos vemos». Si recepción no confirma, al paciente se le dijo que se veían.
   */
  it('pero no puede dar por hecha una cita que recepción no ha confirmado', async () => {
    const { elegida } = await conHoraCogida();

    const gracias = await enviar(
      'Gracias!',
      agenteGuionado(
        [extraccion({ intencion: 'agendar', servicio: 'laser-axilas' })],
        [`¡A ti! Nos vemos a las ${elegida}.`, `¡A ti! Nos vemos a las ${elegida}.`],
      ),
    );

    // No sale, ni siquiera tras regenerar: al paciente le llega el texto fijo.
    expect(gracias.respuesta).not.toContain('Nos vemos');
    expect(gracias.efectos.some((e) => e.tipo === 'escalar_a_humano')).toBe(true);
  });
});

describe('preguntar por una franja que no se le ha propuesto', () => {
  /**
   * «¿Y por la tarde tienes alguna hora?» no es una consulta de horario: es un
   * cambio de preferencia, y se resuelve consultando, igual que el reagendado.
   */
  it('vuelve a consultar y repropone en vez de contestar de memoria', async () => {
    await enviar(
      'quiero depilacion laser de axilas por la mañana',
      agenteGuionado([
        extraccion({
          intencion: 'agendar',
          servicio: 'laser-axilas',
          preferencia: preferencia({ franjas: ['manana'] }),
        }),
      ]),
    );
    const antes = (await huecos()).filter((h) => h.state === 'propuesta').map((h) => h.hora);
    expect(antes.length).toBeGreaterThan(0);

    // Con la intención que salió de verdad: `horario`, no `agendar`.
    const tarde = await enviar(
      'Y por la tarde tienes alguna hora?',
      agenteGuionado([
        extraccion({ intencion: 'horario', preferencia: preferencia({ franjas: ['tarde'] }) }),
      ]),
    );

    const despues = (await huecos()).filter((h) => h.state === 'propuesta').map((h) => h.hora);
    // Se ha vuelto a mirar: las opciones vivas ya no son las de la mañana.
    expect(despues).not.toEqual(antes);
    expect(tarde.respuesta).not.toBeNull();
  });

  /**
   * Y si el modelo se inventa que no hay nada en un turno donde no se consultó,
   * no sale. Ésta es la frase textual de la sesión real.
   */
  it('una afirmación de disponibilidad sin consulta detrás no llega al paciente', async () => {
    await conHoraCogida();

    // Con `otro` y no `horario`: el horario de apertura ya se compone sin modelo,
    // así que con esa etiqueta no habría redactor que pudiera mentir, y lo que
    // este test mide es la barrera de la validación.
    const salida = await enviar(
      'y el sabado?',
      agenteGuionado(
        [extraccion({ intencion: 'otro' })],
        [
          'Por la tarde no me aparece nada libre.',
          'El sábado tampoco me queda ningún hueco.',
        ],
      ),
    );

    expect(salida.respuesta).not.toContain('no me aparece nada libre');
    expect(salida.respuesta).not.toContain('ningún hueco');
    expect(salida.efectos.some((e) => e.tipo === 'escalar_a_humano')).toBe(true);
  });
});
