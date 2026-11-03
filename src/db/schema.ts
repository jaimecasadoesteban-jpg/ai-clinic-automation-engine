import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Esquema propio, deliberadamente NO `public`: en Supabase todo lo que vive en
 * `public` queda expuesto por PostgREST a los roles `anon` y `authenticated`.
 * Aquí hay historiales de pacientes.
 */
export const motor = pgSchema('motor');

// --- Vocabulario del dominio -------------------------------------------------
// Valores en español (son dominio); nombres de columna y tabla en inglés.

/**
 * La máquina de estados de docs/DESIGN_RULES.md, menos `asistida` y `no_asistida`: la
 * asistencia vive sólo en `appointments.outcome`. `holds` gestiona el hueco,
 * `appointments` gestiona la cita y lo que se factura. Dos fuentes de verdad
 * para el dato que dispara la factura es una discusión con el cliente esperando
 * a ocurrir.
 *
 * `liberada` es la salida de `confirmada`, y no se reutiliza `caducada` porque
 * no son lo mismo: `caducada` es «venció sin que nadie actuara» y `liberada` es
 * «se soltó deliberadamente». Además `liberada` no es limpieza, es un evento de
 * negocio: un hueco liberado con menos de 72 h de antelación dispara el relleno
 * de cancelaciones.
 */
export const holdState = motor.enum('hold_state', [
  'propuesta',
  'retenida',
  'pendiente_recepcion',
  'confirmada',
  'liberada',
  'caducada',
  'colisionada',
]);

/** Por qué se soltó un hueco confirmado. Es la señal de la cola de espera. */
export const releaseReason = motor.enum('release_reason', ['cancelacion', 'ciclo_cerrado']);

export const appointmentOutcome = motor.enum('appointment_outcome', [
  'pendiente',
  'asistida',
  'no_asistida',
  'cancelada',
]);

/** Cómo sabemos que asistió. `presuncion` = recepción no contestó en 7 días naturales. */
export const attendanceSource = motor.enum('attendance_source', [
  'recepcion',
  'presuncion',
  'rectificacion',
]);

export const messageDirection = motor.enum('message_direction', ['entrante', 'saliente']);

/**
 * Qué pasa con la conversación después de un corte del cortafuegos.
 *
 * `pausada`: el agente NO vuelve a responder solo. Se sale cuando una persona
 * de la clínica marca el escalado como atendido.
 * `cerrada`: baja. No se envía nada más, nunca.
 */
export const conversationStatus = motor.enum('conversation_status', [
  'abierta',
  'pausada',
  'cerrada',
]);

export const waveState = motor.enum('wave_state', ['borrador', 'ejecutando', 'terminada']);

export const waveRecipientState = motor.enum('wave_recipient_state', [
  'pendiente',
  'enviado',
  'respondido',
  'suprimido',
  'fallido',
]);

export const suppressionReason = motor.enum('suppression_reason', [
  'baja_solicitada',
  'menor_de_edad',
  'rebote',
  'manual',
]);

export const escalationReason = motor.enum('escalation_reason', [
  'urgencia_clinica',
  'contenido_clinico',
  'validacion_fallida',
  'sin_respuesta_recepcion',
  'peticion_paciente',
  'menor_de_edad',
  // Señales no clínicas que detecta el modelo pequeño con salida cerrada. No es
  // el modelo grande decidiendo escalar: es una extracción más, como la del
  // cortafuegos pero para lo que no es clínico.
  'queja',
  'pide_persona',
  'agente_atascado',
  // Solicitud de derechos del RGPD. Motivo propio porque el destinatario es
  // otro: no recepción, sino quien la clínica designe para protección de datos.
  'derechos_rgpd',
  /** Un cron que debería haber llamado y no llamó. La ausencia de señal. */
  'latido_perdido',
  /** Modo `automatica`: n8n no pudo dejar el evento en la agenda, o no contestó. */
  'agenda_no_escrita',
  /** La agenda no responde y un paciente pedía hueco. El turno no se pierde. */
  'agenda_no_disponible',
  /**
   * Al paciente se le dijo algo que no era verdad y sigue en el historial. Va
   * con `detail`: recepción tiene que saber QUÉ aclararle.
   */
  'historial_falso',
]);

export const rightKind = motor.enum('right_kind', [
  'acceso',
  'rectificacion',
  'supresion',
  'oposicion',
  'limitacion',
  'portabilidad',
  /** El paciente ejerce un derecho sin decir cuál. No se adivina. */
  'sin_determinar',
]);

export const rightState = motor.enum('right_state', ['recibida', 'trasladada', 'cerrada']);

export const escalationState = motor.enum('escalation_state', ['abierta', 'atendida', 'cerrada']);

export const auditActor = motor.enum('audit_actor', ['sistema', 'recepcion', 'paciente', 'n8n', 'operador']);

// --- Tablas ------------------------------------------------------------------

/**
 * La clínica. Es la tabla raíz del multi-tenant: aquí el `client_id` de la
 * regla 1 es el propio `id`, y la política RLS compara contra él.
 *
 * `config` es el YAML cargado. Regla 7: la diferencia entre clientes vive aquí,
 * nunca en un `.ts`.
 */
export const clients = motor.table('clients', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  timezone: text('timezone').notNull().default('Europe/Madrid'),
  config: jsonb('config').notNull(),
  configVersion: text('config_version').notNull(),
  active: boolean('active').notNull().default(true),
  /**
   * Contador de pacientes de ESTA clínica. La numeración es por clínica: con una
   * identidad global, la magnitud de un `pac_8371` revelaría el volumen total
   * del sistema. Lo incrementa un trigger, que bloquea esta fila y serializa.
   */
  patientSeq: bigint('patient_seq', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * El paciente.
 *
 * Regla 2: al prompt van `publicRef` y `givenName`, y nada más. `familyName` y
 * `phoneE164` existen porque recepción necesita dar de alta a un paciente nuevo
 * como paciente real, pero no cruzan la frontera del prompt. Quien garantiza
 * eso es `src/agent/prompt-boundary.ts` y su test, no la ausencia del dato.
 */
export const patients = motor.table(
  'patients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    /** Número de paciente DENTRO de su clínica. Lo pone un trigger. */
    seq: bigint('seq', { mode: 'number' }).notNull(),
    /** El identificador que ve el modelo: `pac_8371`. */
    publicRef: text('public_ref').generatedAlwaysAs(sql`'pac_' || seq::text`),
    /** Nombre de pila. Lo único identificativo que llega al prompt. */
    givenName: text('given_name').notNull(),
    /** Apellidos. Sólo si el paciente los facilita o vienen en el export. Nunca al prompt. */
    familyName: text('family_name'),
    /** Nunca al prompt. Vive aquí y se usa para enviar. */
    phoneE164: text('phone_e164').notNull(),
    /** Identificador del paciente en el programa de la clínica, si lo hay. */
    externalRef: text('external_ref'),
    /** Antigüedad. La reactivación se segmenta por esto, nunca por tratamiento. */
    lastVisitAt: timestamp('last_visit_at', { withTimezone: true }),
    locale: text('locale').notNull().default('es-ES'),
    /**
     * El interruptor del agente. Con valor, el agente está parado para esta
     * persona y no contesta hasta que alguien lo reactive: sin plazo. El
     * cortafuegos sigue corriendo (regla 5). Ver la migración 0017.
     */
    agentStoppedAt: timestamp('agent_stopped_at', { withTimezone: true }),
    /** Quién lo paró: `chatwoot:etiqueta`, y mañana la persona de la interfaz. */
    agentStoppedBy: text('agent_stopped_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('patients_client_phone_unico').on(t.clientId, t.phoneE164),
    uniqueIndex('patients_seq_unico').on(t.clientId, t.seq),
    uniqueIndex('patients_public_ref_unico').on(t.clientId, t.publicRef),
    index('patients_reactivacion').on(t.clientId, t.lastVisitAt),
  ],
);

export const conversations = motor.table(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    channel: text('channel').notNull().default('whatsapp'),
    status: conversationStatus('status').notNull().default('abierta'),
    /** Resumen de la ventana de 8 turnos. */
    summary: text('summary'),
    /** Hasta qué mensaje cubre el resumen: lo posterior todavía está en la ventana. */
    summaryUntil: timestamp('summary_until', { withTimezone: true }),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    /**
     * El servicio que se está tratando en esta conversación.
     *
     * **El servicio no es una propiedad del mensaje, es estado de la
     * conversación.** Una vez determinado —porque lo diga el paciente, o porque
     * el agente lo proponga y el paciente acepte— persiste hasta que se cambie
     * explícitamente. Sin esto, «sí por favor, quiero una cita» tras haberle
     * ofrecido la limpieza facial no determina nada y el paciente entra en un
     * callejón sin salida del que no puede salir.
     */
    serviceCode: text('service_code'),
    /**
     * Por dónde se le escribe: lo deja cada turno que entra por el núcleo. Es lo
     * que permite que un cron le mande algo sin que él haya escrito. `null` en
     * las conversaciones que sólo han entrado por n8n. Ver la migración 0019.
     */
    replyChannel: jsonb('reply_channel').$type<CanalDelPaciente>(),
    pausedAt: timestamp('paused_at', { withTimezone: true }),
    /** La categoría del cortafuegos que la dejó en pausa. */
    pauseReason: text('pause_reason'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    /**
     * Última respuesta automática enviada estando en pausa. Sirve para no
     * contestar diez veces «el equipo ya tiene tu mensaje» a quien manda diez
     * mensajes seguidos.
     */
    lastAutoReplyAt: timestamp('last_auto_reply_at', { withTimezone: true }),
    /**
     * El hueco que el paciente ha elegido mientras se le pregunta si es **en
     * lugar** de una cita que ya tiene del mismo tratamiento **o además**.
     *
     * No se retiene hasta saberlo: retenerlo y soltar la otra sería decidir un
     * cambio que no ha pedido, y retenerlo sin soltar nada sería darle una cita
     * de más si lo que quería era cambiarla. Se guarda para que la respuesta
     * —«en lugar», «las dos»— no tenga que volver a decir qué hora eligió.
     */
    pendingHoldId: uuid('pending_hold_id').references((): AnyPgColumn => holds.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** 12 meses. Lo pone un trigger, no la aplicación. */
    purgeAt: timestamp('purge_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('conversations_client_patient').on(t.clientId, t.patientId),
    index('conversations_purga').on(t.purgeAt),
  ],
);

/**
 * Todo mensaje, entrante y saliente, con su telemetría (regla 6).
 *
 * `body` y `prompt` son nullable porque a los 90 días los mensajes clínicos se
 * **redactan**, no se borran: desaparece el dato de salud y se conserva el
 * rastro (hora, dirección, modelo, tokens, latencia, validación).
 */
export const messages = motor.table(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'restrict' }),
    direction: messageDirection('direction').notNull(),
    body: text('body'),
    /** Lo marca el cortafuegos determinista, antes de cualquier llamada al modelo. */
    isClinical: boolean('is_clinical').notNull().default(false),
    redactedAt: timestamp('redacted_at', { withTimezone: true }),
    /** 90 días si es clínico, 12 meses si no. Lo pone un trigger. */
    purgeAt: timestamp('purge_at', { withTimezone: true }).notNull(),

    /** Identificador del proveedor, para que un reintento de Meta no duplique. */
    providerMessageId: text('provider_message_id'),

    // Telemetría exigida por la regla 6.
    prompt: jsonb('prompt'),
    model: text('model'),
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    latencyMs: integer('latency_ms'),
    toolsUsed: jsonb('tools_used'),
    validationResult: jsonb('validation_result'),
    intent: text('intent'),
    /** Qué patrón del cortafuegos cortó, si cortó. */
    firewallRule: text('firewall_rule'),
    /** Categoría del corte. Es lo que permite medir la tasa de corte y la carga de escalados. */
    firewallCategory: text('firewall_category'),

    /**
     * Cuándo se supo que este mensaje saliente no era verdad, y la verdad que lo
     * corrige. No se borra ni se oculta: entra en la ventana del modelo anotado,
     * para que pueda aclarárselo al paciente. Ver `service/desmentidos.ts`.
     */
    disprovedAt: timestamp('disproved_at', { withTimezone: true }),
    disprovedNote: text('disproved_note'),
    /** `panel`: lo escribió una persona desde la interfaz. Ver la migración 0020. */
    sentBy: text('sent_by'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('messages_conversacion').on(t.clientId, t.conversationId, t.createdAt),
    // Para medir la tasa de corte por categoría sin escanear la tabla entera.
    index('messages_cortafuegos')
      .on(t.clientId, t.firewallCategory, t.createdAt)
      .where(sql`firewall_category is not null`),
    index('messages_purga').on(t.purgeAt),
    uniqueIndex('messages_provider_id_unico')
      .on(t.clientId, t.providerMessageId)
      .where(sql`provider_message_id is not null`),
  ],
);

/**
 * El hueco y su máquina de estados. Termina en `confirmada`, más sus dos salidas
 * por incidencia. La asistencia NO está aquí.
 */
export const holds = motor.table(
  'holds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'restrict' }),
    slotStart: timestamp('slot_start', { withTimezone: true }).notNull(),
    slotEnd: timestamp('slot_end', { withTimezone: true }).notNull(),
    /** Código del catálogo del YAML del cliente. No hay tabla de servicios: regla 7. */
    serviceCode: text('service_code').notNull(),
    state: holdState('state').notNull().default('propuesta'),
    /** 1ª, 2ª o 3ª opción de las tres que se proponen en un solo turno. */
    rank: smallint('rank'),
    /** Vencimiento del estado actual: 6 h propuesta, 30 min retenida, fin de jornada pendiente. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    stateChangedAt: timestamp('state_changed_at', { withTimezone: true }).notNull().defaultNow(),

    receptionNotifiedAt: timestamp('reception_notified_at', { withTimezone: true }),
    receptionAckAt: timestamp('reception_ack_at', { withTimezone: true }),
    reminderSentAt: timestamp('reminder_sent_at', { withTimezone: true }),
    escalatedAt: timestamp('escalated_at', { withTimezone: true }),
    collisionDetectedAt: timestamp('collision_detected_at', { withTimezone: true }),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    releaseReason: releaseReason('release_reason'),

    idempotencyKey: text('idempotency_key'),
    /**
     * La cita que este hueco sustituye, si viene de un reagendado.
     *
     * **Un paciente puede tener varias citas vivas a la vez**, de servicios
     * distintos, así que «sustituye a la cita del paciente» no significa nada:
     * hay que decir a cuál. Se fija al proponer huecos dentro del reagendado de
     * una cita concreta —o al elegir, si el paciente confirma que es un cambio—
     * y es lo único que autoriza a soltar otra cita al elegir éste.
     *
     * Se lee también al revés: cuando recepción pulsa el aviso de una cita ya
     * soltada, el sustituto es el hueco que la nombra aquí, no «la otra que
     * tenga viva», que puede ser de otro tratamiento.
     *
     * Mismo paciente y misma clínica: lo impone `holds_sustituye_al_mismo`.
     */
    replacesHoldId: uuid('replaces_hold_id').references((): AnyPgColumn => holds.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // La restricción que evita la doble reserva. Literal, como está en docs/DESIGN_RULES.md.
    // `propuesta` queda fuera a propósito: proponer 3 huecos a 5 personas no
    // puede bloquear 15 huecos de una clínica que tiene 20 al día.
    uniqueIndex('holds_slot_unico')
      .on(t.clientId, t.slotStart)
      .where(sql`state in ('retenida', 'pendiente_recepcion', 'confirmada')`),
    index('holds_vencimientos').on(t.clientId, t.state, t.expiresAt),
    index('holds_conversacion').on(t.clientId, t.conversationId),
    // La cola del relleno de cancelaciones: huecos soltados que aún tienen
    // margen para volver a ofrecerse.
    index('holds_liberados')
      .on(t.clientId, t.slotStart)
      .where(sql`state = 'liberada' and release_reason = 'cancelacion'`),
  ],
);

/**
 * La cita y lo que se factura. Única fuente de verdad de la asistencia.
 *
 * Presunción de asistencia del contrato: se envía semanalmente a recepción la
 * relación del periodo (`attendanceRequestedAt`); si no responde en 7 días
 * naturales, se presume asistida (`attendanceSource = 'presuncion'`). Una
 * rectificación posterior no reescribe la historia: se anota y se compensa en
 * la facturación siguiente.
 */
export const appointments = motor.table(
  'appointments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'restrict' }),
    holdId: uuid('hold_id')
      .notNull()
      .unique()
      .references(() => holds.id, { onDelete: 'restrict' }),

    slotStart: timestamp('slot_start', { withTimezone: true }).notNull(),
    slotEnd: timestamp('slot_end', { withTimezone: true }).notNull(),
    serviceCode: text('service_code').notNull(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }).notNull().defaultNow(),

    outcome: appointmentOutcome('outcome').notNull().default('pendiente'),
    /** Cuándo se le pidió a recepción que confirmara asistencias del periodo. */
    attendanceRequestedAt: timestamp('attendance_requested_at', { withTimezone: true }),
    attendanceConfirmedAt: timestamp('attendance_confirmed_at', { withTimezone: true }),
    attendanceSource: attendanceSource('attendance_source'),
    /** El recordatorio de esta cita ya se procesó (salió, o se avisó de por qué no). Ver la migración 0022. */
    reminderSentAt: timestamp('reminder_sent_at', { withTimezone: true }),

    /**
     * Bono de varias sesiones: cuenta una sola vez. Nullable a propósito y NUNCA
     * inferido. Se rellena sólo si viene del export de la clínica o si recepción
     * lo aporta; si está vacío, el informe marca el caso para revisión manual.
     * Un dato inventado aquí acaba en una factura.
     */
    bundleRef: text('bundle_ref'),
    /** Cita generada según el contrato: conversación + hueco + confirmación + asistencia. */
    countsAsGenerated: boolean('counts_as_generated').notNull().default(false),
    /** Periodo en el que se facturó, 'YYYY-MM'. Nulo si aún no se ha facturado. */
    billedPeriod: text('billed_period'),

    // Rectificación de una asistencia dada por error.
    rectifiedAt: timestamp('rectified_at', { withTimezone: true }),
    outcomeBeforeRectification: appointmentOutcome('outcome_before_rectification'),
    rectificationNote: text('rectification_note'),
    /** Periodo en cuya factura se aplica el ajuste. Nulo mientras esté pendiente. */
    adjustmentPeriod: text('adjustment_period'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // El bono cuenta una sola vez, cuando sabemos a qué bono pertenece.
    uniqueIndex('appointments_bundle_unico')
      .on(t.clientId, t.bundleRef)
      .where(sql`bundle_ref is not null`),
    index('appointments_periodo').on(t.clientId, t.slotStart),
    index('appointments_presuncion').on(t.clientId, t.outcome, t.attendanceRequestedAt),
    // Ajustes pendientes de aplicar en la siguiente factura.
    index('appointments_rectificaciones')
      .on(t.clientId, t.rectifiedAt)
      .where(sql`rectified_at is not null and adjustment_period is null`),
  ],
);

export const waves = motor.table(
  'waves',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    /** Segmentación SÓLO por antigüedad. Segmentar por tratamiento sería tratar datos de salud con fin comercial. */
    segment: jsonb('segment').notNull(),
    templateRef: text('template_ref').notNull(),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
    state: waveState('state').notNull().default('borrador'),
    /**
     * Aprobación del cliente. **Sin esto una oleada no se ejecuta.** Enviar
     * mensajes comerciales en nombre de una clínica que no los ha aprobado no es
     * un fallo técnico, es hacerlo por nuestra cuenta.
     */
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvedBy: text('approved_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('waves_client_estado').on(t.clientId, t.state)],
);

export const waveRecipients = motor.table(
  'wave_recipients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    waveId: uuid('wave_id')
      .notNull()
      .references(() => waves.id, { onDelete: 'restrict' }),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
    state: waveRecipientState('state').notNull().default('pendiente'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
    idempotencyKey: text('idempotency_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('wave_recipients_unico').on(t.clientId, t.waveId, t.patientId),
    index('wave_recipients_estado').on(t.clientId, t.waveId, t.state),
  ],
);

/**
 * Registro de bajas. **Indefinido, nunca se borra** — está exento de la purga.
 *
 * Se guarda un HMAC-SHA256 del teléfono, no el teléfono: la lista sólo necesita
 * responder «¿está de baja este número?», y así deja de ser un directorio
 * permanente de teléfonos. La pimienta es crítica y no es rotable; ver docs/DESIGN_RULES.md.
 */
export const suppression = motor.table(
  'suppression',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    patientId: uuid('patient_id').references(() => patients.id, { onDelete: 'set null' }),
    phoneHash: text('phone_hash').notNull(),
    reason: suppressionReason('reason').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * Cuándo la levantó el paciente. **La fila no se borra nunca**: es la prueba
     * de que respetamos el opt-out mientras estuvo vigente.
     */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /** Dónde consta que lo pidió: mensaje, llamada, en consulta. */
    revokedNote: text('revoked_note'),
  },
  // Sólo las vigentes: así se puede volver a dar de baja después de revocar.
  (t) =>
    [
      uniqueIndex('suppression_unico')
        .on(t.clientId, t.phoneHash)
        .where(sql`revoked_at is null`),
    ] as const,
);

export const escalations = motor.table(
  'escalations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'restrict',
    }),
    patientId: uuid('patient_id').references(() => patients.id, { onDelete: 'restrict' }),
    holdId: uuid('hold_id').references(() => holds.id, { onDelete: 'restrict' }),
    reason: escalationReason('reason').notNull(),
    /** Lo concreto, cuando el motivo solo no basta. «Se le dijo que tenía cita el lunes a las 10:20 y no existe». */
    detail: text('detail'),
    severity: smallint('severity').notNull().default(1),
    state: escalationState('state').notNull().default('abierta'),
    assignee: text('assignee'),
    notifiedAt: timestamp('notified_at', { withTimezone: true }),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('escalations_abiertas').on(t.clientId, t.state, t.createdAt)],
);

/** Auditoría, 12 meses. Aquí van también las transiciones de la máquina de estados. */
export const auditLog = motor.table(
  'audit_log',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    entity: text('entity').notNull(),
    entityId: uuid('entity_id'),
    action: text('action').notNull(),
    fromState: text('from_state'),
    toState: text('to_state'),
    actor: auditActor('actor').notNull(),
    idempotencyKey: text('idempotency_key'),
    /** Sin teléfono, sin apellidos y sin contenido clínico. */
    payload: jsonb('payload'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** 12 meses. Lo pone un trigger. */
    purgeAt: timestamp('purge_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('audit_log_entidad').on(t.clientId, t.entity, t.entityId),
    index('audit_log_purga').on(t.purgeAt),
  ],
);

/**
 * Lo único que sobrevive al borrado del detalle a los 24 meses: cifras por
 * periodo, **sin `patient_id` y sin nada identificativo**.
 *
 * La purga no borra el detalle de un periodo que no esté consolidado aquí. El
 * orden importa: primero se consolida, después se borra. Al revés se pierde la
 * base de una factura ya emitida.
 */
export const periodMetrics = motor.table(
  'period_metrics',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    /** 'YYYY-MM'. */
    period: text('period').notNull(),
    citasGeneradas: integer('citas_generadas').notNull().default(0),
    huecosPropuestos: integer('huecos_propuestos').notNull().default(0),
    conversaciones: integer('conversaciones').notNull().default(0),
    noShows: integer('no_shows').notNull().default(0),
    consolidatedAt: timestamp('consolidated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('period_metrics_unico').on(t.clientId, t.period)],
);

/**
 * Idempotencia de los endpoints. Meta reintenta webhooks: sin guardar la
 * respuesta, el reintento recibiría un error donde la primera vez hubo un éxito.
 * TTL de 30 días.
 */
export const idempotencyKeys = motor.table(
  'idempotency_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    key: text('key').notNull(),
    endpoint: text('endpoint').notNull(),
    /** Hash del cuerpo: la misma clave con cuerpo distinto es un error de quien llama. */
    requestHash: text('request_hash').notNull(),
    statusCode: integer('status_code').notNull(),
    response: jsonb('response').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** 30 días. Lo pone un trigger. */
    purgeAt: timestamp('purge_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('idempotency_keys_unico').on(t.clientId, t.key),
    index('idempotency_keys_purga').on(t.purgeAt),
  ],
);

/**
 * Solicitudes de derechos del RGPD.
 *
 * **Lo que el contrato de encargo obliga a registrar**: fecha de recepción,
 * derecho ejercido, fecha de traslado a la clínica y fecha de cierre. Sin esta
 * tabla no hay forma de demostrar que se cumplió el plazo, y el plazo es una
 * obligación legal del responsable que nosotros tenemos que poder acreditar.
 *
 * `transfer_due_at` y `answer_due_at` van materializadas: 48 h y un mes. Se
 * podrían derivar, pero entonces no se puede indexar por ellas ni ordenar la
 * cola de lo que vence antes.
 */
export const rightsRequests = motor.table(
  'rights_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    patientId: uuid('patient_id').references(() => patients.id, { onDelete: 'restrict' }),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'restrict',
    }),
    kind: rightKind('kind').notNull().default('sin_determinar'),
    state: rightState('state').notNull().default('recibida'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    transferredAt: timestamp('transferred_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    transferDueAt: timestamp('transfer_due_at', { withTimezone: true }).notNull(),
    answerDueAt: timestamp('answer_due_at', { withTimezone: true }).notNull(),
    note: text('note'),
    /** Avisos ya enviados a la clínica, para no repetirlos cada día. */
    warned20At: timestamp('warned_20_at', { withTimezone: true }),
    warned27At: timestamp('warned_27_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('rights_requests_pendientes').on(t.clientId, t.state, t.answerDueAt),
    index('rights_requests_por_paciente').on(t.clientId, t.patientId, t.state),
  ],
);

/**
 * Cuándo llamó por última vez cada cron.
 *
 * **La ausencia de señal es el fallo más traicionero que hay**: no genera ningún
 * error, simplemente no pasa nada. Si `/caducar-retenciones` deja de llamarse,
 * los vencimientos no ocurren, la gente se queda con huecos que no caducan y sin
 * el mensaje que le tocaba, y no salta absolutamente nada.
 */
export const jobRuns = motor.table(
  'job_runs',
  {
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    job: text('job').notNull(),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.clientId, t.job] })],
);

/** Lo que lleva cada fila de la tabla de salida, según su tipo. */
export type CargaDeSalida =
  | { asunto: string; cuerpo: string }
  /** Correo a un contacto de la clínica (`kind: 'correo'`). */
  | CargaDeCorreo
  | {
      /** E.164, con `+`. */
      para: string;
      texto: string;
      /** La línea de la clínica en Meta (`canal.remitenteId`). */
      remitenteId: string;
    }
  | CargaDeChatwoot
  | CargaDeEtiqueta
  | CargaDeEvento;

/**
 * Por dónde le llega al paciente lo que salga después: la confirmación de la
 * cita no la escribe el turno, sino el ejecutor cuando Google contesta.
 */
export type CanalDelPaciente =
  | { por: 'chatwoot'; cuentaId: number; conversacionId: number }
  | { por: 'meta'; telefono: string; remitenteId: string };

export interface CargaDeCorreo {
  correoA: string;
  asunto: string;
  cuerpo: string;
}

/** Un evento que hay que crear en la agenda de la clínica. Modo `automatica`. */
export interface CargaDeEvento {
  holdId: string;
  calendarioId: string;
  /** Lo que hace que un reintento no cree dos eventos: de aquí sale su id en Google. */
  idempotencyKey: string;
  inicio: string;
  fin: string;
  resumen: string;
  descripcion: string;
  canal: CanalDelPaciente;
  /** El nombre de la clínica, para los avisos al operador. */
  clinica: string;
}

/**
 * Un mensaje en una conversación de Chatwoot. `privado`: una nota para el
 * equipo, que el paciente no ve —así llegan los avisos a la clínica cuando el
 * canal es Chatwoot—.
 */
export interface CargaDeChatwoot {
  cuentaId: number;
  conversacionId: number;
  /** Lo que se lee en Chatwoot. Con plantilla, es su texto compuesto. */
  texto: string;
  privado: boolean;
  /** Fuera de la ventana de 24 h: la plantilla aprobada y sus valores, en orden. */
  plantilla?: { nombre: string; idioma: string; parametros: string[] };
}

/** Poner o quitar una etiqueta en una conversación de Chatwoot (el interruptor del panel). */
export interface CargaDeEtiqueta {
  cuentaId: number;
  conversacionId: number;
  etiqueta: string;
  poner: boolean;
}

/**
 * La tabla de salida. Lo que hay que mandar fuera se guarda aquí DENTRO de la
 * transacción del turno, y lo envía `service/ejecutor.ts` después del commit:
 * un `rollback` no desenvía nada (regla 3). Ver la migración 0015.
 */
export const outbox = motor.table(
  'outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'correo_operador' | 'correo' | 'whatsapp' | 'chatwoot' | 'evento_agenda'>().notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    payload: jsonb('payload').$type<CargaDeSalida>().notNull(),
    state: text('state').$type<'pendiente' | 'enviado' | 'fallido'>().notNull().default('pendiente'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull(),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    /** El id que le dio Chatwoot al mensaje: distingue nuestro eco de lo que escribe una persona. */
    sentRef: text('sent_ref'),
  },
  (t) => [uniqueIndex('outbox_dedupe_unico').on(t.clientId, t.kind, t.dedupeKey)],
);

/**
 * La bandeja de entrada: lo que llega por el webhook de WhatsApp, guardado antes
 * de responder 200 a Meta y procesado después. Ver la migración 0016.
 */
export interface MensajeDeLaBandeja {
  telefono: string;
  nombre: string;
  tipo: 'texto' | 'audio' | 'imagen' | 'documento' | 'ubicacion' | 'otro';
  texto?: string;
  /** Si llegó por Chatwoot: la conversación donde hay que contestar. */
  chatwoot?: { cuentaId: number; conversacionId: number };
  /**
   * Un mensaje que **no** es del paciente: lo escribió una persona del equipo
   * desde el móvil (coexistencia) o desde Chatwoot. No pasa por el turno: se
   * guarda en el historial, salvo que sea el eco de uno nuestro.
   */
  saliente?: { chatwootMensajeId: number };
}

export const inbox = motor.table(
  'inbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    providerMessageId: text('provider_message_id').notNull(),
    payload: jsonb('payload').$type<MensajeDeLaBandeja>().notNull(),
    state: text('state').$type<'pendiente' | 'procesado' | 'fallido'>().notNull().default('pendiente'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull(),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('inbox_mensaje_unico').on(t.clientId, t.providerMessageId)],
);
