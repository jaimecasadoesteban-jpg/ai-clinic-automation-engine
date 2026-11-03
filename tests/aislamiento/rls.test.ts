import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { conexionAdmin, conexionApp, prepararBaseDeDatos } from '../support/db.js';

/**
 * Aislamiento entre clínicas. La regla 1 de docs/DESIGN_RULES.md dice que la fuga de datos
 * entre clientes es el peor fallo posible del sistema; esto es lo que impide
 * que ocurra sin que nadie se entere.
 *
 * No se puede probar contra mocks: hace falta Postgres de verdad, con roles y
 * con RLS. Si no hay base de datos, este fichero revienta a propósito — un test
 * de aislamiento que se salta solo no vale nada.
 */

/** Las once tablas de dominio más la de idempotencia. */
const TABLAS_ESPERADAS = [
  'appointments',
  'audit_log',
  'clients',
  'conversations',
  'escalations',
  'holds',
  'idempotency_keys',
  'inbox',
  'job_runs',
  'messages',
  'outbox',
  'patients',
  'period_metrics',
  'rights_requests',
  'suppression',
  'wave_recipients',
  'waves',
] as const;

const CLINICA_A = '11111111-1111-4111-8111-111111111111';
const CLINICA_B = '22222222-2222-4222-8222-222222222222';
const PACIENTE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PACIENTE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const admin = conexionAdmin();
const app = conexionApp();

/** Abre una transacción con el contexto de cliente establecido, como hace el núcleo. */
async function conCliente<T>(
  clientId: string,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return app.begin(async (tx) => {
    await tx`select set_config('app.client_id', ${clientId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

beforeAll(async () => {
  await prepararBaseDeDatos(admin);

  await admin`
    insert into motor.clients (id, slug, name, config, config_version)
    values
      (${CLINICA_A}, 'clinica-a', 'Clínica A', '{}'::jsonb, 'test'),
      (${CLINICA_B}, 'clinica-b', 'Clínica B', '{}'::jsonb, 'test')
  `;
  await admin`
    insert into motor.patients (id, client_id, given_name, phone_e164)
    values
      (${PACIENTE_A}, ${CLINICA_A}, 'Ana', '+34600000001'),
      (${PACIENTE_B}, ${CLINICA_B}, 'Berta', '+34600000002')
  `;
}, 60_000);

afterAll(async () => {
  await app.end();
  await admin.end();
});

describe('aislamiento entre clínicas', () => {
  it('desde el contexto de A no se lee una fila de B ni pidiéndola por su id exacto', async () => {
    const filas = await conCliente(CLINICA_A, async (tx) => {
      return tx`select id from motor.patients where id = ${PACIENTE_B}`;
    });

    expect(filas).toHaveLength(0);
  });

  it('desde el contexto de A sí se lee lo propio', async () => {
    const filas = await conCliente(CLINICA_A, async (tx) => {
      return tx`select given_name from motor.patients where id = ${PACIENTE_A}`;
    });

    expect(filas).toHaveLength(1);
    expect(filas[0]?.['given_name']).toBe('Ana');
  });

  it('sin contexto, la consulta FALLA — no devuelve cero filas', async () => {
    // El matiz es el que importa: cero filas se parece demasiado a «esta clínica
    // no tiene pacientes» y el código de arriba seguiría adelante tan tranquilo.
    const consulta = app.begin(async (tx) => {
      return tx`select id from motor.patients`;
    });

    await expect(consulta).rejects.toMatchObject({ code: '42501' });
  });

  it('el contexto no sobrevive a la transacción siguiente en la misma conexión', async () => {
    await conCliente(CLINICA_A, async (tx) => tx`select 1`);

    // Misma conexión física (max: 1), transacción nueva y sin contexto: si el
    // `set_config` se hubiera hecho de sesión en vez de local, esta consulta
    // devolvería datos de la clínica A a quien no le corresponden.
    const consulta = app.begin(async (tx) => tx`select id from motor.patients`);

    await expect(consulta).rejects.toMatchObject({ code: '42501' });
  });

  it('desde el contexto de A no se puede insertar un paciente con el client_id de B', async () => {
    const insercion = conCliente(CLINICA_A, async (tx) => {
      return tx`
        insert into motor.patients (client_id, given_name, phone_e164)
        values (${CLINICA_B}, 'Intrusa', '+34600000003')
      `;
    });

    // Rechazada dos veces, y por eso aquí valen dos códigos: el trigger que
    // numera al paciente no ve la clínica B bajo el contexto de A y corta antes
    // (23503); si ese trigger no existiera, el WITH CHECK de la política la
    // pararía igual (42501). El caso de abajo comprueba el WITH CHECK a solas.
    const error: unknown = await insercion.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(['42501', '23503']).toContain((error as { code?: string }).code);
  });

  it('el WITH CHECK de la política rechaza escribir con el client_id de otro', async () => {
    // `conversations` no tiene triggers que puedan adelantarse a la política,
    // así que aquí el 42501 sólo puede venir del WITH CHECK.
    const insercion = conCliente(CLINICA_A, async (tx) => {
      return tx`
        insert into motor.conversations (client_id, patient_id)
        values (${CLINICA_B}, ${PACIENTE_B})
      `;
    });

    await expect(insercion).rejects.toMatchObject({ code: '42501' });
  });

  it('desde el contexto de A no se puede mover una fila propia a B', async () => {
    const actualizacion = conCliente(CLINICA_A, async (tx) => {
      return tx`
        update motor.patients set client_id = ${CLINICA_B} where id = ${PACIENTE_A}
      `;
    });

    await expect(actualizacion).rejects.toMatchObject({ code: '42501' });
  });

  it('desde el contexto de A no se puede borrar nada de B', async () => {
    const borrado = conCliente(CLINICA_A, async (tx) => {
      return tx`delete from motor.patients where id = ${PACIENTE_B}`;
    });

    // El rol no tiene DELETE en absoluto: 42501 tanto por permiso como por RLS.
    await expect(borrado).rejects.toMatchObject({ code: '42501' });
  });
});

describe('el rol de la aplicación no puede saltarse RLS', () => {
  it('motor_app no tiene BYPASSRLS ni es superusuario', async () => {
    const filas = await admin`
      select rolbypassrls, rolsuper from pg_roles where rolname = 'motor_app'
    `;

    expect(filas).toHaveLength(1);
    expect(filas[0]?.['rolbypassrls']).toBe(false);
    expect(filas[0]?.['rolsuper']).toBe(false);
  });

  it('motor_app no es propietario de ninguna tabla del esquema motor', async () => {
    const filas = await admin`
      select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'motor'
        and c.relkind = 'r'
        and pg_get_userbyid(c.relowner) = 'motor_app'
    `;

    expect(filas.map((f) => f['relname'])).toEqual([]);
  });
});

/**
 * Éste es el que protege de aquí a seis meses: no comprueba las tablas de hoy,
 * comprueba que ninguna tabla futura pueda entrar sin RLS ni sin client_id.
 */
describe('ninguna tabla puede quedarse fuera de RLS', () => {
  it('el esquema motor contiene exactamente las tablas esperadas', async () => {
    const filas = await admin`
      select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'motor' and c.relkind = 'r'
      order by c.relname
    `;

    // Si esto falla es que alguien añadió o quitó una tabla. Que venga aquí y
    // confirme a conciencia que la nueva cumple todo lo de abajo.
    expect(filas.map((f) => f['relname'])).toEqual([...TABLAS_ESPERADAS]);
  });

  it('todas las tablas tienen RLS activo y forzado', async () => {
    const filas = await admin`
      select c.relname, c.relrowsecurity, c.relforcerowsecurity
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'motor' and c.relkind = 'r'
      order by c.relname
    `;

    const sinRls = filas
      .filter((f) => f['relrowsecurity'] !== true || f['relforcerowsecurity'] !== true)
      .map((f) => f['relname']);

    expect(sinRls).toEqual([]);
  });

  it('todas las tablas tienen al menos una política', async () => {
    const filas = await admin`
      select c.relname, count(p.polname) as politicas
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_policy p on p.polrelid = c.oid
      where n.nspname = 'motor' and c.relkind = 'r'
      group by c.relname
      order by c.relname
    `;

    const sinPolitica = filas.filter((f) => Number(f['politicas']) === 0).map((f) => f['relname']);

    expect(sinPolitica).toEqual([]);
  });

  it('todas las tablas llevan client_id, salvo clients que lleva el suyo en el id', async () => {
    const filas = await admin`
      select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'motor'
        and c.relkind = 'r'
        and c.relname <> 'clients'
        and not exists (
          select 1 from pg_attribute a
          where a.attrelid = c.oid and a.attname = 'client_id' and a.attnum > 0 and not a.attisdropped
        )
      order by c.relname
    `;

    expect(filas.map((f) => f['relname'])).toEqual([]);
  });
});
