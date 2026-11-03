import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createCore, type Core } from '../../src/db/client.js';
import { caducarRetenciones } from '../../src/service/vencimientos.js';
import { AgendaFalsa, configDePrueba, dependenciasDePrueba, registroDePrueba } from '../support/fakes.js';
import { APP_URL, conexionAdmin, prepararBaseDeDatos } from '../support/db.js';

/**
 * **Lo que el sistema le escribe al paciente sin que él haya escrito.**
 *
 * `/caducar-retenciones` emitía `{ tipo: 'mensaje_al_paciente', plantilla:
 * 'propuesta_caducada' }` y nada más: ni teléfono, ni texto. n8n no tenía a
 * quién mandarlo ni qué decir, y el workflow se lo saltaba. «Nadie recibe "tu
 * propuesta ha caducado" a las tres de la mañana» describía algo que no había
 * llegado nunca a nadie, a ninguna hora. Nadie lo vio porque los crons no
 * estaban montados.
 */

const CLINICA = 'eeee0000-eeee-4eee-8eee-eeee00000000';
const PACIENTE = 'eeee1111-eeee-4eee-8eee-eeee11111111';
const CONVERSACION = 'eeee2222-eeee-4eee-8eee-eeee22222222';
const TELEFONO = '+34600333222';

/** Martes 15 de septiembre de 2026, 12:00 en Madrid: dentro de la franja. */
const MEDIODIA = new Date('2026-09-15T10:00:00.000Z');
/** Las 03:00 de Madrid del día siguiente. */
const MADRUGADA = new Date('2026-09-16T01:00:00.000Z');

const admin = conexionAdmin();
let core: Core;

function deps(ahora = MEDIODIA, automatica = false) {
  return dependenciasDePrueba({
    core,
    agenda: new AgendaFalsa(),
    reloj: () => ahora,
    ...(automatica
      ? {
          configuracion: registroDePrueba([
            {
              slug: 'clinica-de-pruebas',
              config: configDePrueba({
                slug: 'clinica-de-pruebas',
                agenda: { nivel: 'A', calendarioId: 'pruebas@group.calendar.google.com', confirmacion: 'automatica' },
                vencimientos: { agendaMinutos: 3 },
              }),
            },
          ]),
        }
      : {}),
  });
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
  for (const tabla of ['audit_log', 'idempotency_keys', 'job_runs', 'appointments', 'escalations', 'messages', 'holds', 'conversations', 'patients']) {
    await admin.unsafe(`delete from motor.${tabla} where client_id = $1`, [CLINICA]);
  }
  await admin`delete from motor.clients where id = ${CLINICA}`;
  await admin`
    insert into motor.clients (id, slug, name, config, config_version)
    values (${CLINICA}, 'clinica-de-pruebas', 'Clínica', '{}'::jsonb, 'test')
  `;
  await admin`
    insert into motor.patients (id, client_id, given_name, phone_e164)
    values (${PACIENTE}, ${CLINICA}, 'Marta', ${TELEFONO})
  `;
  await admin`
    insert into motor.conversations (id, client_id, patient_id)
    values (${CONVERSACION}, ${CLINICA}, ${PACIENTE})
  `;
});

async function crearHueco(
  estado: string,
  desdeHace: number,
  slot: string,
  opciones: { avisado?: boolean; ahora?: Date } = {},
): Promise<string> {
  const ahora = opciones.ahora ?? MEDIODIA;
  const cambiado = new Date(ahora.getTime() - desdeHace * 60_000);
  const avisado = estado === 'pendiente_recepcion' && opciones.avisado !== false ? cambiado.toISOString() : null;
  const filas = await admin`
    insert into motor.holds
      (client_id, patient_id, conversation_id, slot_start, slot_end, service_code, state,
       state_changed_at, reception_notified_at)
    values (${CLINICA}, ${PACIENTE}, ${CONVERSACION}, ${slot},
            ${new Date(new Date(slot).getTime() + 20 * 60_000).toISOString()}, 'laser-axilas',
            ${estado}::motor.hold_state, ${cambiado.toISOString()}, ${avisado})
    returning id
  `;
  return String(filas[0]?.['id']);
}

type Salida = Awaited<ReturnType<typeof caducarRetenciones>>;

function alPaciente(salida: Salida) {
  return salida.aplicados.flatMap((a) => a.efectos).filter((e) => e.tipo === 'mensaje_al_paciente');
}

async function mensajesGuardados(): Promise<string[]> {
  const filas = await admin`
    select body from motor.messages
     where client_id = ${CLINICA} and direction = 'saliente' order by created_at
  `;
  return filas.map((f) => String(f['body']));
}

describe('el mensaje sale resuelto: a quién y qué', () => {
  it('una propuesta que caduca lleva el teléfono del paciente y un texto que dice de qué', async () => {
    await crearHueco('propuesta', 7 * 60, '2026-09-20T09:00:00.000Z');

    const [mensaje] = alPaciente(await caducarRetenciones(deps(), { clientId: CLINICA }));

    expect(mensaje?.destinatarios).toEqual([{ nombre: 'Marta', canal: 'whatsapp', destino: TELEFONO }]);
    expect(mensaje?.texto).toMatch(/láser axilas/);
    // Una propuesta no estaba reservada: no se le dice que «ya no se le guarda».
    expect(mensaje?.texto).not.toMatch(/guard|reserv/i);
  });

  it('y queda registrado en la conversación (regla 6), para que el modelo lo vea si contesta', async () => {
    await crearHueco('propuesta', 7 * 60, '2026-09-20T09:00:00.000Z');

    const [mensaje] = alPaciente(await caducarRetenciones(deps(), { clientId: CLINICA }));

    expect(await mensajesGuardados()).toEqual([mensaje?.texto]);
  });

  it('pendiente de recepción al acabar la jornada: el paciente sabe qué cita y a qué hora', async () => {
    // Avisada a las 12:00; a las 21:30 ya ha acabado la jornada del martes.
    await crearHueco('pendiente_recepcion', 0, '2026-09-20T09:00:00.000Z');
    const noche = new Date('2026-09-15T18:45:00.000Z');

    const salida = await caducarRetenciones(deps(noche), { clientId: CLINICA });

    const [mensaje] = alPaciente(salida);
    expect(mensaje?.destinatarios[0]?.destino).toBe(TELEFONO);
    expect(mensaje?.texto).toMatch(/láser axilas/);
    expect(mensaje?.texto).toMatch(/domingo 20/);
    expect(mensaje?.texto).not.toMatch(/confirmada\b/);
    // Y una persona lo sabe.
    expect(salida.aplicados.flatMap((a) => a.efectos).map((e) => e.tipo)).toContain('escalar_a_humano');
  });
});

describe('un aviso por propuesta, no uno por hueco', () => {
  it('tres propuestas que caducan a la vez: un solo mensaje', async () => {
    for (const dia of ['20', '21', '22']) await crearHueco('propuesta', 7 * 60, `2026-09-${dia}T09:00:00.000Z`);

    const salida = await caducarRetenciones(deps(), { clientId: CLINICA });

    expect(salida.aplicados).toHaveLength(3);
    expect(alPaciente(salida).filter((e) => e.texto !== '')).toHaveLength(1);
    expect(await mensajesGuardados()).toHaveLength(1);
  });

  it('si el lote las parte, avisa la última en caer, no la primera', async () => {
    for (const dia of ['20', '21', '22']) await crearHueco('propuesta', 7 * 60, `2026-09-${dia}T09:00:00.000Z`);

    const enviados: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const salida = await caducarRetenciones(deps(), { clientId: CLINICA, limite: 1 });
      enviados.push(alPaciente(salida).filter((e) => e.texto !== '').length);
    }

    expect(enviados).toEqual([0, 0, 1]);
  });

  it('a quien ya tiene su cita no se le dice «si sigues queriendo cita»', async () => {
    // Eligió una de las tres; las otras dos siguen vivas como alternativa y
    // caducan después.
    await crearHueco('pendiente_recepcion', 60, '2026-09-20T09:00:00.000Z');
    await crearHueco('propuesta', 7 * 60, '2026-09-21T09:00:00.000Z');
    await crearHueco('propuesta', 7 * 60, '2026-09-22T09:00:00.000Z');

    const salida = await caducarRetenciones(deps(), { clientId: CLINICA });

    expect(salida.aplicados.filter((a) => a.hasta === 'caducada')).toHaveLength(2);
    expect(alPaciente(salida)).toEqual([]);
    expect(await mensajesGuardados()).toEqual([]);
  });
});

describe('la franja de contacto', () => {
  it('a las tres de la mañana no le llega nada a nadie', async () => {
    await crearHueco('propuesta', 7 * 60, '2026-09-20T09:00:00.000Z', { ahora: MADRUGADA });

    const salida = await caducarRetenciones(deps(MADRUGADA), { clientId: CLINICA });

    expect(salida.diferidoPorHorario).toBe(true);
    expect(alPaciente(salida)).toEqual([]);
    expect(await mensajesGuardados()).toEqual([]);
  });

  it('salvo quien eligió hace tres minutos en automática: se entera ya, y el texto dice que recepción lo verá al abrir', async () => {
    await crearHueco('retenida', 4, '2026-09-20T09:00:00.000Z', { ahora: MADRUGADA });

    const salida = await caducarRetenciones(deps(MADRUGADA, true), { clientId: CLINICA });

    const [mensaje] = alPaciente(salida);
    expect(mensaje?.destinatarios[0]?.destino).toBe(TELEFONO);
    expect(mensaje?.texto).toMatch(/en cuanto recepción abra/);
    expect(mensaje?.texto).toMatch(/láser axilas/);
  });
});
