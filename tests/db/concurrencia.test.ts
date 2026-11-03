import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { conexionAdmin, conexionApp, prepararBaseDeDatos } from '../support/db.js';

/**
 * La colisión de dos retenciones concurrentes sobre el mismo hueco.
 *
 * Lo que se prueba aquí es que la protección real es una restricción de
 * integridad y NO una comprobación en la aplicación: las dos transacciones
 * llegan a la vez, ninguna consulta antes si el hueco está libre, y aun así
 * sólo una gana.
 *
 * Verificado por sabotaje: quitando `holds_slot_unico` estos tests fallan.
 */

const CLINICA = 'cccc0000-cccc-4ccc-8ccc-cccc00000000';
const PACIENTE_1 = 'cccc1111-cccc-4ccc-8ccc-cccc11111111';
const PACIENTE_2 = 'cccc2222-cccc-4ccc-8ccc-cccc22222222';
const CONVERSACION_1 = 'cccc3333-cccc-4ccc-8ccc-cccc33333333';
const CONVERSACION_2 = 'cccc4444-cccc-4ccc-8ccc-cccc44444444';

const admin = conexionAdmin();
// Dos conexiones independientes: hacen falta dos transacciones abiertas a la vez.
const app1 = conexionApp();
const app2 = conexionApp();

function esperar(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Abre transacción y fija el contexto, como hace el núcleo. */
async function abrir(conexion: postgres.Sql): Promise<postgres.ReservedSql> {
  const c = await conexion.reserve();
  await c`begin`;
  await c`select set_config('app.client_id', ${CLINICA}, true)`;
  return c;
}

async function retener(
  c: postgres.ReservedSql,
  paciente: string,
  conversacion: string,
  hora: string,
): Promise<unknown> {
  return c`
    insert into motor.holds (client_id, patient_id, conversation_id, slot_start, slot_end, service_code, state)
    values (${CLINICA}, ${paciente}, ${conversacion}, ${hora}, ${hora}, 'limpieza', 'retenida')
  `;
}

beforeAll(async () => {
  await prepararBaseDeDatos(admin);

  await admin`
    insert into motor.clients (id, slug, name, config, config_version)
    values (${CLINICA}, 'clinica-concurrente', 'Clínica Concurrente', '{}'::jsonb, 'test')
  `;
  await admin`
    insert into motor.patients (id, client_id, given_name, phone_e164)
    values
      (${PACIENTE_1}, ${CLINICA}, 'Uno', '+34600000031'),
      (${PACIENTE_2}, ${CLINICA}, 'Dos', '+34600000032')
  `;
  await admin`
    insert into motor.conversations (id, client_id, patient_id)
    values (${CONVERSACION_1}, ${CLINICA}, ${PACIENTE_1}), (${CONVERSACION_2}, ${CLINICA}, ${PACIENTE_2})
  `;
}, 60_000);

afterAll(async () => {
  await app1.end();
  await app2.end();
  await admin.end();
});

describe('dos retenciones concurrentes sobre el mismo hueco', () => {
  it('la segunda falla en Postgres, no en un if de la aplicación', async () => {
    const hora = '2026-10-01T09:00:00.000Z';
    const c1 = await abrir(app1);
    const c2 = await abrir(app2);

    try {
      await retener(c1, PACIENTE_1, CONVERSACION_1, hora);

      // La segunda no comprueba nada antes: inserta directamente. Se queda
      // esperando a que la primera resuelva, porque el índice único se lo impone.
      const segunda = retener(c2, PACIENTE_2, CONVERSACION_2, hora);
      await esperar(200);

      await c1`commit`;

      await expect(segunda).rejects.toMatchObject({
        code: '23505',
        constraint_name: 'holds_slot_unico',
      });
    } finally {
      await c2`rollback`.catch(() => undefined);
      c1.release();
      c2.release();
    }

    const filas = await admin`
      select count(*)::int as n from motor.holds
      where client_id = ${CLINICA} and slot_start = ${hora} and state = 'retenida'
    `;
    // Una y sólo una. Esto es lo que impide la doble reserva.
    expect(filas[0]?.['n']).toBe(1);
  });

  it('si la primera aborta, la segunda gana el hueco', async () => {
    const hora = '2026-10-01T10:00:00.000Z';
    const c1 = await abrir(app1);
    const c2 = await abrir(app2);

    try {
      await retener(c1, PACIENTE_1, CONVERSACION_1, hora);
      const segunda = retener(c2, PACIENTE_2, CONVERSACION_2, hora);
      await esperar(200);

      await c1`rollback`;

      // La retención que quedó esperando sale adelante: el hueco nunca estuvo
      // realmente ocupado. No se pierde disponibilidad por una carrera.
      await expect(segunda).resolves.not.toThrow();
      await c2`commit`;
    } finally {
      c1.release();
      c2.release();
    }

    const filas = await admin`
      select patient_id from motor.holds
      where client_id = ${CLINICA} and slot_start = ${hora} and state = 'retenida'
    `;
    expect(filas).toHaveLength(1);
    expect(filas[0]?.['patient_id']).toBe(PACIENTE_2);
  });

  it('dos propuestas concurrentes sobre el mismo hueco conviven', async () => {
    const hora = '2026-10-01T11:00:00.000Z';
    const c1 = await abrir(app1);
    const c2 = await abrir(app2);

    try {
      await c1`
        insert into motor.holds (client_id, patient_id, conversation_id, slot_start, slot_end, service_code, state)
        values (${CLINICA}, ${PACIENTE_1}, ${CONVERSACION_1}, ${hora}, ${hora}, 'limpieza', 'propuesta')
      `;
      await c2`
        insert into motor.holds (client_id, patient_id, conversation_id, slot_start, slot_end, service_code, state)
        values (${CLINICA}, ${PACIENTE_2}, ${CONVERSACION_2}, ${hora}, ${hora}, 'limpieza', 'propuesta')
      `;
      await c1`commit`;
      await c2`commit`;
    } finally {
      c1.release();
      c2.release();
    }

    const filas = await admin`
      select count(*)::int as n from motor.holds
      where client_id = ${CLINICA} and slot_start = ${hora}
    `;
    expect(filas[0]?.['n']).toBe(2);
  });
});
