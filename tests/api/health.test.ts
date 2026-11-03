import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer, type App } from '../../src/api/server.js';
import { healthResponseSchema } from '../../src/api/routes/health.js';

describe('GET /salud', () => {
  let app: App;

  beforeAll(async () => {
    app = await buildServer({ logLevel: 'silent' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('responde 200 con un cuerpo que cumple su esquema', async () => {
    const response = await app.inject({ method: 'GET', url: '/salud' });

    expect(response.statusCode).toBe(200);

    const body = healthResponseSchema.parse(response.json());
    expect(body.estado).toBe('ok');
    expect(body.servicio).toBe('motor-de-citas');
    expect(Date.parse(body.hora)).not.toBeNaN();
  });

  it('no exige base de datos para responder', async () => {
    // El andamiaje se comprueba sin Postgres levantado: si esto empieza a
    // fallar es que alguien ha metido una dependencia de datos en /salud.
    const response = await app.inject({ method: 'GET', url: '/salud' });
    expect(response.statusCode).toBe(200);
  });

  it('una ruta inexistente responde 404 con cuerpo, no en silencio', async () => {
    const response = await app.inject({ method: 'GET', url: '/no-existe' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'not_found' });
  });
});
