import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { sql as sqlRaw } from 'drizzle-orm';

import { createCore, type Core } from '../../src/db/client.js';
import {
  consolidarPeriodo,
  mesAnterior,
  PeriodoInvalidoError,
} from '../../src/service/consolidacion.js';
import { generarInforme } from '../../src/service/informe.js';
import { AgendaFalsa, dependenciasDePrueba } from '../support/fakes.js';
import { APP_URL, conexionAdmin, prepararBaseDeDatos } from '../support/db.js';

/**
 * Consolidar primero, borrar después.
 *
 * La purga de los 24 meses sólo borra el detalle de periodos ya consolidados en
 * `period_metrics`. Durante tres fases no hubo nada que consolidara, así que la
 * purga no borraba nada: el lado seguro, pero el detalle de salud se acumulaba
 * sin fecha de caducidad real. Estos tests comprueban la cadena entera, no cada
 * mitad por su lado — que era exactamente el hueco.
 */

const CLINICA = 'dddd1111-dddd-4ddd-8ddd-dddd11110000';

const admin = conexionAdmin();
let core: Core;

function deps(ahora = new Date('2026-09-14T10:00:00.000Z')) {
  return dependenciasDePrueba({ core, agenda: new AgendaFalsa(), reloj: () => ahora });
}

/** Una conversación de hace 30 meses, con su cita y su hueco. */
async function sembrarAntiguo(): Promise<{ conversacion: string; periodo: string }> {
  const pacientes = await admin`
    insert into motor.patients (client_id, given_name, phone_e164)
    values (${CLINICA}, 'Antigua', '+34600999888') returning id
  `;
  const paciente = String(pacientes[0]?.['id']);

  const conversaciones = await admin.unsafe(
    `insert into motor.conversations (client_id, patient_id, created_at)
     values ($1, $2, now() - interval '30 months')
     returning id, to_char(created_at, 'YYYY-MM') as periodo`,
    [CLINICA, paciente],
  );
  const conversacion = String(conversaciones[0]?.['id']);
  const periodo = String(conversaciones[0]?.['periodo']);

  await admin`
    insert into motor.messages (client_id, conversation_id, direction, body)
    values (${CLINICA}, ${conversacion}, 'entrante', 'hola')
  `;
  const huecos = await admin.unsafe(
    `insert into motor.holds
       (client_id, conversation_id, patient_id, service_code, slot_start, slot_end, rank, state, created_at)
     values ($1, $2, $3, 'laser-axilas',
             now() - interval '30 months', now() - interval '30 months' + interval '20 minutes',
             1, 'confirmada', now() - interval '30 months')
     returning id`,
    [CLINICA, conversacion, paciente],
  );
  await admin.unsafe(
    `insert into motor.appointments
       (client_id, conversation_id, patient_id, hold_id, service_code, slot_start, slot_end,
        counts_as_generated, outcome, created_at)
     values ($1, $2, $3, $4, 'laser-axilas',
             now() - interval '30 months', now() - interval '30 months' + interval '20 minutes',
             true, 'asistida', now() - interval '30 months')`,
    [CLINICA, conversacion, paciente, String(huecos[0]?.['id'])],
  );

  return { conversacion, periodo };
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
    'period_metrics',
    'suppression',
    'patients',
  ]) {
    await admin.unsafe(`delete from motor.${tabla} where client_id = $1`, [CLINICA]);
  }
  await admin`delete from motor.clients where id = ${CLINICA}`;
  await admin`
    insert into motor.clients (id, slug, name, config, config_version)
    values (${CLINICA}, 'clinica-de-pruebas', 'Clínica Consolidación', '{}'::jsonb, 'test')
  `;
});

describe('la consolidación cuenta lo que hay que facturar', () => {
  it('deja las cifras del periodo y la marca de consolidado', async () => {
    const { periodo } = await sembrarAntiguo();

    const salida = await consolidarPeriodo(deps(), { clientId: CLINICA, periodo });

    expect(salida.citasGeneradas).toBe(1);
    expect(salida.conversaciones).toBe(1);
    expect(salida.huecosPropuestos).toBe(1);
    expect(salida.noShows).toBe(0);

    const filas = await admin`
      select consolidated_at from motor.period_metrics
       where client_id = ${CLINICA} and period = ${periodo}
    `;
    expect(filas[0]?.['consolidated_at']).not.toBeNull();
  });

  it('es idempotente: consolidar dos veces no duplica ni cambia las cifras', async () => {
    const { periodo } = await sembrarAntiguo();

    const primera = await consolidarPeriodo(deps(), { clientId: CLINICA, periodo });
    const segunda = await consolidarPeriodo(deps(), { clientId: CLINICA, periodo });

    expect(segunda).toEqual(primera);
    const filas = await admin`
      select count(*)::int as n from motor.period_metrics where client_id = ${CLINICA}
    `;
    expect(filas[0]?.['n']).toBe(1);
  });

  it('sin periodo consolida el mes anterior', async () => {
    const salida = await consolidarPeriodo(deps(new Date('2026-03-04T00:00:00.000Z')), {
      clientId: CLINICA,
    });

    expect(salida.periodo).toBe('2026-02');
  });

  it('mesAnterior cruza bien el cambio de año', () => {
    expect(mesAnterior(new Date('2026-01-15T00:00:00.000Z'))).toBe('2025-12');
    expect(mesAnterior(new Date('2026-12-31T23:00:00.000Z'))).toBe('2026-11');
  });

  it('un periodo mal escrito es un 400 legible, no un error de Postgres', async () => {
    await expect(
      consolidarPeriodo(deps(), { clientId: CLINICA, periodo: '2026-13' }),
    ).rejects.toBeInstanceOf(PeriodoInvalidoError);
    await expect(
      consolidarPeriodo(deps(), { clientId: CLINICA, periodo: "2026-01'; drop table x --" }),
    ).rejects.toBeInstanceOf(PeriodoInvalidoError);
  });
});

describe('la consolidación y el informe cuentan lo mismo', () => {
  /**
   * **Son dos cálculos distintos del mismo dato.** `consolidar_periodo` cuenta en
   * SQL dentro de una función; `generarInforme` cuenta con otras consultas desde
   * el servicio. Si divergen, la factura y el informe dirán cosas distintas y lo
   * descubriremos discutiendo con un cliente, que es el peor sitio.
   *
   * Este test los enfrenta sobre los mismos datos. Si algún día hay que
   * cambiarlos, hay que cambiar los dos a la vez o esto salta.
   */
  it('citas generadas, huecos propuestos, conversaciones y no-shows coinciden', async () => {
    const { periodo } = await sembrarAntiguo();
    // Un segundo paciente con una cita no asistida, para que las cifras no sean
    // todas uno y una coincidencia trivial pase por acierto.
    const otros = await admin`
      insert into motor.patients (client_id, given_name, phone_e164)
      values (${CLINICA}, 'Otra', '+34600111000') returning id
    `;
    const otroPaciente = String(otros[0]?.['id']);
    const conv = await admin.unsafe(
      `insert into motor.conversations (client_id, patient_id, created_at)
       values ($1, $2, now() - interval '30 months') returning id`,
      [CLINICA, otroPaciente],
    );
    const otraConversacion = String(conv[0]?.['id']);
    const hueco = await admin.unsafe(
      `insert into motor.holds
         (client_id, conversation_id, patient_id, service_code, slot_start, slot_end, rank, state, created_at)
       values ($1, $2, $3, 'laser-axilas',
               now() - interval '30 months' + interval '2 hours',
               now() - interval '30 months' + interval '2 hours 20 minutes',
               1, 'confirmada', now() - interval '30 months')
       returning id`,
      [CLINICA, otraConversacion, otroPaciente],
    );
    await admin.unsafe(
      `insert into motor.appointments
         (client_id, conversation_id, patient_id, hold_id, service_code, slot_start, slot_end,
          counts_as_generated, outcome, created_at)
       values ($1, $2, $3, $4, 'laser-axilas',
               now() - interval '30 months' + interval '2 hours',
               now() - interval '30 months' + interval '2 hours 20 minutes',
               false, 'no_asistida', now() - interval '30 months')`,
      [CLINICA, otraConversacion, otroPaciente, String(hueco[0]?.['id'])],
    );

    const consolidado = await consolidarPeriodo(deps(), { clientId: CLINICA, periodo });

    // El informe, sobre el mismo mes natural.
    const [anio, mes] = periodo.split('-').map(Number);
    const desde = `${periodo}-01`;
    const finDeMes = new Date(Date.UTC(anio!, mes!, 0)).getUTCDate();
    const hasta = `${periodo}-${String(finDeMes).padStart(2, '0')}`;
    const informe = await generarInforme(deps(), { clientId: CLINICA, desde, hasta });

    expect(consolidado.citasGeneradas).toBe(informe.citasGeneradas);
    expect(consolidado.huecosPropuestos).toBe(informe.huecosPropuestos);
    expect(consolidado.conversaciones).toBe(informe.conversaciones);
    expect(consolidado.noShows).toBe(informe.noShows);

    // Y las cifras no son todas iguales: si lo fueran, coincidir no probaría nada.
    expect(consolidado.citasGeneradas).toBe(1);
    expect(consolidado.noShows).toBe(1);
    expect(consolidado.huecosPropuestos).toBe(2);
    expect(consolidado.conversaciones).toBe(2);
  });
});

describe('consolidar primero, borrar después — la cadena entera', () => {
  it('SIN consolidar, la purga no borra el detalle de 30 meses', async () => {
    const { conversacion } = await sembrarAntiguo();

    await admin`select * from motor.purge_expired()`;

    const quedan = await admin`
      select count(*)::int as n from motor.conversations where id = ${conversacion}
    `;
    // Borrarlo sería destruir la base de una factura ya emitida.
    expect(quedan[0]?.['n']).toBe(1);
  });

  it('CONSOLIDANDO con el servicio real, la purga sí borra y el agregado sobrevive', async () => {
    const { conversacion, periodo } = await sembrarAntiguo();

    // Ésta es la pieza que faltaba: sin ella los dos lados estaban bien y la
    // cadena no funcionaba, y ningún test lo veía porque el otro se insertaba
    // la fila de `period_metrics` a mano.
    await consolidarPeriodo(deps(), { clientId: CLINICA, periodo });
    await admin`select * from motor.purge_expired()`;

    const conversaciones = await admin`
      select count(*)::int as n from motor.conversations where id = ${conversacion}
    `;
    const mensajes = await admin`
      select count(*)::int as n from motor.messages where conversation_id = ${conversacion}
    `;
    const citas = await admin`
      select count(*)::int as n from motor.appointments where conversation_id = ${conversacion}
    `;
    expect(conversaciones[0]?.['n']).toBe(0);
    expect(mensajes[0]?.['n']).toBe(0);
    expect(citas[0]?.['n']).toBe(0);

    // Lo que sobrevive: cifras por periodo, sin patient_id.
    const agregado = await admin`
      select citas_generadas from motor.period_metrics
       where client_id = ${CLINICA} and period = ${periodo}
    `;
    expect(Number(agregado[0]?.['citas_generadas'])).toBe(1);

    const columnas = await admin`
      select count(*)::int as n from information_schema.columns
       where table_schema = 'motor' and table_name = 'period_metrics'
         and column_name = 'patient_id'
    `;
    expect(columnas[0]?.['n']).toBe(0);
  });

  it('no se puede consolidar la clínica de otro: lo impide RLS, no un if', async () => {
    const otra = 'dddd2222-dddd-4ddd-8ddd-dddd22220000';
    await admin`delete from motor.clients where id = ${otra}`;
    await admin`
      insert into motor.clients (id, slug, name, config, config_version)
      values (${otra}, 'clinica-ajena', 'Ajena', '{}'::jsonb, 'test')
    `;

    // El contexto es CLINICA y el objetivo es otra: la función es SECURITY
    // INVOKER, así que el WITH CHECK de period_metrics lo rechaza en la base.
    await expect(
      core.withClient(CLINICA, async (tx) =>
        tx.execute(sqlRaw`select * from motor.consolidar_periodo(${otra}::uuid, '2026-01')`),
      ),
    ).rejects.toThrow();

    const filas = await admin`
      select count(*)::int as n from motor.period_metrics where client_id = ${otra}
    `;
    expect(filas[0]?.['n']).toBe(0);
    await admin`delete from motor.clients where id = ${otra}`;
  });

  it('el paciente NO se borra a los 24 meses: eso es el protocolo de salida', async () => {
    const { periodo } = await sembrarAntiguo();

    await consolidarPeriodo(deps(), { clientId: CLINICA, periodo });
    await admin`select * from motor.purge_expired()`;

    const pacientes = await admin`
      select count(*)::int as n from motor.patients where client_id = ${CLINICA}
    `;
    expect(pacientes[0]?.['n']).toBe(1);
  });
});
