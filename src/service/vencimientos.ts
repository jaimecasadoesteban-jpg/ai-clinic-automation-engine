import { sql } from 'drizzle-orm';

import { cambiaDeEstado, transicionar, type Efecto } from '../core/hold-state-machine.js';
import type { Tx } from '../db/client.js';
import * as q from '../db/queries.js';
import { dentroDeFranja, resolverCliente, type ContextoDeCliente } from './contexto.js';
import { registrarLatido } from './vigilancia.js';
import type { Dependencias } from './pipeline.js';
import { resolverEfectos } from './efectos.js';
import type { Destinatario } from './avisos.js';

/**
 * Aplica los vencimientos de la máquina de estados. Es lo que hace que la
 * regla 4 ocurra de verdad: sin esta llamada periódica, toda la maquinaria de
 * caducidades está escrita pero inerte, y un paciente se queda esperando una
 * respuesta que nadie va a dar.
 *
 * ## Si n8n deja de llamar durante horas
 *
 * Dos frenos, porque el problema tiene dos partes:
 *
 * 1. **Franja de contacto.** Los mensajes al paciente sólo salen dentro del
 *    horario configurado (por defecto 09:00–21:00, hora de la clínica). Fuera de
 *    ella no se procesa nada: nadie recibe «tu propuesta ha caducado» a las tres
 *    de la mañana. Los huecos no se liberan hasta esa hora, y no pasa nada
 *    porque a esa hora tampoco hay nadie reservando.
 * 2. **Lote acotado.** Aunque sean las diez de la mañana, cien vencimientos
 *    acumulados son cien mensajes de golpe. Se procesan como mucho
 *    `envios.loteDeVencimientos` por llamada, los más antiguos primero, y se
 *    devuelve cuántos quedan. n8n vuelve a llamar y se van drenando.
 *
 * ## Si dos llamadas se solapan
 *
 * `FOR UPDATE SKIP LOCKED`: cada ejecución se lleva un conjunto disjunto de
 * filas y ninguna espera a la otra. No hay doble procesamiento ni bloqueo, y la
 * protección está en Postgres, no en un `if` — por eso su test es concurrente.
 */

export interface EntradaDeVencimientos {
  readonly clientId: string;
  readonly limite?: number;
}

export interface VencimientoAplicado {
  readonly holdId: string;
  readonly desde: string;
  readonly hasta: string;
  readonly efectos: Array<Efecto & { destinatarios: Destinatario[]; texto: string }>;
}

export interface SalidaDeVencimientos {
  readonly aplicados: VencimientoAplicado[];
  /** Cuántos quedan pendientes tras este lote. */
  readonly restantes: number;
  /** `true` si está fuera de la franja de contacto y no se ha tocado nada. */
  readonly diferidoPorHorario: boolean;
}

export async function caducarRetenciones(
  deps: Dependencias,
  entrada: EntradaDeVencimientos,
  /**
   * Para quien envía desde el núcleo (el planificador): corre **dentro** de la
   * transacción, así lo que haya que mandar se encola junto con el cambio de
   * estado (regla 3). Por HTTP no se pasa y la salida vuelve a quien llamó.
   */
  alTerminar?: (tx: Tx, salida: SalidaDeVencimientos) => Promise<void>,
): Promise<SalidaDeVencimientos> {
  const ahora = deps.reloj();

  return deps.core.withClient(entrada.clientId, async (tx) => {
    const cliente = await resolverCliente(entrada.clientId, tx, deps.configuracion);
    // Antes de decidir si hay algo que hacer: lo que se vigila es que la LLAMADA
    // ocurra, no que produzca trabajo. Un cron que llama y no encuentra nada
    // está sano; uno que no llama es el fallo silencioso.
    await registrarLatido(entrada.clientId, tx, 'caducar-retenciones', ahora);

    /**
     * Fuera de la franja no se inicia contacto: ni avisos a recepción, ni
     * caducidades, ni nada que despierte a nadie a las tres de la mañana.
     *
     * **Con una excepción, y es la regla de 24/7 otra vez.** En modo
     * `automatica`, un hueco en `retenida` es un paciente que eligió hace dos
     * minutos y está esperando su confirmación **ahora mismo**. Que n8n se haya
     * muerto entre medias no convierte su espera en algo que pueda contestarse
     * mañana: eso sería el silencio de diez horas que el modo nocturno existe
     * para evitar, sólo que por otra puerta.
     *
     * Así que de madrugada se procesan sólo esos, y su aviso a recepción se
     * difiere igual que el del camino normal.
     */
    const enFranja = dentroDeFranja(ahora, cliente);
    if (!enFranja && cliente.config.agenda.confirmacion !== 'automatica') {
      const pendientes = await contarPendientes(entrada.clientId, tx, ahora, cliente);
      return { aplicados: [], restantes: pendientes, diferidoPorHorario: true };
    }

    const limite = Math.min(
      entrada.limite ?? cliente.config.envios.loteDeVencimientos,
      cliente.config.envios.loteDeVencimientos,
    );

    // SKIP LOCKED: dos ejecuciones simultáneas se reparten el trabajo en vez de
    // pisarse o esperarse. Los más antiguos primero, para que nadie se quede
    // atrás cuando hay atasco.
    const candidatos = await tx.execute<{
      id: string;
      state: string;
      state_changed_at: Date;
      slot_start: Date;
      expires_at: Date | null;
      reminder_sent_at: Date | null;
      escalated_at: Date | null;
      reception_notified_at: Date | null;
    }>(sql`
      select id, state, state_changed_at, slot_start, expires_at,
             reminder_sent_at, escalated_at, reception_notified_at
        from motor.holds
       where client_id = ${entrada.clientId}
         and state in ${enFranja
           ? sql`('propuesta', 'retenida', 'pendiente_recepcion')`
           : sql`('retenida')`}
       order by state_changed_at asc
       limit ${limite}
         for update skip locked
    `);

    const aplicados: VencimientoAplicado[] = [];

    for (const fila of candidatos) {
      /**
       * **Ningún vencimiento avisa de un hueco cuya hora ya pasó.**
       *
       * Con los crons caídos un día, la primera pasada mandaría a recepción
       * «cita nueva, mete ésta» sobre citas de ayer, y al paciente «tu
       * propuesta ha caducado» sobre una propuesta de hace semanas. Ocurrió en
       * potencia con una cita del 28 de agosto que seguía `pendiente_recepcion`
       * en octubre.
       *
       * Así que se anota y nada más: sin mensajes, sin avisos, sin escalados.
       * El fallo de verdad fue que el cron no corriera, y ése ya lo destapa el
       * latido. Las lecturas no esperaban a esto para darlo por muerto (ver
       * `sigueVivo`); esto sólo pone la fila al día.
       */
      if (new Date(fila.slot_start) <= ahora) {
        await q.actualizarHueco(entrada.clientId, tx, fila.id, {
          state: 'caducada',
          stateChangedAt: ahora,
          expiresAt: null,
        });
        await q.anotarAuditoria(entrada.clientId, tx, {
          entity: 'holds',
          entityId: fila.id,
          action: 'caducada_sin_aviso:hora_pasada',
          fromState: fila.state,
          toState: 'caducada',
          actor: 'sistema',
        });
        aplicados.push({
          holdId: fila.id,
          desde: fila.state,
          hasta: 'caducada',
          efectos: [],
        });
        continue;
      }

      // Lo retenido de madrugada espera aquí: al abrir la franja se avisa a
      // recepción y sólo entonces empiezan a correrle los plazos.
      if (fila.state === 'pendiente_recepcion' && fila.reception_notified_at === null) {
        await q.actualizarHueco(entrada.clientId, tx, fila.id, {
          receptionNotifiedAt: ahora,
          expiresAt: cliente.politica.finDeJornada(ahora),
        });
        await q.anotarAuditoria(entrada.clientId, tx, {
          entity: 'holds',
          entityId: fila.id,
          action: 'aviso_a_recepcion_diferido',
          actor: 'sistema',
        });
        aplicados.push({
          holdId: fila.id,
          desde: 'pendiente_recepcion',
          hasta: 'pendiente_recepcion',
          efectos: await resolverEfectos(
            entrada.clientId,
            tx,
            cliente,
            [{ tipo: 'avisar_a_recepcion' } as const],
            { holdId: fila.id },
          ),
        });
        continue;
      }

      const resultado = transicionar({
        hueco: {
          state: fila.state as never,
          stateChangedAt: new Date(fila.state_changed_at),
          slotStart: new Date(fila.slot_start),
          reminderSentAt: fila.reminder_sent_at === null ? null : new Date(fila.reminder_sent_at),
          escalatedAt: fila.escalated_at === null ? null : new Date(fila.escalated_at),
          receptionNotifiedAt:
            fila.reception_notified_at === null ? null : new Date(fila.reception_notified_at),
        },
        evento: { tipo: 'tiempo' },
        ahora,
        politica: cliente.politica,
      });
      if (!resultado.ok) continue;

      const { transicion } = resultado;
      if (transicion.efectos.length === 0 && !cambiaDeEstado(transicion)) continue;

      const cambios: Parameters<typeof q.actualizarHueco>[3] = {
        expiresAt: transicion.expiresAt,
      };
      if (cambiaDeEstado(transicion)) {
        cambios.state = transicion.hasta as never;
        cambios.stateChangedAt = ahora;
      }
      for (const efecto of transicion.efectos) {
        if (efecto.tipo === 'recordar_a_recepcion') cambios.reminderSentAt = ahora;
        if (efecto.tipo === 'escalar_a_humano') cambios.escalatedAt = ahora;
        // El aviso a recepción sólo arranca sus plazos cuando sale de verdad. De
        // madrugada espera, y lo emitirá esta misma función al abrir la franja.
        if (efecto.tipo === 'avisar_a_recepcion' && enFranja) {
          cambios.receptionNotifiedAt = ahora;
        }
      }
      if (transicion.hasta === 'pendiente_recepcion' && !enFranja) {
        cambios.expiresAt = null;
      }
      await q.actualizarHueco(entrada.clientId, tx, fila.id, cambios);

      /** El id del escalado recién creado, para poder decir a quién va el aviso. */
      let escaladoDeEsteHueco: string | undefined;
      for (const efecto of transicion.efectos) {
        if (efecto.tipo !== 'escalar_a_humano') continue;
        // El motivo lo dice la transición, no esta función: «sin respuesta de
        // recepción» y «no se pudo escribir en la agenda» van a sitios distintos.
        escaladoDeEsteHueco = await q.crearEscalado(entrada.clientId, tx, {
          holdId: fila.id,
          reason: efecto.motivo,
          severity: 2,
          notifiedAt: ahora,
          createdAt: ahora,
        });
      }

      await q.anotarAuditoria(entrada.clientId, tx, {
        entity: 'holds',
        entityId: fila.id,
        action: 'vencimiento',
        fromState: transicion.desde,
        toState: transicion.hasta,
        actor: 'sistema',
      });

      const hueco = await q.buscarHueco(entrada.clientId, tx, fila.id);

      /**
       * **Un aviso por propuesta, no uno por hueco.** Se proponen tres huecos a la
       * vez y caducan a la vez: sin esto, el paciente recibía tres «las horas que
       * te pasé ya pueden haberse ocupado» seguidos. Y si eligió uno, las otras
       * dos siguen vivas como alternativa y caducan después: decirle entonces
       * «si sigues queriendo cita» a quien ya tiene la suya es no saber con quién
       * se habla.
       *
       * Así que sólo avisa la última que cae, y sólo si en la conversación no
       * queda nada vivo: ni otra propuesta, ni una cita.
       */
      const efectosDelHueco =
        hueco !== undefined &&
        transicion.efectos.some((e) => e.tipo === 'mensaje_al_paciente' && e.plantilla === 'propuesta_caducada') &&
        (await q.quedaAlgoVivoEnLaConversacion(entrada.clientId, tx, {
          conversationId: hueco.conversationId,
          excepto: fila.id,
          ahora,
        }))
          ? transicion.efectos.filter(
              (e) => !(e.tipo === 'mensaje_al_paciente' && e.plantilla === 'propuesta_caducada'),
            )
          : transicion.efectos;

      const resueltos = await resolverEfectos(
        entrada.clientId,
        tx,
        cliente,
        efectosDelHueco.filter((e) => enFranja || e.tipo !== 'avisar_a_recepcion'),
        { holdId: fila.id, escaladoId: escaladoDeEsteHueco, avisoDiferido: !enFranja },
      );

      // Regla 6: lo que se le manda al paciente se registra, también lo que el
      // sistema le escribe por su cuenta. Y así el modelo lo ve en la ventana
      // si el paciente contesta: «¿cómo que ya no está?».
      for (const efecto of resueltos) {
        if (efecto.tipo !== 'mensaje_al_paciente' || efecto.texto === '' || hueco === undefined) continue;
        await q.guardarMensaje(entrada.clientId, tx, {
          conversationId: hueco.conversationId,
          direction: 'saliente',
          body: efecto.texto,
          isClinical: false,
          createdAt: ahora,
        });
      }

      aplicados.push({
        holdId: fila.id,
        desde: transicion.desde,
        hasta: transicion.hasta,
        // De madrugada, el aviso a recepción no sale: se queda para cuando abra,
        // y lo emite el bloque de arriba. Lo demás sí sale — el paciente está
        // esperando.
        /**
         * Resueltos aquí también: el aviso a recepción del flujo nocturno sale
         * de este cron, y si no llevara destinatario sería justo el que no llega.
         *
         * Los efectos de la máquina de estados no traen `holdId` —lo lleva el
         * `aplicado` que los envuelve— así que se le añade al pasarlos.
         */
        efectos: resueltos,
      });
    }

    const restantes = await contarPendientes(entrada.clientId, tx, ahora, cliente);

    const salida: SalidaDeVencimientos = { aplicados, restantes, diferidoPorHorario: false };
    await alTerminar?.(tx, salida);
    return salida;
  });
}

/** Cuántos huecos tienen algo que aplicar ahora mismo. */
async function contarPendientes(
  clientId: string,
  tx: Tx,
  ahora: Date,
  cliente: ContextoDeCliente,
): Promise<number> {
  const filas = await tx.execute<{
    id: string;
    state: string;
    state_changed_at: Date;
    slot_start: Date;
    reminder_sent_at: Date | null;
    escalated_at: Date | null;
    reception_notified_at: Date | null;
  }>(sql`
    select id, state, state_changed_at, slot_start,
           reminder_sent_at, escalated_at, reception_notified_at
      from motor.holds
     where client_id = ${clientId}
       and state in ('propuesta', 'retenida', 'pendiente_recepcion')
  `);

  let pendientes = 0;
  for (const fila of filas) {
    // Una hora ya pasada también es trabajo pendiente: hay que anotarla.
    if (new Date(fila.slot_start) <= ahora) {
      pendientes += 1;
      continue;
    }
    if (fila.state === 'pendiente_recepcion' && fila.reception_notified_at === null) {
      pendientes += 1;
      continue;
    }

    const resultado = transicionar({
      hueco: {
        state: fila.state as never,
        stateChangedAt: new Date(fila.state_changed_at),
        slotStart: new Date(fila.slot_start),
        reminderSentAt: fila.reminder_sent_at === null ? null : new Date(fila.reminder_sent_at),
        escalatedAt: fila.escalated_at === null ? null : new Date(fila.escalated_at),
        receptionNotifiedAt:
          fila.reception_notified_at === null ? null : new Date(fila.reception_notified_at),
      },
      evento: { tipo: 'tiempo' },
      ahora,
      politica: cliente.politica,
    });
    if (!resultado.ok) continue;
    if (cambiaDeEstado(resultado.transicion) || resultado.transicion.efectos.length > 0) {
      pendientes += 1;
    }
  }
  return pendientes;
}
