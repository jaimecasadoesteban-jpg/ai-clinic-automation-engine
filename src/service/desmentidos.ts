import { and, desc, eq, gt, inArray, isNotNull, isNull } from 'drizzle-orm';

import { momentoCoincideCon, reservasAfirmadas } from '../agent/output-validation.js';
import type { Tx } from '../db/client.js';
import { auditLog, holds, messages } from '../db/schema.js';

/**
 * **Un mensaje falso del historial no se oculta: se desmiente.**
 *
 * El caso: el agente escribió «te la dejo apuntada el lunes a las 10:20» sin que
 * se hubiera reservado nada. Al día siguiente, a un «Hola», el modelo leyó ese
 * mensaje e intentó recordarle al paciente su cita del lunes. La validación lo
 * bloqueó con razón, y el escalado salió como «validación fallida», que no le
 * dice nada a recepción. Un mensaje falso no caduca ni se corrige solo: cada
 * turno siguiente hereda la mentira.
 *
 * No se oculta. Si desaparece de la ventana, el modelo no entiende «¿entonces lo
 * del lunes?» y el paciente sigue creyéndoselo. Se marca, entra en la ventana
 * anotado con la verdad, y recepción recibe un escalado que dice QUÉ aclarar.
 *
 * ## Qué se puede detectar sin una persona
 *
 * Una afirmación de reserva con día y hora tiene con qué compararse: la
 * auditoría dice si alguna vez se retuvo ese hueco. Si nunca hubo un
 * `paciente_elige` sobre un hueco con ese día y esa hora, la reserva no existió.
 *
 * **Alguna vez, no «antes del mensaje».** Comparar horas metía dos relojes —la
 * auditoría se sella con `now()` de Postgres y el mensaje con el del turno— y
 * desmentía reservas reales en cuanto no coincidían. Y no hace falta: si el
 * hueco llegó a retenerse, el mensaje describe algo que existió y no engaña a
 * nadie. Lo que no tiene estado con qué compararse —un
 * aparcamiento inventado— no se puede detectar así; para eso queda pendiente una
 * acción de recepción que desmienta a mano.
 */

/** Los turnos que mira: la misma ventana que ve el modelo, y algo más. */
const MENSAJES_A_REVISAR = 20;

export interface ReservaDesmentida {
  readonly messageId: string;
  /** La verdad, en una frase y sin datos del paciente. */
  readonly nota: string;
  /** El hueco que se afirmó, si existió como propuesta. Para poder negarlo. */
  readonly huecos: readonly Date[];
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

/**
 * Revisa los mensajes del modelo de la ventana, marca los que afirmaron una
 * reserva que no existió y devuelve **todos** los desmentidos de la ventana —los
 * de antes y los nuevos—, con `nuevos` aparte para escalar sólo una vez.
 */
export async function desmentirReservasFalsas(
  clientId: string,
  tx: Tx,
  datos: { conversationId: string; ahora: Date; zonaHoraria: string },
): Promise<{ desmentidos: ReservaDesmentida[]; nuevos: ReservaDesmentida[] }> {
  const recientes = await tx
    .select({
      id: messages.id,
      body: messages.body,
      createdAt: messages.createdAt,
      disprovedAt: messages.disprovedAt,
      disprovedNote: messages.disprovedNote,
    })
    .from(messages)
    .where(
      and(
        eq(messages.clientId, clientId),
        eq(messages.conversationId, datos.conversationId),
        eq(messages.direction, 'saliente'),
        // Sólo lo que redactó el modelo: los textos fijos no afirman nada que
        // no haya hecho el sistema en ese mismo turno.
        isNotNull(messages.model),
        isNotNull(messages.body),
        gt(messages.purgeAt, datos.ahora),
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.direction))
    .limit(MENSAJES_A_REVISAR);

  if (recientes.length === 0) return { desmentidos: [], nuevos: [] };

  const huecos = await tx
    .select({ id: holds.id, slotStart: holds.slotStart })
    .from(holds)
    .where(and(eq(holds.clientId, clientId), eq(holds.conversationId, datos.conversationId)));

  const elegidos =
    huecos.length === 0
      ? []
      : await tx
          .select({ holdId: auditLog.entityId })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.clientId, clientId),
              eq(auditLog.entity, 'holds'),
              eq(auditLog.action, 'paciente_elige'),
              inArray(
                auditLog.entityId,
                huecos.map((h) => h.id),
              ),
            ),
          );

  const desmentidos: ReservaDesmentida[] = [];
  const nuevos: ReservaDesmentida[] = [];

  for (const mensaje of recientes) {
    const afirmados = reservasAfirmadas(mensaje.body ?? '').filter((m) => m.horas !== null);
    if (afirmados.length === 0) continue;

    const deEseMomento = (m: (typeof afirmados)[number]) =>
      huecos.filter((h) => momentoCoincideCon(m, h.slotStart, mensaje.createdAt, datos.zonaHoraria));

    // Falso si ALGUNO de los momentos afirmados no se retuvo nunca.
    const falsos = afirmados.filter(
      (m) => !deEseMomento(m).some((h) => elegidos.some((e) => e.holdId === h.id)),
    );
    if (falsos.length === 0) continue;

    const huecosAfirmados = falsos.flatMap((m) => deEseMomento(m).map((h) => h.slotStart));
    const nota =
      mensaje.disprovedNote ??
      `No existe ninguna cita ${falsos
        .map((m) => {
          const h = deEseMomento(m)[0];
          return h === undefined ? m.literal.trim() : `el ${momento(h.slotStart, datos.zonaHoraria)}`;
        })
        .join(' ni ')}: nunca llegó a reservarse.`;

    const desmentido = { messageId: mensaje.id, nota, huecos: huecosAfirmados };
    desmentidos.push(desmentido);

    if (mensaje.disprovedAt === null) {
      await tx
        .update(messages)
        .set({ disprovedAt: datos.ahora, disprovedNote: nota })
        .where(
          and(eq(messages.clientId, clientId), eq(messages.id, mensaje.id), isNull(messages.disprovedAt)),
        );
      nuevos.push(desmentido);
    }
  }

  return { desmentidos, nuevos };
}
