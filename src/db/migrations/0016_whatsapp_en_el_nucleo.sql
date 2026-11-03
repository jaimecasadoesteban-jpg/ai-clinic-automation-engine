-- WhatsApp en el núcleo, sin n8n en medio.
--
-- 1. La bandeja de entrada. Meta reintenta si no recibe un 200 a tiempo, y el
--    turno —con el modelo de por medio— puede tardar más que eso. Así que el
--    webhook guarda el mensaje aquí, responde 200 al momento y lo procesa
--    después. Si respondiera 200 sin guardarlo, una caída lo perdería; si lo
--    procesara antes de responder, Meta lo reenviaría.
CREATE TABLE "motor"."inbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "client_id" uuid NOT NULL REFERENCES "motor"."clients"("id") ON DELETE cascade,
  -- El id del mensaje en Meta (wamid). Meta reintenta: no se procesa dos veces.
  "provider_message_id" text NOT NULL,
  -- Lo que hace falta para el turno: teléfono, nombre, tipo y texto. Vive lo
  -- justo (ver la purga): el turno lo guarda en `messages` con su retención.
  "payload" jsonb NOT NULL,
  "state" text NOT NULL DEFAULT 'pendiente' CHECK ("state" IN ('pendiente', 'procesado', 'fallido')),
  "attempts" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamptz NOT NULL,
  "last_error" text,
  "created_at" timestamptz NOT NULL,
  "processed_at" timestamptz
);--> statement-breakpoint

CREATE UNIQUE INDEX "inbox_mensaje_unico" ON "motor"."inbox" ("client_id", "provider_message_id");--> statement-breakpoint
CREATE INDEX "inbox_pendientes" ON "motor"."inbox" ("client_id", "next_attempt_at") WHERE "state" = 'pendiente';--> statement-breakpoint

ALTER TABLE "motor"."inbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "motor"."inbox" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "inbox_aislamiento" ON "motor"."inbox"
  USING (client_id = motor.current_client_id())
  WITH CHECK (client_id = motor.current_client_id());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "motor"."inbox" TO motor_app;--> statement-breakpoint

-- 2. La tabla de salida también manda WhatsApp.
ALTER TABLE "motor"."outbox" DROP CONSTRAINT "outbox_kind_check";--> statement-breakpoint
ALTER TABLE "motor"."outbox" ADD CONSTRAINT "outbox_kind_check" CHECK ("kind" IN ('correo_operador', 'whatsapp'));--> statement-breakpoint

-- 3. La purga y el protocolo de salida, con la bandeja. Las mismas funciones de
--    0015 con un paso más.
CREATE OR REPLACE FUNCTION motor.purge_expired()
  RETURNS TABLE (paso text, filas bigint)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, motor
AS $$
DECLARE
  n bigint;
  ids uuid[];
BEGIN
  -- Mensajes vencidos: se redacta el contenido, no se borra la fila. Desaparece
  -- el dato de salud y sobrevive el rastro que exige la regla 6 (hora, dirección,
  -- modelo, tokens, latencia, validación) para poder depurar o responder a una
  -- reclamación.
  UPDATE motor.messages
     SET body = NULL, prompt = NULL, redacted_at = now()
   WHERE purge_at <= now() AND redacted_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  paso := 'mensajes_redactados'; filas := n; RETURN NEXT;

  UPDATE motor.messages
     SET prompt = NULL
   WHERE prompt IS NOT NULL AND created_at <= now() - interval '90 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  paso := 'registro_de_llamadas_redactado'; filas := n; RETURN NEXT;

  DELETE FROM motor.outbox
   WHERE state IN ('enviado', 'fallido') AND created_at <= now() - interval '30 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  paso := 'salida_borrada'; filas := n; RETURN NEXT;

  -- La bandeja guarda el texto del paciente sólo hasta procesarlo: después vive
  -- en `messages`, con su propia retención. Lo procesado se va al día; lo que
  -- falló, a los 30 (es la prueba de qué no se pudo atender). Lo pendiente nunca.
  DELETE FROM motor.inbox
   WHERE (state = 'procesado' AND created_at <= now() - interval '1 day')
      OR (state = 'fallido' AND created_at <= now() - interval '30 days');
  GET DIAGNOSTICS n = ROW_COUNT;
  paso := 'bandeja_borrada'; filas := n; RETURN NEXT;

  UPDATE motor.conversations
     SET summary = NULL
   WHERE purge_at <= now() AND summary IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  paso := 'conversaciones_redactadas'; filas := n; RETURN NEXT;

  DELETE FROM motor.audit_log WHERE purge_at <= now();
  GET DIAGNOSTICS n = ROW_COUNT;
  paso := 'auditoria_borrada'; filas := n; RETURN NEXT;

  DELETE FROM motor.idempotency_keys WHERE purge_at <= now();
  GET DIAGNOSTICS n = ROW_COUNT;
  paso := 'idempotencia_borrada'; filas := n; RETURN NEXT;

  -- Límite exterior: a los 24 meses el detalle se borra entero. Una fila con
  -- patient_id y telemetría sigue siendo dato personal aunque el contenido esté
  -- redactado, y sin fecha de caducidad estaríamos acumulando responsabilidad
  -- indefinidamente sobre algo que ya no aporta valor.
  --
  -- Sólo se borra el detalle de periodos YA CONSOLIDADOS en period_metrics, que
  -- es lo que sobrevive: cifras por periodo, sin patient_id. Un periodo sin
  -- consolidar se queda como está y se informa; nunca se borra la base de una
  -- factura ya emitida.
  SELECT array_agg(c.id) INTO ids
    FROM motor.conversations c
    JOIN motor.period_metrics pm
      ON pm.client_id = c.client_id
     AND pm.period = to_char(c.created_at, 'YYYY-MM')
     AND pm.consolidated_at IS NOT NULL
   WHERE c.created_at <= now() - interval '24 months';

  IF ids IS NOT NULL THEN
    -- Orden impuesto por las claves ajenas. `wave_recipients.message_id` es
    -- ON DELETE SET NULL, así que se resuelve solo.
    DELETE FROM motor.escalations WHERE conversation_id = ANY(ids);
    DELETE FROM motor.appointments WHERE conversation_id = ANY(ids);
    DELETE FROM motor.messages WHERE conversation_id = ANY(ids);
    DELETE FROM motor.holds WHERE conversation_id = ANY(ids);
    DELETE FROM motor.conversations WHERE id = ANY(ids);
    filas := array_length(ids, 1);
  ELSE
    filas := 0;
  END IF;
  paso := 'detalle_borrado_24_meses'; RETURN NEXT;

  SELECT count(*) INTO n
    FROM motor.conversations c
   WHERE c.created_at <= now() - interval '24 months'
     AND NOT EXISTS (
       SELECT 1 FROM motor.period_metrics pm
        WHERE pm.client_id = c.client_id
          AND pm.period = to_char(c.created_at, 'YYYY-MM')
          AND pm.consolidated_at IS NOT NULL);
  paso := 'detalle_vencido_sin_consolidar'; filas := n; RETURN NEXT;
END;
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION motor.purge_expired() FROM PUBLIC;--> statement-breakpoint

CREATE OR REPLACE FUNCTION motor.offboard_client(objetivo uuid)
  RETURNS TABLE (paso text, filas bigint)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, motor
AS $$
DECLARE
  n bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM motor.clients WHERE id = objetivo) THEN
    RAISE EXCEPTION 'no existe la clínica %', objetivo USING ERRCODE = '23503';
  END IF;

  RETURN QUERY SELECT * FROM motor.offboard_extra(objetivo);

  DELETE FROM motor.wave_recipients WHERE client_id = objetivo;
  GET DIAGNOSTICS n = ROW_COUNT; paso := 'destinatarios'; filas := n; RETURN NEXT;

  DELETE FROM motor.waves WHERE client_id = objetivo;
  GET DIAGNOSTICS n = ROW_COUNT; paso := 'oleadas'; filas := n; RETURN NEXT;

  DELETE FROM motor.escalations WHERE client_id = objetivo;
  GET DIAGNOSTICS n = ROW_COUNT; paso := 'escalados'; filas := n; RETURN NEXT;

  DELETE FROM motor.appointments WHERE client_id = objetivo;
  GET DIAGNOSTICS n = ROW_COUNT; paso := 'citas'; filas := n; RETURN NEXT;

  DELETE FROM motor.messages WHERE client_id = objetivo;
  GET DIAGNOSTICS n = ROW_COUNT; paso := 'mensajes'; filas := n; RETURN NEXT;

  DELETE FROM motor.holds WHERE client_id = objetivo;
  GET DIAGNOSTICS n = ROW_COUNT; paso := 'huecos'; filas := n; RETURN NEXT;

  DELETE FROM motor.conversations WHERE client_id = objetivo;
  GET DIAGNOSTICS n = ROW_COUNT; paso := 'conversaciones'; filas := n; RETURN NEXT;

  DELETE FROM motor.audit_log WHERE client_id = objetivo;
  GET DIAGNOSTICS n = ROW_COUNT; paso := 'auditoria'; filas := n; RETURN NEXT;

  DELETE FROM motor.idempotency_keys WHERE client_id = objetivo;
  GET DIAGNOSTICS n = ROW_COUNT; paso := 'idempotencia'; filas := n; RETURN NEXT;

  DELETE FROM motor.inbox WHERE client_id = objetivo;
  GET DIAGNOSTICS n = ROW_COUNT; paso := 'bandeja'; filas := n; RETURN NEXT;

  DELETE FROM motor.outbox WHERE client_id = objetivo;
  GET DIAGNOSTICS n = ROW_COUNT; paso := 'salida'; filas := n; RETURN NEXT;

  DELETE FROM motor.patients WHERE client_id = objetivo;
  GET DIAGNOSTICS n = ROW_COUNT; paso := 'pacientes'; filas := n; RETURN NEXT;

  UPDATE motor.clients SET active = false WHERE id = objetivo;
  paso := 'cliente_desactivado'; filas := 1; RETURN NEXT;

  -- Sobreviven `suppression`, `period_metrics` y `rights_requests`: quien pidió
  -- no recibir más mensajes tiene derecho a que lo sigamos respetando aunque la
  -- clínica se vaya, y las cifras y los derechos tramitados son la prueba.
END;
$$;
