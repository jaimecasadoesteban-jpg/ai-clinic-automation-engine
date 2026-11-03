import type { Core, Tx } from '../db/client.js';
import type { CargaDeEvento } from '../db/schema.js';
import * as q from '../db/queries.js';
import type { ChatwootSaliente } from './chatwoot/api.js';
import type { CorreoSaliente } from './correo.js';
import { eventoDeAgenda } from './agenda-evento.js';
import type { EscritorDeAgenda } from './google/escritor.js';
import { encolarParaElPaciente, type Dependencias } from './pipeline.js';
import { EnvioRechazadoError, type WhatsAppSaliente } from './whatsapp/meta.js';

/**
 * **El ejecutor de la tabla de salida.** Lo único del núcleo que manda algo fuera
 * (además del proveedor del LLM), y nunca desde dentro de la transacción de un
 * turno: lee lo que los turnos ya confirmaron y lo envía (regla 3).
 *
 * - Al menos una vez: si el envío sale y la marca no llega a guardarse, se
 *   reintentará. Un duplicado es una molestia; un aviso perdido es el silencio
 *   que esto existe para evitar.
 * - Reintentos con espera creciente (1, 2, 4… hasta 60 minutos) y un tope:
 *   pasado, queda `fallido` con el último error.
 * - **Un WhatsApp que no se puede entregar avisa al operador por correo**, en la
 *   misma transacción: un paciente que no recibe respuesta es el fallo que más
 *   importa ver. Un rechazo permanente (fuera de la ventana de 24 h, número no
 *   válido) no se reintenta: falla a la primera y avisa.
 */

export const MAX_INTENTOS = 8;
const ESPERA_MAXIMA_MIN = 60;

export interface ResultadoDeEjecucion {
  readonly enviados: number;
  readonly reintentos: number;
  readonly fallidos: Array<{ id: string; error: string }>;
}

export interface Enviadores {
  readonly correo: CorreoSaliente;
  readonly operador: string;
  /** Sin él, las filas de WhatsApp se quedan pendientes: aún no hay credenciales. */
  readonly whatsapp?: WhatsAppSaliente;
  /** Igual para Chatwoot. */
  readonly chatwoot?: ChatwootSaliente;
  /**
   * Igual para los eventos de agenda (modo `automatica`). Con las dependencias
   * del turno, porque el resultado lo procesa la misma lógica que atendía
   * `/evento-de-agenda`.
   */
  readonly agenda?: { readonly escritor: EscritorDeAgenda; readonly deps: Dependencias };
}

export async function ejecutarSalida(
  core: Core,
  clientId: string,
  datos: Enviadores & { ahora: Date; limite?: number },
): Promise<ResultadoDeEjecucion> {
  return core.withClient(clientId, async (tx) => {
    const pendientes = await q.salidaPendiente(clientId, tx, { ahora: datos.ahora, limite: datos.limite ?? 20 });
    let enviados = 0;
    let reintentos = 0;
    const fallidos: Array<{ id: string; error: string }> = [];

    for (const fila of pendientes) {
      const carga = fila.payload;
      if (fila.kind === 'whatsapp' && datos.whatsapp === undefined) continue;
      if (fila.kind === 'chatwoot' && datos.chatwoot === undefined) continue;
      if (fila.kind === 'evento_agenda' && datos.agenda === undefined) continue;
      try {
        if ('holdId' in carga) {
          await crearEvento(clientId, tx, { carga, agenda: datos.agenda, filaId: fila.id, ahora: datos.ahora });
        } else if ('correoA' in carga) {
          await datos.correo.enviar({ para: carga.correoA, asunto: carga.asunto, cuerpo: carga.cuerpo });
        } else if ('asunto' in carga) {
          await datos.correo.enviar({ para: datos.operador, asunto: carga.asunto, cuerpo: carga.cuerpo });
        } else if ('etiqueta' in carga) {
          await datos.chatwoot?.cambiarEtiqueta(carga);
        } else if ('cuentaId' in carga) {
          const enviado = await datos.chatwoot?.enviar(carga);
          if (enviado?.id != null) {
            // Antes de marcarlo enviado: el eco de Chatwoot se procesa con
            // retraso y tiene que encontrar esto para no guardarlo dos veces.
            await q.marcarSalida(clientId, tx, fila.id, { sentRef: String(enviado.id) });
          }
        } else {
          await datos.whatsapp?.enviarTexto({ remitenteId: carga.remitenteId, para: carga.para, texto: carga.texto });
        }
        await q.marcarSalida(clientId, tx, fila.id, {
          state: 'enviado',
          attempts: fila.attempts + 1,
          sentAt: datos.ahora,
          lastError: null,
        });
        enviados += 1;
      } catch (error: unknown) {
        const mensaje = error instanceof Error ? error.message : String(error);
        const intentos = fila.attempts + 1;
        const permanente = error instanceof EnvioRechazadoError && error.permanente;
        if (permanente || intentos >= MAX_INTENTOS) {
          await q.marcarSalida(clientId, tx, fila.id, { state: 'fallido', attempts: intentos, lastError: mensaje });
          fallidos.push({ id: fila.id, error: mensaje });
          // El correo del operador no puede avisar de sí mismo; un WhatsApp sí,
          // y un mensaje de Chatwoot también: o es la respuesta a un paciente o
          // es el aviso al equipo, y ninguno de los dos puede perderse callado.
          if (fila.kind === 'chatwoot') {
            await q.encolarSalida(clientId, tx, {
              kind: 'correo_operador',
              dedupeKey: `fallo:${fila.id}`,
              payload: {
                asunto: '[Motor de Citas] Un mensaje no ha llegado a Chatwoot',
                cuerpo: [
                  `Chatwoot no ha aceptado ${'etiqueta' in carga ? `el cambio de la etiqueta ${carga.etiqueta} (el interruptor del panel y Chatwoot pueden no coincidir)` : 'privado' in carga && carga.privado ? 'un aviso al equipo (nota privada)' : 'un mensaje al paciente'} tras ${intentos} intento(s).`,
                  `Motivo: ${mensaje}`,
                  `Conversación de Chatwoot: ${'cuentaId' in carga ? `cuenta ${carga.cuentaId}, n.º ${carga.conversacionId}` : '?'}`,
                  `Fila de salida: ${fila.id}`,
                  `Hora: ${datos.ahora.toISOString()}`,
                ].join('\n'),
              },
              ahora: datos.ahora,
            });
          }
          if (fila.kind === 'evento_agenda') {
            await q.encolarSalida(clientId, tx, {
              kind: 'correo_operador',
              dedupeKey: `fallo:${fila.id}`,
              payload: {
                asunto: '[Motor de Citas] Un evento de agenda no se ha podido procesar',
                cuerpo: [
                  `Tras ${intentos} intento(s), el resultado de crear un evento no se ha podido registrar.`,
                  `Motivo: ${mensaje}`,
                  `Hueco: ${'holdId' in carga ? carga.holdId : '?'}`,
                  `Fila de salida: ${fila.id}`,
                  'Comprueba en el calendario si la cita está y en qué estado ha quedado el hueco.',
                ].join('\n'),
              },
              ahora: datos.ahora,
            });
          }
          if (fila.kind === 'whatsapp') {
            await q.encolarSalida(clientId, tx, {
              kind: 'correo_operador',
              dedupeKey: `fallo:${fila.id}`,
              payload: {
                asunto: '[Motor de Citas] Un WhatsApp no se ha podido entregar',
                cuerpo: [
                  `No ha llegado un mensaje de WhatsApp tras ${intentos} intento(s).`,
                  `Motivo: ${mensaje}`,
                  `Fila de salida: ${fila.id}`,
                  `Hora: ${datos.ahora.toISOString()}`,
                  'Si el motivo es la ventana de 24 h, el paciente no ha escrito en un día: hace falta una plantilla aprobada por Meta.',
                ].join('\n'),
              },
              ahora: datos.ahora,
            });
          }
        } else {
          const esperaMin = Math.min(2 ** (intentos - 1), ESPERA_MAXIMA_MIN);
          await q.marcarSalida(clientId, tx, fila.id, {
            attempts: intentos,
            lastError: mensaje,
            nextAttemptAt: new Date(datos.ahora.getTime() + esperaMin * 60_000),
          });
          reintentos += 1;
        }
      }
    }

    return { enviados, reintentos, fallidos };
  });
}

/**
 * Escribe el evento y procesa lo que pasó, **en este orden y sin saltarse
 * nada**: el escritor relee el hueco justo antes (la ventana entre releer y
 * escribir son segundos, que es lo que justifica el modo), y el resultado pasa
 * por la misma lógica que atendía `/evento-de-agenda` —confirmar, pasar a la
 * segunda opción o degradar a recepción—. Lo que salga de ahí, la confirmación
 * al paciente incluida, se encola por su canal en esta misma transacción.
 *
 * Un reintento es seguro: el evento lleva un id fijo (Google contesta 409 si ya
 * existe) y el resultado, una clave de idempotencia.
 */
async function crearEvento(
  clientId: string,
  tx: Tx,
  datos: {
    carga: CargaDeEvento;
    agenda: Enviadores['agenda'];
    filaId: string;
    ahora: Date;
  },
): Promise<void> {
  const { carga, agenda } = datos;
  if (agenda === undefined) return;
  const resultado = await agenda.escritor.crear(carga);
  const clave = `${carga.idempotencyKey}:resultado`;
  const { cuerpo } = await eventoDeAgenda(agenda.deps, {
    idempotencyKey: clave,
    clientId,
    holdId: carga.holdId,
    creado: resultado.creado,
    ...(resultado.creado ? { eventoId: resultado.eventoId } : { motivo: resultado.motivo }),
  });
  await encolarParaElPaciente(clientId, tx, {
    clave,
    canal: carga.canal,
    clinica: carga.clinica,
    respuesta: cuerpo.respuesta,
    efectos: cuerpo.efectos,
    ahora: datos.ahora,
  });

  // No sabemos si el evento existe: la persona que lo compruebe ya tiene su
  // escalado; el operador recibe el motivo técnico (un permiso revocado no se
  // arregla en la clínica). Sin datos del paciente.
  if (!resultado.creado && resultado.motivo !== 'ocupado') {
    await q.encolarSalida(clientId, tx, {
      kind: 'correo_operador',
      dedupeKey: `agenda:${datos.filaId}`,
      payload: {
        asunto: `[Motor de Citas] No se ha podido escribir en la agenda · ${carga.clinica}`,
        cuerpo: [
          `Resultado: ${resultado.motivo}`,
          `Detalle: ${resultado.detalle}`,
          `Hueco: ${carga.holdId}`,
          `Hora: ${datos.ahora.toISOString()}`,
          'La cita ha pasado a confirmación de recepción y hay un escalado abierto.',
        ].join('\n'),
      },
      ahora: datos.ahora,
    });
  }
}
