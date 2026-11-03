import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Extraccion } from '../../src/agent/extraccion.js';
import { createCore, type Core } from '../../src/db/client.js';
import * as q from '../../src/db/queries.js';
import { procesarMensajeEntrante, type SalidaDeMensaje } from '../../src/service/pipeline.js';
import { accionRecepcion } from '../../src/service/reception.js';
import { caducarRetenciones } from '../../src/service/vencimientos.js';
import {
  AgendaFalsa,
  AgenteFalso,
  ClasificadorFalso,
  dependenciasDePrueba,
  RedactorFalso,
} from '../support/fakes.js';
import { APP_URL, conexionAdmin, prepararBaseDeDatos } from '../support/db.js';

/**
 * **Un cron materializa el estado; no lo define.**
 *
 * Del servidor de pruebas, sin crons montados: a «¿hay cita para mañana por la
 * mañana?» el agente contestó «martes 25 a las 10:00 o 10:20» —propuestas del 24
 * de agosto, vencidas ese mismo día a las 10:44— y recordó tres veces al
 * paciente «tienes tu hora el viernes 28 a las 17:00», una cita de agosto que
 * seguía `pendiente_recepcion` en octubre. Las filas lo decían y las lecturas se
 * lo creían.
 *
 * Aquí ningún test llama al cron antes de comprobar: el cron es justo lo que no
 * ha pasado.
 */

const CLINICA = '55556666-5555-4555-8555-555566660000';
const TELEFONO = '+34600555666';
// Lunes 14 a las 12:00 en Madrid. La jornada acaba a las 20:00 (18:00 UTC).
const AHORA = new Date('2026-09-14T10:00:00.000Z');
const horas = (n: number): Date => new Date(AHORA.getTime() + n * 3_600_000);
// Domingo 20 a las 12:00 en Madrid: todos los huecos propuestos ya han pasado.
const SEMANA_DESPUES = new Date('2026-09-20T10:00:00.000Z');

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

function deps(ahora: Date) {
  return dependenciasDePrueba({ core, agenda, reloj: () => ahora });
}

async function enviar(
  texto: string,
  guion: Extraccion,
  ahora: Date = AHORA,
  redactor: RedactorFalso = new RedactorFalso(),
): Promise<SalidaDeMensaje> {
  contador += 1;
  const { cuerpo } = await procesarMensajeEntrante(
    { ...deps(ahora), agente: new AgenteFalso(new ClasificadorFalso([guion]), redactor) },
    {
      idempotencyKey: `vigencia-${contador}`,
      clientId: CLINICA,
      telefono: TELEFONO,
      nombre: 'Marta',
      texto,
    },
  );
  return cuerpo;
}

async function estado(holdId: string): Promise<string> {
  const filas = await admin`select state from motor.holds where id = ${holdId}`;
  return String(filas[0]?.['state']);
}

/** Pide axilas y elige la primera, dentro de la franja: aviso a recepción ya. */
async function conCitaPendiente(): Promise<string> {
  await enviar('quiero axilas', extraccion({ intencion: 'agendar', servicio: 'laser-axilas' }));
  const eleccion = await enviar('la primera', extraccion({ intencion: 'elegir_hueco', opcion: 1 }));
  if (eleccion.holdId === undefined) throw new Error('no se retuvo nada');
  return eleccion.holdId;
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
  await admin`update motor.conversations set pending_hold_id = null where client_id = ${CLINICA}`;
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
    values (${CLINICA}, 'clinica-de-pruebas', 'Clínica Vigencia', '{}'::jsonb, 'test')
  `;
  agenda = new AgendaFalsa();
  contador = 0;
});

describe('propuestas vencidas, sin que el cron haya pasado', () => {
  it('no se le ponen delante al redactor', async () => {
    await enviar('quiero axilas', extraccion({ intencion: 'agendar', servicio: 'laser-axilas' }));
    const filas = await admin`select state from motor.holds where client_id = ${CLINICA}`;
    // Las filas siguen diciendo `propuesta`: el cron no ha pasado.
    expect(filas.every((f) => f['state'] === 'propuesta')).toBe(true);

    const redactor = new RedactorFalso();
    await enviar('hola, ¿qué tenías?', extraccion({ intencion: 'otro' }), horas(7), redactor);

    expect(redactor.huecosRecibidos[0]).toEqual([]);
  });

  it('una hora suya ya no se puede nombrar: la validación la trata como inventada', async () => {
    await enviar('quiero axilas', extraccion({ intencion: 'agendar', servicio: 'laser-axilas' }));
    const [primera] = await admin`
      select slot_start from motor.holds where client_id = ${CLINICA} order by rank limit 1
    `;
    const momento = new Intl.DateTimeFormat('es-ES', {
      timeZone: 'Europe/Madrid',
      weekday: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(String(primera?.['slot_start'])));

    // El caso de las 02:01: el modelo ofrece una propuesta vencida como si
    // siguiera libre.
    const redactor = new RedactorFalso([
      `Lo que tengo es el ${momento}, ¿te encaja?`,
      'Dime qué día te viene bien y te lo miro.',
    ]);
    await enviar('¿hay algo?', extraccion({ intencion: 'otro' }), horas(7), redactor);

    expect(redactor.correcciones).toHaveLength(1);
  });

  it('y elegirla no retiene nada', async () => {
    await enviar('quiero axilas', extraccion({ intencion: 'agendar', servicio: 'laser-axilas' }));

    const eleccion = await enviar(
      'la primera',
      extraccion({ intencion: 'elegir_hueco', opcion: 1 }),
      horas(7),
    );

    expect(eleccion.holdId).toBeUndefined();
    const vivos = await admin`
      select count(*)::int as n from motor.holds
       where client_id = ${CLINICA} and state in ('retenida', 'pendiente_recepcion', 'confirmada')
    `;
    expect(vivos[0]?.['n']).toBe(0);
  });
});

describe('una cita cuya hora ya pasó no es «su cita»', () => {
  it('el redactor no la ve: lo de «tienes tu hora el viernes 28» no puede pasar', async () => {
    const pasada = await conCitaPendiente();
    // Sigue `pendiente_recepcion` en la base una semana después.
    expect(await estado(pasada)).toBe('pendiente_recepcion');

    const redactor = new RedactorFalso();
    await enviar('hola', extraccion({ intencion: 'otro' }), SEMANA_DESPUES, redactor);

    expect(redactor.estados[0]?.citasVigentes).toEqual([]);
  });

  it('no cuenta como «ya tiene hora»: pedir otra del mismo tratamiento propone', async () => {
    await conCitaPendiente();

    const redactor = new RedactorFalso();
    await enviar(
      'quiero axilas',
      extraccion({ intencion: 'agendar', servicio: 'laser-axilas' }),
      SEMANA_DESPUES,
      redactor,
    );

    expect(redactor.huecosRecibidos[0]?.length).toBeGreaterThan(0);
  });

  it('cancelar no la toca: no hay ninguna cita viva que cancelar', async () => {
    const pasada = await conCitaPendiente();

    const redactor = new RedactorFalso();
    await enviar('cancela mi cita', extraccion({ intencion: 'cancelar' }), SEMANA_DESPUES, redactor);

    expect(redactor.estados[0]?.cancelada).toBe(false);
    expect(await estado(pasada)).toBe('pendiente_recepcion');
  });
});

describe('pendiente de recepción vencida al acabar la jornada', () => {
  it('a las 21:00 del mismo día ya no es una cita viva, aunque la fila lo diga', async () => {
    await conCitaPendiente();

    const redactor = new RedactorFalso();
    // 21:00 en Madrid: la jornada acabó a las 20:00 y nadie confirmó.
    await enviar('hola', extraccion({ intencion: 'otro' }), horas(9), redactor);

    expect(redactor.estados[0]?.citasVigentes).toEqual([]);
  });
});

describe('recepción pulsa sobre una cita que ya no está viva', () => {
  it('si su hora ya pasó, NO se crea la cita: se le dice que pasó', async () => {
    // Es el cierre de circuito que se iba a probar a mano sobre la cita del
    // 28 de agosto. Sin esto, se habría confirmado en octubre.
    const pasada = await conCitaPendiente();

    const salida = await accionRecepcion(deps(SEMANA_DESPUES), {
      idempotencyKey: 'pulsa-tarde',
      clientId: CLINICA,
      holdId: pasada,
    });

    expect(salida.cuerpo.estado).toBe('anulada');
    expect(salida.cuerpo.citaId).toBeNull();
    expect(salida.cuerpo.respuesta).toBeNull();
    expect(salida.cuerpo.mensajeParaRecepcion).toMatch(/ya pasó/);
    const citas = await admin`select count(*)::int as n from motor.appointments where client_id = ${CLINICA}`;
    expect(citas[0]?.['n']).toBe(0);
  });

  it('si caducó al acabar la jornada, se le dice que caducó, no que la canceló el paciente', async () => {
    const vencida = await conCitaPendiente();

    const salida = await accionRecepcion(deps(horas(9)), {
      idempotencyKey: 'pulsa-tras-la-jornada',
      clientId: CLINICA,
      holdId: vencida,
    });

    expect(salida.cuerpo.estado).toBe('anulada');
    expect(salida.cuerpo.mensajeParaRecepcion).toMatch(/caducó/);
    expect(salida.cuerpo.mensajeParaRecepcion).not.toMatch(/canceló/);
  });

  it('dentro de la jornada se confirma con normalidad', async () => {
    const viva = await conCitaPendiente();

    const salida = await accionRecepcion(deps(horas(2)), {
      idempotencyKey: 'pulsa-a-tiempo',
      clientId: CLINICA,
      holdId: viva,
    });

    expect(salida.cuerpo.estado).toBe('confirmada');
  });
});

describe('el cron, cuando por fin pasa, anota pero no avisa de lo que ya pasó', () => {
  it('la cita y las propuestas pasadas caducan sin un solo mensaje ni aviso', async () => {
    const pasada = await conCitaPendiente();

    const salida = await caducarRetenciones(deps(SEMANA_DESPUES), { clientId: CLINICA });

    expect(await estado(pasada)).toBe('caducada');
    const restantes = await admin`
      select count(*)::int as n from motor.holds
       where client_id = ${CLINICA} and state in ('propuesta', 'pendiente_recepcion')
    `;
    expect(restantes[0]?.['n']).toBe(0);
    // Nada a recepción («mete esta cita» de la semana pasada) y nada al
    // paciente («tu propuesta ha caducado» de hace días).
    expect(salida.aplicados.length).toBeGreaterThan(0);
    expect(salida.aplicados.flatMap((a) => a.efectos)).toEqual([]);
  });
});

describe('lo que se le manda al modelo respeta la retención sin esperar a la purga', () => {
  it('un mensaje con la retención vencida no está en los turnos', async () => {
    await enviar('me duele un poco la zona', extraccion({ intencion: 'otro' }));
    await enviar('vale, gracias', extraccion({ intencion: 'otro' }));
    const [conversacion] = await admin`
      select id from motor.conversations where client_id = ${CLINICA}
    `;
    // El primero ha vencido su retención y la purga diaria todavía no ha pasado:
    // el contenido sigue en la fila.
    await admin`
      update motor.messages set purge_at = ${horas(-1).toISOString()}
       where client_id = ${CLINICA} and body = 'me duele un poco la zona'
    `;

    const turnos = await core.withClient(CLINICA, (tx) =>
      q.turnosRecientes(CLINICA, tx, String(conversacion?.['id']), 10, AHORA),
    );

    const textos = turnos.map((t) => t.texto);
    expect(textos).toContain('vale, gracias');
    expect(textos).not.toContain('me duele un poco la zona');
  });
});
