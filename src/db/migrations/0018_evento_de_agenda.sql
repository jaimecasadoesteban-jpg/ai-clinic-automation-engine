-- Modo `automatica` sin n8n: la cita se escribe en Google Calendar desde la
-- tabla de salida. El turno en que el paciente elige encola el evento junto con
-- el cambio de estado (regla 3); el ejecutor relee el hueco, lo crea y le pasa
-- el resultado a la misma lógica que atendía `/evento-de-agenda`.
ALTER TABLE "motor"."outbox" DROP CONSTRAINT "outbox_kind_check";--> statement-breakpoint
ALTER TABLE "motor"."outbox" ADD CONSTRAINT "outbox_kind_check" CHECK ("kind" IN ('correo_operador', 'whatsapp', 'chatwoot', 'evento_agenda'));
