import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Extraccion } from '../../src/agent/extraccion.js';
import { createCore, type Core } from '../../src/db/client.js';
import { procesarMensajeEntrante, type SalidaDeMensaje } from '../../src/service/pipeline.js';
import { accionRecepcion } from '../../src/service/reception.js';
import type { FabricaDeAgente } from '../../src/service/ports.js';
import {
  AgendaFalsa,
  AgenteFalso,
  ClasificadorFalso,
  dependenciasDePrueba,
  RedactorFalso,
} from '../support/fakes.js';
import { APP_URL, conexionAdmin, prepararBaseDeDatos } from '../support/db.js';
import { evaluarEstilo } from '../../src/agent/estilo.js';
import { clienteConfigSchema } from '../../src/config/cliente.js';

/** Sólo para medir el estilo del texto fijo con las mismas reglas del prompt. */
const CONFIG_DE_ESTILO = clienteConfigSchema.parse({
  slug: 'x',
  nombre: 'X',
  zonaHoraria: 'Europe/Madrid',
  canal: { tipo: 'whatsapp', remitenteId: '1' },
  agenda: { nivel: 'A', calendarioId: 'pruebas@group.calendar.google.com' },
  horario: [{ dia: 'lunes', abre: '10:00', cierra: '20:00' }],
  servicios: [{ codigo: 'a', nombre: 'A', precio: 35, duracionMinutos: 20 }],
  escalado: {
      recepcion: [{ nombre: 'Recepción', canal: 'whatsapp', destino: '+34600111111' }],
      contactos: [{ nombre: 'R', canal: 'whatsapp', destino: '+34600000000' }],
      proteccionDeDatos: [
        { nombre: 'DPD', canal: 'email', destino: 'datos@clinica.example' },
      ],
    },
});

/**
 * Reagendar y cancelar.
 *
 * En el banco: «justo me acordé de que a esa hora no puedo, ¿podría ser 10:45?»
 * y el agente contestó «prefiero que esto te lo confirme una persona del
 * equipo». La intención se extraía bien y **no la atendía nadie**: caía al
 * modelo grande, la validación bloqueaba por franja no propuesta y salía un
 * escalado. Escalar eso es la fatiga de alertas que hace que recepción deje de
 * mirar los avisos.
 *
 * La cita anterior no se suelta cuando el paciente dice que quiere cambiarla,
 * sino cuando elige una nueva. Si se soltara antes, un paciente que pregunta y
 * luego se lo piensa se queda sin nada.
 */

const CLINICA = 'ffff1111-ffff-4fff-8fff-ffff11110000';
const TELEFONO = '+34600444555';
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

function agenteGuionado(extracciones: readonly Extraccion[]): FabricaDeAgente {
  return new AgenteFalso(new ClasificadorFalso(extracciones), new RedactorFalso());
}

async function enviar(texto: string, agente: FabricaDeAgente): Promise<SalidaDeMensaje> {
  contador += 1;
  const deps = dependenciasDePrueba({ core, agenda, reloj: () => AHORA });
  const { cuerpo } = await procesarMensajeEntrante(
    { ...deps, agente },
    {
      idempotencyKey: `reagendar-${contador}`,
      clientId: CLINICA,
      telefono: TELEFONO,
      nombre: 'Nuria',
      texto,
    },
  );
  return cuerpo;
}

async function huecos(): Promise<Array<{ id: string; state: string; release_reason: string | null }>> {
  const filas = await admin`
    select id, state, release_reason from motor.holds
     where client_id = ${CLINICA} order by created_at, rank
  `;
  return filas.map((f) => ({
    id: String(f['id']),
    state: String(f['state']),
    release_reason: f['release_reason'] === null ? null : String(f['release_reason']),
  }));
}

/** Hasta tener una cita confirmada, como en el banco. */
async function conCitaConfirmada(): Promise<string> {
  await enviar(
    'quiero depilacion laser de axilas',
    agenteGuionado([extraccion({ intencion: 'agendar', servicio: 'laser-axilas' })]),
  );
  const eleccion = await enviar(
    'la segunda',
    agenteGuionado([extraccion({ intencion: 'elegir_hueco', opcion: 2 })]),
  );
  const holdId = eleccion.holdId;
  if (holdId === undefined) throw new Error('no se retuvo nada');

  const deps = dependenciasDePrueba({ core, agenda, reloj: () => AHORA });
  await accionRecepcion(deps, { idempotencyKey: 'rec-1', clientId: CLINICA, holdId });
  return holdId;
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
    values (${CLINICA}, 'clinica-de-pruebas', 'Clínica Reagendar', '{}'::jsonb, 'test')
  `;
  agenda = new AgendaFalsa();
  contador = 0;
});

describe('reagendar es un flujo, no un escalado', () => {
  it('«¿podría ser a las 10:45?» propone huecos y NO escala', async () => {
    await conCitaConfirmada();

    const salida = await enviar(
      'justo me acorde de que a esa hora no puedo, podria ser 10:45?',
      agenteGuionado([
        extraccion({
          intencion: 'reagendar',
          preferencia: preferencia({ horaExacta: '10:45' }),
        }),
      ]),
    );

    // Nada de «prefiero que esto te lo confirme una persona».
    expect(salida.efectos.filter((e) => e.tipo === 'escalar_a_humano')).toEqual([]);
    expect(salida.estadoConversacion).toBe('abierta');

    const propuestos = (await huecos()).filter((h) => h.state === 'propuesta');
    expect(propuestos.length).toBeGreaterThan(0);
  });

  it('la cita anterior sigue en pie mientras el paciente se lo piensa', async () => {
    const original = await conCitaConfirmada();

    await enviar(
      'podria ser mas tarde?',
      agenteGuionado([
        extraccion({ intencion: 'reagendar', preferencia: preferencia({ franjas: ['tarde'] }) }),
      ]),
    );

    const filas = await huecos();
    expect(filas.find((h) => h.id === original)?.state).toBe('confirmada');
  });

  it('al elegir la nueva, la anterior se libera y la cita queda cancelada', async () => {
    const original = await conCitaConfirmada();

    await enviar(
      'podria ser 10:45?',
      agenteGuionado([
        extraccion({ intencion: 'reagendar', preferencia: preferencia({ horaExacta: '10:45' }) }),
      ]),
    );
    const nueva = await enviar(
      'la primera',
      agenteGuionado([extraccion({ intencion: 'elegir_hueco', opcion: 1 })]),
    );

    const filas = await huecos();
    const vieja = filas.find((h) => h.id === original);
    expect(vieja?.state).toBe('liberada');
    expect(vieja?.release_reason).toBe('cancelacion');

    expect(nueva.holdId).toBeDefined();
    expect(nueva.holdId).not.toBe(original);
    // Dentro de la franja de contacto se avisa a recepción en el mismo turno.
    expect(filas.find((h) => h.id === nueva.holdId)?.state).toBe('pendiente_recepcion');

    const citas = await admin`
      select outcome from motor.appointments where client_id = ${CLINICA} and hold_id = ${original}
    `;
    expect(citas[0]?.['outcome']).toBe('cancelada');

    const acciones = await admin`select action from motor.audit_log where client_id = ${CLINICA}`;
    expect(acciones.map((f) => String(f['action']))).toContain('reagendada');
  });

  it('nunca se propone un hueco que solape con la cita que todavía tiene', async () => {
    const original = await conCitaConfirmada();
    const suyo = await admin`select slot_start, slot_end from motor.holds where id = ${original}`;
    const inicio = new Date(String(suyo[0]?.['slot_start'])).getTime();
    const fin = new Date(String(suyo[0]?.['slot_end'])).getTime();

    await enviar(
      'podria cambiarla?',
      agenteGuionado([extraccion({ intencion: 'reagendar' })]),
    );

    const propuestos = await admin`
      select slot_start, slot_end from motor.holds
       where client_id = ${CLINICA} and state = 'propuesta'
    `;
    for (const fila of propuestos) {
      const a = new Date(String(fila['slot_start'])).getTime();
      const b = new Date(String(fila['slot_end'])).getTime();
      expect(a < fin && inicio < b).toBe(false);
    }
  });
});

describe('el mensaje del reagendado no puede ser el de elegir', () => {
  it('dice la hora nueva Y que la anterior queda libre', async () => {
    const original = await conCitaConfirmada();
    const suyo = await admin`select slot_start from motor.holds where id = ${original}`;
    const horaVieja = new Intl.DateTimeFormat('es-ES', {
      timeZone: 'Europe/Madrid',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(String(suyo[0]?.['slot_start'])));

    await enviar(
      'podria cambiarla?',
      agenteGuionado([extraccion({ intencion: 'reagendar' })]),
    );
    const nueva = await enviar(
      'la primera',
      agenteGuionado([extraccion({ intencion: 'elegir_hueco', opcion: 1 })]),
    );

    const filas = await admin`select slot_start from motor.holds where id = ${nueva.holdId!}`;
    const horaNueva = new Intl.DateTimeFormat('es-ES', {
      timeZone: 'Europe/Madrid',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(String(filas[0]?.['slot_start'])));

    const texto = nueva.respuesta ?? '';
    // Quien acaba de cambiar su cita necesita saber a qué hora la tiene ahora.
    expect(texto).toContain(horaNueva);
    // Y que la anterior se ha soltado: es la otra mitad de lo que pregunta.
    expect(texto).toContain(horaVieja);
    // Y no puede ser el texto de elegir por primera vez: aquél habla de un solo
    // hueco, y aquí hay dos horas en juego.
    expect(texto).toContain('suelto el de');
  });

  it('elegir por primera vez sigue con su texto de siempre', async () => {
    await enviar(
      'quiero cita de axilas',
      agenteGuionado([extraccion({ intencion: 'agendar', servicio: 'laser-axilas' })]),
    );
    const eleccion = await enviar(
      'la primera',
      agenteGuionado([extraccion({ intencion: 'elegir_hueco', opcion: 1 })]),
    );

    /**
     * No hay cita anterior que soltar, así que no hay cambio que anunciar — pero
     * la hora sí se dice. Antes el texto era «te he guardado ese hueco» y el
     * paciente se quedaba sin saber cuál: el mismo fallo que ya se había
     * corregido en el del reagendado y que aquí seguía vivo.
     */
    const filas = await admin`select slot_start from motor.holds where id = ${eleccion.holdId!}`;
    const hora = new Intl.DateTimeFormat('es-ES', {
      timeZone: 'Europe/Madrid',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(String(filas[0]?.['slot_start'])));

    expect(eleccion.respuesta).toContain(hora);
    expect(eleccion.respuesta).not.toContain('suelto el de');
  });

  it('el texto del reagendado respeta el tono: dos frases, sin listas ni emojis', async () => {
    await conCitaConfirmada();
    await enviar('podria cambiarla?', agenteGuionado([extraccion({ intencion: 'reagendar' })]));
    const nueva = await enviar(
      'la primera',
      agenteGuionado([extraccion({ intencion: 'elegir_hueco', opcion: 1 })]),
    );

    const motivos = evaluarEstilo(nueva.respuesta ?? '', CONFIG_DE_ESTILO);
    expect(motivos).toEqual([]);
  });
});

describe('cancelar también es un flujo', () => {
  it('suelta el hueco, cancela la cita y no escala', async () => {
    const original = await conCitaConfirmada();

    const salida = await enviar(
      'al final no voy a poder ir, cancelala por favor',
      agenteGuionado([extraccion({ intencion: 'cancelar' })]),
    );

    expect(salida.efectos.filter((e) => e.tipo === 'escalar_a_humano')).toEqual([]);

    const filas = await huecos();
    expect(filas.find((h) => h.id === original)?.state).toBe('liberada');
    expect(filas.find((h) => h.id === original)?.release_reason).toBe('cancelacion');

    const citas = await admin`
      select outcome from motor.appointments where client_id = ${CLINICA}
    `;
    expect(citas[0]?.['outcome']).toBe('cancelada');
  });

  it('se puede cancelar ANTES de que recepción confirme', async () => {
    await enviar(
      'quiero cita de axilas',
      agenteGuionado([extraccion({ intencion: 'agendar', servicio: 'laser-axilas' })]),
    );
    const eleccion = await enviar(
      'la primera',
      agenteGuionado([extraccion({ intencion: 'elegir_hueco', opcion: 1 })]),
    );

    await enviar(
      'dejalo, que al final no puedo',
      agenteGuionado([extraccion({ intencion: 'cancelar' })]),
    );

    const filas = await huecos();
    expect(filas.find((h) => h.id === eleccion.holdId)?.state).toBe('liberada');
  });

  it('cancelar sin cita no revienta ni escala: se le contesta', async () => {
    const salida = await enviar(
      'quiero cancelar mi cita',
      agenteGuionado([extraccion({ intencion: 'cancelar' })]),
    );

    expect(salida.respuesta).not.toBeNull();
    expect(salida.efectos.filter((e) => e.tipo === 'escalar_a_humano')).toEqual([]);
  });

  it('el hueco liberado vuelve a estar disponible para otro paciente', async () => {
    const original = await conCitaConfirmada();
    const suyo = await admin`select slot_start from motor.holds where id = ${original}`;
    const slot = new Date(String(suyo[0]?.['slot_start'])).toISOString();

    await enviar('cancela', agenteGuionado([extraccion({ intencion: 'cancelar' })]));

    contador += 1;
    const deps = dependenciasDePrueba({ core, agenda, reloj: () => AHORA });
    await procesarMensajeEntrante(
      {
        ...deps,
        agente: agenteGuionado([extraccion({ intencion: 'agendar', servicio: 'laser-axilas' })]),
      },
      {
        idempotencyKey: `otra-${contador}`,
        clientId: CLINICA,
        telefono: '+34600888999',
        nombre: 'Elena',
        texto: 'quiero cita de axilas',
      },
    );

    const reofrecido = await admin`
      select count(*)::int as n from motor.holds
       where client_id = ${CLINICA} and state = 'propuesta' and slot_start = ${slot}
    `;
    // `liberada` no bloquea: por eso la cancelación devuelve capacidad de verdad.
    expect(reofrecido[0]?.['n']).toBe(1);
  });
});
