-- Regla 6: el registro de cada llamada al modelo, y el resumen de conversación
-- que docs/DESIGN_RULES.md describía («ventana de 8 turnos más resumen») y nada escribía.
--
-- 1. `conversations.summary_until`: hasta qué mensaje cubre el resumen. Sin esto
--    no se sabe qué ha salido de la ventana desde el último resumen.
ALTER TABLE "motor"."conversations" ADD COLUMN IF NOT EXISTS "summary_until" timestamp with time zone;
--> statement-breakpoint

-- 2. El registro de llamadas (`messages.prompt`) lleva la ventana de turnos que
--    vio el modelo, y en ella puede ir un mensaje clínico de hace dos días. Si
--    viviera lo que vive su fila —doce meses, si el mensaje del turno no era
--    clínico— ese texto sobreviviría a su propio plazo de 90 días. Así que el
--    registro vive lo que el plazo más corto, venga de la fila que venga. La
--    telemetría de la regla 6 (modelo, tokens, latencia, validación) está en
--    otras columnas y sobrevive.
--
--    Es la misma función de 0001 con un paso más, tras redactar los mensajes.
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

REVOKE ALL ON FUNCTION motor.purge_expired() FROM PUBLIC;
