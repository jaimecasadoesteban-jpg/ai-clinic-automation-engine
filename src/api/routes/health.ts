import { z } from 'zod';

import { APP_NAME, APP_VERSION } from '../../config/version.js';
import type { App } from '../server.js';

export const healthResponseSchema = z.object({
  estado: z.literal('ok'),
  servicio: z.literal(APP_NAME),
  version: z.string().min(1),
  hora: z.iso.datetime(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const readyResponseSchema = z.object({
  estado: z.enum(['listo', 'no_listo']),
  base: z.enum(['ok', 'inalcanzable']),
  version: z.string().min(1),
  hora: z.iso.datetime(),
});

/**
 * Vida y preparación, que **no son lo mismo y no deben confundirse**.
 *
 * `GET /salud` no toca la base a propósito: dice si el proceso responde. Es lo
 * que va en el `HEALTHCHECK` de Docker, y la razón es que un contenedor que se
 * reinicia porque Postgres está caído **no arregla nada**: vuelve, no encuentra
 * la base tampoco, y se reinicia otra vez, añadiendo una tormenta de arranques a
 * un problema que no es suyo.
 *
 * `GET /listo` sí la toca, con la consulta más barata posible. Es lo que hay que
 * mirar para decidir si mandarle tráfico, para verificar un despliegue y para el
 * monitor externo. Devuelve 503 cuando no puede trabajar, así que un balanceador
 * lo saca de rotación sin que nadie lo mate.
 *
 * Los dos son públicos: exigirles token los haría inútiles para un supervisor
 * que no debería llevar credenciales. Ninguno revela nada.
 */
export async function registerHealthRoutes(app: App): Promise<void> {
  app.get(
    '/salud',
    { schema: { response: { 200: healthResponseSchema } } },
    async () => ({
      estado: 'ok' as const,
      servicio: APP_NAME,
      version: APP_VERSION,
      hora: new Date().toISOString(),
    }),
  );

  app.get(
    '/listo',
    { schema: { response: { 200: readyResponseSchema, 503: readyResponseSchema } } },
    async (_peticion, respuesta) => {
      // Sin dependencias montadas —el servidor de algunos tests— no hay base
      // que comprobar, y decir que está listo sería mentir a medias.
      const alcanzable = app.deps !== undefined && (await app.deps.core.alcanzable());
      if (!alcanzable) {
        // SIN `await`: la respuesta de Fastify es «thenable», así que esperarla
        // aquí es esperar a haberla enviado antes de devolver el cuerpo. Se
        // queda colgado y el balanceador con él, que es peor que un 503.
        respuesta.code(503);
        return {
          estado: 'no_listo' as const,
          base: 'inalcanzable' as const,
          version: APP_VERSION,
          hora: new Date().toISOString(),
        };
      }
      return {
        estado: 'listo' as const,
        base: 'ok' as const,
        version: APP_VERSION,
        hora: new Date().toISOString(),
      };
    },
  );
}
