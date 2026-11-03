import { existsSync } from 'node:fs';

import { defineConfig } from 'vitest/config';

// Los tests de aislamiento necesitan TEST_DATABASE_URL y TEST_APP_DATABASE_URL.
if (existsSync('.env')) process.loadEnvFile('.env');

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
    // Los tests de aislamiento recrean el esquema entero: no pueden correr en
    // paralelo con otro fichero que toque la misma base de datos.
    fileParallelism: false,
  },
});
