import type { Tx } from '../db/client.js';
import * as q from '../db/queries.js';
import type { inbox } from '../db/schema.js';
import { resolverCliente } from './contexto.js';
import { procesarMensajeEntrante, type Dependencias } from './pipeline.js';

/**
 * **El procesador de la bandeja de entrada.** El webhook de WhatsApp guarda el
 * mensaje y responde 200 a Meta al momento; esto lo pasa por el turno de siempre
 * con `envia: 'nucleo'`, así que la respuesta sale por la tabla de salida.
 *
 * En orden de llegada, por clínica. Si el turno falla por algo inesperado —no
 * una agenda caída, que el turno ya contesta—, se reintenta con espera corta: el
 * paciente está esperando. Agotados los intentos, **no se queda en silencio**:
 * recibe un texto fijo que no promete a nadie y el operador recibe un correo.
 */

export const MAX_INTENTOS_BANDEJA = 3;
const ESPERAS_SEG = [5, 30];

export interface ResultadoDeBandeja {
  readonly procesados: number;
  readonly reintentos: number;
  readonly fallidos: Array<{ id: string; error: string }>;
}

export async function procesarBandeja(
  deps: Dependencias,
  clientId: string,
  datos: { ahora: Date; limite?: number },
): Promise<ResultadoDeBandeja> {
  return deps.core.withClient(clientId, async (tx) => {
    const pendientes = await q.bandejaPendiente(clientId, tx, { ahora: datos.ahora, limite: datos.limite ?? 10 });
    let procesados = 0;
    let reintentos = 0;
    const fallidos: Array<{ id: string; error: string }> = [];

    for (const fila of pendientes) {
      const m = fila.payload;
      if (m.saliente !== undefined) {
        if (await guardarDelEquipo(clientId, tx, fila, datos.ahora)) procesados += 1;
        else reintentos += 1;
        continue;
      }
      try {
        // Su propia transacción: el turno confirma o revierte entero, y la fila
        // de la bandeja sólo se marca cuando ha confirmado.
        await procesarMensajeEntrante(
          deps,
          {
            idempotencyKey: fila.providerMessageId,
            clientId,
            telefono: m.telefono,
            nombre: m.nombre,
            ...(m.texto === undefined ? {} : { texto: m.texto }),
            tipo: m.tipo,
            proveedorMensajeId: fila.providerMessageId,
          },
          m.chatwoot === undefined ? 'nucleo' : { por: 'chatwoot', ...m.chatwoot },
        );
        await q.marcarBandeja(clientId, tx, fila.id, { state: 'procesado', attempts: fila.attempts + 1, processedAt: datos.ahora, lastError: null });
        procesados += 1;
      } catch (error: unknown) {
        const mensaje = error instanceof Error ? error.message : String(error);
        const intentos = fila.attempts + 1;
        if (intentos < MAX_INTENTOS_BANDEJA) {
          const espera = ESPERAS_SEG[intentos - 1] ?? 30;
          await q.marcarBandeja(clientId, tx, fila.id, {
            attempts: intentos,
            lastError: mensaje,
            nextAttemptAt: new Date(datos.ahora.getTime() + espera * 1000),
          });
          reintentos += 1;
          continue;
        }

        await q.marcarBandeja(clientId, tx, fila.id, { state: 'fallido', attempts: intentos, lastError: mensaje });
        fallidos.push({ id: fila.id, error: mensaje });
        const cliente = await resolverCliente(clientId, tx, deps.configuracion);
        const dedupeKey = `fuera_de_servicio:${fila.providerMessageId}`;
        const texto = cliente.textos.fueraDeServicio();
        await (m.chatwoot === undefined
          ? q.encolarSalida(clientId, tx, {
              kind: 'whatsapp',
              dedupeKey,
              payload: { para: m.telefono, texto, remitenteId: cliente.config.canal.remitenteId },
              ahora: datos.ahora,
            })
          : q.encolarSalida(clientId, tx, {
              kind: 'chatwoot',
              dedupeKey,
              payload: { ...m.chatwoot, texto, privado: false },
              ahora: datos.ahora,
            }));
        await q.encolarSalida(clientId, tx, {
          kind: 'correo_operador',
          dedupeKey: `bandeja:${fila.id}`,
          payload: {
            asunto: '[Motor de Citas] Un mensaje de WhatsApp no se ha podido atender',
            cuerpo: [
              `Tras ${intentos} intentos, un mensaje entrante no se ha podido procesar.`,
              `Error: ${mensaje}`,
              `Fila de la bandeja: ${fila.id}`,
              'Al paciente se le ha contestado con el texto de «fuera de servicio».',
            ].join('\n'),
          },
          ahora: datos.ahora,
        });
      }
    }

    return { procesados, reintentos, fallidos };
  });
}

/**
 * Lo que escribió una persona del equipo desde el móvil o desde Chatwoot, al
 * historial: el panel lo enseña y el modelo lo ve en su ventana, así que al
 * reactivar el agente sabe lo que se le dijo al paciente.
 *
 * **Salvo que sea nuestro.** Chatwoot avisa también de lo que mandan el agente
 * y el panel, con el mismo usuario; lo distingue el id que el ejecutor apuntó al
 * enviarlo (`outbox.sent_ref`). Por eso esto llega con unos segundos de retraso.
 *
 * No pasa por el turno, no contesta y no despierta al agente. Si falla, se
 * reintenta y al final avisa al operador; nunca le escribe al paciente, que no
 * ha escrito nada.
 */
async function guardarDelEquipo(
  clientId: string,
  tx: Tx,
  fila: typeof inbox.$inferSelect,
  ahora: Date,
): Promise<boolean> {
  const m = fila.payload;
  try {
    await tx.transaction(async (sp) => {
      if (m.saliente === undefined || m.chatwoot === undefined) return;
      if (await q.esEcoNuestro(clientId, sp, m.saliente.chatwootMensajeId)) return;
      const paciente = await q.upsertPatient(clientId, sp, { phoneE164: m.telefono, givenName: m.nombre });
      const conversacion = await q.conversacionAbierta(clientId, sp, paciente.id);
      await q.guardarMensaje(clientId, sp, {
        conversationId: conversacion.id,
        direction: 'saliente',
        body: m.texto ?? '',
        isClinical: false,
        sentBy: 'equipo',
        providerMessageId: fila.providerMessageId,
        createdAt: ahora,
      });
      await q.guardarCanal(clientId, sp, conversacion.id, { por: 'chatwoot', ...m.chatwoot });
    });
    await q.marcarBandeja(clientId, tx, fila.id, { state: 'procesado', attempts: fila.attempts + 1, processedAt: ahora, lastError: null });
    return true;
  } catch (error: unknown) {
    const mensaje = error instanceof Error ? error.message : String(error);
    const intentos = fila.attempts + 1;
    if (intentos < MAX_INTENTOS_BANDEJA) {
      await q.marcarBandeja(clientId, tx, fila.id, {
        attempts: intentos,
        lastError: mensaje,
        nextAttemptAt: new Date(ahora.getTime() + (ESPERAS_SEG[intentos - 1] ?? 30) * 1000),
      });
      return false;
    }
    await q.marcarBandeja(clientId, tx, fila.id, { state: 'fallido', attempts: intentos, lastError: mensaje });
    await q.encolarSalida(clientId, tx, {
      kind: 'correo_operador',
      dedupeKey: `bandeja:${fila.id}`,
      payload: {
        asunto: '[Motor de Citas] Un mensaje del equipo no ha entrado en el historial',
        cuerpo: [
          'Un mensaje que escribió una persona del equipo (móvil o Chatwoot) no se ha podido guardar.',
          `Error: ${mensaje}`,
          `Fila de la bandeja: ${fila.id}`,
          'El paciente sí lo recibió; lo que falta es que el panel y el modelo lo vean.',
        ].join('\n'),
      },
      ahora,
    });
    return false;
  }
}
