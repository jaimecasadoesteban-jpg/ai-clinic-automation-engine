import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createCore, type Core } from '../../src/db/client.js';
import { registrarResultadoDeCita, ResultadoRechazadoError } from '../../src/service/appointments.js';
import { DIAS_PARA_PRESUMIR, ejecutarTrabajo, tocaEjecutar } from '../../src/service/planificador.js';
import { AgendaFalsa, configDePrueba, dependenciasDePrueba, registroDePrueba } from '../support/fakes.js';
import { APP_URL, conexionAdmin, prepararBaseDeDatos } from '../support/db.js';

/**
 * La asistencia: el dato que dispara la factura, la reseña y la reactivación.
 * Se anota cuando la cita ha pasado; lo que recepción no conteste en 7 días
 * desde la relación semanal se presume asistido (contrato); y de las citas
 * asistidas sale la última visita del paciente.
 */

const MADRID = 'Europe/Madrid';

describe('cuándo toca la relación semanal', () => {
  const a = (iso: string) => new Date(iso);
  // Lunes 19 de octubre de 2026; Madrid en verano (UTC+2).
  it('el lunes a las 09:00 en hora de la clínica, una vez por semana', () => {
    expect(tocaEjecutar('relacion-de-asistencia', a('2026-10-12T07:01:00Z'), a('2026-10-19T06:59:00Z'), MADRID)).toBe(false);
    expect(tocaEjecutar('relacion-de-asistencia', a('2026-10-12T07:01:00Z'), a('2026-10-19T07:00:00Z'), MADRID)).toBe(true);
    expect(tocaEjecutar('relacion-de-asistencia', a('2026-10-19T07:01:00Z'), a('2026-10-21T10:00:00Z'), MADRID)).toBe(false);
  });

  it('si el lunes estaba caído, al volver; no a la semana siguiente', () => {
    expect(tocaEjecutar('relacion-de-asistencia', a('2026-10-12T07:01:00Z'), a('2026-10-20T10:00:00Z'), MADRID)).toBe(true);
  });

  it('la presunción, a diario a las 09:10', () => {
    expect(tocaEjecutar('presumir-asistencia', a('2026-10-18T07:11:00Z'), a('2026-10-19T07:09:00Z'), MADRID)).toBe(false);
    expect(tocaEjecutar('presumir-asistencia', a('2026-10-18T07:11:00Z'), a('2026-10-19T07:10:00Z'), MADRID)).toBe(true);
  });
});

const CLINICA = 'a515e000-0000-4000-8000-00000000a515';
const PACIENTE = 'a515e111-0000-4000-8000-00000000a515';
const CONVERSACION = 'a515e222-0000-4000-8000-00000000a515';
/** Lunes 21 de septiembre de 2026, 11:00 en Madrid. */
const AHORA = new Date('2026-09-21T09:00:00.000Z');

const admin = conexionAdmin();
let core: Core;

function deps(ahora = AHORA, recepcionPorCorreo = false) {
  return dependenciasDePrueba({
    core,
    agenda: new AgendaFalsa(),
    reloj: () => ahora,
    configuracion: registroDePrueba([
      {
        slug: 'clinica-de-pruebas',
        config: configDePrueba(
          recepcionPorCorreo
            ? {
                escalado: {
                  recepcion: [{ nombre: 'Recepción', canal: 'email', destino: 'recepcion@clinica.example' }],
                  contactos: [{ nombre: 'Recepción', canal: 'whatsapp', destino: '+34600000000', severidadMinima: 1 }],
                  proteccionDeDatos: [{ nombre: 'DPD', canal: 'email', destino: 'datos@clinica.example' }],
                },
              }
            : {},
        ),
      },
    ]),
  });
}

/** Una cita confirmada que empieza `diasAtras` días antes de AHORA. */
async function cita(diasAtras: number, extra: { pedidaHaceDias?: number } = {}): Promise<string> {
  const inicio = new Date(AHORA.getTime() - diasAtras * 86_400_000);
  const fin = new Date(inicio.getTime() + 20 * 60_000);
  const [h] = await admin`
    insert into motor.holds (client_id, patient_id, conversation_id, slot_start, slot_end, service_code, state, state_changed_at)
    values (${CLINICA}, ${PACIENTE}, ${CONVERSACION}, ${inicio.toISOString()}, ${fin.toISOString()}, 'laser-axilas', 'confirmada', ${inicio.toISOString()})
    returning id
  `;
  const pedida = extra.pedidaHaceDias === undefined ? null : new Date(AHORA.getTime() - extra.pedidaHaceDias * 86_400_000).toISOString();
  const [c] = await admin`
    insert into motor.appointments (client_id, patient_id, conversation_id, hold_id, slot_start, slot_end, service_code, attendance_requested_at)
    values (${CLINICA}, ${PACIENTE}, ${CONVERSACION}, ${String(h?.['id'])}, ${inicio.toISOString()}, ${fin.toISOString()}, 'laser-axilas', ${pedida})
    returning id
  `;
  return String(c?.['id']);
}

const ultimaVisita = async (): Promise<Date | null> => {
  const valor = (await admin`select last_visit_at from motor.patients where id = ${PACIENTE}`)[0]?.['last_visit_at'];
  return valor === null || valor === undefined ? null : new Date(String(valor instanceof Date ? valor.toISOString() : valor));
};

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
  await admin`insert into motor.conversations (id, client_id, patient_id) values (${CONVERSACION}, ${CLINICA}, ${PACIENTE})`;
});

describe('anotar la asistencia', () => {
  it('no antes de la cita: «asistió» sobre una cita de mañana es un error de clic', async () => {
    const id = await cita(-1);

    await expect(
      registrarResultadoDeCita(deps(), { clientId: CLINICA, citaId: id, outcome: 'asistida', fuente: 'recepcion' }),
    ).rejects.toBeInstanceOf(ResultadoRechazadoError);
  });

  it('«asistió» deja la última visita del paciente en la hora de esa cita', async () => {
    const id = await cita(3);

    await registrarResultadoDeCita(deps(), { clientId: CLINICA, citaId: id, outcome: 'asistida', fuente: 'recepcion' });

    expect((await ultimaVisita())?.getTime()).toBe(AHORA.getTime() - 3 * 86_400_000);
  });

  it('un doble clic no hace nada; cambiarlo sin rectificación no se deja', async () => {
    const id = await cita(3);
    await registrarResultadoDeCita(deps(), { clientId: CLINICA, citaId: id, outcome: 'asistida', fuente: 'recepcion' });

    await expect(
      registrarResultadoDeCita(deps(), { clientId: CLINICA, citaId: id, outcome: 'asistida', fuente: 'recepcion' }),
    ).resolves.toMatchObject({ outcome: 'asistida' });
    await expect(
      registrarResultadoDeCita(deps(), { clientId: CLINICA, citaId: id, outcome: 'no_asistida', fuente: 'recepcion' }),
    ).rejects.toBeInstanceOf(ResultadoRechazadoError);
  });

  it('una rectificación a «no vino» devuelve la última visita a la anterior, y deja constancia', async () => {
    const vieja = await cita(40);
    const nueva = await cita(3);
    await registrarResultadoDeCita(deps(), { clientId: CLINICA, citaId: vieja, outcome: 'asistida', fuente: 'recepcion' });
    await registrarResultadoDeCita(deps(), { clientId: CLINICA, citaId: nueva, outcome: 'asistida', fuente: 'recepcion' });

    await registrarResultadoDeCita(deps(), { clientId: CLINICA, citaId: nueva, outcome: 'no_asistida', fuente: 'rectificacion' });

    expect((await ultimaVisita())?.getTime()).toBe(AHORA.getTime() - 40 * 86_400_000);
    const [fila] = await admin`select outcome, outcome_before_rectification, attendance_source from motor.appointments where id = ${nueva}`;
    expect(fila).toMatchObject({ outcome: 'no_asistida', outcome_before_rectification: 'asistida', attendance_source: 'rectificacion' });
  });
});

describe('la relación semanal', () => {
  it('marca como pedidas las citas pasadas sin resultado, y le llega a recepción por correo', async () => {
    const pasada = await cita(2);
    await cita(-2); // futura: no entra

    await ejecutarTrabajo(deps(AHORA, true), CLINICA, 'relacion-de-asistencia');

    const filas = await admin`select id, attendance_requested_at from motor.appointments where client_id = ${CLINICA} and attendance_requested_at is not null`;
    expect(filas.map((f) => String(f['id']))).toEqual([pasada]);
    const correos = await admin`select payload from motor.outbox where client_id = ${CLINICA} and kind = 'correo'`;
    expect(correos.map((c) => (c['payload'] as { correoA: string }).correoA)).toEqual(['recepcion@clinica.example']);
    expect(String((correos[0]?.['payload'] as { cuerpo: string }).cuerpo)).toMatch(/Láser axilas · Lola/);
  });

  it('sin correo de recepción, el operador recibe un aviso sin datos de pacientes', async () => {
    await cita(2);

    await ejecutarTrabajo(deps(), CLINICA, 'relacion-de-asistencia');

    const [aviso] = await admin`select payload from motor.outbox where client_id = ${CLINICA} and kind = 'correo_operador'`;
    expect(JSON.stringify(aviso?.['payload'])).toMatch(/Asistencia/);
    expect(JSON.stringify(aviso?.['payload'])).not.toMatch(/Lola|34600123456/);
  });

  it('una cita ya pedida no vuelve a entrar en la relación siguiente', async () => {
    await cita(2);
    await ejecutarTrabajo(deps(AHORA, true), CLINICA, 'relacion-de-asistencia');

    const r = await ejecutarTrabajo(deps(new Date(AHORA.getTime() + 7 * 86_400_000), true), CLINICA, 'relacion-de-asistencia');

    expect(r.resumen['citas']).toBe(0);
  });
});

describe('la presunción del contrato', () => {
  it(`a los ${DIAS_PARA_PRESUMIR} días de la relación sin respuesta, se da por asistida (fuente: presunción)`, async () => {
    const vencida = await cita(10, { pedidaHaceDias: DIAS_PARA_PRESUMIR + 1 });
    const enPlazo = await cita(5, { pedidaHaceDias: DIAS_PARA_PRESUMIR - 1 });
    const sinPedir = await cita(6);

    await ejecutarTrabajo(deps(), CLINICA, 'presumir-asistencia');

    const filas = await admin`select id, outcome, attendance_source from motor.appointments where client_id = ${CLINICA}`;
    const por = Object.fromEntries(filas.map((f) => [String(f['id']), f]));
    expect(por[vencida]).toMatchObject({ outcome: 'asistida', attendance_source: 'presuncion' });
    expect(por[enPlazo]).toMatchObject({ outcome: 'pendiente' });
    expect(por[sinPedir]).toMatchObject({ outcome: 'pendiente' });
    expect(await ultimaVisita()).not.toBeNull();
  });
});
