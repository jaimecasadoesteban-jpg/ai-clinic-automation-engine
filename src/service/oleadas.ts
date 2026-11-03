import { and, eq, sql } from 'drizzle-orm';

import { hashTelefono } from '../core/phone.js';
import { DomainError } from '../core/errors.js';
import * as q from '../db/queries.js';
import { waveRecipients, waves } from '../db/schema.js';
import { dentroDeFranja, resolverCliente } from './contexto.js';
import type { Dependencias } from './pipeline.js';

/**
 * Devuelve el lote de destinatarios y textos de una oleada de reactivación.
 * El envío lo hace n8n; aquí sólo se decide a quién.
 *
 * Dos cosas no negociables:
 *
 * 1. **Sin aprobación registrada del cliente, no se ejecuta.** Mandar mensajes
 *    comerciales en nombre de una clínica que no los ha aprobado no es un fallo
 *    técnico, es hacerlo por nuestra cuenta.
 * 2. **La supresión se comprueba en el momento del envío, no sólo al construir
 *    el segmento.** Entre una cosa y otra pueden pasar días, y en ese hueco cabe
 *    perfectamente una baja. Escribir a quien pidió no recibir más mensajes es
 *    de los pocos fallos de este sistema con consecuencias legales.
 */

export class OleadaSinAprobacion extends DomainError {
  readonly code = 'oleada_sin_aprobacion';
  readonly httpStatus = 409;

  constructor(readonly waveId: string) {
    super(
      `La oleada ${waveId} no tiene aprobación registrada del cliente. ` +
        'No se ejecuta: los mensajes comerciales los aprueba la clínica, no nosotros.',
    );
  }
}

export class OleadaInexistente extends DomainError {
  readonly code = 'oleada_inexistente';
  readonly httpStatus = 404;
}

export interface EntradaDeOleada {
  readonly idempotencyKey: string;
  readonly clientId: string;
  readonly waveId: string;
  readonly limite?: number;
}

export interface DestinatarioDeOleada {
  readonly recipientId: string;
  readonly patientId: string;
  readonly telefono: string;
  readonly nombre: string;
  readonly texto: string;
}

export interface SalidaDeOleada {
  readonly waveId: string;
  readonly destinatarios: DestinatarioDeOleada[];
  /** Cuántos se han descartado por estar de baja, comprobado ahora mismo. */
  readonly suprimidos: number;
  readonly restantes: number;
  readonly diferidoPorHorario: boolean;
}

export async function ejecutarOleada(
  deps: Dependencias,
  entrada: EntradaDeOleada,
): Promise<SalidaDeOleada> {
  const ahora = deps.reloj();

  return deps.core.withClient(entrada.clientId, async (tx) => {
    const cliente = await resolverCliente(entrada.clientId, tx, deps.configuracion);

    const oleadas = await tx
      .select()
      .from(waves)
      .where(and(eq(waves.clientId, entrada.clientId), eq(waves.id, entrada.waveId)))
      .limit(1);
    const oleada = oleadas[0];
    if (oleada === undefined) throw new OleadaInexistente('Esa oleada no existe.');

    // Barrera 1: aprobación. Antes que nada, y sin excepción.
    if (oleada.approvedAt === null || oleada.approvedBy === null) {
      throw new OleadaSinAprobacion(entrada.waveId);
    }

    if (!dentroDeFranja(ahora, cliente)) {
      return {
        waveId: entrada.waveId,
        destinatarios: [],
        suprimidos: 0,
        restantes: -1,
        diferidoPorHorario: true,
      };
    }

    const limite = Math.min(
      entrada.limite ?? cliente.config.envios.loteDeOleada,
      cliente.config.envios.loteDeOleada,
    );

    const candidatos = await tx.execute<{
      recipient_id: string;
      patient_id: string;
      phone_e164: string;
      given_name: string;
    }>(sql`
      select r.id as recipient_id, p.id as patient_id, p.phone_e164, p.given_name
        from motor.wave_recipients r
        join motor.patients p on p.id = r.patient_id and p.client_id = r.client_id
       where r.client_id = ${entrada.clientId}
         and r.wave_id = ${entrada.waveId}
         and r.state = 'pendiente'
       order by r.created_at asc
       limit ${limite}
         for update of r skip locked
    `);

    const destinatarios: DestinatarioDeOleada[] = [];
    let suprimidos = 0;

    for (const fila of candidatos) {
      /**
       * Barrera 2: la lista de bajas Y las solicitudes de derechos vigentes,
       * AQUÍ, con el teléfono en la mano y no con el segmento que se calculó
       * hace tres días.
       *
       * Lo de los derechos faltaba, y era grave: alguien con una supresión, una
       * limitación o una oposición en curso podía recibir publicidad nuestra.
       * Es exactamente lo que el contrato de encargo dice que no pasa, y lo que
       * más caro sale de todo lo que este endpoint puede hacer mal.
       *
       * Se comprueba en el envío por la misma razón que la baja: entre construir
       * el segmento y mandar caben días, y en ese hueco cabe una solicitud.
       */
      const hash = hashTelefono(fila.phone_e164, deps.pimienta);
      const fuera =
        (await q.estaSuprimido(entrada.clientId, tx, hash)) ||
        (await q.tieneDerechoQueLimita(entrada.clientId, tx, fila.patient_id));
      if (fuera) {
        await tx
          .update(waveRecipients)
          .set({ state: 'suprimido' })
          .where(
            and(
              eq(waveRecipients.clientId, entrada.clientId),
              eq(waveRecipients.id, fila.recipient_id),
            ),
          );
        suprimidos += 1;
        continue;
      }

      await tx
        .update(waveRecipients)
        .set({ state: 'enviado', sentAt: ahora })
        .where(
          and(
            eq(waveRecipients.clientId, entrada.clientId),
            eq(waveRecipients.id, fila.recipient_id),
          ),
        );

      destinatarios.push({
        recipientId: fila.recipient_id,
        patientId: fila.patient_id,
        telefono: fila.phone_e164,
        nombre: fila.given_name,
        texto: oleada.templateRef,
      });
    }

    const pendientes = await tx.execute<{ n: number }>(sql`
      select count(*)::int as n from motor.wave_recipients
       where client_id = ${entrada.clientId} and wave_id = ${entrada.waveId}
         and state = 'pendiente'
    `);

    await q.anotarAuditoria(entrada.clientId, tx, {
      entity: 'waves',
      entityId: entrada.waveId,
      action: 'oleada_ejecutada',
      actor: 'n8n',
      idempotencyKey: entrada.idempotencyKey,
    });

    return {
      waveId: entrada.waveId,
      destinatarios,
      suprimidos,
      restantes: pendientes[0]?.n ?? 0,
      diferidoPorHorario: false,
    };
  });
}
