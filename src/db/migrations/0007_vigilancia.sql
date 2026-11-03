--------------------------------------------------------------------------------
-- Vigilar lo que el sistema promete
--------------------------------------------------------------------------------

-- Dos obligaciones que el sistema promete y nadie vigilaba. Registrar el
-- incumplimiento en vez de evitarlo es PEOR que no registrarlo, porque deja la
-- prueba.

-- 1. El plazo de un mes de las solicitudes de derechos. Se avisa ANTES de que
--    venza, no cuando ya venció.
ALTER TABLE "motor"."rights_requests"
  ADD COLUMN "warned_20_at" timestamptz,
  ADD COLUMN "warned_27_at" timestamptz;--> statement-breakpoint

-- 2. Latido de los crons. La ausencia de señal es el fallo más traicionero que
--    hay: no genera ningún error, simplemente no pasa nada. Si `/caducar-
--    retenciones` deja de llamarse, los vencimientos no ocurren y la gente se
--    queda colgada sin que salte nada.
CREATE TABLE "motor"."job_runs" (
  "client_id" uuid NOT NULL REFERENCES "motor"."clients"("id") ON DELETE restrict,
  "job" text NOT NULL,
  "last_run_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("client_id", "job")
);--> statement-breakpoint

ALTER TABLE "motor"."job_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "motor"."job_runs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "job_runs_aislamiento" ON "motor"."job_runs"
  USING (client_id = motor.current_client_id())
  WITH CHECK (client_id = motor.current_client_id());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "motor"."job_runs" TO motor_app;--> statement-breakpoint

ALTER TYPE "motor"."escalation_reason" ADD VALUE IF NOT EXISTS 'latido_perdido';--> statement-breakpoint

-- 3. El bloqueo de citas con un derecho limitante en curso, en la base y no
--    sólo en un IF sobre una intención que adivina un modelo. Supresión,
--    limitación y oposición son incompatibles con seguir dándole hora; acceso,
--    rectificación y portabilidad no bloquean nada.
CREATE FUNCTION motor.check_sin_derecho_limitante() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, motor
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM motor.rights_requests r
     WHERE r.client_id = NEW.client_id
       AND r.patient_id = NEW.patient_id
       AND r.kind IN ('supresion', 'limitacion', 'oposicion')
       AND r.state <> 'cerrada'
  ) THEN
    RAISE EXCEPTION
      'el paciente % tiene una solicitud de derechos en curso que limita el tratamiento',
      NEW.patient_id
      USING ERRCODE = '23514', CONSTRAINT = 'holds_derecho_en_curso';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- Sólo al CREAR un hueco o al pasarlo a retenida. Confirmar o liberar uno que ya
-- existía sigue permitido: ejercer un derecho no deshace un acuerdo anterior.
CREATE TRIGGER holds_sin_derecho_limitante
  BEFORE INSERT OR UPDATE OF state ON motor.holds
  FOR EACH ROW WHEN (NEW.state IN ('propuesta', 'retenida'))
  EXECUTE FUNCTION motor.check_sin_derecho_limitante();

--> statement-breakpoint

-- 4. El protocolo de salida tiene que conocer las tablas nuevas, o falla por
--    clave ajena el día que una clínica se va. Se arregla aquí y no «cuando
--    toque»: una función de baja que revienta se descubre en el peor momento.
--
--    `job_runs` es operativa y se borra. `rights_requests` NO: es la prueba de
--    cómo se tramitaron los derechos, igual que el registro de bajas. Se le
--    quitan los identificadores personales y la fila se queda.
CREATE OR REPLACE FUNCTION motor.offboard_extra(objetivo uuid)
  RETURNS TABLE (paso text, filas bigint)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, motor
AS $$
DECLARE
  n bigint;
BEGIN
  DELETE FROM motor.job_runs WHERE client_id = objetivo;
  GET DIAGNOSTICS n = ROW_COUNT; paso := 'latidos'; filas := n; RETURN NEXT;

  UPDATE motor.rights_requests
     SET patient_id = NULL, conversation_id = NULL
   WHERE client_id = objetivo;
  GET DIAGNOSTICS n = ROW_COUNT; paso := 'derechos_anonimizados'; filas := n; RETURN NEXT;
END;
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION motor.offboard_extra(uuid) FROM PUBLIC;--> statement-breakpoint

-- Y se engancha al protocolo existente, para que sea UNA llamada y no dos que
-- alguien pueda olvidarse de encadenar.
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

  DELETE FROM motor.patients WHERE client_id = objetivo;
  GET DIAGNOSTICS n = ROW_COUNT; paso := 'pacientes'; filas := n; RETURN NEXT;

  UPDATE motor.clients SET active = false WHERE id = objetivo;
  paso := 'cliente_desactivado'; filas := 1; RETURN NEXT;

  -- Sobreviven `suppression`, `period_metrics` y `rights_requests`: quien pidió
  -- no recibir más mensajes tiene derecho a que lo sigamos respetando aunque la
  -- clínica se vaya, y las cifras y los derechos tramitados son la prueba.
END;
$$;
