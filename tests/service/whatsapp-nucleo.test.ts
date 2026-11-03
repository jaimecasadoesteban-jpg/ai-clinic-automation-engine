import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Extraccion } from '../../src/agent/extraccion.js';
import { buildServer, type App } from '../../src/api/server.js';
import { createCore, type Core } from '../../src/db/client.js';
import type { CorreoSaliente } from '../../src/service/correo.js';
import { procesarBandeja, MAX_INTENTOS_BANDEJA } from '../../src/service/bandeja.js';
import { ejecutarSalida } from '../../src/service/ejecutor.js';
import { procesarMensajeEntrante } from '../../src/service/pipeline.js';
import type { Clasificacion, ClasificadorDeIntencion } from '../../src/service/ports.js';
import { EnvioRechazadoError, type WhatsAppSaliente } from '../../src/service/whatsapp/meta.js';
import { AgendaFalsa, AgenteFalso, ClasificadorFalso, RedactorFalso, dependenciasDePrueba } from '../support/fakes.js';
import { APP_URL, conexionAdmin, prepararBaseDeDatos } from '../support/db.js';
import { firmar, webhookDeMeta } from '../support/meta.js';

/**
 * WhatsApp sin n8n: el webhook guarda y responde, la bandeja procesa por el
 * turno de siempre, y lo que sale va por la tabla de salida.
 */

const CLINICA = 'aa0c0000-0000-4000-8000-00000000c0c0';
const REMITENTE = '000'; // canal.remitenteId de configDePrueba
const SECRETO = 'secreto-de-la-app-de-pruebas';
const VERIFICAR = 'frase-de-verificacion-larga';
const TOKEN = 'token-de-prueba-suficientemente-largo';
const AHORA = new Date('2026-09-14T10:00:00.000Z');
const admin = conexionAdmin();
let core: Core;
let app: App;
let agenda: AgendaFalsa;
let agente: AgenteFalso;
let despertado = 0;

function extraccion(extra: Partial<Extraccion> = {}): Extraccion {
  return {
    intencion: 'agendar', servicio: 'laser-axilas', opcion: null, preferencia: null,
    escalar: null, cita: null, sustitucion: null, tema: null, ...extra,
  };
}

function deps() {
  return { ...dependenciasDePrueba({ core, agenda, reloj: () => AHORA }), agente };
}

async function entrar(mensajes: Array<Record<string, unknown> & { id: string; type: string }>, firma?: string) {
  const cuerpo = JSON.stringify(
    webhookDeMeta({ remitenteId: REMITENTE, mensajes: mensajes.map((m) => ({ from: '34600123456', ...m })) }),
  );
  return app.inject({
    method: 'POST',
    url: '/whatsapp',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': firma ?? firmar(cuerpo, SECRETO) },
    payload: cuerpo,
  });
}

const salidaWhatsApp = async () =>
  (await admin`select payload, dedupe_key from motor.outbox where client_id = ${CLINICA} and kind = 'whatsapp' order by created_at`).map(
    (f) => f['payload'] as { para: string; texto: string; remitenteId: string },
  );

class CorreoFalso implements CorreoSaliente {
  readonly enviados: string[] = [];
  enviar(m: { asunto: string }): Promise<void> {
    this.enviados.push(m.asunto);
    return Promise.resolve();
  }
  comprobar(): Promise<boolean> {
    return Promise.resolve(true);
  }
  cerrar(): void {}
}

class WhatsAppFalso implements WhatsAppSaliente {
  readonly enviados: Array<{ para: string; texto: string; remitenteId: string }> = [];
  constructor(private readonly error?: Error) {}
  enviarTexto(m: { remitenteId: string; para: string; texto: string }): Promise<void> {
    if (this.error !== undefined) return Promise.reject(this.error);
    this.enviados.push(m);
    return Promise.resolve();
  }
}

beforeAll(async () => {
  await prepararBaseDeDatos(admin);
  core = createCore(APP_URL);
}, 60_000);

afterAll(async () => {
  await app.close();
  await core.close();
  await admin.end();
});

beforeEach(async () => {
  await admin`update motor.conversations set pending_hold_id = null where client_id = ${CLINICA}`;
  for (const tabla of ['inbox', 'outbox', 'audit_log', 'idempotency_keys', 'job_runs', 'appointments', 'escalations', 'messages', 'holds', 'conversations', 'patients']) {
    await admin.unsafe(`delete from motor.${tabla} where client_id = $1`, [CLINICA]);
  }
  await admin`delete from motor.clients where id = ${CLINICA}`;
  await admin`
    insert into motor.clients (id, slug, name, config, config_version)
    values (${CLINICA}, 'clinica-de-pruebas', 'Clínica', '{}'::jsonb, 'test')
  `;
  agenda = new AgendaFalsa();
  agente = new AgenteFalso(new ClasificadorFalso([extraccion()]), new RedactorFalso());
  despertado = 0;
  if (app !== undefined) await app.close();
  app = await buildServer({
    logLevel: 'silent',
    token: TOKEN,
    deps: deps(),
    whatsapp: { appSecret: SECRETO, verifyToken: VERIFICAR, alRecibir: () => (despertado += 1) },
  });
});

describe('el webhook', () => {
  it('Meta lo verifica con su frase, y con otra no', async () => {
    const bien = await app.inject({ method: 'GET', url: `/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFICAR}&hub.challenge=123` });
    const mal = await app.inject({ method: 'GET', url: '/whatsapp?hub.mode=subscribe&hub.verify_token=otra&hub.challenge=123' });

    expect(bien.statusCode).toBe(200);
    expect(bien.body).toBe('123');
    expect(mal.statusCode).toBe(403);
  });

  it('no pide nuestro token —Meta no lo tiene—, pero sin firma válida no guarda nada', async () => {
    const r = await entrar([{ id: 'wamid.A', type: 'text', text: { body: 'hola' } }], 'sha256=000');

    expect(r.statusCode).toBe(401);
    expect(await admin`select 1 from motor.inbox where client_id = ${CLINICA}`).toHaveLength(0);
  });

  it('el resto de rutas sigue pidiendo el token', async () => {
    const r = await app.inject({ method: 'GET', url: '/clinicas' });
    expect(r.statusCode).toBe(401);
  });

  it('con firma válida guarda en la bandeja, responde 200 y avisa al procesador', async () => {
    const r = await entrar([{ id: 'wamid.A', type: 'text', text: { body: 'Quiero cita' } }]);

    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ recibidos: 1 });
    expect(despertado).toBe(1);
    const [fila] = await admin`select payload, state from motor.inbox where client_id = ${CLINICA}`;
    expect(fila?.['state']).toBe('pendiente');
    expect(fila?.['payload']).toMatchObject({ telefono: '+34600123456', tipo: 'texto', texto: 'Quiero cita' });
  });

  it('Meta reintenta: el mismo wamid no entra dos veces', async () => {
    await entrar([{ id: 'wamid.A', type: 'text', text: { body: 'Quiero cita' } }]);
    const otra = await entrar([{ id: 'wamid.A', type: 'text', text: { body: 'Quiero cita' } }]);

    expect(otra.json()).toEqual({ recibidos: 0 });
    expect(await admin`select 1 from motor.inbox where client_id = ${CLINICA}`).toHaveLength(1);
  });

  it('una línea sin clínica no se guarda, y se contesta 200 para que Meta no reintente días', async () => {
    const cuerpo = JSON.stringify(webhookDeMeta({ remitenteId: '999', mensajes: [{ id: 'wamid.X', from: '346', type: 'text', text: { body: 'x' } }] }));
    const r = await app.inject({
      method: 'POST',
      url: '/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': firmar(cuerpo, SECRETO) },
      payload: cuerpo,
    });

    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ recibidos: 0 });
  });
});

describe('la bandeja pasa el mensaje por el turno y encola la respuesta', () => {
  it('la respuesta sale por la tabla de salida, al teléfono del paciente y por su línea', async () => {
    await entrar([{ id: 'wamid.A', type: 'text', text: { body: 'Quiero cita para axilas' } }]);

    const r = await procesarBandeja(deps(), CLINICA, { ahora: AHORA });

    expect(r.procesados).toBe(1);
    const [salida] = await salidaWhatsApp();
    expect(salida).toMatchObject({ para: '+34600123456', remitenteId: REMITENTE });
    expect(salida?.texto).toContain('opcion 1');
    expect((await admin`select state from motor.inbox where client_id = ${CLINICA}`)[0]?.['state']).toBe('procesado');
  });

  it('el aviso a recepción también se encola, a su número', async () => {
    await entrar([{ id: 'wamid.A', type: 'text', text: { body: 'Quiero cita para axilas' } }]);
    await procesarBandeja(deps(), CLINICA, { ahora: AHORA });
    agente = new AgenteFalso(new ClasificadorFalso([extraccion({ intencion: 'elegir_hueco', opcion: 1 })]), new RedactorFalso());
    await entrar([{ id: 'wamid.B', type: 'text', text: { body: 'la primera' } }]);

    await procesarBandeja(deps(), CLINICA, { ahora: AHORA });

    const destinos = (await salidaWhatsApp()).map((s) => s.para);
    expect(destinos).toContain('+34600111111'); // escalado.recepcion de configDePrueba
  });

  it('una nota de voz recibe respuesta: ya no se descarta en silencio', async () => {
    await entrar([{ id: 'wamid.A', type: 'audio', audio: {} }]);

    await procesarBandeja(deps(), CLINICA, { ahora: AHORA });

    const [salida] = await salidaWhatsApp();
    expect(salida?.texto).toMatch(/escrito|texto/i);
  });

  it('lo que entra por /mensaje-entrante (n8n) NO se encola: lo envía n8n, y no sale dos veces', async () => {
    await procesarMensajeEntrante(deps(), {
      idempotencyKey: 'n8n-1', clientId: CLINICA, telefono: '+34600123456', nombre: 'Lola', texto: 'Quiero cita para axilas',
    });

    expect(await salidaWhatsApp()).toEqual([]);
  });

  it('si el turno falla una y otra vez, el paciente recibe un texto y el operador un correo', async () => {
    const roto: ClasificadorDeIntencion = { clasificar: (): Promise<Clasificacion> => Promise.reject(new Error('fallo inesperado')) };
    agente = new AgenteFalso(roto, new RedactorFalso());
    await entrar([{ id: 'wamid.A', type: 'text', text: { body: 'hola' } }]);

    let ahora = AHORA;
    for (let i = 0; i < MAX_INTENTOS_BANDEJA; i += 1) {
      await procesarBandeja(deps(), CLINICA, { ahora });
      ahora = new Date(ahora.getTime() + 60_000);
    }

    expect((await admin`select state from motor.inbox where client_id = ${CLINICA}`)[0]?.['state']).toBe('fallido');
    const [aviso] = await salidaWhatsApp();
    expect(aviso?.texto).toMatch(/no puedo atenderte/i);
    expect(aviso?.texto).not.toMatch(/persona|equipo/i);
    expect(await admin`select 1 from motor.outbox where client_id = ${CLINICA} and kind = 'correo_operador'`).toHaveLength(1);
  });
});

describe('el envío', () => {
  async function conRespuestaEncolada(): Promise<void> {
    await entrar([{ id: 'wamid.A', type: 'text', text: { body: 'Quiero cita para axilas' } }]);
    await procesarBandeja(deps(), CLINICA, { ahora: AHORA });
  }

  it('sale por Meta y se marca enviado', async () => {
    await conRespuestaEncolada();
    const whatsapp = new WhatsAppFalso();

    await ejecutarSalida(core, CLINICA, { correo: new CorreoFalso(), operador: 'op@x.test', whatsapp, ahora: AHORA });

    expect(whatsapp.enviados).toHaveLength(1);
    expect(whatsapp.enviados[0]).toMatchObject({ para: '+34600123456', remitenteId: REMITENTE });
  });

  it('un rechazo permanente (fuera de la ventana de 24 h) no se reintenta: falla y avisa al operador', async () => {
    await conRespuestaEncolada();
    const whatsapp = new WhatsAppFalso(new EnvioRechazadoError('fuera de ventana', true, 131047));

    const r = await ejecutarSalida(core, CLINICA, { correo: new CorreoFalso(), operador: 'op@x.test', whatsapp, ahora: AHORA });

    expect(r.fallidos).toHaveLength(1);
    const [correo] = await admin`select payload from motor.outbox where client_id = ${CLINICA} and kind = 'correo_operador'`;
    expect(String((correo?.['payload'] as { asunto: string }).asunto)).toMatch(/no se ha podido entregar/);
    expect(JSON.stringify(correo?.['payload'])).not.toContain('34600123456');
  });

  it('un fallo pasajero se reintenta', async () => {
    await conRespuestaEncolada();
    const whatsapp = new WhatsAppFalso(new EnvioRechazadoError('Meta no responde', false, null));

    const r = await ejecutarSalida(core, CLINICA, { correo: new CorreoFalso(), operador: 'op@x.test', whatsapp, ahora: AHORA });

    expect(r.reintentos).toBe(1);
  });

  it('sin credenciales de WhatsApp, lo que hay que enviar espera: no se pierde ni se marca fallido', async () => {
    await conRespuestaEncolada();

    await ejecutarSalida(core, CLINICA, { correo: new CorreoFalso(), operador: 'op@x.test', ahora: AHORA });

    expect((await admin`select state from motor.outbox where client_id = ${CLINICA} and kind = 'whatsapp'`)[0]?.['state']).toBe('pendiente');
  });
});
