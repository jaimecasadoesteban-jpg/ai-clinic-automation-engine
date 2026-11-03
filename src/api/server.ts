import { registrarRutasDeChatwoot, type OpcionesDeChatwoot } from './routes/chatwoot.js';
import { registrarRutasDelPanel, type OpcionesDePanel } from './routes/panel.js';
import { registrarRutasDeWhatsApp, type OpcionesDeWhatsApp } from './routes/whatsapp.js';
import { randomUUID } from 'node:crypto';

import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type RawReplyDefaultExpression,
  type RawRequestDefaultExpression,
  type RawServerDefault,
} from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

import { isDomainError } from '../core/errors.js';
import { registrarAutenticacion } from './auth.js';
import type { Dependencias } from '../service/pipeline.js';
import { registerHealthRoutes } from './routes/health.js';
import { registrarRutasDeMantenimiento, registrarRutasDeMensajes } from './routes/mensajes.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Sólo lo usa `/listo`, para preguntarle a la base si está ahí. */
    deps?: Dependencias;
  }
}

/**
 * Instancia de Fastify con el proveedor de tipos de Zod ya aplicado.
 * Toda ruta del proyecto se declara sobre este tipo: es lo que hace que
 * `schema: { body, response }` valide en ejecución y tipe en compilación.
 */
export type App = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;

export interface BuildServerOptions {
  logLevel?: string;
  /**
   * Sin dependencias sólo se monta `/salud`. Así los tests del andamiaje siguen
   * corriendo sin base de datos, que es justo lo que comprueban.
   */
  deps?: Dependencias;
  /**
   * Token compartido con n8n. Sin él no se monta la autenticación, y eso sólo
   * es aceptable en tests: `src/index.ts` lo exige siempre.
   */
  token?: string;
  /** Sin esto no se monta `/whatsapp`: el webhook sigue llegando a n8n. */
  whatsapp?: OpcionesDeWhatsApp;
  /** Sin esto no se monta `/chatwoot`. */
  chatwoot?: OpcionesDeChatwoot;
  /** Sin esto no se monta `/panel`. */
  panel?: OpcionesDePanel;
}

/**
 * Construye la instancia de Fastify sin escucharla. Los tests la usan con
 * `app.inject()`; `src/index.ts` es quien la pone a escuchar.
 */
export async function buildServer(options: BuildServerOptions = {}): Promise<App> {
  const app = Fastify({
    // Detrás del proxy de la plataforma de despliegue (un salto): la IP del cliente es la que
    // añade el proxy, no la del proxy. Sin esto, el límite de intentos del
    // panel contaría a todo el mundo como una sola IP y bloquearía a todos.
    trustProxy: 1,
    logger: {
      level: options.logLevel ?? 'info',
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie'],
        censor: '[oculto]',
      },
    },
    genReqId: () => randomUUID(),
  }).withTypeProvider<ZodTypeProvider>();

  // Zod compila la validación de entrada y la serialización de salida.
  // Nada entra ni sale de un endpoint sin pasar por su esquema.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Regla 4 — ninguna ruta termina en silencio. Ni las que no existen,
  // ni las que revientan: toda respuesta sale con un cuerpo explicable.
  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({
      error: 'not_found',
      mensaje: `No existe la ruta ${request.method} ${request.url}.`,
      requestId: request.id,
    });
  });

  app.setErrorHandler((error, request, reply) => {
    if (isDomainError(error)) {
      request.log.warn({ err: error, code: error.code }, 'error de dominio');
      void reply.status(error.httpStatus).send({
        error: error.code,
        mensaje: error.message,
        ...(error.patientMessage === null ? {} : { mensajePaciente: error.patientMessage }),
        requestId: request.id,
      });
      return;
    }

    // Entrada que no cumple su esquema: culpa de quien llama (n8n).
    if (hasZodFastifySchemaValidationErrors(error)) {
      request.log.warn({ err: error }, 'entrada no supera su esquema');
      void reply.status(400).send({
        error: 'validation_error',
        mensaje: 'La petición no cumple el esquema esperado.',
        problemas: error.validation.map((issue) => issue.message),
        requestId: request.id,
      });
      return;
    }

    // Salida que no cumple su esquema: culpa nuestra. Se registra entera y se
    // corta con un 500 antes de que salga del núcleo un cuerpo no conforme.
    if (isResponseSerializationError(error)) {
      request.log.error({ err: error, method: error.method, url: error.url }, 'la respuesta del núcleo no cumple su esquema');
      void reply.status(500).send({
        error: 'response_schema_error',
        mensaje: 'El núcleo ha generado una respuesta que no cumple su esquema.',
        requestId: request.id,
      });
      return;
    }

    // Desconocido: se registra entero, pero al exterior no sale nada del interior.
    request.log.error({ err: error }, 'error no controlado');
    void reply.status(500).send({
      error: 'internal_error',
      mensaje: 'Error interno del núcleo.',
      requestId: request.id,
    });
  });

  if (options.token !== undefined) registrarAutenticacion(app, options.token);

  if (options.deps !== undefined) {
    // `/listo` necesita la base; se decora antes de registrar las rutas.
    app.decorate('deps', options.deps);
  }
  await app.register(registerHealthRoutes);
  if (options.deps !== undefined) {
    await app.register(registrarRutasDeMensajes(options.deps));
    await app.register(registrarRutasDeMantenimiento(options.deps));
    if (options.whatsapp !== undefined) {
      await app.register(registrarRutasDeWhatsApp(options.deps, options.whatsapp));
    }
    if (options.chatwoot !== undefined) {
      await app.register(registrarRutasDeChatwoot(options.deps, options.chatwoot));
    }
    if (options.panel !== undefined) {
      await app.register(registrarRutasDelPanel(options.deps, options.panel));
    }
  }

  return app;
}
