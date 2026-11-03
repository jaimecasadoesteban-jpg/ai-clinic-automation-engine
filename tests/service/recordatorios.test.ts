import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createCore, type Core } from '../../src/db/client.js';
import { ejecutarTrabajo } from '../../src/service/planificador.js';
import { AgendaFalsa, configDePrueba, dependenciasDePrueba, registroDePrueba } from '../support/fakes.js';
import { APP_URL, conexionAdmin, prepararBaseDeDatos } from '../support/db.js';

/**
 * Recordatorios antes de la cita: sólo si la clínica los quiere, dentro de la
 * franja, una vez, a quien la pidió con antelación, y con plantilla si han
 * pasado 24 h desde su último mensaje.
 */

const CLINICA = 'ec0d0000-0000-4000-8000-00000000ec0d';
const PACIENTE = 'ec0d1111-0000-4000-8000-00000000ec0d';
const CONVERSACION = 'ec0d2222-0000-4000-8000-00000000ec0d';
/** Martes 15 de septiembre de 2026, 12:00 en Madrid. */
const AHORA = new Date('2026-09-15T10:00:00.000Z');
const CHATWOOT = { por: 'chatwoot', cuentaId: 7, conversacionId: 1001 };

const admin = conexionAdmin();
let core: Core;

function deps(opciones: { ahora?: Date; recordatorios?: boolean; plantilla?: boolean } = {}) {
  return dependenciasDePrueba({
    core,
    agenda: new AgendaFalsa(),
    reloj: () => opciones.ahora ?? AHORA,
    configuracion: registroDePrueba([
      {
        slug: 'clinica-de-pruebas',
        config: configDePrueba({
          canal: { tipo: 'whatsapp', remitenteId: '000', chatwoot: { cuentaId: 7, inboxId: 42 } },
          ...(opciones.recordatorios === false ? {} : { recordatorios: { horasAntes: 24 } }),
          ...(opciones.plantilla === true
            ? { plantillas: { recordatorio: { nombre: 'recordatorio_cita', idioma: 'es', variables: ['nombre', 'servicio', 'cuando', 'clinica'] } } }
            : {}),
        }),
      },
    ]),
  });
}

/** Una cita confirmada dentro de `horas` horas, pedida hace `pedidaHaceHoras`. */
async function cita(horas: number, pedidaHaceHoras = 72, estadoHueco = 'confirmada'): Promise<string> {
  const inicio = new Date(AHORA.getTime() + horas * 3_600_000);
  const fin = new Date(inicio.getTime() + 20 * 60_000);
  const [h] = await admin`
    insert into motor.holds (client_id, patient_id, conversation_id, slot_start, slot_end, service_code, state, state_changed_at)
    values (${CLINICA}, ${PACIENTE}, ${CONVERSACION}, ${inicio.toISOString()}, ${fin.toISOString()}, 'laser-axilas', ${estadoHueco}::motor.hold_state, ${AHORA.toISOString()})
    returning id
  `;
  const [c] = await admin`
    insert into motor.appointments (client_id, patient_id, conversation_id, hold_id, slot_start, slot_end, service_code, confirmed_at)
    values (${CLINICA}, ${PACIENTE}, ${CONVERSACION}, ${String(h?.['id'])}, ${inicio.toISOString()}, ${fin.toISOString()}, 'laser-axilas',
            ${new Date(AHORA.getTime() - pedidaHaceHoras * 3_600_000).toISOString()})
    returning id
  `;
  return String(c?.['id']);
}

async function escribioHace(horas: number): Promise<void> {
  await admin`
    insert into motor.messages (client_id, conversation_id, direction, body, is_clinical, purge_at, created_at)
    values (${CLINICA}, ${CONVERSACION}, 'entrante', 'hola', false, now() + interval '1 year', ${new Date(AHORA.getTime() - horas * 3_600_000).toISOString()})
  `;
}

const salida = async (kind: string) =>
  (await admin`select payload from motor.outbox where client_id = ${CLINICA} and kind = ${kind} order by created_at`).map(
    (f) => f['payload'] as Record<string, unknown>,
  );

beforeAll(async () => {
  await prepararBaseDeDatos(admin);
  core = createCore(APP_URL);
}, 60_000);

afterAll(async () => {
  await core.close();
  await admin.end();
});

beforeEach(async () => {
  for (const tabla of ['outbox', 'audit_log', 'job_runs', 'appointments', 'escalations', 'messages', 'holds', 'conversations', 'patients']) {
    await admin.unsafe(`delete from motor.${tabla} where client_id = $1`, [CLINICA]);
  }
  await admin`delete from motor.clients where id = ${CLINICA}`;
  await admin`insert into motor.clients (id, slug, name, config, config_version) values (${CLINICA}, 'clinica-de-pruebas', 'Clínica', '{}'::jsonb, 'test')`;
  await admin`insert into motor.patients (id, client_id, given_name, phone_e164) values (${PACIENTE}, ${CLINICA}, 'Lola', '+34600123456')`;
  await admin`
    insert into motor.conversations (id, client_id, patient_id, reply_channel)
    values (${CONVERSACION}, ${CLINICA}, ${PACIENTE}, ${JSON.stringify(CHATWOOT)}::jsonb)
  `;
});

describe('a quién y cuándo', () => {
  it('dentro de las 24 h desde su último mensaje: texto con su nombre, el tratamiento y la hora; y queda registrado', async () => {
    await escribioHace(5);
    await cita(20);

    await ejecutarTrabajo(deps(), CLINICA, 'recordatorios');

    const [m] = await salida('chatwoot');
    expect(m).toMatchObject({ cuentaId: 7, conversacionId: 1001, privado: false });
    expect(String(m?.['texto'])).toMatch(/Hola Lola, .*láser axilas.*16/);
    expect(await admin`select 1 from motor.messages where client_id = ${CLINICA} and direction = 'saliente'`).toHaveLength(1);
  });

  it('una sola vez: la siguiente pasada no lo repite', async () => {
    await escribioHace(5);
    await cita(20);
    await ejecutarTrabajo(deps(), CLINICA, 'recordatorios');

    await ejecutarTrabajo(deps({ ahora: new Date(AHORA.getTime() + 15 * 60_000) }), CLINICA, 'recordatorios');

    expect(await salida('chatwoot')).toHaveLength(1);
    // Ni en el historial: el agente leería el recordatorio repetido cada 15 minutos.
    expect(await admin`select 1 from motor.messages where client_id = ${CLINICA} and direction = 'saliente'`).toHaveLength(1);
    const [c] = await admin`select reminder_sent_at from motor.appointments where client_id = ${CLINICA}`;
    expect(c?.['reminder_sent_at']).not.toBeNull();
  });

  it('todavía no: a 30 h de la cita, con 24 de plazo, no sale', async () => {
    await escribioHace(5);
    await cita(30);

    await ejecutarTrabajo(deps(), CLINICA, 'recordatorios');

    expect(await salida('chatwoot')).toEqual([]);
  });

  it('a quien la pidió hoy para mañana no se le recuerda: acaba de recibir su confirmación', async () => {
    await escribioHace(1);
    await cita(20, 2);

    await ejecutarTrabajo(deps(), CLINICA, 'recordatorios');

    expect(await salida('chatwoot')).toEqual([]);
  });

  it('una cita que ya no está confirmada (cancelada, movida) no se recuerda', async () => {
    await escribioHace(5);
    await cita(20, 72, 'liberada');

    await ejecutarTrabajo(deps(), CLINICA, 'recordatorios');

    expect(await salida('chatwoot')).toEqual([]);
  });

  it('sin la sección recordatorios en el YAML, la clínica no los manda', async () => {
    await escribioHace(5);
    await cita(20);

    await ejecutarTrabajo(deps({ recordatorios: false }), CLINICA, 'recordatorios');

    expect(await salida('chatwoot')).toEqual([]);
  });

  it('de madrugada no: espera a la franja de contacto', async () => {
    await escribioHace(5);
    const madrugada = new Date('2026-09-15T01:00:00.000Z'); // 03:00 en Madrid
    await cita(20);

    const r = await ejecutarTrabajo(deps({ ahora: madrugada }), CLINICA, 'recordatorios');

    expect(r.resumen['fueraDeFranja']).toBe(true);
    expect(await salida('chatwoot')).toEqual([]);
  });
});

describe('fuera de las 24 h', () => {
  it('con la plantilla recordatorio: sale la plantilla con nombre, tratamiento, hora y clínica', async () => {
    await escribioHace(72);
    await cita(20);

    await ejecutarTrabajo(deps({ plantilla: true }), CLINICA, 'recordatorios');

    const [m] = await salida('chatwoot');
    expect(m?.['plantilla']).toMatchObject({ nombre: 'recordatorio_cita', idioma: 'es' });
    const parametros = (m?.['plantilla'] as { parametros: string[] }).parametros;
    expect(parametros[0]).toBe('Lola');
    expect(parametros[1]).toBe('Láser axilas');
    expect(parametros[3]).toBe('Clínica de Pruebas');
  });

  it('sin plantilla: no sale, el operador lo sabe, y no se reintenta cada 15 minutos', async () => {
    await escribioHace(72);
    await cita(20);

    await ejecutarTrabajo(deps(), CLINICA, 'recordatorios');
    await ejecutarTrabajo(deps({ ahora: new Date(AHORA.getTime() + 15 * 60_000) }), CLINICA, 'recordatorios');

    expect(await salida('chatwoot')).toEqual([]);
    const correos = await salida('correo_operador');
    expect(correos).toHaveLength(1);
    expect(String(correos[0]?.['cuerpo'])).toMatch(/plantillas\.recordatorio/);
  });
});
