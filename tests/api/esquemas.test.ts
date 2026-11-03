import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { buildServer, type App } from '../../src/api/server.js';

/**
 * Comprueba que el proveedor de tipos de Zod está enchufado de verdad: que
 * valida la entrada y también la salida. Las rutas de aquí son de prueba y no
 * existen en el servidor real.
 */
describe('validación por esquema en los endpoints', () => {
  let app: App;

  beforeAll(async () => {
    app = await buildServer({ logLevel: 'silent' });

    app.post(
      '/_prueba/entrada',
      { schema: { body: z.object({ nombre: z.string().min(1) }) } },
      async (request) => ({ recibido: request.body.nombre }),
    );

    // El esquema exige 5 caracteres y el handler devuelve 2: el tipo cuadra,
    // pero el valor no. Así se simula un fallo nuestro sin recurrir a un cast.
    app.get(
      '/_prueba/salida',
      { schema: { response: { 200: z.object({ valor: z.string().min(5) }) } } },
      async () => ({ valor: 'ab' }),
    );

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rechaza con 400 una entrada que no cumple su esquema', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/_prueba/entrada',
      payload: { nombre: '' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'validation_error' });
  });

  it('acepta una entrada válida', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/_prueba/entrada',
      payload: { nombre: 'Ana' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ recibido: 'Ana' });
  });

  it('corta con 500 una salida que no cumple su esquema, en vez de enviarla', async () => {
    const response = await app.inject({ method: 'GET', url: '/_prueba/salida' });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: 'response_schema_error' });
  });
});
