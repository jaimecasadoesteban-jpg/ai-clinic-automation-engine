import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildServer, type App } from '../../src/api/server.js';
import { createCore, type Core } from '../../src/db/client.js';
import { turnosRecientes } from '../../src/db/queries.js';
import { clinicas } from '../../src/panel/datos.js';
import { claveCorrecta, crearSesion, hashDeClave, LimiteDeIntentos, leerSesion } from '../../src/panel/sesion.js';
import { AgendaFalsa, configDePrueba, dependenciasDePrueba, registroDePrueba } from '../support/fakes.js';
import { APP_URL, conexionAdmin, prepararBaseDeDatos } from '../support/db.js';

/**
 * El panel del operador: una página con datos de salud en internet. Lo que se
 * prueba primero es que no entre nadie más, y después que lo que hace —contestar,
 * parar el agente, atender un escalado— deje el mismo rastro que todo lo demás.
 */

const SECRETO = 'secreto-de-sesiones-del-panel-de-pruebas';
const CLAVE = 'una-contraseña-larga-de-pruebas';
const HASH = hashDeClave(CLAVE);
const AHORA = new Date('2026-09-15T10:00:00.000Z');

describe('la sesión', () => {
  it('la contraseña se comprueba contra su hash, y otra no pasa', () => {
    expect(claveCorrecta(CLAVE, HASH)).toBe(true);
    expect(claveCorrecta('otra', HASH)).toBe(false);
    expect(HASH).not.toContain(CLAVE);
  });

  it('una cookie firmada vale hasta que caduca; tocada o caducada, no', () => {
    const cookie = crearSesion('operador', SECRETO, AHORA);
    expect(leerSesion(cookie, SECRETO, AHORA)).toBe('operador');
    expect(leerSesion(cookie, 'otro-secreto-de-sesiones-cualquiera', AHORA)).toBeUndefined();
    const [u, c, f] = cookie.split('.');
    expect(leerSesion(`${u}.${Number(c) + 1}.${f}`, SECRETO, AHORA)).toBeUndefined();
    expect(leerSesion(cookie, SECRETO, new Date(AHORA.getTime() + 13 * 3_600_000))).toBeUndefined();
  });

  it('cinco fallos bloquean esa IP quince minutos, no a las demás', () => {
    const l = new LimiteDeIntentos();
    for (let i = 0; i < 5; i += 1) l.fallo('1.1.1.1', AHORA);
    expect(l.bloqueado('1.1.1.1', AHORA)).toBe(true);
    expect(l.bloqueado('2.2.2.2', AHORA)).toBe(false);
    expect(l.bloqueado('1.1.1.1', new Date(AHORA.getTime() + 16 * 60_000))).toBe(false);
  });
});

const CLINICA = 'ba7e0000-0000-4000-8000-0000000ba7e0';
const PACIENTE = 'ba7e1111-0000-4000-8000-0000000ba7e0';
const CONVERSACION = 'ba7e2222-0000-4000-8000-0000000ba7e0';
const CHATWOOT = { por: 'chatwoot', cuentaId: 7, conversacionId: 1001 };
const HOST = 'nucleo.test';

const admin = conexionAdmin();
let core: Core;
let app: App;
let agenda: AgendaFalsa;
let cookie = '';

const CONFIG = registroDePrueba([
  {
    slug: 'clinica-de-pruebas',
    config: configDePrueba({ canal: { tipo: 'whatsapp', remitenteId: '000', chatwoot: { cuentaId: 7, inboxId: 42 } } }),
  },
]);

function peticion(metodo: 'GET' | 'POST', url: string, cuerpo?: unknown, cabeceras: Record<string, string> = {}) {
  return app.inject({
    method: metodo,
    url,
    headers: {
      host: HOST,
      ...(metodo === 'POST' ? { 'content-type': 'application/json', 'x-panel': '1', origin: `https://${HOST}` } : {}),
      ...(cookie === '' ? {} : { cookie }),
      ...cabeceras,
    },
    ...(cuerpo === undefined ? {} : { payload: JSON.stringify(cuerpo) }),
  });
}

async function entrar(): Promise<void> {
  const r = await peticion('POST', '/panel/entrar', { usuario: 'operador', clave: CLAVE });
  expect(r.statusCode).toBe(200);
  cookie = String(r.headers['set-cookie']).split(';')[0] ?? '';
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
  for (const tabla of ['outbox', 'audit_log', 'idempotency_keys', 'escalations', 'messages', 'appointments', 'holds', 'conversations', 'patients']) {
    await admin.unsafe(`delete from motor.${tabla} where client_id = $1`, [CLINICA]);
  }
  await admin`delete from motor.clients where id = ${CLINICA}`;
  await admin`insert into motor.clients (id, slug, name, config, config_version) values (${CLINICA}, 'clinica-de-pruebas', 'Clínica', '{}'::jsonb, 'test')`;
  await admin`insert into motor.patients (id, client_id, given_name, phone_e164) values (${PACIENTE}, ${CLINICA}, 'Lola', '+34600123456')`;
  await admin`
    insert into motor.conversations (id, client_id, patient_id, reply_channel)
    values (${CONVERSACION}, ${CLINICA}, ${PACIENTE}, ${JSON.stringify(CHATWOOT)}::jsonb)
  `;
  await admin`
    insert into motor.messages (client_id, conversation_id, direction, body, is_clinical, purge_at, created_at, model)
    values (${CLINICA}, ${CONVERSACION}, 'entrante', 'Hola, ¿tenéis hueco?', false, now() + interval '1 year', ${AHORA.toISOString()}, null),
           (${CLINICA}, ${CONVERSACION}, 'saliente', 'Sí, el martes a las 10:00.', false, now() + interval '1 year', ${new Date(AHORA.getTime() + 1000).toISOString()}, 'claude-opus-5')
  `;
  await admin`
    insert into motor.messages (client_id, conversation_id, direction, body, is_clinical, purge_at, created_at, sent_by)
    values (${CLINICA}, ${CONVERSACION}, 'saliente', 'Te llamo yo, Lola', false, now() + interval '1 year', ${new Date(AHORA.getTime() + 2000).toISOString()}, 'equipo')
  `;
  cookie = '';
  if (app !== undefined) await app.close();
  app = await buildServer({
    logLevel: 'silent',
    token: 'token-del-nucleo-suficientemente-largo',
    deps: dependenciasDePrueba({ core, agenda: (agenda = new AgendaFalsa()), reloj: () => AHORA, configuracion: CONFIG }),
    panel: { usuario: 'operador', claveHash: HASH, secreto: SECRETO },
  });
});

describe('que no entre nadie más', () => {
  it('la página se sirve sin sesión, con una CSP que no deja ejecutar nada de fuera', async () => {
    const r = await peticion('GET', '/panel');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-security-policy']).toMatch(/script-src 'self'/);
    expect(r.headers['x-frame-options']).toBe('DENY');
  });

  it('los datos, no: sin sesión, 401', async () => {
    expect((await peticion('GET', '/panel/api/conversaciones')).statusCode).toBe(401);
  });

  it('una contraseña mala no entra, y la cookie es HttpOnly, Secure y SameSite=Strict', async () => {
    expect((await peticion('POST', '/panel/entrar', { usuario: 'operador', clave: 'mala' })).statusCode).toBe(401);
    expect((await peticion('POST', '/panel/entrar', { usuario: 'otro', clave: CLAVE })).statusCode).toBe(401);
    const bien = await peticion('POST', '/panel/entrar', { usuario: 'operador', clave: CLAVE });
    expect(String(bien.headers['set-cookie'])).toMatch(/HttpOnly; Secure; SameSite=Strict/);
  });

  it('al sexto intento fallido, 429 aunque la contraseña sea buena', async () => {
    for (let i = 0; i < 5; i += 1) await peticion('POST', '/panel/entrar', { usuario: 'operador', clave: 'mala' });
    expect((await peticion('POST', '/panel/entrar', { usuario: 'operador', clave: CLAVE })).statusCode).toBe(429);
  });

  it('con sesión, una escritura desde otro origen o sin la cabecera del panel se rechaza', async () => {
    await entrar();
    const url = `/panel/api/conversaciones/${CLINICA}/${CONVERSACION}/responder`;
    expect((await peticion('POST', url, { texto: 'x' }, { origin: 'https://malo.example' })).statusCode).toBe(403);
    expect((await peticion('POST', url, { texto: 'x' }, { 'x-panel': '0' })).statusCode).toBe(403);
    expect(await admin`select 1 from motor.outbox where client_id = ${CLINICA}`).toHaveLength(0);
  });

  it('el resto del núcleo sigue pidiendo su token: la sesión del panel no abre nada más', async () => {
    await entrar();
    expect((await peticion('GET', '/clinicas')).statusCode).toBe(401);
  });
});

describe('lo que ve', () => {
  it('las conversaciones de todas las clínicas, con su último mensaje', async () => {
    await entrar();
    const lista = (await peticion('GET', '/panel/api/conversaciones')).json() as Array<Record<string, unknown>>;
    expect(lista).toEqual([
      expect.objectContaining({ id: CONVERSACION, nombre: 'Lola', telefono: '+34600123456', ultimo: 'Te llamo yo, Lola', puedeResponder: true }),
    ]);
  });

  it('un chat entero, con quién dijo cada cosa', async () => {
    await entrar();
    const chat = (await peticion('GET', `/panel/api/conversaciones/${CLINICA}/${CONVERSACION}`)).json() as {
      mensajes: Array<{ autor: string; texto: string }>;
    };
    expect(chat.mensajes.map((m) => m.autor)).toEqual(['paciente', 'agente', 'equipo']);
  });

  it('con la misma hora, primero lo que escribió el paciente y después la respuesta, en el panel y en la ventana del modelo', async () => {
    // Un turno guarda las dos cosas con el mismo instante; insertadas al revés
    // para que el orden no salga de la inserción.
    await admin`delete from motor.messages where client_id = ${CLINICA}`;
    const t = new Date(AHORA.getTime() + 60_000).toISOString();
    await admin`
      insert into motor.messages (client_id, conversation_id, direction, body, is_clinical, purge_at, created_at)
      values (${CLINICA}, ${CONVERSACION}, 'saliente', 'respuesta', false, now() + interval '1 year', ${t}),
             (${CLINICA}, ${CONVERSACION}, 'entrante', 'pregunta', false, now() + interval '1 year', ${t})
    `;
    await entrar();

    const chat = (await peticion('GET', `/panel/api/conversaciones/${CLINICA}/${CONVERSACION}`)).json() as { mensajes: Array<{ texto: string }> };
    const lista = (await peticion('GET', '/panel/api/conversaciones')).json() as Array<{ ultimo: string }>;
    const ventana = await core.withClient(CLINICA, (tx) => turnosRecientes(CLINICA, tx, CONVERSACION, 10, AHORA));

    expect(chat.mensajes.map((m) => m.texto)).toEqual(['pregunta', 'respuesta']);
    expect(lista[0]?.ultimo).toBe('respuesta');
    expect(ventana.map((v) => v.texto)).toEqual(['pregunta', 'respuesta']);
  });

  it('una conversación de otra clínica no existe para ésta (regla 1)', async () => {
    await entrar();
    const r = await peticion('GET', `/panel/api/conversaciones/ba7e9999-0000-4000-8000-0000000ba7e0/${CONVERSACION}`);
    expect(r.statusCode).toBe(409);
  });
});

describe('lo que hace', () => {
  it('contestar: sale por Chatwoot, queda como mensaje de una persona y en auditoría sin el texto', async () => {
    await entrar();

    const r = await peticion('POST', `/panel/api/conversaciones/${CLINICA}/${CONVERSACION}/responder`, { texto: 'Te llamo en cinco minutos' });

    expect(r.statusCode).toBe(200);
    const [salida] = await admin`select payload from motor.outbox where client_id = ${CLINICA} and kind = 'chatwoot'`;
    expect(salida?.['payload']).toEqual({ ...CHATWOOT, por: undefined, texto: 'Te llamo en cinco minutos', privado: false });
    const [mensaje] = await admin`select sent_by, model from motor.messages where client_id = ${CLINICA} and body = 'Te llamo en cinco minutos'`;
    expect(mensaje).toMatchObject({ sent_by: 'panel', model: null });
    const [auditoria] = await admin`select actor, payload from motor.audit_log where client_id = ${CLINICA} and action = 'mensaje_del_panel'`;
    expect(auditoria?.['actor']).toBe('operador');
    expect(JSON.stringify(auditoria?.['payload'])).not.toContain('cinco minutos');
  });

  it('pasadas 24 h desde su último mensaje, no se deja escribir texto libre: WhatsApp no lo entregaría', async () => {
    await admin`update motor.messages set created_at = ${new Date(AHORA.getTime() - 25 * 3_600_000).toISOString()} where client_id = ${CLINICA}`;
    await entrar();

    const chat = (await peticion('GET', `/panel/api/conversaciones/${CLINICA}/${CONVERSACION}`)).json() as { ventanaAbierta: boolean };
    const r = await peticion('POST', `/panel/api/conversaciones/${CLINICA}/${CONVERSACION}/responder`, { texto: 'hola' });

    expect(chat.ventanaAbierta).toBe(false);
    expect(r.statusCode).toBe(409);
    expect(String((r.json() as { mensaje: string }).mensaje)).toMatch(/24 h/);
    expect(await admin`select 1 from motor.outbox where client_id = ${CLINICA}`).toHaveLength(0);
  });

  it('contestar a una conversación sin canal no finge que sale: 409 y nada encolado', async () => {
    await entrar();
    await admin`update motor.conversations set reply_channel = null where id = ${CONVERSACION}`;

    const r = await peticion('POST', `/panel/api/conversaciones/${CLINICA}/${CONVERSACION}/responder`, { texto: 'hola' });

    expect(r.statusCode).toBe(409);
    expect(await admin`select 1 from motor.outbox where client_id = ${CLINICA}`).toHaveLength(0);
    expect(await admin`select 1 from motor.messages where client_id = ${CLINICA} and body = 'hola'`).toHaveLength(0);
  });

  it('parar el agente: la base manda, y la etiqueta de Chatwoot se mueve para decir lo mismo', async () => {
    await entrar();

    await peticion('POST', `/panel/api/pacientes/${CLINICA}/${PACIENTE}/agente`, { parado: true });

    const [p] = await admin`select agent_stopped_at, agent_stopped_by from motor.patients where id = ${PACIENTE}`;
    expect(p?.['agent_stopped_at']).not.toBeNull();
    expect(p?.['agent_stopped_by']).toBe('panel:operador');
    const [etiqueta] = await admin`select payload from motor.outbox where client_id = ${CLINICA} and kind = 'chatwoot'`;
    expect(etiqueta?.['payload']).toEqual({ cuentaId: 7, conversacionId: 1001, etiqueta: 'agente-parado', poner: true });

    await peticion('POST', `/panel/api/pacientes/${CLINICA}/${PACIENTE}/agente`, { parado: false });

    const acciones = await admin`select action, actor from motor.audit_log where client_id = ${CLINICA} and entity = 'patients' order by created_at`;
    expect(acciones.map((a) => [a['action'], a['actor']])).toEqual([
      ['agente_parado', 'operador'],
      ['agente_reactivado', 'operador'],
    ]);
  });

  it('asistencia: una cita pasada aparece para marcarla, y «Asistió» la anota; una futura, no se deja', async () => {
    await entrar();
    async function citaA(inicio: Date): Promise<string> {
      const fin = new Date(inicio.getTime() + 20 * 60_000).toISOString();
      const [h] = await admin`
        insert into motor.holds (client_id, patient_id, conversation_id, slot_start, slot_end, service_code, state, state_changed_at)
        values (${CLINICA}, ${PACIENTE}, ${CONVERSACION}, ${inicio.toISOString()}, ${fin}, 'laser-axilas', 'confirmada', ${inicio.toISOString()}) returning id
      `;
      const [c] = await admin`
        insert into motor.appointments (client_id, patient_id, conversation_id, hold_id, slot_start, slot_end, service_code)
        values (${CLINICA}, ${PACIENTE}, ${CONVERSACION}, ${String(h?.['id'])}, ${inicio.toISOString()}, ${fin}, 'laser-axilas') returning id
      `;
      return String(c?.['id']);
    }
    const pasada = await citaA(new Date(AHORA.getTime() - 2 * 86_400_000));
    const futura = await citaA(new Date(AHORA.getTime() + 2 * 86_400_000));

    const lista = (await peticion('GET', '/panel/api/asistencia')).json() as Array<{ id: string; servicio: string }>;
    expect(lista.map((c) => c.id)).toEqual([pasada]);
    expect(lista[0]?.servicio).toBe('Láser axilas');

    const bien = await peticion('POST', `/panel/api/citas/${CLINICA}/${pasada}/asistencia`, { resultado: 'asistida' });
    const mal = await peticion('POST', `/panel/api/citas/${CLINICA}/${futura}/asistencia`, { resultado: 'asistida' });

    expect(bien.statusCode).toBe(200);
    expect(mal.statusCode).toBe(409);
    const [fila] = await admin`select outcome, attendance_source from motor.appointments where id = ${pasada}`;
    expect(fila).toMatchObject({ outcome: 'asistida', attendance_source: 'recepcion' });
    await admin`delete from motor.appointments where client_id = ${CLINICA}`;
  });

  it('calendario: la semana en hora de la clínica, con cada cita en su día y su minuto; sin propuestas ni caducadas', async () => {
    await entrar();
    // AHORA es el martes 15 de septiembre: la semana va del lunes 14 al domingo 20.
    for (const [inicio, estado] of [
      ['2026-09-16T08:00:00.000Z', 'confirmada'], // miércoles 10:00 en Madrid
      ['2026-09-17T15:30:00.000Z', 'retenida'], // jueves 17:30
      ['2026-09-18T08:00:00.000Z', 'propuesta'], // no es una cita
      ['2026-09-18T10:00:00.000Z', 'caducada'], // tampoco
      ['2026-09-22T08:00:00.000Z', 'confirmada'], // la semana que viene
    ] as const) {
      await admin`
        insert into motor.holds (client_id, patient_id, conversation_id, slot_start, slot_end, service_code, state, state_changed_at)
        values (${CLINICA}, ${PACIENTE}, ${CONVERSACION}, ${inicio}, ${new Date(new Date(inicio).getTime() + 20 * 60_000).toISOString()},
                'laser-axilas', ${estado}::motor.hold_state, ${AHORA.toISOString()})
      `;
    }

    const r = (await peticion('GET', '/panel/api/calendario?semana=0')).json() as {
      clinicas: Array<{ dias: Array<{ fecha: string; esHoy: boolean }>; citas: Array<{ dia: number; inicioMin: number; finMin: number; estado: string; servicio: string }> }>;
    };
    const [c] = r.clinicas;

    expect(c?.dias.map((d) => d.fecha)).toEqual(['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20']);
    expect(c?.dias[1]?.esHoy).toBe(true);
    expect(c?.citas).toEqual([
      expect.objectContaining({ dia: 2, inicioMin: 600, finMin: 620, estado: 'confirmada', servicio: 'Láser axilas' }),
      expect.objectContaining({ dia: 3, inicioMin: 17 * 60 + 30, estado: 'retenida' }),
    ]);
    const siguiente = (await peticion('GET', '/panel/api/calendario?semana=1')).json() as typeof r;
    expect(siguiente.clinicas[0]?.citas.map((x) => x.dia)).toEqual([1]);
  });

  it('«Ya la he metido»: relee, confirma, y la confirmación al paciente sale por su Chatwoot en la misma transacción', async () => {
    await entrar();
    const inicio = new Date(AHORA.getTime() + 3 * 86_400_000).toISOString();
    const [h] = await admin`
      insert into motor.holds (client_id, patient_id, conversation_id, slot_start, slot_end, service_code, state, state_changed_at, reception_notified_at)
      values (${CLINICA}, ${PACIENTE}, ${CONVERSACION}, ${inicio}, ${new Date(new Date(inicio).getTime() + 20 * 60_000).toISOString()},
              'laser-axilas', 'pendiente_recepcion', ${AHORA.toISOString()}, ${AHORA.toISOString()}) returning id
    `;
    const holdId = String(h?.['id']);

    const r = await peticion('POST', `/panel/api/huecos/${CLINICA}/${holdId}/metida`, {});

    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ estado: 'confirmada' });
    expect((await admin`select state from motor.holds where id = ${holdId}`)[0]?.['state']).toBe('confirmada');
    const [m] = await admin`select payload from motor.outbox where client_id = ${CLINICA} and kind = 'chatwoot'`;
    expect(m?.['payload']).toMatchObject({ cuentaId: 7, conversacionId: 1001, privado: false });
    expect(String((m?.['payload'] as { texto: string }).texto)).toMatch(/láser axilas/i);
    const [a] = await admin`select actor from motor.audit_log where client_id = ${CLINICA} and action = 'metida_desde_el_panel:confirmada'`;
    expect(a?.['actor']).toBe('operador');
    await admin`delete from motor.outbox where client_id = ${CLINICA}`;
    await admin`delete from motor.appointments where client_id = ${CLINICA}`;
  });

  it('«Ya la he metido» con la agenda caída: no confirma nada y dice que hay que volver a pulsar', async () => {
    await entrar();
    const inicio = new Date(AHORA.getTime() + 3 * 86_400_000).toISOString();
    const [h] = await admin`
      insert into motor.holds (client_id, patient_id, conversation_id, slot_start, slot_end, service_code, state, state_changed_at, reception_notified_at)
      values (${CLINICA}, ${PACIENTE}, ${CONVERSACION}, ${inicio}, ${new Date(new Date(inicio).getTime() + 20 * 60_000).toISOString()},
              'laser-axilas', 'pendiente_recepcion', ${AHORA.toISOString()}, ${AHORA.toISOString()}) returning id
    `;
    agenda.fallarAlReleer();

    const r = await peticion('POST', `/panel/api/huecos/${CLINICA}/${String(h?.['id'])}/metida`, {});

    expect(r.json()).toMatchObject({ estado: 'agenda_no_disponible' });
    expect(String((r.json() as { mensaje: string }).mensaje)).toMatch(/vuelve a pulsar/);
    expect((await admin`select state from motor.holds where id = ${String(h?.['id'])}`)[0]?.['state']).toBe('pendiente_recepcion');
    expect(await admin`select 1 from motor.outbox where client_id = ${CLINICA} and kind = 'chatwoot'`).toHaveLength(0);
  });

  it('el inicio: lo de hoy en hora de la clínica, lo que necesita atención y lo del mes', async () => {
    await entrar();
    const hoyALas = (h: number) => new Date(Date.UTC(2026, 8, 15, h - 2)).toISOString(); // martes 15, Madrid UTC+2
    await admin`
      insert into motor.holds (client_id, patient_id, conversation_id, slot_start, slot_end, service_code, state, state_changed_at)
      values (${CLINICA}, ${PACIENTE}, ${CONVERSACION}, ${hoyALas(17)}, ${hoyALas(18)}, 'laser-axilas', 'pendiente_recepcion', ${AHORA.toISOString()}),
             (${CLINICA}, ${PACIENTE}, ${CONVERSACION}, ${hoyALas(19)}, ${hoyALas(20)}, 'laser-axilas', 'propuesta', ${AHORA.toISOString()})
    `;

    const [c] = (await peticion('GET', '/panel/api/resumen')).json() as Array<{ cifras: Record<string, number>; deHoy: Array<{ estado: string }> }>;

    expect(c?.deHoy.map((x) => x.estado)).toEqual(['pendiente_recepcion']);
    expect(c?.cifras).toMatchObject({ pendientes_recepcion: 1, semana: 1, chats_hoy: 1 });
  });

  it('atender un escalado lo cierra con el nombre del operador', async () => {
    await entrar();
    const [e] = await admin`
      insert into motor.escalations (client_id, conversation_id, patient_id, reason, severity, created_at)
      values (${CLINICA}, ${CONVERSACION}, ${PACIENTE}, 'queja', 2, ${AHORA.toISOString()}) returning id
    `;

    // Como el navegador: un POST sin datos va con {}.
    const r = await peticion('POST', `/panel/api/escalados/${CLINICA}/${String(e?.['id'])}/atendido`, {});

    expect(r.statusCode).toBe(200);
    const [fila] = await admin`select state, assignee from motor.escalations where id = ${String(e?.['id'])}`;
    expect(fila).toMatchObject({ state: 'atendida', assignee: 'operador' });
  });
});

describe('lo que tarda', () => {
  it('el id de la clínica se pregunta a la base una vez por minuto, no en cada petición', async () => {
    let preguntas = 0;
    const contado: Core = { ...core, idDeClinicaPorSlug: async (slug) => { preguntas += 1; return core.idDeClinicaPorSlug(slug); } };
    const deps = dependenciasDePrueba({ core: contado, agenda: new AgendaFalsa(), reloj: () => AHORA, configuracion: CONFIG });
    const primera = await clinicas(deps);
    await clinicas(deps);
    await clinicas(deps);
    expect(primera.map((c) => c.clientId)).toEqual([CLINICA]);
    expect(preguntas).toBe(1);
  });
});
