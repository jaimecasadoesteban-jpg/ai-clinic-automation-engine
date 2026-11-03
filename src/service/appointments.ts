import { and, eq, inArray } from 'drizzle-orm';

import { transicionar } from '../core/hold-state-machine.js';
import * as q from '../db/queries.js';
import { resolverCliente } from './contexto.js';
import { guardarRespuesta, hashDePeticion, respuestaPrevia } from './idempotency.js';
import { DomainError } from '../core/errors.js';
import { conversations, escalations } from '../db/schema.js';
import { HuecoInexistenteError, TransicionRechazadaError, type Dependencias } from './pipeline.js';

/**
 * El cableado que faltaba entre `appointments.outcome` y el hueco.
 *
 * Cerrar el ciclo de una cita —asistida o no— libera el hueco, igual que lo
 * libera una cancelación. Sin esto, un hueco confirmado se quedaba dentro del
 * índice parcial para siempre, también en el camino feliz.
 */

export type Resultado = 'asistida' | 'no_asistida' | 'cancelada';

/** El resultado no se puede anotar así (cita futura, o ya anotado y no es rectificación). */
export class ResultadoRechazadoError extends DomainError {
  readonly code = 'resultado_rechazado';
  readonly httpStatus = 409;
}
export type Fuente = 'recepcion' | 'presuncion' | 'rectificacion';

export interface SalidaDeResultado {
  readonly citaId: string;
  readonly outcome: Resultado;
  readonly holdId: string;
  readonly estadoHueco: 'liberada';
  readonly motivoLiberacion: 'cancelacion' | 'ciclo_cerrado';
  readonly cuentaComoGenerada: boolean;
  readonly rellenoEncolado: boolean;
}

export async function registrarResultadoDeCita(
  deps: Dependencias,
  entrada: {
    readonly clientId: string;
    readonly citaId: string;
    readonly outcome: Resultado;
    readonly fuente: Fuente;
  },
): Promise<SalidaDeResultado> {
  const ahora = deps.reloj();

  return deps.core.withClient(entrada.clientId, async (tx) => {
    const cliente = await resolverCliente(entrada.clientId, tx, deps.configuracion);
    const cita = await q.buscarCita(entrada.clientId, tx, entrada.citaId);
    if (cita === undefined) throw new HuecoInexistenteError('Esa cita no existe.');

    const hueco = await q.buscarHueco(entrada.clientId, tx, cita.holdId);
    if (hueco === undefined) throw new HuecoInexistenteError('El hueco de esa cita no existe.');

    /**
     * **La asistencia se anota cuando la cita ha pasado.** «Asistió» sobre una
     * cita de mañana no es un dato: es un error de clic que acaba en la factura
     * y lanzando la reseña a quien todavía no ha venido.
     */
    if (entrada.outcome !== 'cancelada' && cita.slotStart > ahora) {
      throw new ResultadoRechazadoError('La cita todavía no ha empezado: su asistencia se anota después.');
    }

    /**
     * Ya tenía resultado. Repetir el mismo es un doble clic y no hace nada;
     * cambiarlo sólo es posible como **rectificación**, que no vuelve a tocar el
     * hueco (ya está liberado) y deja constancia de lo que había.
     */
    if (cita.outcome !== 'pendiente') {
      if (cita.outcome === entrada.outcome) {
        return {
          citaId: cita.id,
          outcome: entrada.outcome,
          holdId: hueco.id,
          estadoHueco: 'liberada' as const,
          motivoLiberacion: hueco.releaseReason === 'cancelacion' ? ('cancelacion' as const) : ('ciclo_cerrado' as const),
          cuentaComoGenerada: entrada.outcome === 'asistida',
          rellenoEncolado: false,
        };
      }
      if (entrada.fuente !== 'rectificacion') {
        throw new ResultadoRechazadoError(`Esa cita ya consta como ${cita.outcome}. Para cambiarlo, es una rectificación.`);
      }
      await q.actualizarCita(entrada.clientId, tx, cita.id, {
        outcome: entrada.outcome,
        attendanceConfirmedAt: ahora,
        attendanceSource: 'rectificacion',
        countsAsGenerated: entrada.outcome === 'asistida',
        rectifiedAt: ahora,
        outcomeBeforeRectification: cita.outcome,
      });
      await q.anotarAuditoria(entrada.clientId, tx, {
        entity: 'appointments',
        entityId: cita.id,
        action: `rectificacion:${entrada.outcome}`,
        fromState: cita.outcome,
        toState: entrada.outcome,
        actor: 'recepcion',
      });
      await q.recalcularUltimaVisita(entrada.clientId, tx, cita.patientId);
      return {
        citaId: cita.id,
        outcome: entrada.outcome,
        holdId: hueco.id,
        estadoHueco: 'liberada' as const,
        motivoLiberacion: hueco.releaseReason === 'cancelacion' ? ('cancelacion' as const) : ('ciclo_cerrado' as const),
        cuentaComoGenerada: entrada.outcome === 'asistida',
        rellenoEncolado: false,
      };
    }

    const evento =
      entrada.outcome === 'cancelada'
        ? ({ tipo: 'cita_cancelada' } as const)
        : ({ tipo: 'ciclo_cerrado' } as const);

    const resultado = transicionar({
      hueco: {
        state: hueco.state,
        stateChangedAt: hueco.stateChangedAt,
        slotStart: hueco.slotStart,
        reminderSentAt: hueco.reminderSentAt,
        escalatedAt: hueco.escalatedAt,
        receptionNotifiedAt: hueco.receptionNotifiedAt,
      },
      evento,
      ahora,
      politica: cliente.politica,
    });
    if (!resultado.ok) throw new TransicionRechazadaError(resultado.error.message);

    const { transicion } = resultado;
    const motivo = transicion.motivoLiberacion ?? 'ciclo_cerrado';

    await q.actualizarHueco(entrada.clientId, tx, hueco.id, {
      state: 'liberada',
      stateChangedAt: ahora,
      expiresAt: null,
      releasedAt: ahora,
      releaseReason: motivo,
    });

    // Una rectificación no reescribe la historia: se anota de dónde viene, y el
    // ajuste se aplica en la factura siguiente.
    const esRectificacion = entrada.fuente === 'rectificacion';
    await q.actualizarCita(entrada.clientId, tx, cita.id, {
      outcome: entrada.outcome,
      attendanceConfirmedAt: ahora,
      attendanceSource: entrada.fuente,
      countsAsGenerated: entrada.outcome === 'asistida',
      ...(esRectificacion
        ? { rectifiedAt: ahora, outcomeBeforeRectification: cita.outcome }
        : {}),
    });

    await q.anotarAuditoria(entrada.clientId, tx, {
      entity: 'appointments',
      entityId: cita.id,
      action: `resultado:${entrada.outcome}`,
      fromState: cita.outcome,
      toState: entrada.outcome,
      actor: entrada.fuente === 'presuncion' ? 'sistema' : 'recepcion',
    });

    // La última visita sale de las citas asistidas: es lo que segmenta la
    // reactivación (por antigüedad, nunca por tratamiento).
    await q.recalcularUltimaVisita(entrada.clientId, tx, cita.patientId);

    const relleno = transicion.efectos.some(
      (e) => e.tipo === 'encolar_relleno_de_cancelacion',
    );

    return {
      citaId: cita.id,
      outcome: entrada.outcome,
      holdId: hueco.id,
      estadoHueco: 'liberada' as const,
      motivoLiberacion: motivo,
      cuentaComoGenerada: entrada.outcome === 'asistida',
      rellenoEncolado: relleno,
    };
  });
}

/** No existe ese escalado en esta clínica. 404: puede ser un id de otra. */
export class EscaladoInexistenteError extends DomainError {
  readonly code = 'escalado_inexistente';
  readonly httpStatus = 404;
}

/**
 * Los motivos que paran la conversación —el agente deja de contestar— y que,
 * por tanto, al atenderse la pueden reanudar. La baja la cierra en vez de
 * pausarla, y también se reabre: el paciente que escribe después de darse de
 * baja tiene que poder ser atendido.
 *
 * Un `latido_perdido` o una `validacion_fallida` no paran nada: atenderlos no
 * cambia el estado de la conversación.
 */
const PARAN_LA_CONVERSACION = [
  'urgencia_clinica',
  'menor_de_edad',
  'queja',
  'pide_persona',
  'agente_atascado',
  'peticion_paciente',
] as const;

export interface SalidaEscaladoAtendido {
  readonly escaladoId: string;
  /** `ya_estaba_atendida` si alguien lo atendió antes: no es un error. */
  readonly estado: 'atendida' | 'ya_estaba_atendida';
  readonly conversacionId: string | null;
  /** Cómo queda la conversación. `null` si el escalado no tiene conversación. */
  readonly estadoConversacion: 'abierta' | 'pausada' | 'cerrada' | null;
  /**
   * Otros escalados abiertos que siguen parando esta conversación. Si hay
   * alguno, **no se reanuda**: quien atiende una queja no ha atendido la
   * urgencia que llegó después.
   */
  readonly sigueParadaPor: string[];
}

/**
 * Una persona de la clínica marca el escalado como atendido.
 *
 * Es la única forma de salir de `pausada`. Que no haya un vencimiento
 * automático es deliberado: una urgencia no deja de serlo porque pasen horas.
 *
 * Tres cosas que la primera versión no hacía, y que hacen falta en cuanto hay
 * un botón que cualquiera pulsa:
 *
 * - **Sólo reanuda si nada más la para.** Pausada por una urgencia y con una
 *   queja después, atender la queja reabría la conversación y el agente volvía
 *   a charlar encima de la urgencia sin resolver.
 * - **Queda quién lo atendió**, en el escalado y en auditoría. Sin eso, ante una
 *   reclamación no hay forma de saber si alguien miró la urgencia.
 * - **Idempotente, y pulsarlo dos veces no es un error.** Un botón de WhatsApp
 *   se pulsa dos veces; la segunda devuelve `ya_estaba_atendida` y no reescribe
 *   ni la hora ni quién.
 *
 * Se reanuda tanto lo pausado como lo cerrado. **Reabrir la conversación no
 * levanta la baja**: esto deja que el agente conteste cuando el paciente
 * escriba, y la baja sigue bloqueando lo que enviamos nosotros. Volver a las
 * oleadas es `reactivarComunicaciones`, y sólo si lo pide el paciente.
 */
export async function marcarEscaladoAtendido(
  deps: Dependencias,
  entrada: {
    readonly idempotencyKey: string;
    readonly clientId: string;
    readonly escaladoId: string;
    /** Quién lo ha atendido: nombre o puesto. Va al escalado y a auditoría. */
    readonly atendidoPor: string;
  },
): Promise<SalidaEscaladoAtendido> {
  const ahora = deps.reloj();
  const hash = hashDePeticion({ clientId: entrada.clientId, escaladoId: entrada.escaladoId });

  return deps.core.withClient(entrada.clientId, async (tx) => {
    const previa = await respuestaPrevia(entrada.clientId, tx, entrada.idempotencyKey, hash);
    if (previa !== undefined) return previa.cuerpo as SalidaEscaladoAtendido;

    const [escalado] = await tx
      .select({
        state: escalations.state,
        reason: escalations.reason,
        conversationId: escalations.conversationId,
      })
      .from(escalations)
      .where(and(eq(escalations.clientId, entrada.clientId), eq(escalations.id, entrada.escaladoId)))
      .for('update');
    if (escalado === undefined) {
      throw new EscaladoInexistenteError(`No hay ningún escalado ${entrada.escaladoId} en esta clínica.`);
    }

    const conversacionId = escalado.conversationId;
    const yaEstaba = escalado.state !== 'abierta';

    if (!yaEstaba) {
      await tx
        .update(escalations)
        .set({ state: 'atendida', acknowledgedAt: ahora, resolvedAt: ahora, assignee: entrada.atendidoPor })
        .where(and(eq(escalations.clientId, entrada.clientId), eq(escalations.id, entrada.escaladoId)));
      await q.anotarAuditoria(entrada.clientId, tx, {
        entity: 'escalations',
        entityId: entrada.escaladoId,
        action: `escalado_atendido:${escalado.reason}`,
        fromState: 'abierta',
        toState: 'atendida',
        actor: 'recepcion',
        idempotencyKey: entrada.idempotencyKey,
        payload: { atendidoPor: entrada.atendidoPor },
      });
    }

    const sigueParadaPor =
      conversacionId === null
        ? []
        : (
            await tx
              .select({ reason: escalations.reason })
              .from(escalations)
              .where(
                and(
                  eq(escalations.clientId, entrada.clientId),
                  eq(escalations.conversationId, conversacionId),
                  eq(escalations.state, 'abierta'),
                  inArray(escalations.reason, [...PARAN_LA_CONVERSACION]),
                ),
              )
          ).map((f) => f.reason);

    const paraba = (PARAN_LA_CONVERSACION as readonly string[]).includes(escalado.reason);
    if (conversacionId !== null && !yaEstaba && paraba && sigueParadaPor.length === 0) {
      await tx
        .update(conversations)
        .set({ status: 'abierta', pausedAt: null, pauseReason: null, closedAt: null })
        .where(
          and(
            eq(conversations.clientId, entrada.clientId),
            eq(conversations.id, conversacionId),
            inArray(conversations.status, ['pausada', 'cerrada']),
          ),
        );
    }

    const [conversacion] =
      conversacionId === null
        ? []
        : await tx
            .select({ status: conversations.status })
            .from(conversations)
            .where(and(eq(conversations.clientId, entrada.clientId), eq(conversations.id, conversacionId)));

    const salida: SalidaEscaladoAtendido = {
      escaladoId: entrada.escaladoId,
      estado: yaEstaba ? 'ya_estaba_atendida' : 'atendida',
      conversacionId,
      estadoConversacion: conversacion?.status ?? null,
      sigueParadaPor,
    };
    await guardarRespuesta(entrada.clientId, tx, {
      clave: entrada.idempotencyKey,
      endpoint: '/escalado-atendido',
      hash,
      statusCode: 200,
      cuerpo: salida,
    });
    return salida;
  });
}

/**
 * El paciente ha dicho que quiere volver a recibir comunicaciones.
 *
 * **Es lo único que levanta una baja, y sólo lo puede desencadenar él.** Pedir
 * cita no revoca el opt-out: querer una cita y no querer publicidad son cosas
 * compatibles, y deducir un consentimiento de una acción que no lo expresa es
 * precisamente lo que no se puede hacer. Por eso esto no es un efecto lateral
 * de reservar ni un botón que recepción pulse por su cuenta.
 *
 * El parámetro `loPidioElPaciente` es del tipo `true`, no `boolean`: no hay
 * forma de llamar a esta función sin afirmarlo. Es la misma idea que
 * `huecoSigueLibre` en el paso 6 — una regla que se puede volver imposible en el
 * tipo no se deja en un comentario.
 */
export async function reactivarComunicaciones(
  deps: Dependencias,
  entrada: {
    readonly clientId: string;
    readonly patientId: string;
    readonly loPidioElPaciente: true;
    /** Dónde consta que lo pidió: mensaje, llamada, en consulta. Va a auditoría. */
    readonly constancia: string;
  },
): Promise<{ reactivado: boolean }> {
  const ahora = deps.reloj();

  return deps.core.withClient(entrada.clientId, async (tx) => {
    const levantadas = await q.levantarBaja(entrada.clientId, tx, entrada.patientId, {
      ahora,
      constancia: entrada.constancia,
    });

    await q.anotarAuditoria(entrada.clientId, tx, {
      entity: 'suppression',
      entityId: entrada.patientId,
      action: `baja_levantada:${entrada.constancia}`.slice(0, 200),
      actor: 'recepcion',
    });

    return { reactivado: levantadas > 0 };
  });
}
