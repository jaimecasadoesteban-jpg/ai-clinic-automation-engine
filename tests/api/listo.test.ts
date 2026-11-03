import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer, type App } from '../../src/api/server.js';
import { createCore, type Core } from '../../src/db/client.js';
import { AgendaFalsa, dependenciasDePrueba } from '../support/fakes.js';
import { APP_URL, conexionAdmin, prepararBaseDeDatos } from '../support/db.js';

/**
 * Vida y preparación no son lo mismo.
 *
 * `/salud` dice que el proceso responde y no toca la base a propósito: es lo que
 * mira el `HEALTHCHECK` del contenedor, porque **reiniciar un contenedor porque
 * Postgres está caído no arregla nada** — vuelve, tampoco la encuentra, y añade
 * una tormenta de arranques a un problema que no es suyo.
 *
 * `/listo` sí la toca y devuelve 503 cuando no puede trabajar: es lo que debe
 * mirar el balanceador y el monitor externo.
 *
 * Los dos sin token: un supervisor no debe llevar la llave del sistema, y meter
 * el token en un Dockerfile para que pase el healthcheck es peor que no tenerlo.
 */

const admin = conexionAdmin();
let core: Core;
let app: App;

beforeAll(async () => {
  await prepararBaseDeDatos(admin);
  core = createCore(APP_URL);
  app = await buildServer({
    logLevel: 'silent',
    token: 'token-de-prueba-suficientemente-largo',
    deps: dependenciasDePrueba({ core, agenda: new AgendaFalsa(), reloj: () => new Date() }),
  });
}, 60_000);

afterAll(async () => {
  await app.close();
  await core.close();
  await admin.end();
});

describe('vida y preparación', () => {
  it('/salud responde sin token y sin tocar la base', async () => {
    const r = await app.inject({ method: 'GET', url: '/salud' });

    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ estado: 'ok' });
  });

  it('/listo responde sin token y dice que la base contesta', async () => {
    const r = await app.inject({ method: 'GET', url: '/listo' });

    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ estado: 'listo', base: 'ok' });
  });

  it('con la base inalcanzable, /listo devuelve 503 y NO se queda colgado', async () => {
    const roto = await buildServer({
      logLevel: 'silent',
      token: 'token-de-prueba-suficientemente-largo',
      deps: dependenciasDePrueba({
        core: { ...core, alcanzable: async () => false },
        agenda: new AgendaFalsa(),
        reloj: () => new Date(),
      }),
    });

    try {
      const t0 = Date.now();
      const r = await roto.inject({ method: 'GET', url: '/listo' });

      // Se colgaba: `await respuesta.code(503)` espera a haber enviado la
      // respuesta antes de devolver el cuerpo, y el balanceador se cuelga con él.
      expect(Date.now() - t0).toBeLessThan(3_000);
      expect(r.statusCode).toBe(503);
      expect(r.json()).toMatchObject({ estado: 'no_listo', base: 'inalcanzable' });
    } finally {
      await roto.close();
    }
  });

  it('los endpoints de trabajo SÍ siguen exigiendo token', async () => {
    const r = await app.inject({ method: 'POST', url: '/mensaje-entrante', payload: {} });

    expect(r.statusCode).toBe(401);
  });
});
