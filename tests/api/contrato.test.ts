import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer, type App } from '../../src/api/server.js';
import { createCore, type Core } from '../../src/db/client.js';
import { AgendaFalsa, dependenciasDePrueba } from '../support/fakes.js';
import { APP_URL, conexionAdmin, prepararBaseDeDatos } from '../support/db.js';

/**
 * El contrato con n8n, comprobado desde fuera.
 *
 * Estos tests existen porque el primer workflow se escribió a partir de
 * suposiciones y no del contrato, y las suposiciones eran razonables: mandar el
 * slug en vez del UUID, el teléfono sin el más, olvidar `nombre`. **Un contrato
 * que sólo vive en un documento se incumple**; éste falla en rojo.
 */

const CLINICA = '77778888-7777-4777-8777-777788880000';
const TOKEN = 'token-de-prueba-suficientemente-largo';

const admin = conexionAdmin();
let core: Core;
let app: App;

function pedir(payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/mensaje-entrante',
    headers: { authorization: `Bearer ${TOKEN}` },
    payload,
  });
}

function valido(extra: Record<string, unknown> = {}) {
  return {
    idempotencyKey: `wamid-${Math.random()}`,
    clientId: CLINICA,
    telefono: '+34600000009',
    nombre: 'Marta',
    texto: 'hola',
    ...extra,
  };
}

beforeAll(async () => {
  await prepararBaseDeDatos(admin);
  core = createCore(APP_URL);
  await admin`delete from motor.clients where id = ${CLINICA}`;
  await admin`
    insert into motor.clients (id, slug, name, config, config_version)
    values (${CLINICA}, 'clinica-de-pruebas', 'Clínica Contrato', '{}'::jsonb, 'test')
  `;
  app = await buildServer({
    logLevel: 'silent',
    token: TOKEN,
    deps: dependenciasDePrueba({ core, agenda: new AgendaFalsa(), reloj: () => new Date() }),
  });
}, 60_000);

afterAll(async () => {
  await app.close();
  await core.close();
  await admin.end();
});

describe('lo que el workflow mandaba mal', () => {
  it('el slug en vez del UUID es un 400', async () => {
    const r = await pedir(valido({ clientId: 'ejemplo' }));

    expect(r.statusCode).toBe(400);
    expect(JSON.stringify(r.json())).toContain('UUID');
  });

  it('el teléfono sin el más es un 400', async () => {
    const r = await pedir(valido({ telefono: '34600000009' }));

    expect(r.statusCode).toBe(400);
    expect(JSON.stringify(r.json())).toContain('E.164');
  });

  it('sin `nombre` es un 400: es obligatorio', async () => {
    const cuerpo = valido();
    delete (cuerpo as Record<string, unknown>)['nombre'];
    const r = await pedir(cuerpo);

    expect(r.statusCode).toBe(400);
  });

  it('un campo que sobra es un 400, NO un descarte en silencio', async () => {
    // Lo que motiva `strict`: si n8n manda `telefno` por una errata, hay que
    // enterarse en la primera prueba y no el día que alguien se pregunte por
    // qué no llega nada.
    const r = await pedir(valido({ recibidoEn: '2026-08-21T10:00:00.000Z' }));

    expect(r.statusCode).toBe(400);
  });
});

describe('el límite de texto es el del canal', () => {
  it('4096 caracteres entran', async () => {
    const r = await pedir(valido({ texto: 'a'.repeat(4096) }));

    // Poner un tope más bajo que el que WhatsApp entrega es inventarse un fallo.
    expect(r.statusCode).not.toBe(400);
  });

  it('4097 no', async () => {
    const r = await pedir(valido({ texto: 'a'.repeat(4097) }));

    expect(r.statusCode).toBe(400);
  });
});

describe('lo que no es texto entra y se contesta', () => {
  it('una nota de voz recibe respuesta en vez de silencio', async () => {
    const r = await pedir(valido({ tipo: 'audio', texto: undefined }));

    expect(r.statusCode).toBe(200);
    expect(r.json().respuesta).toContain('escritos');
  });

  it('y queda registrada en el hilo, con etiqueta legible', async () => {
    await pedir(valido({ tipo: 'imagen', texto: undefined, telefono: '+34600000011' }));

    const filas = await admin`
      select body from motor.messages
       where client_id = ${CLINICA} and direction = 'entrante'
       order by created_at desc limit 1
    `;
    // Un hueco en blanco haría pensar a la clínica que no llegó nada.
    expect(String(filas[0]?.['body'])).toBe('[imagen]');
  });

  it('no gasta ni una llamada al modelo', async () => {
    await pedir(valido({ tipo: 'ubicacion', texto: undefined, telefono: '+34600000012' }));

    // Sólo esta conversación: una llamada al proveedor para producir un texto
    // fijo es gasto sin contrapartida.
    const filas = await admin`
      select count(*)::int as n from motor.messages m
        join motor.conversations c on c.id = m.conversation_id
        join motor.patients p on p.id = c.patient_id
       where m.client_id = ${CLINICA} and p.phone_e164 = '+34600000012'
         and m.direction = 'saliente' and m.model is not null
    `;
    expect(filas[0]?.['n']).toBe(0);
  });

  it('un tipo `texto` sin texto sigue siendo un 400', async () => {
    const r = await pedir(valido({ texto: undefined }));

    expect(r.statusCode).toBe(400);
  });
});

describe('de la línea de WhatsApp al clientId', () => {
  it('resuelve el remitente configurado', async () => {
    const r = await app.inject({
      method: 'GET',
      // El `canal.remitenteId` de la clínica de pruebas.
      url: '/cliente-por-remitente/000',
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(r.statusCode).toBe(200);
    expect(r.json().slug).toBe('clinica-de-pruebas');
    expect(r.json().clientId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('un remitente desconocido es 404, NUNCA una clínica por defecto', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/cliente-por-remitente/000000000000000',
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    // Elegir «la primera» mandaría la conversación de un paciente a otra
    // clínica: la regla 1 rota por la puerta de entrada.
    expect(r.statusCode).toBe(404);
  });

  it('exige token: revela UUIDs de clínicas', async () => {
    const r = await app.inject({ method: 'GET', url: '/cliente-por-remitente/109876543210987' });

    expect(r.statusCode).toBe(401);
  });
});

describe('a qué clínicas llaman los crons', () => {
  it('las cargadas y dadas de alta, con su clientId: la lista no vive en cada workflow', async () => {
    const r = await app.inject({ method: 'GET', url: '/clinicas', headers: { authorization: `Bearer ${TOKEN}` } });

    expect(r.statusCode).toBe(200);
    expect(r.json().clinicas).toContainEqual({ clientId: CLINICA, slug: 'clinica-de-pruebas' });
  });

  it('una con YAML y sin alta activa no recibe crons, y se dice', async () => {
    await admin`update motor.clients set active = false where id = ${CLINICA}`;
    try {
      const r = await app.inject({ method: 'GET', url: '/clinicas', headers: { authorization: `Bearer ${TOKEN}` } });

      expect(r.json().clinicas).toEqual([]);
      expect(r.json().sinAlta).toEqual(['clinica-de-pruebas']);
    } finally {
      await admin`update motor.clients set active = true where id = ${CLINICA}`;
    }
  });

  it('exige token', async () => {
    const r = await app.inject({ method: 'GET', url: '/clinicas' });

    expect(r.statusCode).toBe(401);
  });
});

describe('POST /escalado-atendido', () => {
  it('exige token: reabre conversaciones paradas por urgencias', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/escalado-atendido',
      payload: { idempotencyKey: 'x', clientId: CLINICA, escaladoId: CLINICA, atendidoPor: 'Recepción' },
    });

    expect(r.statusCode).toBe(401);
  });

  it('sin quién lo atendió no entra: es lo que se pregunta ante una reclamación', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/escalado-atendido',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { idempotencyKey: 'x', clientId: CLINICA, escaladoId: CLINICA, atendidoPor: '  ' },
    });

    expect(r.statusCode).toBe(400);
  });

  it('un escalado que no existe es 404', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/escalado-atendido',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { idempotencyKey: 'x-404', clientId: CLINICA, escaladoId: CLINICA, atendidoPor: 'Recepción' },
    });

    expect(r.statusCode).toBe(404);
    expect(r.json().error).toBe('escalado_inexistente');
  });
});
