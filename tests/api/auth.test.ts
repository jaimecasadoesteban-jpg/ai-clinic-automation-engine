import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer, type App } from '../../src/api/server.js';

/**
 * El núcleo no se expone a internet, pero eso es una propiedad del despliegue.
 * Una regla de red la puede cambiar alguien sin darse cuenta y la única barrera
 * desaparecería sin que nada fallara.
 */

const TOKEN = 'token-de-pruebas-lo-bastante-largo';

describe('autenticación', () => {
  let app: App;

  beforeAll(async () => {
    app = await buildServer({ logLevel: 'silent', token: TOKEN });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('/salud responde sin credenciales: es el comprobador de vida', async () => {
    const respuesta = await app.inject({ method: 'GET', url: '/salud' });

    expect(respuesta.statusCode).toBe(200);
  });

  it('una ruta protegida sin cabecera devuelve 401 con cuerpo, no en silencio', async () => {
    const respuesta = await app.inject({ method: 'POST', url: '/mensaje-entrante', payload: {} });

    expect(respuesta.statusCode).toBe(401);
    expect(respuesta.json()).toMatchObject({ error: 'no_autenticado' });
  });

  it('un token equivocado también es 401', async () => {
    const respuesta = await app.inject({
      method: 'POST',
      url: '/mensaje-entrante',
      headers: { authorization: 'Bearer otro-token-igual-de-largo-pero-falso' },
      payload: {},
    });

    expect(respuesta.statusCode).toBe(401);
  });

  it('un esquema que no es Bearer es 401', async () => {
    const respuesta = await app.inject({
      method: 'POST',
      url: '/mensaje-entrante',
      headers: { authorization: `Basic ${TOKEN}` },
      payload: {},
    });

    expect(respuesta.statusCode).toBe(401);
  });

  it('la autenticación va ANTES que la validación de esquema', async () => {
    // Cuerpo inválido y sin token: debe responder 401, no 400. Si respondiera
    // 400 estaría contando qué endpoints existen y qué esperan a quien no se ha
    // autenticado.
    const respuesta = await app.inject({
      method: 'POST',
      url: '/accion-recepcion',
      payload: { basura: true },
    });

    expect(respuesta.statusCode).toBe(401);
  });

  it('una ruta inexistente sin token es 401, no 404', async () => {
    const respuesta = await app.inject({ method: 'GET', url: '/no-existe' });

    expect(respuesta.statusCode).toBe(401);
  });

  it('con el token correcto la petición pasa y la valida el esquema', async () => {
    const respuesta = await app.inject({
      method: 'POST',
      url: '/mensaje-entrante',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {},
    });

    // 404 porque sin dependencias la ruta no está montada; lo que importa es
    // que ya no es 401: el token ha pasado.
    expect(respuesta.statusCode).not.toBe(401);
  });
});
