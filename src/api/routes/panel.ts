import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { isDomainError } from '../../core/errors.js';
import {
  anotarAsistencia,
  atenderEscalado,
  cambiarAgente,
  clinicas,
  listarAsistencia,
  meterEnAgenda,
  resumen,
  semanaDelCalendario,
  listarCitas,
  listarConversaciones,
  listarEscalados,
  responder,
  verConversacion,
} from '../../panel/datos.js';
import { CSS, HTML, JS } from '../../panel/pagina.js';
import { COOKIE, HORAS_DE_SESION, LimiteDeIntentos, claveCorrecta, crearSesion, leerSesion } from '../../panel/sesion.js';
import type { Dependencias } from '../../service/pipeline.js';
import type { App } from '../server.js';

/**
 * `/panel` — la interfaz del operador, servida por el núcleo.
 *
 * No lleva el token del núcleo (lo usaría un navegador): lo protege su propia
 * sesión. Todo lo de `/panel/api` exige la cookie firmada, y lo que escribe
 * exige además la cabecera `x-panel` y un `Origin` del mismo sitio —con
 * `SameSite=Strict`, otra web no puede hacer que el navegador del operador
 * conteste a un paciente—.
 */
export interface OpcionesDePanel {
  readonly usuario: string;
  readonly claveHash: string;
  readonly secreto: string;
}

function cookieDe(request: FastifyRequest): string | undefined {
  const cabecera = request.headers.cookie;
  if (cabecera === undefined) return undefined;
  for (const parte of cabecera.split(';')) {
    const [nombre, ...valor] = parte.trim().split('=');
    if (nombre === COOKIE) return valor.join('=');
  }
  return undefined;
}

const SEGURIDAD = {
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
} as const;

const uuid = z.uuid();

export function registrarRutasDelPanel(deps: Dependencias, opciones: OpcionesDePanel) {
  const intentos = new LimiteDeIntentos();

  return async (app: App): Promise<void> => {
    const operador = (request: FastifyRequest): string | undefined => leerSesion(cookieDe(request), opciones.secreto, deps.reloj());

    // Guardia de todo /panel/api: sesión, y en lo que escribe, mismo origen.
    app.addHook('preHandler', async (request, reply) => {
      reply.headers(SEGURIDAD);
      const ruta = request.url.split('?')[0] ?? '';
      if (!ruta.startsWith('/panel/api/')) return;
      if (operador(request) === undefined) {
        return reply.status(401).send({ error: 'sin_sesion', mensaje: 'Inicia sesión.', requestId: request.id });
      }
      if (request.method !== 'GET' && !mismoOrigen(request)) {
        return reply.status(403).send({ error: 'origen', mensaje: 'Petición de otro origen.', requestId: request.id });
      }
      return undefined;
    });

    app.get('/panel', async (_request, reply) =>
      reply
        .type('text/html; charset=utf-8')
        .header(
          'content-security-policy',
          "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        )
        .send(HTML),
    );
    app.get('/panel/app.js', async (_request, reply) => reply.type('text/javascript; charset=utf-8').send(JS));
    app.get('/panel/app.css', async (_request, reply) => reply.type('text/css; charset=utf-8').send(CSS));

    app.post(
      '/panel/entrar',
      { schema: { body: z.object({ usuario: z.string().max(200), clave: z.string().max(500) }) } },
      async (request, reply) => {
        const ahora = deps.reloj();
        const ip = request.ip;
        if (!mismoOrigen(request)) return reply.status(403).send({ error: 'origen', mensaje: 'Petición de otro origen.' });
        if (intentos.bloqueado(ip, ahora)) {
          return reply.status(429).send({ error: 'demasiados_intentos', mensaje: 'Demasiados intentos. Espera 15 minutos.' });
        }
        const { usuario, clave } = request.body;
        // Se calcula siempre el hash, también con el usuario mal: el tiempo de
        // respuesta no dice si el usuario existe.
        const claveBien = claveCorrecta(clave, opciones.claveHash);
        if (!claveBien || usuario !== opciones.usuario) {
          intentos.fallo(ip, ahora);
          request.log.warn('panel: intento de acceso fallido');
          return reply.status(401).send({ error: 'credenciales', mensaje: 'Usuario o contraseña incorrectos.' });
        }
        intentos.acierto(ip);
        request.log.info('panel: sesión iniciada');
        return reply
          .header(
            'set-cookie',
            `${COOKIE}=${crearSesion(usuario, opciones.secreto, ahora)}; Path=/panel; HttpOnly; Secure; SameSite=Strict; Max-Age=${HORAS_DE_SESION * 3600}`,
          )
          .send({ ok: true });
      },
    );

    app.post('/panel/salir', async (_request, reply) =>
      reply.header('set-cookie', `${COOKIE}=; Path=/panel; HttpOnly; Secure; SameSite=Strict; Max-Age=0`).send({ ok: true }),
    );

    app.get('/panel/api/yo', async (request) => ({ usuario: operador(request), clinicas: await clinicas(deps) }));
    app.get('/panel/api/conversaciones', async () => listarConversaciones(deps));
    app.get('/panel/api/citas', async () => listarCitas(deps));
    app.get('/panel/api/escalados', async () => listarEscalados(deps));
    app.get('/panel/api/asistencia', async () => listarAsistencia(deps));
    app.get('/panel/api/resumen', async () => resumen(deps));

    app.post(
      '/panel/api/huecos/:clientId/:id/metida',
      { schema: { params: z.object({ clientId: uuid, id: uuid }) } },
      async (request, reply) =>
        conError(reply, () => meterEnAgenda(deps, { clientId: request.params.clientId, holdId: request.params.id, operador: operador(request) ?? '?' })),
    );
    app.get(
      '/panel/api/calendario',
      { schema: { querystring: z.object({ semana: z.coerce.number().int().min(-260).max(260).default(0) }) } },
      async (request) => semanaDelCalendario(deps, request.query.semana),
    );

    app.post(
      '/panel/api/citas/:clientId/:id/asistencia',
      {
        schema: {
          params: z.object({ clientId: uuid, id: uuid }),
          body: z.object({ resultado: z.enum(['asistida', 'no_asistida']) }),
        },
      },
      async (request, reply) =>
        conError(reply, () => anotarAsistencia(deps, { clientId: request.params.clientId, citaId: request.params.id, resultado: request.body.resultado })),
    );

    app.get(
      '/panel/api/conversaciones/:clientId/:id',
      { schema: { params: z.object({ clientId: uuid, id: uuid }) } },
      async (request, reply) => conError(reply, () => verConversacion(deps, request.params.clientId, request.params.id)),
    );

    app.post(
      '/panel/api/conversaciones/:clientId/:id/responder',
      { schema: { params: z.object({ clientId: uuid, id: uuid }), body: z.object({ texto: z.string().min(1).max(4096) }) } },
      async (request, reply) =>
        conError(reply, () =>
          responder(deps, {
            clientId: request.params.clientId,
            conversationId: request.params.id,
            texto: request.body.texto,
            operador: operador(request) ?? '?',
          }),
        ),
    );

    app.post(
      '/panel/api/pacientes/:clientId/:id/agente',
      { schema: { params: z.object({ clientId: uuid, id: uuid }), body: z.object({ parado: z.boolean() }) } },
      async (request, reply) =>
        conError(reply, () =>
          cambiarAgente(deps, {
            clientId: request.params.clientId,
            pacienteId: request.params.id,
            parado: request.body.parado,
            operador: operador(request) ?? '?',
          }),
        ),
    );

    app.post(
      '/panel/api/escalados/:clientId/:id/atendido',
      { schema: { params: z.object({ clientId: uuid, id: uuid }) } },
      async (request, reply) =>
        conError(reply, () =>
          atenderEscalado(deps, { clientId: request.params.clientId, escaladoId: request.params.id, operador: operador(request) ?? '?' }),
        ),
    );
  };
}

/** `Origin` (o, sin él, `Referer`) del mismo host, y la cabecera propia del panel. */
function mismoOrigen(request: FastifyRequest): boolean {
  if (request.headers['x-panel'] !== '1') return false;
  const origen = request.headers.origin ?? request.headers.referer;
  if (origen === undefined) return false;
  try {
    return new URL(origen).host === request.headers.host;
  } catch {
    return false;
  }
}

async function conError<T>(reply: FastifyReply, f: () => Promise<T>): Promise<T | FastifyReply> {
  try {
    return await f();
  } catch (error: unknown) {
    if (isDomainError(error)) {
      return reply.status(error.httpStatus).send({ error: error.code, mensaje: error.message });
    }
    throw error;
  }
}
