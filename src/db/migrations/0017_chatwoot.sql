-- WhatsApp a través de Chatwoot (coexistencia): el paciente escribe al número
-- de la clínica, Chatwoot avisa al núcleo, y el núcleo contesta por la API de
-- Chatwoot. Así la conversación entera —agente y personas— vive en un sitio.

-- 1. La tabla de salida también manda a Chatwoot: la respuesta al paciente y
--    las notas privadas para el equipo.
ALTER TABLE "motor"."outbox" DROP CONSTRAINT "outbox_kind_check";--> statement-breakpoint
ALTER TABLE "motor"."outbox" ADD CONSTRAINT "outbox_kind_check" CHECK ("kind" IN ('correo_operador', 'whatsapp', 'chatwoot'));--> statement-breakpoint

-- 2. El interruptor del agente, por paciente. Parado, el agente no contesta
--    hasta que alguien lo vuelva a activar: sin plazo y sin reactivarse solo.
--    Vive en el paciente y no en la conversación porque lo que se para es «el
--    chat con esta persona», que sobrevive a que una conversación nuestra se
--    cierre y se abra otra. Hoy lo mueve una etiqueta de Chatwoot; mañana, el
--    botón de la interfaz. La verdad está aquí, no en Chatwoot.
ALTER TABLE "motor"."patients" ADD COLUMN "agent_stopped_at" timestamptz;--> statement-breakpoint
ALTER TABLE "motor"."patients" ADD COLUMN "agent_stopped_by" text;
