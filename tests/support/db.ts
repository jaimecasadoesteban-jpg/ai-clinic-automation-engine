import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

/**
 * Base de datos de pruebas. Si no está, los tests que la usan FALLAN — no se
 * saltan. Un test de aislamiento que se salta solo no vale nada.
 */
function exigir(nombre: string): string {
  const valor = process.env[nombre];
  if (valor === undefined || valor === '') {
    throw new Error(
      `Falta ${nombre}.\n` +
        'Levanta la base de datos de pruebas con `npm run db:test:up` y copia .env.example a .env.',
    );
  }
  return valor;
}

export const ADMIN_URL = exigir('TEST_DATABASE_URL');
export const APP_URL = exigir('TEST_APP_DATABASE_URL');

/** Conexión con privilegios: para migrar y sembrar. Se salta RLS por ser superusuario. */
export function conexionAdmin(): postgres.Sql {
  return postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
}

/**
 * Conexión con el rol real del núcleo: sin BYPASSRLS y sin ser propietario.
 *
 * `max: 1` a propósito en los tests: obliga a que todas las transacciones
 * compartan la misma conexión física, que es el escenario en el que un contexto
 * mal puesto se filtraría de una clínica a la siguiente.
 */
export function conexionApp(): postgres.Sql {
  return postgres(APP_URL, { max: 1, prepare: false, onnotice: () => {} });
}

/** Recrea el esquema entero desde las migraciones. Deja la base determinista. */
export async function prepararBaseDeDatos(admin: postgres.Sql): Promise<void> {
  await admin`drop schema if exists motor cascade`;
  await admin`drop schema if exists drizzle cascade`;
  await migrate(drizzle(admin), { migrationsFolder: './src/db/migrations' });

  // El rol se crea sin login en la migración: las credenciales son cosa de cada
  // entorno, no del repositorio. En la base de pruebas se le da acceso local,
  // que no necesita contraseña porque el contenedor usa autenticación `trust`.
  await admin`alter role motor_app login`;
}
