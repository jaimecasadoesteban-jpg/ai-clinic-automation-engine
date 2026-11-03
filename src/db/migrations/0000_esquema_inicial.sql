CREATE SCHEMA "motor";
--> statement-breakpoint
CREATE TYPE "motor"."appointment_outcome" AS ENUM('pendiente', 'asistida', 'no_asistida', 'cancelada');--> statement-breakpoint
CREATE TYPE "motor"."attendance_source" AS ENUM('recepcion', 'presuncion', 'rectificacion');--> statement-breakpoint
CREATE TYPE "motor"."audit_actor" AS ENUM('sistema', 'recepcion', 'paciente', 'n8n');--> statement-breakpoint
CREATE TYPE "motor"."conversation_status" AS ENUM('abierta', 'pausada', 'cerrada');--> statement-breakpoint
CREATE TYPE "motor"."escalation_reason" AS ENUM('urgencia_clinica', 'contenido_clinico', 'validacion_fallida', 'sin_respuesta_recepcion', 'peticion_paciente', 'menor_de_edad');--> statement-breakpoint
CREATE TYPE "motor"."escalation_state" AS ENUM('abierta', 'atendida', 'cerrada');--> statement-breakpoint
CREATE TYPE "motor"."hold_state" AS ENUM('propuesta', 'retenida', 'pendiente_recepcion', 'confirmada', 'liberada', 'caducada', 'colisionada');--> statement-breakpoint
CREATE TYPE "motor"."message_direction" AS ENUM('entrante', 'saliente');--> statement-breakpoint
CREATE TYPE "motor"."release_reason" AS ENUM('cancelacion', 'ciclo_cerrado');--> statement-breakpoint
CREATE TYPE "motor"."suppression_reason" AS ENUM('baja_solicitada', 'menor_de_edad', 'rebote', 'manual');--> statement-breakpoint
CREATE TYPE "motor"."wave_recipient_state" AS ENUM('pendiente', 'enviado', 'respondido', 'suprimido', 'fallido');--> statement-breakpoint
CREATE TYPE "motor"."wave_state" AS ENUM('borrador', 'ejecutando', 'terminada');--> statement-breakpoint
CREATE TABLE "motor"."appointments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"hold_id" uuid NOT NULL,
	"slot_start" timestamp with time zone NOT NULL,
	"slot_end" timestamp with time zone NOT NULL,
	"service_code" text NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome" "motor"."appointment_outcome" DEFAULT 'pendiente' NOT NULL,
	"attendance_requested_at" timestamp with time zone,
	"attendance_confirmed_at" timestamp with time zone,
	"attendance_source" "motor"."attendance_source",
	"bundle_ref" text,
	"counts_as_generated" boolean DEFAULT false NOT NULL,
	"billed_period" text,
	"rectified_at" timestamp with time zone,
	"outcome_before_rectification" "motor"."appointment_outcome",
	"rectification_note" text,
	"adjustment_period" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointments_hold_id_unique" UNIQUE("hold_id")
);
--> statement-breakpoint
CREATE TABLE "motor"."audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "motor"."audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"client_id" uuid NOT NULL,
	"entity" text NOT NULL,
	"entity_id" uuid,
	"action" text NOT NULL,
	"from_state" text,
	"to_state" text,
	"actor" "motor"."audit_actor" NOT NULL,
	"idempotency_key" text,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purge_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "motor"."clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"timezone" text DEFAULT 'Europe/Madrid' NOT NULL,
	"config" jsonb NOT NULL,
	"config_version" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"patient_seq" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clients_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "motor"."conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"channel" text DEFAULT 'whatsapp' NOT NULL,
	"status" "motor"."conversation_status" DEFAULT 'abierta' NOT NULL,
	"summary" text,
	"last_message_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"pause_reason" text,
	"closed_at" timestamp with time zone,
	"last_auto_reply_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purge_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "motor"."escalations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"conversation_id" uuid,
	"patient_id" uuid,
	"hold_id" uuid,
	"reason" "motor"."escalation_reason" NOT NULL,
	"severity" smallint DEFAULT 1 NOT NULL,
	"state" "motor"."escalation_state" DEFAULT 'abierta' NOT NULL,
	"assignee" text,
	"notified_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "motor"."holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"slot_start" timestamp with time zone NOT NULL,
	"slot_end" timestamp with time zone NOT NULL,
	"service_code" text NOT NULL,
	"state" "motor"."hold_state" DEFAULT 'propuesta' NOT NULL,
	"rank" smallint,
	"expires_at" timestamp with time zone,
	"state_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reception_notified_at" timestamp with time zone,
	"reception_ack_at" timestamp with time zone,
	"reminder_sent_at" timestamp with time zone,
	"escalated_at" timestamp with time zone,
	"collision_detected_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"release_reason" "motor"."release_reason",
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "motor"."idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"key" text NOT NULL,
	"endpoint" text NOT NULL,
	"request_hash" text NOT NULL,
	"status_code" integer NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purge_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "motor"."messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"direction" "motor"."message_direction" NOT NULL,
	"body" text,
	"is_clinical" boolean DEFAULT false NOT NULL,
	"redacted_at" timestamp with time zone,
	"purge_at" timestamp with time zone NOT NULL,
	"provider_message_id" text,
	"prompt" jsonb,
	"model" text,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"latency_ms" integer,
	"tools_used" jsonb,
	"validation_result" jsonb,
	"intent" text,
	"firewall_rule" text,
	"firewall_category" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "motor"."patients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"public_ref" text GENERATED ALWAYS AS ('pac_' || seq::text) STORED,
	"given_name" text NOT NULL,
	"family_name" text,
	"phone_e164" text NOT NULL,
	"external_ref" text,
	"last_visit_at" timestamp with time zone,
	"locale" text DEFAULT 'es-ES' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "motor"."period_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"period" text NOT NULL,
	"citas_generadas" integer DEFAULT 0 NOT NULL,
	"huecos_propuestos" integer DEFAULT 0 NOT NULL,
	"conversaciones" integer DEFAULT 0 NOT NULL,
	"no_shows" integer DEFAULT 0 NOT NULL,
	"consolidated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "motor"."suppression" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"patient_id" uuid,
	"phone_hash" text NOT NULL,
	"reason" "motor"."suppression_reason" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "motor"."wave_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"wave_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"message_id" uuid,
	"state" "motor"."wave_recipient_state" DEFAULT 'pendiente' NOT NULL,
	"sent_at" timestamp with time zone,
	"responded_at" timestamp with time zone,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "motor"."waves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"name" text NOT NULL,
	"segment" jsonb NOT NULL,
	"template_ref" text NOT NULL,
	"scheduled_for" timestamp with time zone,
	"state" "motor"."wave_state" DEFAULT 'borrador' NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "motor"."appointments" ADD CONSTRAINT "appointments_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "motor"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "motor"."appointments" ADD CONSTRAINT "appointments_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "motor"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "motor"."appointments" ADD CONSTRAINT "appointments_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "motor"."conversations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "motor"."appointments" ADD CONSTRAINT "appointments_hold_id_holds_id_fk" FOREIGN KEY ("hold_id") REFERENCES "motor"."holds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "motor"."audit_log" ADD CONSTRAINT "audit_log_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "motor"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "motor"."conversations" ADD CONSTRAINT "conversations_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "motor"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "motor"."conversations" ADD CONSTRAINT "conversations_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "motor"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "motor"."escalations" ADD CONSTRAINT "escalations_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "motor"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "motor"."escalations" ADD CONSTRAINT "escalations_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "motor"."conversations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "motor"."escalations" ADD CONSTRAINT "escalations_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "motor"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "motor"."escalations" ADD CONSTRAINT "escalations_hold_id_holds_id_fk" FOREIGN KEY ("hold_id") REFERENCES "motor"."holds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "motor"."holds" ADD CONSTRAINT "holds_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "motor"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "motor"."holds" ADD CONSTRAINT "holds_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "motor"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "motor"."holds" ADD CONSTRAINT "holds_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "motor"."conversations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "motor"."idempotency_keys" ADD CONSTRAINT "idempotency_keys_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "motor"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "motor"."messages" ADD CONSTRAINT "messages_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "motor"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "motor"."messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "motor"."conversations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "motor"."patients" ADD CONSTRAINT "patients_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "motor"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "motor"."period_metrics" ADD CONSTRAINT "period_metrics_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "motor"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "motor"."suppression" ADD CONSTRAINT "suppression_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "motor"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "motor"."suppression" ADD CONSTRAINT "suppression_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "motor"."patients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "motor"."wave_recipients" ADD CONSTRAINT "wave_recipients_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "motor"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "motor"."wave_recipients" ADD CONSTRAINT "wave_recipients_wave_id_waves_id_fk" FOREIGN KEY ("wave_id") REFERENCES "motor"."waves"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "motor"."wave_recipients" ADD CONSTRAINT "wave_recipients_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "motor"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "motor"."wave_recipients" ADD CONSTRAINT "wave_recipients_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "motor"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "motor"."waves" ADD CONSTRAINT "waves_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "motor"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "appointments_bundle_unico" ON "motor"."appointments" USING btree ("client_id","bundle_ref") WHERE bundle_ref is not null;--> statement-breakpoint
CREATE INDEX "appointments_periodo" ON "motor"."appointments" USING btree ("client_id","slot_start");--> statement-breakpoint
CREATE INDEX "appointments_presuncion" ON "motor"."appointments" USING btree ("client_id","outcome","attendance_requested_at");--> statement-breakpoint
CREATE INDEX "appointments_rectificaciones" ON "motor"."appointments" USING btree ("client_id","rectified_at") WHERE rectified_at is not null and adjustment_period is null;--> statement-breakpoint
CREATE INDEX "audit_log_entidad" ON "motor"."audit_log" USING btree ("client_id","entity","entity_id");--> statement-breakpoint
CREATE INDEX "audit_log_purga" ON "motor"."audit_log" USING btree ("purge_at");--> statement-breakpoint
CREATE INDEX "conversations_client_patient" ON "motor"."conversations" USING btree ("client_id","patient_id");--> statement-breakpoint
CREATE INDEX "conversations_purga" ON "motor"."conversations" USING btree ("purge_at");--> statement-breakpoint
CREATE INDEX "escalations_abiertas" ON "motor"."escalations" USING btree ("client_id","state","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "holds_slot_unico" ON "motor"."holds" USING btree ("client_id","slot_start") WHERE state in ('retenida', 'pendiente_recepcion', 'confirmada');--> statement-breakpoint
CREATE INDEX "holds_vencimientos" ON "motor"."holds" USING btree ("client_id","state","expires_at");--> statement-breakpoint
CREATE INDEX "holds_conversacion" ON "motor"."holds" USING btree ("client_id","conversation_id");--> statement-breakpoint
CREATE INDEX "holds_liberados" ON "motor"."holds" USING btree ("client_id","slot_start") WHERE state = 'liberada' and release_reason = 'cancelacion';--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_keys_unico" ON "motor"."idempotency_keys" USING btree ("client_id","key");--> statement-breakpoint
CREATE INDEX "idempotency_keys_purga" ON "motor"."idempotency_keys" USING btree ("purge_at");--> statement-breakpoint
CREATE INDEX "messages_conversacion" ON "motor"."messages" USING btree ("client_id","conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_cortafuegos" ON "motor"."messages" USING btree ("client_id","firewall_category","created_at") WHERE firewall_category is not null;--> statement-breakpoint
CREATE INDEX "messages_purga" ON "motor"."messages" USING btree ("purge_at");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_provider_id_unico" ON "motor"."messages" USING btree ("client_id","provider_message_id") WHERE provider_message_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "patients_client_phone_unico" ON "motor"."patients" USING btree ("client_id","phone_e164");--> statement-breakpoint
CREATE UNIQUE INDEX "patients_seq_unico" ON "motor"."patients" USING btree ("client_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "patients_public_ref_unico" ON "motor"."patients" USING btree ("client_id","public_ref");--> statement-breakpoint
CREATE INDEX "patients_reactivacion" ON "motor"."patients" USING btree ("client_id","last_visit_at");--> statement-breakpoint
CREATE UNIQUE INDEX "period_metrics_unico" ON "motor"."period_metrics" USING btree ("client_id","period");--> statement-breakpoint
CREATE UNIQUE INDEX "suppression_unico" ON "motor"."suppression" USING btree ("client_id","phone_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "wave_recipients_unico" ON "motor"."wave_recipients" USING btree ("client_id","wave_id","patient_id");--> statement-breakpoint
CREATE INDEX "wave_recipients_estado" ON "motor"."wave_recipients" USING btree ("client_id","wave_id","state");--> statement-breakpoint
CREATE INDEX "waves_client_estado" ON "motor"."waves" USING btree ("client_id","state");