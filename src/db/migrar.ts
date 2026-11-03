import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

/**
 * Aplicar migraciones. **Comando aparte, no arranque del servidor.**
 *
 * Migrar al arrancar es cómodo y tiene dos fallos que salen caros:
 *
 * 1. **Varias réplicas arrancando a la vez** se pisan. Aquí hay `CREATE TYPE` y
 *    `ALTER TABLE`, no sólo inserciones idempotentes.
 * 2. **Un reinicio en bucle** convierte un error de migración en un ciclo que
 *    machaca la base cada pocos segundos, justo cuando alguien intenta mirar qué
 *    pasa.
 *
 * Así que esto se ejecuta a mano, una vez, antes de desplegar:
 *
 * ```
 * docker run --rm -e DIRECT_URL=... <imagen> node dist/db/migrar.js
 * ```
 *
 * Usa `drizzle-orm`, que es dependencia de producción, y no `drizzle-kit`, que
 * es de desarrollo: la imagen final no lleva herramientas de desarrollo y aun
 * así puede migrarse a sí misma.
 *
 * **Va por `DIRECT_URL`, no por el pooler.** El pooler de transacciones de
 * Supabase no admite sentencias preparadas ni mantiene estado de sesión, y una
 * migración necesita las dos cosas.
 */

/** Clave del cerrojo de sesión. Arbitraria y fija: sólo tiene que ser la misma. */
const CERROJO = 918_273_645;

async function main(): Promise<void> {
  const url = process.env['DIRECT_URL'];
  if (url === undefined || url === '') {
    throw new Error(
      'Falta DIRECT_URL.\n' +
        'Las migraciones NO van por el pooler: necesitan la conexión directa (puerto 5432).',
    );
  }

  // `max: 1` y sin prepared statements: una sola conexión, secuencial y sin
  // estado que el pooler pueda perder si alguien apunta esto al sitio que no es.
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });

  try {
    /**
     * Cerrojo de aviso: si dos despliegues lanzan esto a la vez, el segundo
     * espera al primero en vez de intentar crear los mismos tipos. Es la misma
     * idea que el resto del sistema — la protección la impone la base, no la
     * disciplina de quien despliega.
     */
    await sql`select pg_advisory_lock(${CERROJO})`;
    await migrate(drizzle(sql), { migrationsFolder: './src/db/migrations' });
    console.log('migraciones aplicadas');
  } finally {
    await sql`select pg_advisory_unlock(${CERROJO})`.catch(() => undefined);
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
