import { and, desc, eq, gt, gte, inArray, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';

import { sigueVivo, type PoliticaDeVencimientos } from '../core/hold-state-machine.js';
import type { Tx } from './client.js';
import {
  appointments,
  conversations,
  escalations,
  holds,
  messages,
  inbox,
  outbox,
  patients,
  rightsRequests,
  suppression,
  type CargaDeChatwoot,
  type CargaDeEtiqueta,
  type CargaDeEvento,
  type CargaDeCorreo,
  type CanalDelPaciente,
} from './schema.js';

/**
 * Acceso a datos. **Toda función recibe `clientId` como primer parámetro, sin
 * valor por defecto** (regla 1), y filtra por él además de la RLS: el filtro de
 * la aplicación y la política de Postgres son dos capas, no una.
 */

export type PatientRow = typeof patients.$inferSelect;
export type ConversationRow = typeof conversations.$inferSelect;
export type HoldRow = typeof holds.$inferSelect;
export type AppointmentRow = typeof appointments.$inferSelect;
export type RightsRequestRow = typeof rightsRequests.$inferSelect;

export async function upsertPatient(
  clientId: string,
  tx: Tx,
  datos: { phoneE164: string; givenName: string; familyName?: string | null },
): Promise<PatientRow> {
  const [fila] = await tx
    .insert(patients)
    .values({
      clientId,
      phoneE164: datos.phoneE164,
      givenName: datos.givenName,
      familyName: datos.familyName ?? null,
      seq: 0, // lo sobrescribe el trigger de numeración por clínica
    })
    .onConflictDoUpdate({
      target: [patients.clientId, patients.phoneE164],
      set: { updatedAt: new Date() },
    })
    .returning();

  if (fila === undefined) throw new Error('no se pudo crear el paciente');
  return fila;
}

/**
 * Cuándo escribió el paciente por última vez, en cualquiera de sus
 * conversaciones: la ventana de 24 h de WhatsApp es de la persona con la línea,
 * no de una conversación nuestra.
 */
export async function ultimoMensajeDelPaciente(clientId: string, tx: Tx, conversationId: string): Promise<Date | null> {
  const [fila] = filasDe<{ ultimo: Date | string | null }>(
    await tx.execute(sql`
      select max(m.created_at) as ultimo
        from motor.messages m
        join motor.conversations c on c.id = m.conversation_id and c.client_id = m.client_id
       where m.client_id = ${clientId}
         and m.direction = 'entrante'
         and c.patient_id = (select patient_id from motor.conversations where client_id = ${clientId} and id = ${conversationId})
    `),
  );
  return fila?.ultimo == null ? null : new Date(fila.ultimo);
}

function filasDe<T>(resultado: unknown): T[] {
  return [...(resultado as Iterable<T>)];
}

/** La fila de salida de un mensaje que mandamos por Chatwoot, por el id que le dio Chatwoot. */
export async function salidaPorReferencia(clientId: string, tx: Tx, chatwootMensajeId: number) {
  const [fila] = await tx
    .select()
    .from(outbox)
    .where(and(eq(outbox.clientId, clientId), eq(outbox.kind, 'chatwoot'), eq(outbox.sentRef, String(chatwootMensajeId))))
    .limit(1);
  return fila;
}

/** ¿Este mensaje de Chatwoot lo mandamos nosotros? Ver la migración 0021. */
export async function esEcoNuestro(clientId: string, tx: Tx, chatwootMensajeId: number): Promise<boolean> {
  const filas = await tx
    .select({ id: outbox.id })
    .from(outbox)
    .where(and(eq(outbox.clientId, clientId), eq(outbox.kind, 'chatwoot'), eq(outbox.sentRef, String(chatwootMensajeId))))
    .limit(1);
  return filas.length > 0;
}

/** Deja en la conversación por dónde se le escribe. Ver la migración 0019. */
export async function guardarCanal(clientId: string, tx: Tx, conversationId: string, canal: CanalDelPaciente): Promise<void> {
  await tx
    .update(conversations)
    .set({ replyChannel: canal })
    .where(and(eq(conversations.clientId, clientId), eq(conversations.id, conversationId)));
}

/** Por dónde se le escribe a esta conversación, si se sabe. */
export async function canalDeLaConversacion(clientId: string, tx: Tx, conversationId: string): Promise<CanalDelPaciente | null> {
  const [fila] = await tx
    .select({ replyChannel: conversations.replyChannel })
    .from(conversations)
    .where(and(eq(conversations.clientId, clientId), eq(conversations.id, conversationId)));
  return fila?.replyChannel ?? null;
}

/** La conversación de un escalado. */
export async function conversacionDelEscalado(clientId: string, tx: Tx, escaladoId: string): Promise<string | null> {
  const [fila] = await tx
    .select({ conversationId: escalations.conversationId })
    .from(escalations)
    .where(and(eq(escalations.clientId, clientId), eq(escalations.id, escaladoId)));
  return fila?.conversationId ?? null;
}

/**
 * Para o reactiva el agente para un paciente. Devuelve si ha cambiado algo: una
 * etiqueta que ya estaba no es un cambio, y no deja rastro de más.
 */
export async function cambiarInterruptorDelAgente(
  clientId: string,
  tx: Tx,
  datos: { patientId: string; parado: boolean; por: string; ahora: Date },
): Promise<boolean> {
  const filas = await tx
    .update(patients)
    .set(
      datos.parado
        ? { agentStoppedAt: datos.ahora, agentStoppedBy: datos.por, updatedAt: datos.ahora }
        : { agentStoppedAt: null, agentStoppedBy: null, updatedAt: datos.ahora },
    )
    .where(
      and(
        eq(patients.clientId, clientId),
        eq(patients.id, datos.patientId),
        datos.parado ? isNull(patients.agentStoppedAt) : sql`${patients.agentStoppedAt} is not null`,
      ),
    )
    .returning({ id: patients.id });
  return filas.length > 0;
}

export async function estaSuprimido(
  clientId: string,
  tx: Tx,
  phoneHash: string,
): Promise<boolean> {
  const filas = await tx
    .select({ id: suppression.id })
    .from(suppression)
    .where(
      and(
        eq(suppression.clientId, clientId),
        eq(suppression.phoneHash, phoneHash),
        // Una baja revocada por el propio paciente ya no bloquea nada.
        isNull(suppression.revokedAt),
      ),
    )
    .limit(1);

  return filas.length > 0;
}

export async function registrarBaja(
  clientId: string,
  tx: Tx,
  datos: { patientId: string; phoneHash: string },
): Promise<void> {
  await tx
    .insert(suppression)
    .values({
      clientId,
      patientId: datos.patientId,
      phoneHash: datos.phoneHash,
      reason: 'baja_solicitada',
    })
    .onConflictDoNothing();
}

export async function conversacionAbierta(
  clientId: string,
  tx: Tx,
  patientId: string,
): Promise<ConversationRow> {
  const existentes = await tx
    .select()
    .from(conversations)
    .where(and(eq(conversations.clientId, clientId), eq(conversations.patientId, patientId)))
    .orderBy(desc(conversations.createdAt))
    .limit(1);

  const existente = existentes[0];
  if (existente !== undefined) return existente;

  const [nueva] = await tx
    .insert(conversations)
    .values({ clientId, patientId, purgeAt: new Date() }) // el trigger la recalcula
    .returning();

  if (nueva === undefined) throw new Error('no se pudo crear la conversación');
  return nueva;
}

export async function actualizarConversacion(
  clientId: string,
  tx: Tx,
  id: string,
  cambios: Partial<typeof conversations.$inferInsert>,
): Promise<void> {
  await tx
    .update(conversations)
    .set(cambios)
    .where(and(eq(conversations.clientId, clientId), eq(conversations.id, id)));
}

/**
 * Entrantes recientes de la conversación, para la ventana del cortafuegos.
 *
 * Se excluyen los que YA cortaron. Si no, durante los tres minutos siguientes a
 * una urgencia todos los mensajes volverían a cortar por arrastre, generando un
 * escalado nuevo cada vez — que es la receta exacta de la fatiga de alertas.
 * Un mensaje que ya provocó un corte está atendido; no vuelve a contar.
 */
export async function entrantesRecientes(
  clientId: string,
  tx: Tx,
  conversationId: string,
  desde: Date,
): Promise<Array<{ texto: string; recibidoEn: Date }>> {
  const filas = await tx
    .select({ body: messages.body, createdAt: messages.createdAt })
    .from(messages)
    .where(
      and(
        eq(messages.clientId, clientId),
        eq(messages.conversationId, conversationId),
        eq(messages.direction, 'entrante'),
        isNull(messages.firewallCategory),
        gte(messages.createdAt, desde),
      ),
    )
    .orderBy(messages.createdAt, messages.direction);

  return filas
    .filter((f): f is { body: string; createdAt: Date } => f.body !== null)
    .map((f) => ({ texto: f.body, recibidoEn: f.createdAt }));
}

/** La ventana de conversación que ve el modelo: últimos turnos, en orden. */
/**
 * Los últimos turnos, para el modelo.
 *
 * **Sólo los que no han vencido su retención.** La redacción la hace
 * `motor.purge_expired()` una vez al día; entre que vence `purge_at` y que pasa,
 * el contenido seguía aquí y salía hacia el proveedor del modelo, que es un
 * tercero. Un mensaje clínico de hace 91 días no existe para la regla de
 * retención, y no puede existir para el prompt porque un proceso no haya pasado.
 */
export async function turnosRecientes(
  clientId: string,
  tx: Tx,
  conversationId: string,
  limite: number,
  ahora: Date,
): Promise<Array<{ rol: 'paciente' | 'clinica'; texto: string }>> {
  const filas = await tx
    .select({
      direction: messages.direction,
      body: messages.body,
      disprovedNote: messages.disprovedNote,
    })
    .from(messages)
    .where(
      and(
        eq(messages.clientId, clientId),
        eq(messages.conversationId, conversationId),
        gt(messages.purgeAt, ahora),
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.direction))
    .limit(limite);

  return filas
    .reverse()
    .filter(
      (f): f is { direction: 'entrante' | 'saliente'; body: string; disprovedNote: string | null } =>
        f.body !== null,
    )
    .map((f) => ({
      rol: f.direction === 'entrante' ? 'paciente' : 'clinica',
      // Un mensaje desmentido no se oculta: si desapareciera, el modelo no
      // entendería «¿entonces lo del lunes?». Entra con la verdad delante.
      texto:
        f.disprovedNote === null
          ? f.body
          : `[CORRECCIÓN: este mensaje de la clínica NO era cierto. ${f.disprovedNote}] «${f.body}»`,
    }));
}

/** Cuántas llamadas al modelo lleva ya esta conversación. Alimenta el tope de gasto. */
/**
 * Llamadas al modelo de una conversación desde `desde`: todas, no sólo los
 * mensajes redactados. Salen del registro de cada turno (`messages.prompt`),
 * que guarda una entrada por llamada —clasificar, redactar, regenerar, resumir—.
 */
export async function llamadasAlModelo(
  clientId: string,
  tx: Tx,
  datos: { conversationId: string; desde: Date },
): Promise<number> {
  const filas = await tx.execute<{ n: number }>(sql`
    select coalesce(sum(jsonb_array_length(prompt->'llamadas')), 0)::int as n
      from motor.messages
     where client_id = ${clientId} and conversation_id = ${datos.conversationId}
       and direction = 'entrante'
       and created_at > ${datos.desde.toISOString()}
       and jsonb_typeof(prompt->'llamadas') = 'array'
  `);
  return filas[0]?.n ?? 0;
}

/**
 * Deja en el mensaje entrante lo que el modelo hizo en su turno: cada llamada
 * con su prompt y su respuesta, y la suma de tokens y de latencia.
 *
 * En el entrante porque es el turno: una respuesta compuesta sin modelo
 * —el horario— también clasificó antes, y esa llamada tiene que constar.
 * El prompt se purga a los 90 días, venga de la fila que venga (migración 0013).
 */
export async function registrarLlamadas(
  clientId: string,
  tx: Tx,
  mensajeId: string,
  llamadas: readonly import('../service/ports.js').LlamadaAlModelo[],
): Promise<void> {
  if (llamadas.length === 0) return;
  await tx
    .update(messages)
    .set({
      prompt: { llamadas },
      latencyMs: llamadas.reduce((t, l) => t + l.latenciaMs, 0),
      promptTokens: llamadas.reduce((t, l) => t + l.tokensEntrada, 0),
      completionTokens: llamadas.reduce((t, l) => t + l.tokensSalida, 0),
    })
    .where(and(eq(messages.clientId, clientId), eq(messages.id, mensajeId)));
}

/**
 * Los mensajes que han salido de la ventana de turnos desde el último resumen,
 * del más antiguo al más nuevo. Todos, también los que no se van a resumir: el
 * resumen avanza sobre ellos igual, o un mensaje clínico se quedaría «pendiente
 * de resumir» para siempre.
 */
export async function mensajesFueraDeLaVentana(
  clientId: string,
  tx: Tx,
  datos: { conversationId: string; ventana: number; desde: Date | null },
): Promise<Array<typeof messages.$inferSelect>> {
  const recientes = tx
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.clientId, clientId), eq(messages.conversationId, datos.conversationId)))
    .orderBy(desc(messages.createdAt), desc(messages.direction))
    .limit(datos.ventana);

  const filas = await tx
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.clientId, clientId),
        eq(messages.conversationId, datos.conversationId),
        sql`${messages.id} not in ${recientes}`,
        ...(datos.desde === null ? [] : [gt(messages.createdAt, datos.desde)]),
      ),
    )
    .orderBy(messages.createdAt, messages.direction);
  return filas;
}

/**
 * Si en la conversación queda algo vivo además de `excepto`: una propuesta, una
 * retención, algo pendiente de recepción o una cita confirmada que no ha pasado.
 *
 * Por estado y hora, no por `sigueVivo`: quien pregunta es el cron que está
 * materializando esos mismos vencimientos, y una propuesta vencida que todavía
 * no ha procesado tiene que contar como viva para que el aviso lo dé la última
 * en caer, no la primera.
 */
export async function quedaAlgoVivoEnLaConversacion(
  clientId: string,
  tx: Tx,
  datos: { conversationId: string; excepto: string; ahora: Date },
): Promise<boolean> {
  const [fila] = await tx
    .select({ id: holds.id })
    .from(holds)
    .where(
      and(
        eq(holds.clientId, clientId),
        eq(holds.conversationId, datos.conversationId),
        ne(holds.id, datos.excepto),
        or(
          inArray(holds.state, ['propuesta', 'retenida', 'pendiente_recepcion']),
          and(eq(holds.state, 'confirmada'), gt(holds.slotStart, datos.ahora)),
        ),
      ),
    )
    .limit(1);
  return fila !== undefined;
}

export async function guardarMensaje(
  clientId: string,
  tx: Tx,
  datos: Omit<typeof messages.$inferInsert, 'clientId' | 'purgeAt'>,
): Promise<string> {
  const [fila] = await tx
    .insert(messages)
    .values({ ...datos, clientId, purgeAt: new Date() }) // el trigger lo recalcula
    .returning({ id: messages.id });

  if (fila === undefined) throw new Error('no se pudo registrar el mensaje');
  return fila.id;
}

export async function crearEscalado(
  clientId: string,
  tx: Tx,
  datos: Omit<typeof escalations.$inferInsert, 'clientId'>,
): Promise<string> {
  const [fila] = await tx
    .insert(escalations)
    .values({ ...datos, clientId })
    .returning({ id: escalations.id });

  if (fila === undefined) throw new Error('no se pudo crear el escalado');
  return fila.id;
}

/** Un escalado por su id. Lo necesita quien tiene que decir a quién avisar. */
export async function buscarEscalado(
  clientId: string,
  tx: Tx,
  escaladoId: string,
): Promise<typeof escalations.$inferSelect | undefined> {
  const filas = await tx
    .select()
    .from(escalations)
    .where(and(eq(escalations.clientId, clientId), eq(escalations.id, escaladoId)))
    .limit(1);

  return filas[0];
}

export async function proponerHuecos(
  clientId: string,
  tx: Tx,
  datos: {
    patientId: string;
    conversationId: string;
    serviceCode: string;
    huecos: ReadonlyArray<{ inicio: Date; fin: Date }>;
    expiresAt: Date;
    /**
     * El reloj del turno. Sin él, `state_changed_at` quedaba con el `now()` de
     * Postgres, y es de ahí desde donde la máquina de estados cuenta las 6 horas
     * de vida de una propuesta: dos relojes para un mismo plazo.
     */
    ahora: Date;
    /**
     * La cita que estos huecos sustituirían, si se proponen para cambiar una
     * concreta. Es lo único que autoriza a soltar otra cita al elegir uno.
     */
    replacesHoldId: string | null;
  },
): Promise<HoldRow[]> {
  if (datos.huecos.length === 0) return [];

  return tx
    .insert(holds)
    .values(
      datos.huecos.map((hueco, indice) => ({
        clientId,
        patientId: datos.patientId,
        conversationId: datos.conversationId,
        slotStart: hueco.inicio,
        slotEnd: hueco.fin,
        serviceCode: datos.serviceCode,
        state: 'propuesta' as const,
        rank: indice + 1,
        stateChangedAt: datos.ahora,
        expiresAt: datos.expiresAt,
        replacesHoldId: datos.replacesHoldId,
      })),
    )
    .returning();
}

/**
 * El momento de una lectura y las reglas con que se juzga qué sigue vivo en él.
 *
 * **Obligatorio en toda lectura de huecos «vivos», sin valor por defecto.** Un
 * cron materializa el estado; no lo define. Sin crons, estas consultas dieron
 * por vivas propuestas de agosto y una cita del 28 de agosto, porque las filas
 * lo decían y nadie las había corregido. Ver `sigueVivo`.
 */
export interface Vigencia {
  readonly ahora: Date;
  readonly politica: PoliticaDeVencimientos;
}

function vivos(filas: readonly HoldRow[], vigencia: Vigencia): HoldRow[] {
  return filas.filter((h) => sigueVivo(h, vigencia.ahora, vigencia.politica));
}

/**
 * Las propuestas vigentes de una conversación: las que el paciente tiene delante
 * AHORA. Una propuesta vencida o cuya hora ya pasó no está aquí aunque su fila
 * siga diciendo `propuesta` porque el cron no ha pasado.
 */
export async function huecosPropuestos(
  clientId: string,
  tx: Tx,
  conversationId: string,
  vigencia: Vigencia,
): Promise<HoldRow[]> {
  const filas = await tx
    .select()
    .from(holds)
    .where(
      and(
        eq(holds.clientId, clientId),
        eq(holds.conversationId, conversationId),
        eq(holds.state, 'propuesta'),
      ),
    )
    .orderBy(holds.rank);

  return vivos(filas, vigencia);
}

/**
 * Las citas que el paciente ya tiene en esta conversación: retenidas,
 * pendientes de recepción o confirmadas. **Exactamente los estados que bloquean
 * el hueco.** En orden de fecha, que es el orden en que se le enseñan al
 * clasificador y en el que se resuelve `cita`.
 *
 * **Pueden ser varias**, y no sólo durante un reagendado: limpieza el miércoles y
 * láser el viernes es lo normal. Antes había aquí `huecoActivo`, que devolvía UNA
 * fila con el comentario «como mucho hay uno», y sobre esa suposición se
 * construyó que elegir cualquier hueco soltara «la» cita del paciente. Al pedir
 * láser se perdió la limpieza.
 *
 * `bloquear` es explícito porque las dos formas se usan y confundirlas duele:
 * quien va a CAMBIAR una cita tiene que bloquearla —bloqueante, no SKIP LOCKED:
 * si recepción está confirmando esa misma cita ahora, hay que esperarla y leer
 * lo que deje— y quien sólo lee para componer un mensaje no debe retener filas.
 */
export async function citasVivas(
  clientId: string,
  tx: Tx,
  conversationId: string,
  opciones: { bloquear: boolean } & Vigencia,
): Promise<HoldRow[]> {
  const consulta = tx
    .select()
    .from(holds)
    .where(
      and(
        eq(holds.clientId, clientId),
        eq(holds.conversationId, conversationId),
        inArray(holds.state, ['retenida', 'pendiente_recepcion', 'confirmada']),
      ),
    )
    .orderBy(holds.slotStart, holds.id);

  // Se bloquean también las que ya no están vivas —la consulta no sabe de
  // tiempo— pero no se devuelven: una cita del 28 de agosto no es «su cita».
  return vivos(await (opciones.bloquear ? consulta.for('update') : consulta), opciones);
}

/**
 * Las propuestas vivas de ese tratamiento pasan a sustituir a `replacesHoldId`.
 *
 * Para el turno en que pide cambiar una cita concreta sin que se le propongan
 * huecos nuevos: «¿podría cambiarla?» y, al siguiente, «la primera» de las que
 * ya tenía delante. Sin esto la intención de cambiar se perdía entre turnos y se
 * le preguntaba «¿en lugar o además?» a quien acababa de decir que la cambiaba.
 */
export async function vincularPropuestas(
  clientId: string,
  tx: Tx,
  datos: { conversationId: string; serviceCode: string; replacesHoldId: string },
): Promise<void> {
  await tx
    .update(holds)
    .set({ replacesHoldId: datos.replacesHoldId })
    .where(
      and(
        eq(holds.clientId, clientId),
        eq(holds.conversationId, datos.conversationId),
        eq(holds.serviceCode, datos.serviceCode),
        eq(holds.state, 'propuesta'),
      ),
    );
}

/**
 * La cita que sustituye a ésta, si el paciente la cambió por otra.
 *
 * La que la NOMBRA en `replaces_hold_id`, no «la otra que tenga viva»: con varias
 * citas, ésa puede ser de otro tratamiento, y a recepción se le diría que meta
 * una cita que no tiene nada que ver con el aviso que acaba de pulsar.
 */
export async function sustitutoDe(
  clientId: string,
  tx: Tx,
  holdId: string,
  vigencia: Vigencia,
): Promise<HoldRow | undefined> {
  const filas = await tx
    .select()
    .from(holds)
    .where(
      and(
        eq(holds.clientId, clientId),
        eq(holds.replacesHoldId, holdId),
        inArray(holds.state, ['retenida', 'pendiente_recepcion', 'confirmada']),
      ),
    )
    .orderBy(desc(holds.stateChangedAt));

  return vivos(filas, vigencia)[0];
}

/**
 * Un paciente por su id. Lo necesita quien tiene que componer algo con su
 * nombre —el evento de la agenda— sin haber pasado por el pipeline.
 */
export async function buscarPaciente(
  clientId: string,
  tx: Tx,
  patientId: string,
): Promise<PatientRow | undefined> {
  const filas = await tx
    .select()
    .from(patients)
    .where(and(eq(patients.clientId, clientId), eq(patients.id, patientId)))
    .limit(1);

  return filas[0];
}

export async function buscarHueco(
  clientId: string,
  tx: Tx,
  holdId: string,
): Promise<HoldRow | undefined> {
  const filas = await tx
    .select()
    .from(holds)
    .where(and(eq(holds.clientId, clientId), eq(holds.id, holdId)))
    .limit(1);

  return filas[0];
}

export async function actualizarHueco(
  clientId: string,
  tx: Tx,
  id: string,
  cambios: Partial<typeof holds.$inferInsert>,
): Promise<void> {
  await tx
    .update(holds)
    .set(cambios)
    .where(and(eq(holds.clientId, clientId), eq(holds.id, id)));
}

/**
 * `ahora` entra como parámetro, como en todo lo demás. Con `new Date()` estos
 * huecos quedaban sellados con la hora del reloj de pared en mitad de la
 * transacción: en la sesión real, los caducados llevan una marca 3,5 segundos
 * posterior a la del resto de escrituras del mismo turno —lo que tardaron las
 * dos llamadas al modelo— y reconstruir el orden de lo que pasó se vuelve un
 * ejercicio de adivinación.
 */
export async function caducarHuecos(
  clientId: string,
  tx: Tx,
  ids: readonly string[],
  ahora: Date,
): Promise<void> {
  if (ids.length === 0) return;
  await tx
    .update(holds)
    .set({ state: 'caducada', stateChangedAt: ahora })
    .where(and(eq(holds.clientId, clientId), inArray(holds.id, [...ids])));
}

export async function crearCita(
  clientId: string,
  tx: Tx,
  datos: Omit<typeof appointments.$inferInsert, 'clientId'>,
): Promise<AppointmentRow> {
  const [fila] = await tx
    .insert(appointments)
    .values({ ...datos, clientId })
    .returning();

  if (fila === undefined) throw new Error('no se pudo crear la cita');
  return fila;
}

export async function buscarCita(
  clientId: string,
  tx: Tx,
  id: string,
): Promise<AppointmentRow | undefined> {
  const filas = await tx
    .select()
    .from(appointments)
    .where(and(eq(appointments.clientId, clientId), eq(appointments.id, id)))
    .limit(1);

  return filas[0];
}

/**
 * Citas que ya han pasado y no tienen asistencia anotada. `soloSinPedir`: las
 * que todavía no han entrado en ninguna relación semanal.
 */
export async function citasSinAsistencia(
  clientId: string,
  tx: Tx,
  datos: { ahora: Date; soloSinPedir: boolean },
): Promise<Array<{ id: string; slotStart: Date; serviceCode: string; nombre: string }>> {
  const filas = await tx
    .select({ id: appointments.id, slotStart: appointments.slotStart, serviceCode: appointments.serviceCode, nombre: patients.givenName })
    .from(appointments)
    .innerJoin(patients, and(eq(patients.id, appointments.patientId), eq(patients.clientId, appointments.clientId)))
    .where(
      and(
        eq(appointments.clientId, clientId),
        eq(appointments.outcome, 'pendiente'),
        lte(appointments.slotEnd, datos.ahora),
        ...(datos.soloSinPedir ? [isNull(appointments.attendanceRequestedAt)] : []),
      ),
    )
    .orderBy(appointments.slotStart)
    .limit(500);
  return filas;
}

export async function marcarAsistenciaPedida(clientId: string, tx: Tx, ids: readonly string[], ahora: Date): Promise<void> {
  if (ids.length === 0) return;
  await tx
    .update(appointments)
    .set({ attendanceRequestedAt: ahora })
    .where(and(eq(appointments.clientId, clientId), inArray(appointments.id, [...ids]), isNull(appointments.attendanceRequestedAt)));
}

/**
 * Las citas a las que toca recordar: confirmadas, sin recordatorio, que empiezan
 * dentro de las próximas `horasAntes` horas, y que se pidieron **antes** de ese
 * plazo (a quien pidió hoy para mañana no se le recuerda: acaba de recibir su
 * confirmación). El hueco tiene que seguir confirmado: una cita cancelada o
 * movida no se recuerda.
 */
export async function citasParaRecordar(
  clientId: string,
  tx: Tx,
  datos: { ahora: Date; horasAntes: number; limite: number },
): Promise<Array<{ id: string; conversationId: string; slotStart: Date; serviceCode: string; nombre: string }>> {
  const hasta = new Date(datos.ahora.getTime() + datos.horasAntes * 3_600_000);
  const filas = await tx
    .select({
      id: appointments.id,
      conversationId: appointments.conversationId,
      slotStart: appointments.slotStart,
      serviceCode: appointments.serviceCode,
      nombre: patients.givenName,
    })
    .from(appointments)
    .innerJoin(holds, and(eq(holds.id, appointments.holdId), eq(holds.clientId, appointments.clientId)))
    .innerJoin(patients, and(eq(patients.id, appointments.patientId), eq(patients.clientId, appointments.clientId)))
    .where(
      and(
        eq(appointments.clientId, clientId),
        eq(appointments.outcome, 'pendiente'),
        eq(holds.state, 'confirmada'),
        isNull(appointments.reminderSentAt),
        gt(appointments.slotStart, datos.ahora),
        lte(appointments.slotStart, hasta),
        sql`${appointments.confirmedAt} <= ${appointments.slotStart} - make_interval(hours => ${datos.horasAntes})`,
      ),
    )
    .orderBy(appointments.slotStart)
    .limit(datos.limite);
  return filas;
}

export async function marcarRecordatorio(clientId: string, tx: Tx, id: string, ahora: Date): Promise<void> {
  await tx
    .update(appointments)
    .set({ reminderSentAt: ahora })
    .where(and(eq(appointments.clientId, clientId), eq(appointments.id, id)));
}

/** Las que se pidieron hace más del plazo y siguen sin resultado. */
export async function citasParaPresumir(
  clientId: string,
  tx: Tx,
  datos: { pedidasAntesDe: Date; limite: number },
): Promise<string[]> {
  const filas = await tx
    .select({ id: appointments.id })
    .from(appointments)
    .where(
      and(
        eq(appointments.clientId, clientId),
        eq(appointments.outcome, 'pendiente'),
        lte(appointments.attendanceRequestedAt, datos.pedidasAntesDe),
      ),
    )
    .orderBy(appointments.attendanceRequestedAt)
    .limit(datos.limite);
  return filas.map((f) => f.id);
}

/**
 * La última visita de un paciente: la cita asistida más reciente. Se recalcula
 * entera, no se suma: una rectificación de «asistió» a «no vino» tiene que
 * poder devolverla atrás.
 */
export async function recalcularUltimaVisita(clientId: string, tx: Tx, patientId: string): Promise<void> {
  await tx.execute(sql`
    update motor.patients p
       set last_visit_at = (
             select max(a.slot_start) from motor.appointments a
              where a.client_id = p.client_id and a.patient_id = p.id and a.outcome = 'asistida')
     where p.client_id = ${clientId} and p.id = ${patientId}
  `);
}

export async function actualizarCita(
  clientId: string,
  tx: Tx,
  id: string,
  cambios: Partial<typeof appointments.$inferInsert>,
): Promise<void> {
  await tx
    .update(appointments)
    .set(cambios)
    .where(and(eq(appointments.clientId, clientId), eq(appointments.id, id)));
}

export async function anotarAuditoria(
  clientId: string,
  tx: Tx,
  datos: {
    entity: string;
    entityId?: string | null;
    action: string;
    fromState?: string | null;
    toState?: string | null;
    actor: 'sistema' | 'recepcion' | 'paciente' | 'n8n' | 'operador';
    idempotencyKey?: string | null;
    /** Sin teléfono, sin apellidos y sin contenido clínico: la auditoría vive 12 meses. */
    payload?: Record<string, string | number | boolean | null>;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into motor.audit_log
      (client_id, entity, entity_id, action, from_state, to_state, actor, idempotency_key, payload, purge_at)
    values (
      ${clientId}, ${datos.entity}, ${datos.entityId ?? null}, ${datos.action},
      ${datos.fromState ?? null}, ${datos.toState ?? null}, ${datos.actor},
      ${datos.idempotencyKey ?? null}, ${datos.payload === undefined ? null : JSON.stringify(datos.payload)}::jsonb, now()
    )
  `);
}

/**
 * Lo que el propio núcleo tiene bloqueado en ese rango.
 *
 * **Hace falta porque la agenda externa no lo sabe.** El núcleo nunca escribe en
 * la agenda del cliente (regla 3): entre que recepción pulsa «ya la he metido»
 * y que la cita aparece en el programa de la clínica, el único sitio donde ese
 * hueco existe es esta tabla. Sin esto, el núcleo vuelve a proponer un hueco que
 * él mismo acaba de confirmar, y el paciente lee dos cosas distintas sobre la
 * misma cita.
 *
 * `propuesta` NO entra: proponer no bloquea, a propósito.
 */
export async function ocupacionPropia(
  clientId: string,
  tx: Tx,
  rango: { desde: Date; hasta: Date },
): Promise<Array<{ inicio: Date; fin: Date }>> {
  const filas = await tx
    .select({ inicio: holds.slotStart, fin: holds.slotEnd })
    .from(holds)
    .where(
      and(
        eq(holds.clientId, clientId),
        inArray(holds.state, ['retenida', 'pendiente_recepcion', 'confirmada']),
        lt(holds.slotStart, rango.hasta),
        gt(holds.slotEnd, rango.desde),
      ),
    );

  return filas.map((f) => ({ inicio: f.inicio, fin: f.fin }));
}


/**
 * El hueco, bloqueado para actualizarlo.
 *
 * Recepción y el paciente pueden tocar la misma fila a la vez: «ya la he metido»
 * y «mejor a las 10:20» pueden salir en el mismo segundo. Sin este cerrojo los
 * dos leen `pendiente_recepcion`, los dos deciden, y gana el último en escribir
 * mientras el otro cree que ha ganado él.
 */
export async function buscarHuecoBloqueando(
  clientId: string,
  tx: Tx,
  holdId: string,
): Promise<HoldRow | undefined> {
  const filas = await tx
    .select()
    .from(holds)
    .where(and(eq(holds.clientId, clientId), eq(holds.id, holdId)))
    .limit(1)
    .for('update');

  return filas[0];
}

/** La cita viva de un hueco, si llegó a crearse. */
export async function citaDeHueco(
  clientId: string,
  tx: Tx,
  holdId: string,
): Promise<AppointmentRow | undefined> {
  const filas = await tx
    .select()
    .from(appointments)
    .where(and(eq(appointments.clientId, clientId), eq(appointments.holdId, holdId)))
    .limit(1);

  return filas[0];
}

/**
 * ¿Ya hay un escalado abierto por este mismo motivo en esta conversación?
 *
 * Es lo que evita cinco avisos idénticos por cinco mensajes seguidos. La fatiga
 * de alertas es la forma en que este producto se degrada por desuso en vez de
 * por fallo técnico, y un aviso repetido no aporta nada que el primero no diga.
 */
export async function escaladoAbiertoPorMotivo(
  clientId: string,
  tx: Tx,
  conversationId: string,
  motivo: (typeof escalations.$inferInsert)['reason'],
): Promise<boolean> {
  const filas = await tx
    .select({ id: escalations.id })
    .from(escalations)
    .where(
      and(
        eq(escalations.clientId, clientId),
        eq(escalations.conversationId, conversationId),
        eq(escalations.reason, motivo),
        eq(escalations.state, 'abierta'),
      ),
    )
    .limit(1);

  return filas.length > 0;
}

/**
 * Quita a un paciente de la lista de bajas.
 *
 * **La única forma de salir de la lista, y sólo cuando lo pide el propio
 * paciente.** El registro de bajas es lo que nunca se purga: es la prueba de
 * que respetamos el opt-out, así que sacar a alguien de ahí es un acto
 * deliberado y auditado, nunca un efecto lateral.
 */
export async function levantarBaja(
  clientId: string,
  tx: Tx,
  patientId: string,
  datos: { ahora: Date; constancia: string },
): Promise<number> {
  const filas = await tx
    .update(suppression)
    .set({ revokedAt: datos.ahora, revokedNote: datos.constancia })
    .where(
      and(
        eq(suppression.clientId, clientId),
        eq(suppression.patientId, patientId),
        isNull(suppression.revokedAt),
      ),
    )
    .returning({ id: suppression.id });

  return filas.length;
}

/** Los derechos cuyo ejercicio suspende que le sigamos agendando citas. */
const DERECHOS_QUE_LIMITAN = ['supresion', 'limitacion', 'oposicion'] as const;

/**
 * Registra una solicitud de derechos con las cuatro fechas del contrato.
 *
 * `transferredAt` se pone en el mismo acto porque el traslado sale en los
 * efectos de esta misma respuesta: devolverlo ES trasladarlo. Si algún día el
 * traslado pasara a ser asíncrono, esto tiene que dejar de ser inmediato o el
 * registro mentiría sobre el cumplimiento de las 48 h.
 */
export async function crearSolicitudDeDerechos(
  clientId: string,
  tx: Tx,
  datos: {
    patientId: string;
    conversationId: string;
    kind: (typeof rightsRequests.$inferInsert)['kind'];
    ahora: Date;
    note: string | null;
  },
): Promise<RightsRequestRow> {
  const [fila] = await tx
    .insert(rightsRequests)
    .values({
      clientId,
      patientId: datos.patientId,
      conversationId: datos.conversationId,
      kind: datos.kind,
      state: 'trasladada',
      receivedAt: datos.ahora,
      transferredAt: datos.ahora,
      transferDueAt: new Date(datos.ahora.getTime() + 48 * 3_600_000),
      answerDueAt: new Date(datos.ahora.getTime() + 30 * 86_400_000),
      note: datos.note,
    })
    .returning();

  if (fila === undefined) throw new Error('no se pudo registrar la solicitud de derechos');
  return fila;
}

/**
 * ¿Hay una solicitud abierta que impida seguir agendándole citas?
 *
 * Supresión, limitación y oposición al tratamiento son incompatibles con seguir
 * tratando sus datos para darle hora como si nada. Acceso, rectificación y
 * portabilidad no: pedir una copia de tus datos no suspende tu relación con la
 * clínica.
 */
export async function tieneDerechoQueLimita(
  clientId: string,
  tx: Tx,
  patientId: string,
): Promise<boolean> {
  const filas = await tx
    .select({ id: rightsRequests.id })
    .from(rightsRequests)
    .where(
      and(
        eq(rightsRequests.clientId, clientId),
        eq(rightsRequests.patientId, patientId),
        inArray(rightsRequests.kind, [...DERECHOS_QUE_LIMITAN]),
        ne(rightsRequests.state, 'cerrada'),
      ),
    )
    .limit(1);

  return filas.length > 0;
}

/**
 * Encola algo para mandar fuera, dentro de la transacción en curso. Si la
 * transacción revierte, no existe; si confirma, el ejecutor lo envía después
 * (regla 3). Idempotente por `dedupeKey`: el mismo escalado no encola dos.
 */
export async function encolarSalida(
  clientId: string,
  tx: Tx,
  datos:
    | { kind: 'correo_operador'; dedupeKey: string; payload: { asunto: string; cuerpo: string }; ahora: Date }
    | { kind: 'whatsapp'; dedupeKey: string; payload: { para: string; texto: string; remitenteId: string }; ahora: Date }
    | { kind: 'chatwoot'; dedupeKey: string; payload: CargaDeChatwoot | CargaDeEtiqueta; ahora: Date }
    | { kind: 'evento_agenda'; dedupeKey: string; payload: CargaDeEvento; ahora: Date }
    | { kind: 'correo'; dedupeKey: string; payload: CargaDeCorreo; ahora: Date },
): Promise<void> {
  await tx
    .insert(outbox)
    .values({
      clientId,
      kind: datos.kind,
      dedupeKey: datos.dedupeKey,
      payload: datos.payload,
      nextAttemptAt: datos.ahora,
      createdAt: datos.ahora,
    })
    .onConflictDoNothing();
}

/**
 * Lo que toca enviar ya, bloqueado para esta pasada. `SKIP LOCKED`: dos
 * ejecutores a la vez se reparten el trabajo en vez de mandarlo dos veces.
 */
export async function salidaPendiente(
  clientId: string,
  tx: Tx,
  datos: { ahora: Date; limite: number },
): Promise<Array<typeof outbox.$inferSelect>> {
  return tx
    .select()
    .from(outbox)
    .where(
      and(
        eq(outbox.clientId, clientId),
        eq(outbox.state, 'pendiente'),
        lte(outbox.nextAttemptAt, datos.ahora),
      ),
    )
    .orderBy(outbox.createdAt)
    .limit(datos.limite)
    .for('update', { skipLocked: true });
}

export async function marcarSalida(
  clientId: string,
  tx: Tx,
  id: string,
  cambios: Partial<Pick<typeof outbox.$inferInsert, 'state' | 'attempts' | 'nextAttemptAt' | 'lastError' | 'sentAt' | 'sentRef'>>,
): Promise<void> {
  await tx.update(outbox).set(cambios).where(and(eq(outbox.clientId, clientId), eq(outbox.id, id)));
}

/** Guarda un mensaje recién llegado. Idempotente: Meta reintenta. Devuelve si era nuevo. */
export async function guardarEnBandeja(
  clientId: string,
  tx: Tx,
  datos: { providerMessageId: string; payload: typeof inbox.$inferInsert['payload']; ahora: Date; noAntesDe?: Date },
): Promise<boolean> {
  const filas = await tx
    .insert(inbox)
    .values({
      clientId,
      providerMessageId: datos.providerMessageId,
      payload: datos.payload,
      nextAttemptAt: datos.noAntesDe ?? datos.ahora,
      createdAt: datos.ahora,
    })
    .onConflictDoNothing()
    .returning({ id: inbox.id });
  return filas.length > 0;
}

/** Lo que toca procesar, en orden de llegada, bloqueado para esta pasada. */
export async function bandejaPendiente(
  clientId: string,
  tx: Tx,
  datos: { ahora: Date; limite: number },
): Promise<Array<typeof inbox.$inferSelect>> {
  return tx
    .select()
    .from(inbox)
    .where(and(eq(inbox.clientId, clientId), eq(inbox.state, 'pendiente'), lte(inbox.nextAttemptAt, datos.ahora)))
    .orderBy(inbox.createdAt)
    .limit(datos.limite)
    .for('update', { skipLocked: true });
}

export async function marcarBandeja(
  clientId: string,
  tx: Tx,
  id: string,
  cambios: Partial<Pick<typeof inbox.$inferInsert, 'state' | 'attempts' | 'nextAttemptAt' | 'lastError' | 'processedAt'>>,
): Promise<void> {
  await tx.update(inbox).set(cambios).where(and(eq(inbox.clientId, clientId), eq(inbox.id, id)));
}
