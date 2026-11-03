import type { Tx } from '../db/client.js';
import * as q from '../db/queries.js';

/**
 * **El interruptor del agente**: parado, no contesta a esa persona hasta que
 * alguien lo reactive. Sin plazo y sin reactivarse solo — así lo quiere la
 * clínica: si lo para es porque lleva ella la conversación.
 *
 * La verdad vive en `patients.agent_stopped_at`, no en quien lo mueve. Hoy lo
 * mueve una etiqueta de Chatwoot; mañana, el botón de la interfaz. Lo que no
 * apaga: el registro del mensaje y el cortafuegos (ver `pipeline.ts`).
 */
export async function ponerInterruptor(
  clientId: string,
  tx: Tx,
  datos: { telefono: string; nombre: string; parado: boolean; por: string; ahora: Date },
): Promise<{ cambiado: boolean }> {
  const paciente = await q.upsertPatient(clientId, tx, { phoneE164: datos.telefono, givenName: datos.nombre });
  const cambiado = await q.cambiarInterruptorDelAgente(clientId, tx, {
    patientId: paciente.id,
    parado: datos.parado,
    por: datos.por,
    ahora: datos.ahora,
  });
  if (cambiado) {
    await q.anotarAuditoria(clientId, tx, {
      entity: 'patients',
      entityId: paciente.id,
      action: datos.parado ? 'agente_parado' : 'agente_reactivado',
      actor: 'recepcion',
      payload: { por: datos.por },
    });
  }
  return { cambiado };
}
