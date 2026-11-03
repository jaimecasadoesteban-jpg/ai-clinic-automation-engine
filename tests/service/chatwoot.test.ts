import { readFileSync } from 'node:fs';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Extraccion } from '../../src/agent/extraccion.js';
import { buildServer, type App } from '../../src/api/server.js';
import { createCore, type Core } from '../../src/db/client.js';
import type { CargaDeChatwoot } from '../../src/db/schema.js';
import type { ChatwootSaliente } from '../../src/service/chatwoot/api.js';
import type { CorreoSaliente } from '../../src/service/correo.js';
import { procesarBandeja } from '../../src/service/bandeja.js';
import { ejecutarSalida } from '../../src/service/ejecutor.js';
import { EnvioRechazadoError } from '../../src/service/whatsapp/meta.js';
import {
  AgendaFalsa,
  AgenteFalso,
  ClasificadorFalso,
  RedactorFalso,
  configDePrueba,
  dependenciasDePrueba,
  registroDePrueba,
} from '../support/fakes.js';
import { APP_URL, conexionAdmin, prepararBaseDeDatos } from '../support/db.js';
import { CUENTA, INBOX, avisoDeConversacion, avisoDeMensaje, firmarChatwoot } from '../support/chatwoot.js';

/**
 * WhatsApp por Chatwoot (coexistencia): el webhook firmado guarda y responde,
 * la bandeja pasa el mensaje por el turno, y lo que sale vuelve a la misma
 * conversación de Chatwoot —la respuesta como mensaje, los avisos a la clínica
 * como nota privada—. Y el interruptor: con la etiqueta puesta, el agente se
 * calla; el cortafuegos, no.
 */

const CLINICA = 'cb0c0000-0000-4000-8000-00000000cbcb';
const SECRETO = 'secreto-del-webhook-de-chatwoot';
const TOKEN = 'token-de-prueba-suficientemente-largo';
const AHORA = new Date('2026-09-14T10:00:00.000Z');
const SEGUNDOS = Math.floor(AHORA.getTime() / 1000);
const CONVERSACION = 1001;

const admin = conexionAdmin();
let core: Core;
let app: App;
let agenda: AgendaFalsa;
let agente: AgenteFalso;
let despertado = 0;
let siguienteId = 1;

const configuracion = registroDePrueba([
  {
    slug: 'clinica-de-pruebas',
    config: configDePrueba({
      canal: { tipo: 'whatsapp', remitenteId: '000', chatwoot: { cuentaId: CUENTA, inboxId: INBOX } },
    }),
  },
]);

function extraccion(extra: Partial<Extraccion> = {}): Extraccion {
  return {
    intencion: 'agendar', servicio: 'laser-axilas', opcion: null, preferencia: null,
    escalar: null, cita: null, sustitucion: null, tema: null, ...extra,
  };
}

function deps() {
  return { ...dependenciasDePrueba({ core, agenda, reloj: () => AHORA, configuracion }), agente };
}

async function avisar(payload: Record<string, unknown>, firma?: string) {
  const cuerpo = JSON.stringify(payload);
  return app.inject({
    method: 'POST',
    url: '/chatwoot',
    headers: {
      'content-type': 'application/json',
      'x-chatwoot-signature': firma ?? firmarChatwoot(cuerpo, SECRETO, SEGUNDOS),
      'x-chatwoot-timestamp': String(SEGUNDOS),
    },
    payload: cuerpo,
  });
}

/** El paciente escribe y el núcleo lo atiende. */
async function escribe(texto: string, extra: Partial<Parameters<typeof avisoDeMensaje>[0]> = {}) {
  siguienteId += 1;
  await avisar(avisoDeMensaje({ id: siguienteId, texto, conversacion: CONVERSACION, ...extra }));
  return procesarBandeja(deps(), CLINICA, { ahora: AHORA });
}

async function salida(kind: 'chatwoot' | 'whatsapp' | 'correo_operador' = 'chatwoot') {
  return (await admin`select payload from motor.outbox where client_id = ${CLINICA} and kind = ${kind} order by created_at`).map(
    (f) => f['payload'] as CargaDeChatwoot & { asunto?: string; cuerpo?: string },
  );
}

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

class ChatwootFalso implements ChatwootSaliente {
  readonly enviados: CargaDeChatwoot[] = [];
  constructor(private readonly error?: Error) {}
  enviar(m: CargaDeChatwoot): Promise<{ id: number }> {
    if (this.error !== undefined) return Promise.reject(this.error);
    this.enviados.push(m);
    return Promise.resolve({ id: 5000 + this.enviados.length });
  }
  cambiarEtiqueta(): Promise<void> {
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
    chatwoot: { secreto: SECRETO, alRecibir: () => (despertado += 1) },
  });
});

describe('el webhook', () => {
  it('no pide nuestro token —Chatwoot no lo tiene—, pero sin firma válida no guarda nada', async () => {
    const r = await avisar(avisoDeMensaje({ id: 1 }), 'sha256=000');

    expect(r.statusCode).toBe(401);
    expect(await admin`select 1 from motor.inbox where client_id = ${CLINICA}`).toHaveLength(0);
  });

  it('con firma válida guarda en la bandeja con la conversación donde contestar, y avisa al procesador', async () => {
    const r = await avisar(avisoDeMensaje({ id: 1, texto: 'Quiero cita' }));

    expect(r.json()).toEqual({ recibidos: 1 });
    expect(despertado).toBe(1);
    const [fila] = await admin`select payload from motor.inbox where client_id = ${CLINICA}`;
    expect(fila?.['payload']).toMatchObject({
      telefono: '+34600123456', texto: 'Quiero cita', chatwoot: { cuentaId: CUENTA, conversacionId: CONVERSACION },
    });
  });

  it('Chatwoot reintenta: el mismo mensaje no entra dos veces', async () => {
    await avisar(avisoDeMensaje({ id: 1 }));
    const otra = await avisar(avisoDeMensaje({ id: 1 }));

    expect(otra.json()).toEqual({ recibidos: 0 });
    expect(await admin`select 1 from motor.inbox where client_id = ${CLINICA}`).toHaveLength(1);
  });

  it('una nota privada no entra', async () => {
    await avisar(avisoDeMensaje({ id: 2, privado: true, texto: 'ojo con esta paciente' }));

    expect(await admin`select 1 from motor.inbox where client_id = ${CLINICA}`).toHaveLength(0);
  });

  it('un inbox sin clínica no se guarda, y se contesta 200 para que no reintente', async () => {
    const r = await avisar(avisoDeMensaje({ id: 1, inbox: 999 }));

    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ recibidos: 0 });
    expect(await admin`select 1 from motor.inbox where client_id = ${CLINICA}`).toHaveLength(0);
  });
});

describe('soloTelefonos: probar en un número real sin contestar a sus contactos', () => {
  async function conLista(telefonos: string[]) {
    await app.close();
    const lista = registroDePrueba([
      {
        slug: 'clinica-de-pruebas',
        config: configDePrueba({
          canal: { tipo: 'whatsapp', remitenteId: '000', chatwoot: { cuentaId: CUENTA, inboxId: INBOX, soloTelefonos: telefonos } },
        }),
      },
    ]);
    app = await buildServer({
      logLevel: 'silent',
      token: TOKEN,
      deps: { ...dependenciasDePrueba({ core, agenda, reloj: () => AHORA, configuracion: lista }), agente },
      chatwoot: { secreto: SECRETO, alRecibir: () => (despertado += 1) },
    });
  }

  it('fuera de la lista, el núcleo no guarda ni contesta nada, ni mueve el interruptor', async () => {
    await conLista(['+34699999999']);

    await avisar(avisoDeMensaje({ id: 1, texto: 'hola, soy tu prima' }));
    await avisar(avisoDeConversacion({ etiquetas: ['agente-parado'] }));

    expect(await admin`select 1 from motor.inbox where client_id = ${CLINICA}`).toHaveLength(0);
    expect(await admin`select 1 from motor.patients where client_id = ${CLINICA}`).toHaveLength(0);
  });

  it('dentro de la lista, como siempre', async () => {
    await conLista(['+34600123456']);

    const r = await avisar(avisoDeMensaje({ id: 1, texto: 'Quiero cita' }));

    expect(r.json()).toEqual({ recibidos: 1 });
  });
});

describe('lo que sale vuelve a la misma conversación', () => {
  it('la respuesta al paciente, como mensaje público; nada por Meta', async () => {
    await escribe('Quiero cita para axilas');

    const [respuesta] = await salida();
    expect(respuesta).toMatchObject({ cuentaId: CUENTA, conversacionId: CONVERSACION, privado: false });
    expect(respuesta?.texto).toContain('opcion 1');
    expect(await salida('whatsapp')).toEqual([]);
    // Y la conversación guarda por dónde escribirle, para lo que mande un cron.
    const [conv] = await admin`select reply_channel from motor.conversations where client_id = ${CLINICA}`;
    expect(conv?.['reply_channel']).toEqual({ por: 'chatwoot', cuentaId: CUENTA, conversacionId: CONVERSACION });
  });

  it('el aviso a recepción, como nota privada en la conversación —no un WhatsApp a su móvil—', async () => {
    await escribe('Quiero cita para axilas');
    agente = new AgenteFalso(new ClasificadorFalso([extraccion({ intencion: 'elegir_hueco', opcion: 1 })]), new RedactorFalso());

    await escribe('la primera');

    const notas = (await salida()).filter((s) => s.privado);
    expect(notas).toHaveLength(1);
    expect(notas[0]).toMatchObject({ cuentaId: CUENTA, conversacionId: CONVERSACION });
    expect(await salida('whatsapp')).toEqual([]);
  });
});

describe('el interruptor del agente', () => {
  it('con la etiqueta puesta, el agente no contesta: ni modelo ni relleno, pero el mensaje queda guardado', async () => {
    await avisar(avisoDeConversacion({ etiquetas: ['agente-parado'] }));

    await escribe('¿cuánto cuesta el láser?');

    expect(await salida()).toEqual([]);
    expect(agente.contextos).toHaveLength(0);
    const guardados = await admin`select body from motor.messages where client_id = ${CLINICA} and direction = 'entrante'`;
    expect(guardados.map((f) => f['body'])).toEqual(['¿cuánto cuesta el láser?']);
  });

  it('parado no es sordo: una urgencia recibe su texto aprobado, su escalado, y el operador un correo sin datos', async () => {
    await avisar(avisoDeConversacion({ etiquetas: ['agente-parado'] }));

    await escribe('estoy sangrando mucho');

    const enviado = await salida();
    expect(enviado.filter((s) => !s.privado)).toHaveLength(1);
    expect(enviado.filter((s) => s.privado)).toHaveLength(1);
    const correos = await salida('correo_operador');
    expect(correos.map((c) => c.asunto)).toEqual([expect.stringMatching(/urgente/i)]);
    expect(JSON.stringify(correos)).not.toMatch(/34600123456|sangrando|Lola/);
    expect(await admin`select 1 from motor.escalations where client_id = ${CLINICA} and reason = 'urgencia_clinica'`).toHaveLength(1);
  });

  it('se quita la etiqueta y vuelve a hablar; y queda en auditoría quién lo paró y lo reactivó', async () => {
    await avisar(avisoDeConversacion({ etiquetas: ['agente-parado'] }));
    await avisar(avisoDeConversacion({ etiquetas: [] }));

    await escribe('Quiero cita para axilas');

    expect((await salida()).filter((s) => !s.privado)).toHaveLength(1);
    const acciones = await admin`select action, actor from motor.audit_log where client_id = ${CLINICA} and entity = 'patients' order by created_at`;
    expect(acciones.map((f) => f['action'])).toEqual(['agente_parado', 'agente_reactivado']);
  });

  it('no se reactiva solo: un día después sigue parado', async () => {
    await avisar(avisoDeConversacion({ etiquetas: ['agente-parado'] }));
    const manana = new Date(AHORA.getTime() + 24 * 3_600_000);
    siguienteId += 1;
    await avisar(avisoDeMensaje({ id: siguienteId, texto: 'hola?' }));

    await procesarBandeja({ ...deps(), reloj: () => manana }, CLINICA, { ahora: manana });

    expect(await salida()).toEqual([]);
  });

  it('si el mensaje llega ya con la etiqueta, el turno se encuentra el agente parado', async () => {
    await escribe('hola', { etiquetas: ['agente-parado'] });

    expect(await salida()).toEqual([]);
  });

  it('otras etiquetas no lo paran, y la que lo para sale del YAML', async () => {
    await avisar(avisoDeConversacion({ etiquetas: ['vip', 'agente-detenido'] }));

    await escribe('Quiero cita para axilas');

    expect((await salida()).filter((s) => !s.privado)).toHaveLength(1);
  });

  it('una etiqueta que ya estaba no es un cambio: no deja rastro de más', async () => {
    await avisar(avisoDeConversacion({ etiquetas: ['agente-parado'] }));
    await avisar(avisoDeConversacion({ etiquetas: ['agente-parado', 'vip'] }));

    expect(await admin`select 1 from motor.audit_log where client_id = ${CLINICA} and entity = 'patients'`).toHaveLength(1);
  });
});

describe('lo que escribe una persona fuera del panel (móvil o Chatwoot)', () => {
  const MAS_TARDE = new Date(AHORA.getTime() + 30_000);

  it('entra en el historial como mensaje del equipo: no pasa por el agente, no contesta, y deja el canal', async () => {
    const r = await avisar(avisoDeMensaje({ id: 77, tipo: 'outgoing', texto: 'Hola Lola, te llamo en un rato' }));
    expect(r.json()).toEqual({ recibidos: 1 });
    // No despierta al procesador: espera a que el eco de lo nuestro se pueda reconocer.
    expect(despertado).toBe(0);

    await procesarBandeja({ ...deps(), reloj: () => MAS_TARDE }, CLINICA, { ahora: MAS_TARDE });

    const [m] = await admin`select direction, body, sent_by, model from motor.messages where client_id = ${CLINICA}`;
    expect(m).toMatchObject({ direction: 'saliente', body: 'Hola Lola, te llamo en un rato', sent_by: 'equipo', model: null });
    expect(agente.contextos).toHaveLength(0);
    expect(await salida()).toEqual([]);
    const [conv] = await admin`select reply_channel from motor.conversations where client_id = ${CLINICA}`;
    expect(conv?.['reply_channel']).toEqual({ por: 'chatwoot', cuentaId: CUENTA, conversacionId: CONVERSACION });
  });

  it('espera unos segundos antes de procesarse: si es el eco de uno nuestro, tiene que poder reconocerse', async () => {
    await avisar(avisoDeMensaje({ id: 77, tipo: 'outgoing', texto: 'x' }));

    await procesarBandeja(deps(), CLINICA, { ahora: AHORA });

    expect(await admin`select 1 from motor.messages where client_id = ${CLINICA}`).toHaveLength(0);
  });

  it('el eco de lo que mandó el agente no se guarda dos veces', async () => {
    await escribe('Quiero cita para axilas');
    const chatwoot = new ChatwootFalso();
    await ejecutarSalida(core, CLINICA, { correo: new CorreoFalso(), operador: 'op@x.test', chatwoot, ahora: AHORA });
    const [{ sent_ref: ref } = { sent_ref: null }] = await admin`select sent_ref from motor.outbox where client_id = ${CLINICA} and kind = 'chatwoot'`;
    expect(ref).toBe('5001');
    const antes = (await admin`select 1 from motor.messages where client_id = ${CLINICA}`).length;

    // Chatwoot avisa de ese mismo mensaje como saliente.
    await avisar(avisoDeMensaje({ id: 5001, tipo: 'outgoing', texto: 'lo que dijo el agente' }));
    await procesarBandeja({ ...deps(), reloj: () => MAS_TARDE }, CLINICA, { ahora: MAS_TARDE });

    expect(await admin`select 1 from motor.messages where client_id = ${CLINICA}`).toHaveLength(antes);
  });
});

describe('lo que WhatsApp no entregó después de que Chatwoot lo aceptara', () => {
  it('si es nuestro: la fila pasa a fallida con el motivo, y el operador recibe un correo sin datos del paciente', async () => {
    await escribe('Quiero cita para axilas');
    await ejecutarSalida(core, CLINICA, { correo: new CorreoFalso(), operador: 'op@x.test', chatwoot: new ChatwootFalso(), ahora: AHORA });

    await avisar({
      ...avisoDeMensaje({ id: 5001, tipo: 'outgoing', texto: 'x' }),
      event: 'message_updated',
      status: 'failed',
      content_attributes: { external_error: '(#131047) Re-engagement message' },
    });

    const [fila] = await admin`select state, last_error from motor.outbox where client_id = ${CLINICA} and kind = 'chatwoot'`;
    expect(fila).toMatchObject({ state: 'fallido' });
    expect(String(fila?.['last_error'])).toMatch(/131047/);
    const correos = await salida('correo_operador');
    expect(correos.map((c) => c.asunto)).toEqual(['[Motor de Citas] WhatsApp no ha entregado un mensaje']);
    expect(JSON.stringify(correos)).not.toContain('34600123456');
  });

  it('si no es nuestro (lo escribió el equipo), no se toca nada', async () => {
    await avisar({ ...avisoDeMensaje({ id: 9999, tipo: 'outgoing', texto: 'x' }), event: 'message_updated', status: 'failed' });

    expect(await salida('correo_operador')).toEqual([]);
  });
});

describe('la migración 0021', () => {
  it('devuelve el canal a las conversaciones que entraron por Chatwoot antes de guardarse', async () => {
    await escribe('Quiero cita para axilas');
    await admin`update motor.conversations set reply_channel = null where client_id = ${CLINICA}`;
    const sqlDeLaMigracion = readFileSync('src/db/migrations/0021_mensajes_del_equipo.sql', 'utf8');
    const relleno = sqlDeLaMigracion.slice(sqlDeLaMigracion.indexOf('UPDATE "motor"."conversations"'));

    await admin.unsafe(relleno);

    const [conv] = await admin`select reply_channel from motor.conversations where client_id = ${CLINICA}`;
    expect(conv?.['reply_channel']).toEqual({ por: 'chatwoot', cuentaId: CUENTA, conversacionId: CONVERSACION });
  });
});

describe('el envío', () => {
  it('sale por Chatwoot y se marca enviado', async () => {
    await escribe('Quiero cita para axilas');
    const chatwoot = new ChatwootFalso();

    await ejecutarSalida(core, CLINICA, { correo: new CorreoFalso(), operador: 'op@x.test', chatwoot, ahora: AHORA });

    expect(chatwoot.enviados).toHaveLength(1);
    expect(chatwoot.enviados[0]).toMatchObject({ cuentaId: CUENTA, conversacionId: CONVERSACION, privado: false });
    expect((await admin`select state from motor.outbox where client_id = ${CLINICA} and kind = 'chatwoot'`)[0]?.['state']).toBe('enviado');
  });

  it('un rechazo permanente avisa al operador por correo, sin el teléfono del paciente', async () => {
    await escribe('Quiero cita para axilas');
    const chatwoot = new ChatwootFalso(new EnvioRechazadoError('Chatwoot ha respondido 404', true, 404));

    const r = await ejecutarSalida(core, CLINICA, { correo: new CorreoFalso(), operador: 'op@x.test', chatwoot, ahora: AHORA });

    expect(r.fallidos).toHaveLength(1);
    const correos = await salida('correo_operador');
    expect(correos[0]?.asunto).toMatch(/no ha llegado a Chatwoot/);
    expect(correos[0]?.cuerpo).toMatch(/mensaje al paciente/);
    expect(JSON.stringify(correos)).not.toContain('34600123456');
  });

  it('sin credenciales de Chatwoot, espera: ni se pierde ni se marca fallido', async () => {
    await escribe('Quiero cita para axilas');

    await ejecutarSalida(core, CLINICA, { correo: new CorreoFalso(), operador: 'op@x.test', ahora: AHORA });

    expect((await admin`select state from motor.outbox where client_id = ${CLINICA} and kind = 'chatwoot'`)[0]?.['state']).toBe('pendiente');
  });
});
