import { existsSync } from 'node:fs';

import { defineConfig } from 'drizzle-kit';

// drizzle-kit corre fuera del proceso de la app, así que carga el .env por su cuenta.
if (existsSync('.env')) process.loadEnvFile('.env');

// Las migraciones NO pasan por el pooler de transacciones: hacen DDL y toman
// locks de sesión, que en modo transacción no sobreviven. Van por la conexión
// directa (5432). DATABASE_URL (pooler, 6543) es sólo para el runtime.
const databaseUrl = process.env['DIRECT_URL'];
if (databaseUrl === undefined || databaseUrl === '') {
  throw new Error(
    'Falta DIRECT_URL (conexión directa, puerto 5432). Copia .env.example a .env y rellénalo.',
  );
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  schemaFilter: ['motor'],
  dbCredentials: { url: databaseUrl },
  strict: true,
  verbose: true,
});
