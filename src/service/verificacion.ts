import type { Tx } from '../db/client.js';
import { sql } from 'drizzle-orm';
import { registrarLatido } from './vigilancia.js';

import * as q from '../db/queries.js';
import { resolverCliente } from './contexto.js';
import { resolverEfectos, type EfectoResuelto } from './efectos.js';
import type { Dependencias, EfectoDeSalida } from './pipeline.js';

/**
 * Paso 8 del flujo: releer la agenda como red de seguridad.
 *
 * Recepción dijo que metió la cita, y se confirmó al paciente. Si media hora
 * después el hueco aparece libre en la agenda de la clínica, o alguien lo ha
 * ocupado con otra cosa, hay que enterarse ahora y no el día de la cita.
 *
 * Sólo lectura y sólo ocupado/libre (regla 3). Aquí no se escribe en la agenda
 * de nadie: se detecta y se escala.
 */

export interface EntradaDeVerificacion {
  readonly clientId: string;
  readonly limite?: number;
}

export interface HuecoVerificado {
  readonly holdId: string;
  readonly slotStart: string;
  readonly estado: 'ok' | 'colisionada';
}

export interface SalidaDeVerificacion {
  readonly verificados: HuecoVerificado[];
  readonly colisiones: number;
  /**
   * El escalado de cada cita que aparece libre, resuelto: a quién y qué.
   *
   * Antes no salía. Se creaba la fila en `escalations` y la respuesta sólo
   * decía `colisiones: 1`: n8n no tenía a quién avisar ni qué decir, y una cita
   * confirmada que no estaba en la agenda de la clínica se descubría el día de
   * la cita, con el paciente en la puerta.
   */
  readonly efectos: EfectoResuelto[];
}

function momento(fecha: Date, zonaHoraria: string): string {
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: zonaHoraria,
    weekday: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(fecha);
}

export async function verificarCitas(
  deps: Dependencias,
  entrada: EntradaDeVerificacion,
  /**
   * Para quien envía desde el núcleo (el planificador): corre **dentro** de la
   * transacción, así lo que haya que mandar se encola junto con el cambio de
   * estado (regla 3). Por HTTP no se pasa y la salida vuelve a quien llamó.
   */
  alTerminar?: (tx: Tx, salida: SalidaDeVerificacion) => Promise<void>,
): Promise<SalidaDeVerificacion> {
  const ahora = deps.reloj();

  return deps.core.withClient(entrada.clientId, async (tx) => {
    const cliente = await resolverCliente(entrada.clientId, tx, deps.configuracion);
    await registrarLatido(entrada.clientId, tx, 'verificar-citas', ahora);
    const limite = entrada.limite ?? cliente.config.envios.loteDeVencimientos;

    const filas = await tx.execute<{
      id: string;
      slot_start: Date;
      slot_end: Date;
      conversation_id: string;
      patient_id: string;
      service_code: string;
      collision_detected_at: Date | null;
    }>(sql`
      select id, slot_start, slot_end, conversation_id, patient_id, service_code, collision_detected_at
        from motor.holds
       where client_id = ${entrada.clientId}
         and state = 'confirmada'
         and slot_start > ${ahora.toISOString()}
       order by slot_start asc
       limit ${limite}
         for update skip locked
    `);

    const verificados: HuecoVerificado[] = [];
    const efectos: EfectoDeSalida[] = [];
    let colisiones = 0;

    for (const fila of filas) {
      const inicio = new Date(fila.slot_start);
      const libre = await deps.agenda.sigueLibre({
        clientId: entrada.clientId,
        calendarioId: cliente.config.agenda.calendarioId,
        inicio,
        fin: new Date(fila.slot_end),
      });

      // Que el hueco esté LIBRE es la mala noticia: significa que la cita no
      // llegó a existir en el programa de la clínica, o que alguien la borró.
      if (libre) {
        colisiones += 1;
        verificados.push({ holdId: fila.id, slotStart: inicio.toISOString(), estado: 'colisionada' });

        // Una vez por cita, no una por pasada: este cron corre cada 30 minutos,
        // y la misma cita libre avisaría cuarenta y ocho veces al día. Si
        // recepción la mete y luego vuelve a desaparecer, se vuelve a avisar.
        if (fila.collision_detected_at !== null) continue;

        await q.actualizarHueco(entrada.clientId, tx, fila.id, {
          collisionDetectedAt: ahora,
        });
        const servicio =
          cliente.config.servicios.find((s) => s.codigo === fila.service_code)?.nombre ?? fila.service_code;
        // `agenda_no_escrita` y no `sin_respuesta_recepcion`, que recepción
        // leía como «cita sin confirmar, a punto de caducar» sobre una cita que
        // estaba confirmada. Lo que pasa es que no está en la agenda.
        const escaladoId = await q.crearEscalado(entrada.clientId, tx, {
          conversationId: fila.conversation_id,
          patientId: fila.patient_id,
          holdId: fila.id,
          reason: 'agenda_no_escrita',
          /**
           * Severidad 2, no 3. Una cita que falta en la agenda es grave para la
           * operación, no para la salud de nadie. La 3 sale a cualquier hora y
           * llega al contacto clínico, y ése es el canal que no se puede
           * ensuciar: si el responsable médico recibe avisos de agenda a las dos
           * de la mañana, deja de mirar el que sí importa.
           */
          severity: 2,
          detail:
            `La cita confirmada de ${servicio} del ${momento(inicio, cliente.config.zonaHoraria)} ` +
            'no aparece en la agenda: ese hueco sale libre. Comprueba que está metida.',
          notifiedAt: ahora,
          createdAt: ahora,
        });
        await q.anotarAuditoria(entrada.clientId, tx, {
          entity: 'holds',
          entityId: fila.id,
          action: 'verificacion:hueco_libre_pero_confirmado',
          actor: 'sistema',
        });
        efectos.push({ tipo: 'escalar_a_humano', escaladoId, severidad: 2, motivo: 'agenda_no_escrita' });
        continue;
      }

      // Vuelve a estar ocupado: recepción la metió. Si desaparece otra vez, se
      // tiene que volver a avisar.
      if (fila.collision_detected_at !== null) {
        await q.actualizarHueco(entrada.clientId, tx, fila.id, { collisionDetectedAt: null });
      }
      verificados.push({ holdId: fila.id, slotStart: inicio.toISOString(), estado: 'ok' });
    }

    const salida: SalidaDeVerificacion = {
      verificados,
      colisiones,
      efectos: await resolverEfectos(entrada.clientId, tx, cliente, efectos),
    };
    await alTerminar?.(tx, salida);
    return salida;
  });
}
