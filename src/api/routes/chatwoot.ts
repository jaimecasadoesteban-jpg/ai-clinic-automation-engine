import * as q from '../../db/queries.js';
import type { Tx } from '../../db/client.js';
import { leerAvisoDeChatwoot, firmaDeChatwootValida, type AvisoDeChatwoot } from '../../service/chatwoot/entrada.js';
import { ponerInterruptor } from '../../service/interruptor.js';
import type { Dependencias } from '../../service/pipeline.js';
import type { App } from '../server.js';

/**
 * `POST /chatwoot` — el webhook de Chatwoot: WhatsApp con coexistencia.
 *
 * Como `/whatsapp`, **no lleva el token del núcleo**: lo protege la firma
 * `X-Chatwoot-Signature`, que sólo calcula quien tiene el secreto del webhook,
 * y la hora firmada, que impide repetir un aviso viejo. Sin firma válida: 401 y
 * no se guarda nada.
 *
 * Atiende dos cosas:
 * - **Un mensaje del paciente**: a la bandeja, 200 y se procesa después, igual
 *   que lo de Meta. Lo que escribe el equipo, el propio agente o una nota
 *   privada no es un mensaje del paciente y no entra.
 * - **Las etiquetas de la conversación**: la etiqueta `agente-parado` (o la que
 *   diga el YAML) es el interruptor del agente.
 */
/** Lo que espera un mensaje saliente antes de procesarse. Ver arriba. */
export const SEGUNDOS_DE_ESPERA_DEL_ECO = 20;

export interface OpcionesDeChatwoot {
  readonly secreto: string;
  readonly alRecibir: () => void;
}

export function registrarRutasDeChatwoot(deps: Dependencias, opciones: OpcionesDeChatwoot) {
  return async (app: App): Promise<void> => {
    // El cuerpo crudo, sólo aquí: la firma se calcula sobre los bytes exactos.
    app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, cuerpo, hecho) => {
      hecho(null, cuerpo);
    });

    app.post('/chatwoot', async (request, reply) => {
      const crudo = request.body;
      const firma = request.headers['x-chatwoot-signature'];
      const marca = request.headers['x-chatwoot-timestamp'];
      const ahora = deps.reloj();
      if (
        !(crudo instanceof Buffer) ||
        !firmaDeChatwootValida({
          cuerpoCrudo: crudo,
          firma: typeof firma === 'string' ? firma : undefined,
          marcaDeTiempo: typeof marca === 'string' ? marca : undefined,
          secreto: opciones.secreto,
          ahora,
        })
      ) {
        request.log.warn('webhook de Chatwoot con firma inválida o caducada');
        return reply.status(401).send({ error: 'firma_invalida', mensaje: 'La firma no es válida.', requestId: request.id });
      }

      let payload: unknown;
      try {
        payload = JSON.parse(crudo.toString('utf8'));
      } catch {
        return reply.status(400).send({ error: 'json_invalido', mensaje: 'El cuerpo no es JSON.', requestId: request.id });
      }

      const aviso = leerAvisoDeChatwoot(payload);
      if (aviso === undefined) return reply.send({ recibidos: 0 });

      const slug = deps.configuracion.porInboxDeChatwoot(aviso.donde.cuentaId, aviso.donde.inboxId);
      const clientId = slug === undefined ? undefined : await deps.core.idDeClinicaPorSlug(slug);
      if (slug === undefined || clientId === undefined) {
        // Ningún inbox de ninguna clínica. 200: si no, Chatwoot reintentaría
        // algo que no tiene destino.
        request.log.error(
          { cuentaId: aviso.donde.cuentaId, inboxId: aviso.donde.inboxId },
          'aviso de Chatwoot para un inbox sin clínica',
        );
        return reply.send({ recibidos: 0 });
      }
      if (aviso.tipo === 'fallo_de_entrega') {
        await deps.core.withClient(clientId, (tx) => registrarFalloDeEntrega(clientId, tx, aviso, ahora));
        return reply.send({ recibidos: 0 });
      }
      const canal = deps.configuracion.obtener(slug).config.canal.chatwoot;
      const etiqueta = canal?.etiquetaAgenteParado ?? 'agente-parado';
      const telefonoDelAviso = aviso.tipo === 'mensaje' ? aviso.mensaje.telefono : aviso.telefono;
      if (canal?.soloTelefonos !== undefined && !canal.soloTelefonos.includes(telefonoDelAviso)) {
        // En pruebas: fuera de la lista, el núcleo no existe para esa persona.
        // Sin el teléfono en el log (regla 2 vale también para lo que leemos).
        request.log.info({ clinica: slug }, 'aviso de Chatwoot de un teléfono fuera de soloTelefonos: ignorado');
        return reply.send({ recibidos: 0 });
      }

      const nuevo = await deps.core.withClient(clientId, async (tx) => {
        const telefono = aviso.tipo === 'mensaje' ? aviso.mensaje.telefono : aviso.telefono;
        const nombre = aviso.tipo === 'mensaje' ? aviso.mensaje.nombre : aviso.nombre;
        // Antes de guardar el mensaje: si viene con la etiqueta puesta, el
        // turno ya tiene que encontrarse el agente parado.
        if (aviso.etiquetas !== undefined) {
          await ponerInterruptor(clientId, tx, {
            telefono,
            nombre,
            parado: aviso.etiquetas.includes(etiqueta),
            por: 'chatwoot:etiqueta',
            ahora,
          });
        }
        if (aviso.tipo !== 'mensaje') return false;
        return q.guardarEnBandeja(clientId, tx, {
          providerMessageId: aviso.id,
          payload: aviso.mensaje,
          ahora,
          // Un saliente espera unos segundos: si es el eco de uno nuestro, el
          // ejecutor tiene que haber apuntado ya su id para reconocerlo.
          ...(aviso.mensaje.saliente === undefined ? {} : { noAntesDe: new Date(ahora.getTime() + SEGUNDOS_DE_ESPERA_DEL_ECO * 1000) }),
        });
      });

      if (nuevo && aviso.tipo === 'mensaje' && aviso.mensaje.saliente === undefined) opciones.alRecibir();
      return reply.send({ recibidos: nuevo ? 1 : 0 });
    });
  };
}

/**
 * Uno de nuestros mensajes no llegó. La fila de salida estaba «enviada» (Chatwoot
 * lo aceptó); pasa a «fallida» con el motivo, y el operador recibe un correo sin
 * datos del paciente. Lo que no es nuestro (lo que escribe el equipo) no se mira:
 * quien lo escribió ve el fallo en su pantalla.
 */
async function registrarFalloDeEntrega(
  clientId: string,
  tx: Tx,
  aviso: Extract<AvisoDeChatwoot, { tipo: 'fallo_de_entrega' }>,
  ahora: Date,
): Promise<void> {
  const fila = await q.salidaPorReferencia(clientId, tx, aviso.chatwootMensajeId);
  if (fila === undefined || fila.state === 'fallido') return;
  await q.marcarSalida(clientId, tx, fila.id, { state: 'fallido', lastError: `WhatsApp no lo entregó: ${aviso.error}` });
  const carga = fila.payload;
  const que = 'plantilla' in carga && carga.plantilla !== undefined ? `la plantilla «${carga.plantilla.nombre}»` : 'privado' in carga && carga.privado ? 'una nota privada' : 'un mensaje al paciente';
  await q.encolarSalida(clientId, tx, {
    kind: 'correo_operador',
    dedupeKey: `entrega:${fila.id}`,
    payload: {
      asunto: '[Motor de Citas] WhatsApp no ha entregado un mensaje',
      cuerpo: [
        `Chatwoot aceptó ${que}, pero WhatsApp no lo ha entregado.`,
        `Motivo: ${aviso.error}`,
        `Conversación de Chatwoot: cuenta ${aviso.donde.cuentaId}, n.º ${aviso.donde.conversacionId}`,
        `Fila de salida: ${fila.id}`,
        'Si el motivo es la ventana de 24 h, ese aviso necesita una plantilla (sección plantillas del YAML).',
      ].join('\n'),
    },
    ahora,
  });
}
