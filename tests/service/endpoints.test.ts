import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildServer, type App } from '../../src/api/server.js';
import { createCore, type Core } from '../../src/db/client.js';
import { AgendaFalsa, dependenciasDePrueba, huecosDesde } from '../support/fakes.js';
import { APP_URL, conexionAdmin, prepararBaseDeDatos } from '../support/db.js';

/** El borde HTTP: que lo que expone n8n valide entrada y salida y responda bien. */

const CLINICA = 'eeee0000-eeee-4eee-8eee-eeee00000000';
const admin = conexionAdmin();
let core: Core;
let app: App;

beforeAll(async () => {
  await prepararBaseDeDatos(admin);
  core = createCore(APP_URL);
  app = await buildServer({
    logLevel: 'silent',
    deps: dependenciasDePrueba({
      core,
      agenda: new AgendaFalsa(huecosDesde(new Date('2026-10-15T09:00:00.000Z'), 3)),
    }),
  });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app.close();
  await core.close();
  await admin.end();
});

beforeEach(async () => {
  await admin`delete from motor.audit_log where client_id = ${CLINICA}`;
  await admin`delete from motor.idempotency_keys where client_id = ${CLINICA}`;
  await admin`delete from motor.escalations where client_id = ${CLINICA}`;
  await admin`delete from motor.messages where client_id = ${CLINICA}`;
  await admin`delete from motor.holds where client_id = ${CLINICA}`;
  await admin`delete from motor.conversations where client_id = ${CLINICA}`;
  await admin`delete from motor.suppression where client_id = ${CLINICA}`;
  await admin`delete from motor.patients where client_id = ${CLINICA}`;
  await admin`delete from motor.clients where id = ${CLINICA}`;
  await admin`
    insert into motor.clients (id, slug, name, config, config_version)
    values (${CLINICA}, 'clinica-de-pruebas', 'Clínica HTTP', '{}'::jsonb, 'test')
  `;
});

function cuerpo(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    idempotencyKey: `http-${Math.random().toString(36).slice(2)}`,
    clientId: CLINICA,
    telefono: '+34600999888',
    nombre: 'Lola',
    texto: 'hola quiero pedir cita de axilas',
    ...extra,
  };
}

describe('POST /mensaje-entrante', () => {
  it('procesa un mensaje y devuelve respuesta y efectos', async () => {
    const respuesta = await app.inject({
      method: 'POST',
      url: '/mensaje-entrante',
      payload: cuerpo(),
    });

    expect(respuesta.statusCode).toBe(200);
    const json = respuesta.json();
    expect(json).toMatchObject({ estadoConversacion: 'abierta', corte: null });
    expect(typeof json.respuesta).toBe('string');
  });

  it('un teléfono que no es E.164 se rechaza antes de tocar nada', async () => {
    const respuesta = await app.inject({
      method: 'POST',
      url: '/mensaje-entrante',
      payload: cuerpo({ telefono: '600999888' }),
    });

    expect(respuesta.statusCode).toBe(400);
    expect(respuesta.json()).toMatchObject({ error: 'validation_error' });
  });

  it('un corte del cortafuegos sale en la respuesta con su categoría', async () => {
    const respuesta = await app.inject({
      method: 'POST',
      url: '/mensaje-entrante',
      payload: cuerpo({ texto: 'me sale pus de la herida' }),
    });

    expect(respuesta.statusCode).toBe(200);
    expect(respuesta.json()).toMatchObject({
      estadoConversacion: 'pausada',
      corte: { categoria: 'urgencia_clinica' },
    });
  });

  it('reutilizar la clave con otro cuerpo devuelve 409, no un duplicado silencioso', async () => {
    const base = cuerpo({ idempotencyKey: 'misma-clave' });
    await app.inject({ method: 'POST', url: '/mensaje-entrante', payload: base });

    const segunda = await app.inject({
      method: 'POST',
      url: '/mensaje-entrante',
      payload: { ...base, texto: 'algo completamente distinto' },
    });

    expect(segunda.statusCode).toBe(409);
    expect(segunda.json()).toMatchObject({ error: 'idempotency_key_reutilizada' });
  });
});

describe('POST /accion-recepcion', () => {
  it('el botón declara un hecho consumado: sólo acepta «ya_esta_en_agenda»', async () => {
    const respuesta = await app.inject({
      method: 'POST',
      url: '/accion-recepcion',
      payload: {
        idempotencyKey: 'x',
        clientId: CLINICA,
        holdId: '00000000-0000-4000-8000-000000000000',
        accion: 'confirmar',
      },
    });

    expect(respuesta.statusCode).toBe(400);
  });

  it('un hueco inexistente responde 404 con cuerpo, no en silencio', async () => {
    const respuesta = await app.inject({
      method: 'POST',
      url: '/accion-recepcion',
      payload: {
        idempotencyKey: 'y',
        clientId: CLINICA,
        holdId: '00000000-0000-4000-8000-000000000000',
        accion: 'ya_esta_en_agenda',
      },
    });

    expect(respuesta.statusCode).toBe(404);
    expect(respuesta.json()).toMatchObject({ error: 'hueco_inexistente' });
  });
});
