import { z } from 'zod';

import * as q from '../../db/queries.js';
import type { Dependencias } from '../../service/pipeline.js';
import { extraerMensajes, firmaValida } from '../../service/whatsapp/entrada.js';
import type { App } from '../server.js';

/**
 * `GET|POST /whatsapp` — el webhook de Meta, sin n8n en medio.
 *
 * **No lleva el token del núcleo** —Meta no puede mandarlo— y por eso es la única
 * ruta expuesta a internet. Lo que la protege es la firma `X-Hub-Signature-256`,
 * que sólo puede calcular quien tenga el App Secret. Sin firma válida: 401, y no
 * se guarda nada.
 *
 * **Guarda y responde; no procesa.** El turno, con el modelo de por medio, puede
 * tardar más de lo que Meta espera, y Meta reintenta lo que no recibe a tiempo.
 * Así que el mensaje va a la bandeja de entrada, se responde 200 y lo procesa
 * `service/bandeja.ts`. Si se respondiera 200 sin guardarlo, una caída lo
 * perdería.
 */
export interface OpcionesDeWhatsApp {
  readonly appSecret: string;
  readonly verifyToken: string;
  /** Para avisar al procesador de que hay algo nuevo, sin esperar a su ciclo. */
  readonly alRecibir: () => void;
}

export function registrarRutasDeWhatsApp(deps: Dependencias, opciones: OpcionesDeWhatsApp) {
  return async (app: App): Promise<void> => {
    // El cuerpo crudo, sólo aquí: la firma se calcula sobre los bytes exactos.
    app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, cuerpo, hecho) => {
      hecho(null, cuerpo);
    });

    // Verificación del webhook: Meta la hace una vez, al configurarlo.
    app.get(
      '/whatsapp',
      {
        schema: {
          querystring: z.object({
            'hub.mode': z.string().optional(),
            'hub.verify_token': z.string().optional(),
            'hub.challenge': z.string().optional(),
          }),
        },
      },
      async (request, reply) => {
        const consulta = request.query;
        if (consulta['hub.mode'] === 'subscribe' && consulta['hub.verify_token'] === opciones.verifyToken) {
          return reply.type('text/plain').send(consulta['hub.challenge'] ?? '');
        }
        request.log.warn('verificación del webhook de WhatsApp rechazada');
        return reply.status(403).send({ error: 'verificacion_rechazada', mensaje: 'Token de verificación incorrecto.', requestId: request.id });
      },
    );

    app.post('/whatsapp', async (request, reply) => {
      const crudo = request.body;
      const cabecera = request.headers['x-hub-signature-256'];
      if (!(crudo instanceof Buffer) || !firmaValida(crudo, typeof cabecera === 'string' ? cabecera : undefined, opciones.appSecret)) {
        request.log.warn('webhook de WhatsApp con firma inválida');
        return reply.status(401).send({ error: 'firma_invalida', mensaje: 'La firma no es válida.', requestId: request.id });
      }

      let payload: unknown;
      try {
        payload = JSON.parse(crudo.toString('utf8'));
      } catch {
        return reply.status(400).send({ error: 'json_invalido', mensaje: 'El cuerpo no es JSON.', requestId: request.id });
      }

      let nuevos = 0;
      const ahora = deps.reloj();
      for (const entrante of extraerMensajes(payload)) {
        const slug = deps.configuracion.porRemitente(entrante.remitenteId);
        const clientId = slug === undefined ? undefined : await deps.core.idDeClinicaPorSlug(slug);
        if (clientId === undefined) {
          // Ninguna clínica tiene esa línea. Se registra y se contesta 200: si no,
          // Meta reintentaría durante días algo que no tiene destino.
          request.log.error({ remitenteId: entrante.remitenteId }, 'mensaje de WhatsApp para una línea sin clínica');
          continue;
        }
        const nuevo = await deps.core.withClient(clientId, (tx) =>
          q.guardarEnBandeja(clientId, tx, { providerMessageId: entrante.id, payload: entrante.mensaje, ahora }),
        );
        if (nuevo) nuevos += 1;
      }

      if (nuevos > 0) opciones.alRecibir();
      return reply.send({ recibidos: nuevos });
    });
  };
}
