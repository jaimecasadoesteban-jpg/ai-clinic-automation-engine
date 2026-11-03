-- El planificador del núcleo: los crons sin n8n.
--
-- 1. Por dónde se le escribe a cada paciente. El turno lo sabe porque el
--    mensaje acaba de llegar por ahí; un cron no tiene mensaje entrante. Cada
--    turno que entra por el núcleo (Chatwoot o Meta) lo deja aquí, y los avisos
--    que inicia el sistema —una propuesta que caduca, un recordatorio— salen
--    por el mismo sitio. Sin esto, «tu propuesta ha caducado» no tendría a
--    dónde ir.
ALTER TABLE "motor"."conversations" ADD COLUMN "reply_channel" jsonb;--> statement-breakpoint

-- 2. Correo a los contactos de la clínica que lo tengan como canal (protección
--    de datos, por ejemplo), además del correo al operador.
ALTER TABLE "motor"."outbox" DROP CONSTRAINT "outbox_kind_check";--> statement-breakpoint
ALTER TABLE "motor"."outbox" ADD CONSTRAINT "outbox_kind_check" CHECK ("kind" IN ('correo_operador', 'correo', 'whatsapp', 'chatwoot', 'evento_agenda'));
