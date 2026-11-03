-- La interfaz del operador (`/panel`).
--
-- 1. Quién mandó un mensaje saliente cuando no fue el modelo ni un texto fijo:
--    `panel` = lo escribió una persona desde la interfaz. Entra en la ventana
--    del modelo como cualquier saliente, así que al reactivar el agente sabe lo
--    que se le dijo. El barrido de desmentidos no lo mira (sólo mira lo que
--    tiene `model`): lo que dice una persona no lo desmiente el sistema.
ALTER TABLE "motor"."messages" ADD COLUMN "sent_by" text;--> statement-breakpoint

-- 2. Las acciones del panel quedan en auditoría con su propio actor.
-- 3. (Sin cambio de esquema.) La tabla de salida también cambia etiquetas en
--    Chatwoot: el interruptor del panel mueve `agente-parado` para que las dos
--    cosas digan lo mismo. Va en `kind = 'chatwoot'` con otra carga.
ALTER TYPE "motor"."audit_actor" ADD VALUE IF NOT EXISTS 'operador';
