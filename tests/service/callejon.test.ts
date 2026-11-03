import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Extraccion } from '../../src/agent/extraccion.js';
import {
  validarSalida,
  type ContextoDeValidacion,
} from '../../src/agent/output-validation.js';
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
 * El callejón sin salida, reproducido entero.
 *
 * La clínica ofrece un servicio, el paciente acepta con un «sí por favor», pide
 * cita, pide día, pide franja — y no recibe ni un hueco. El flujo principal del
 * producto no funcionaba: un paciente no podía llegar a tener una cita.
 *
 * La causa era que la extracción sólo miraba el mensaje del paciente, y ese
 * mensaje no nombra ningún servicio: lo había nombrado la clínica en el turno
 * anterior. **El servicio no es una propiedad del mensaje, es estado de la
 * conversación.**
 *
 * Verificado por sabotaje: si se quita el arrastre del servicio, este test
 * reproduce el callejón exactamente.
 */

const CLINICA = 'cccc7777-cccc-4ccc-8ccc-cccc77770000';
const TELEFONO = '+34600321321';
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

function agenteGuionado(extracciones: readonly Extraccion[]): FabricaDeAgente {
  return new AgenteFalso(new ClasificadorFalso(extracciones), new RedactorFalso());
}

async function enviar(texto: string, agente: FabricaDeAgente): Promise<SalidaDeMensaje> {
  contador += 1;
  const deps = dependenciasDePrueba({ core, agenda, reloj: () => AHORA });
  const { cuerpo } = await procesarMensajeEntrante(
    { ...deps, agente },
    {
      idempotencyKey: `callejon-${contador}`,
      clientId: CLINICA,
      telefono: TELEFONO,
      nombre: 'Beatriz',
      texto,
    },
  );
  return cuerpo;
}

async function huecosVivos(): Promise<number> {
  const filas = await admin`
    select count(*)::int as n from motor.holds
     where client_id = ${CLINICA} and state = 'propuesta'
  `;
  return Number(filas[0]?.['n'] ?? 0);
}

/**
 * Cuántos huecos se han propuesto DESPUÉS de este instante.
 *
 * Contar los vivos no basta: si un turno no propone nada, los del turno
 * anterior siguen ahí y el contador engaña. Lo que hay que comprobar es que el
 * paciente ha recibido huecos nuevos en el turno en que los ha pedido — que es
 * justo lo que no ocurría en el callejón.
 */
async function idsDeHuecos(): Promise<string[]> {
  const filas = await admin`select id from motor.holds where client_id = ${CLINICA}`;
  return filas.map((f) => String(f['id']));
}

async function huecosNuevosDesde(previos: readonly string[]): Promise<number> {
  const ahora = await idsDeHuecos();
  return ahora.filter((id) => !previos.includes(id)).length;
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
    values (${CLINICA}, 'clinica-de-pruebas', 'Clínica Callejón', '{}'::jsonb, 'test')
  `;
  agenda = new AgendaFalsa();
});

describe('el paciente acepta el servicio que le ofreció la clínica', () => {
  it('recorrido completo: pregunta, ofrecen, acepta, y RECIBE huecos', async () => {
    // 1. «¿Tenéis higienes faciales?» — la clínica le habla del servicio.
    await enviar(
      'me gustaria saber si teneis higienes faciales',
      agenteGuionado([extraccion({ intencion: 'servicio', servicio: null })]),
    );
    expect(await huecosVivos()).toBe(0);

    // 2. «Sí por favor, quiero una cita». El mensaje NO nombra el servicio: lo
    //    nombró la clínica. La extracción, que ahora ve la ventana, lo resuelve.
    const acepta = await enviar(
      'si por favor, quiero una cita',
      agenteGuionado([extraccion({ intencion: 'agendar', servicio: 'laser-axilas' })]),
    );

    // Aquí es donde antes se rompía todo. Ahora hay huecos de verdad.
    expect(await huecosVivos()).toBe(3);
    expect(acepta.respuesta).not.toBeNull();

    // 3. El servicio queda guardado en la conversación.
    const conversacion = await admin`
      select service_code from motor.conversations where client_id = ${CLINICA}
    `;
    expect(conversacion[0]?.['service_code']).toBe('laser-axilas');
  });

  it('los turnos siguientes NO vuelven a perder el servicio', async () => {
    await enviar(
      'si por favor, quiero una cita',
      agenteGuionado([extraccion({ intencion: 'agendar', servicio: 'laser-axilas' })]),
    );

    // «Me gustaría para el lunes que viene»: el mensaje no nombra el servicio y
    // la extracción devuelve null. Antes, esto era el callejón.
    const previos = await idsDeHuecos();
    await enviar(
      'me gustaria para el lunes que viene',
      agenteGuionado([
        extraccion({
          intencion: 'agendar',
          servicio: null,
          preferencia: {
            dias: ['lunes'],
            diasExcluidos: [],
            franjas: [],
            desde: null,
            horaExacta: null,
            cuantoAntes: false,
          },
        }),
      ]),
    );

    // Tres huecos NUEVOS, para el día que ha pedido. Sin arrastre del servicio
    // esto es cero: el paciente pide y no recibe nada.
    expect(await huecosNuevosDesde(previos)).toBe(3);
    expect(await huecosVivos()).toBe(3);

    const filas = await admin`
      select slot_start from motor.holds
       where client_id = ${CLINICA} and state = 'propuesta' order by rank
    `;
    // La PRIMERA es la que pidió. Las otras dos ya no: priorizan estar antes en
    // el tiempo, porque ofrecer «lunes 18, lunes 25 y lunes 1» son tres veces la
    // misma opción y ninguna esta semana. El test decía lo contrario.
    const dia = (fila: (typeof filas)[number]) =>
      new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', weekday: 'long' }).format(
        new Date(String(fila['slot_start'])),
      );
    expect(dia(filas[0]!)).toBe('lunes');
  });

  it('«quiero por la mañana» tampoco pierde el servicio', async () => {
    await enviar(
      'si por favor, quiero una cita',
      agenteGuionado([extraccion({ intencion: 'agendar', servicio: 'laser-axilas' })]),
    );

    const previos = await idsDeHuecos();
    await enviar(
      'quiero por la mañana',
      agenteGuionado([
        extraccion({
          intencion: 'agendar',
          servicio: null,
          preferencia: {
            dias: [],
            diasExcluidos: [],
            franjas: ['manana'],
            desde: null,
            horaExacta: null,
            cuantoAntes: false,
          },
        }),
      ]),
    );

    expect(await huecosNuevosDesde(previos)).toBe(3);
    expect(await huecosVivos()).toBe(3);
  });

  it('y elegir sigue funcionando: no hay «no hay huecos propuestos»', async () => {
    await enviar(
      'si por favor, quiero una cita',
      agenteGuionado([extraccion({ intencion: 'agendar', servicio: 'laser-axilas' })]),
    );

    const eleccion = await enviar(
      'la primera',
      agenteGuionado([extraccion({ intencion: 'elegir_hueco', opcion: 1 })]),
    );

    expect(eleccion.holdId).toBeDefined();
  });

  it('el cambio de servicio de la fase 10 sigue funcionando', async () => {
    await enviar(
      'si por favor, quiero una cita',
      agenteGuionado([extraccion({ intencion: 'agendar', servicio: 'laser-axilas' })]),
    );

    await enviar(
      'mejor las piernas',
      agenteGuionado([extraccion({ intencion: 'agendar', servicio: 'laser-piernas' })]),
    );

    const filas = await admin`
      select state, service_code from motor.holds where client_id = ${CLINICA}
    `;
    const vivos = filas.filter((f) => f['state'] === 'propuesta');
    expect(vivos).toHaveLength(3);
    expect(vivos.every((f) => f['service_code'] === 'laser-piernas')).toBe(true);

    const conversacion = await admin`
      select service_code from motor.conversations where client_id = ${CLINICA}
    `;
    expect(conversacion[0]?.['service_code']).toBe('laser-piernas');
  });
});

describe('el agente no puede prometer lo que no puede cumplir', () => {
  const CONTEXTO = {
    precios: [39.9, 89, 399],
    // Lunes 21 de septiembre de 2026, 10:00 en Madrid.
    huecosPropuestos: [new Date('2026-09-21T08:00:00.000Z')],
    citasVigentes: [],
    // Estas frases se juzgan por lo que prometen, no por si se consultó.
    consultaRealizada: true,
    citaConfirmada: true,
    tratamientoDeLosHuecos: null,
    horasQueNombroElPaciente: [],
    reservasDesmentidas: [],
    zonaHoraria: 'Europe/Madrid',
    ahora: AHORA,
  } satisfies ContextoDeValidacion;

  /** Frases textuales de la conversación que destapó el fallo. */
  const PROMESAS = [
    'Ahora mismo miro disponibilidad y te digo qué huecos hay.',
    'Déjame consultar la disponibilidad y te confirmo qué huecos hay.',
    'En cuanto los consulte te los paso y eliges.',
    'Voy a mirar la agenda y te digo.',
    'Te paso los huecos en un momento.',
    'Te escribo luego con las opciones.',
    'Estoy consultando la agenda.',
    'Lo miro y te digo algo.',
  ];

  it.each(PROMESAS)('se bloquea: «%s»', (texto) => {
    const resultado = validarSalida(texto, CONTEXTO);

    expect(resultado.valido).toBe(false);
    if (!resultado.valido) {
      expect(resultado.motivos.map((m) => m.tipo)).toContain('promesa_de_accion_futura');
    }
  });

  /** Lo que SÍ ocurre de verdad y no puede bloquearse. */
  const LEGITIMAS = [
    'Te aviso en cuanto recepción lo confirme.',
    'Queda pendiente de que recepción lo confirme y te aviso en cuanto esté.',
    '¿Qué tratamiento te interesa?',
    'Tenemos hueco el lunes a las 10:00, ¿te viene bien?',
    'Le paso tu mensaje al equipo y te contestan.',
  ];

  it.each(LEGITIMAS)('no se bloquea: «%s»', (texto) => {
    const resultado = validarSalida(texto, CONTEXTO);

    if (!resultado.valido) {
      throw new Error(`bloqueado sin motivo: ${resultado.motivos.map((m) => m.tipo).join(', ')}`);
    }
    expect(resultado.valido).toBe(true);
  });
});
