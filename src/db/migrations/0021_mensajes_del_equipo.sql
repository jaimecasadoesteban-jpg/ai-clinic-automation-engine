-- Lo que escribe una persona fuera del panel (desde el móvil con la
-- coexistencia, o desde Chatwoot) entra en el historial.
--
-- 1. El id que Chatwoot le da a cada mensaje que mandamos nosotros. Chatwoot
--    avisa también de nuestros propios mensajes, con el mismo usuario que usa
--    el equipo: lo único que los distingue es que ese id lo tenemos apuntado.
ALTER TABLE "motor"."outbox" ADD COLUMN "sent_ref" text;--> statement-breakpoint
CREATE INDEX "outbox_por_referencia" ON "motor"."outbox" ("client_id", "sent_ref") WHERE "sent_ref" IS NOT NULL;--> statement-breakpoint

-- 2. El canal de las conversaciones que entraron por Chatwoot antes de 0019,
--    sacado de la bandeja de entrada (que borra lo procesado al día). Sin esto
--    el panel no puede contestarles hasta que el paciente vuelva a escribir.
UPDATE "motor"."conversations" c
   SET reply_channel = jsonb_build_object(
         'por', 'chatwoot',
         'cuentaId', (i.payload -> 'chatwoot' ->> 'cuentaId')::int,
         'conversacionId', (i.payload -> 'chatwoot' ->> 'conversacionId')::int)
  FROM (
    SELECT DISTINCT ON (m.conversation_id) m.client_id, m.conversation_id, b.payload
      FROM "motor"."messages" m
      JOIN "motor"."inbox" b ON b.client_id = m.client_id AND b.provider_message_id = m.provider_message_id
     WHERE b.payload ? 'chatwoot'
     ORDER BY m.conversation_id, m.created_at DESC
  ) i
 WHERE c.id = i.conversation_id AND c.client_id = i.client_id AND c.reply_channel IS NULL;
