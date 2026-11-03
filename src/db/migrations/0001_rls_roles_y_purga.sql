-- Aislamiento entre clínicas (regla 1), retención y purga.
--
-- Nada de esto lo genera drizzle-kit desde el esquema: RLS, roles, funciones y
-- triggers se escriben a mano y se versionan aquí.

--------------------------------------------------------------------------------
-- 1. El contexto de cliente, y qué pasa cuando no está
--------------------------------------------------------------------------------

-- El pooler de transacciones de Supabase no conserva estado de sesión, así que
-- el contexto se establece con `set_config(..., true)` — LOCAL a la transacción,
-- muere en el COMMIT. Si se hiciera de sesión, la siguiente transacción sobre la
-- misma conexión física heredaría el client_id de otra clínica.
--
-- La función revienta si el contexto no está puesto. La alternativa habitual
-- (`current_setting(...)` a secas dentro de la política) compara contra NULL y
-- devuelve CERO FILAS en silencio, que se parece demasiado a «esta clínica no
-- tiene pacientes». Queremos un error, no un resultado vacío.
CREATE FUNCTION motor.current_client_id() RETURNS uuid
  LANGUAGE plpgsql STABLE
  SET search_path = pg_catalog, motor
AS $$
DECLARE
  valor text := current_setting('app.client_id', true);
BEGIN
  IF valor IS NULL OR valor = '' THEN
    RAISE EXCEPTION 'app.client_id no establecido: toda consulta debe abrirse con el contexto de cliente'
      USING ERRCODE = '42501';
  END IF;
  RETURN valor::uuid;
END;
$$;
--> statement-breakpoint

--------------------------------------------------------------------------------
-- 2. El rol de la aplicación
--------------------------------------------------------------------------------

-- Sin LOGIN y sin contraseña: las credenciales son cosa de cada entorno, no del
-- repositorio. En Supabase se hace `ALTER ROLE motor_app LOGIN PASSWORD '...'`
-- a mano una vez; en la base de pruebas, el arranque le da acceso local.
--
-- NOBYPASSRLS explícito y NO propietario de las tablas. Esto es lo que impide el
-- fallo silencioso más peligroso del despliegue: conectarse con el rol `postgres`
-- por defecto de Supabase, que es propietario, y tener RLS desactivado de facto
-- con todos los tests en verde.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'motor_app') THEN
    CREATE ROLE motor_app NOLOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
  ELSE
    ALTER ROLE motor_app NOBYPASSRLS NOSUPERUSER;
  END IF;
END;
$$;
--> statement-breakpoint

GRANT USAGE ON SCHEMA motor TO motor_app;--> statement-breakpoint
-- SELECT, INSERT y UPDATE. **Sin DELETE**: nada del flujo normal borra — las
-- caducidades son transiciones de estado, no borrados. Lo único que borra es la
-- purga, y va por función SECURITY DEFINER. Así un `delete` mal filtrado no es
-- que borre poco: es que no tiene permiso.
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA motor TO motor_app;--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA motor TO motor_app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA motor GRANT SELECT, INSERT, UPDATE ON TABLES TO motor_app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA motor GRANT USAGE, SELECT ON SEQUENCES TO motor_app;--> statement-breakpoint

--------------------------------------------------------------------------------
-- 3. RLS en todas las tablas
--------------------------------------------------------------------------------

-- FORCE además de ENABLE: sin FORCE, el propietario de la tabla se salta sus
-- propias políticas. USING para leer, WITH CHECK para escribir — no basta con no
-- poder leer lo ajeno; tampoco se puede insertar una fila con el client_id de
-- otro ni mover una fila propia a otra clínica.
DO $$
DECLARE
  t text;
  -- `clients` es la tabla raíz: su client_id es su propio id.
  tablas text[] := ARRAY[
    'patients', 'conversations', 'messages', 'holds', 'appointments',
    'waves', 'wave_recipients', 'suppression', 'escalations', 'audit_log',
    'idempotency_keys', 'period_metrics'
  ];
BEGIN
  ALTER TABLE motor.clients ENABLE ROW LEVEL SECURITY;
  ALTER TABLE motor.clients FORCE ROW LEVEL SECURITY;
  CREATE POLICY aislamiento_por_cliente ON motor.clients
    USING (id = motor.current_client_id())
    WITH CHECK (id = motor.current_client_id());

  FOREACH t IN ARRAY tablas LOOP
    EXECUTE format('ALTER TABLE motor.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE motor.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY aislamiento_por_cliente ON motor.%I '
      'USING (client_id = motor.current_client_id()) '
      'WITH CHECK (client_id = motor.current_client_id())', t);
  END LOOP;
END;
$$;
--> statement-breakpoint

--------------------------------------------------------------------------------
-- 3 bis. Numeración de pacientes POR CLÍNICA
--------------------------------------------------------------------------------

-- `pac_8371` se numera dentro de su clínica. Con una identidad global, la
-- magnitud del número revelaría el volumen total del sistema.
--
-- El UPDATE bloquea la fila de `clients`, así que dos altas simultáneas en la
-- misma clínica se serializan. Entre clínicas distintas no hay contención.
CREATE FUNCTION motor.assign_patient_seq() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, motor
AS $$
BEGIN
  UPDATE motor.clients
     SET patient_seq = patient_seq + 1
   WHERE id = NEW.client_id
  RETURNING patient_seq INTO NEW.seq;

  IF NEW.seq IS NULL THEN
    RAISE EXCEPTION 'no existe la clínica % o no es visible en este contexto', NEW.client_id
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER patients_seq BEFORE INSERT ON motor.patients
  FOR EACH ROW EXECUTE FUNCTION motor.assign_patient_seq();--> statement-breakpoint

--------------------------------------------------------------------------------
-- 4. Retención: purge_at lo pone la base de datos, no la aplicación
--------------------------------------------------------------------------------

-- Trigger y no columna generada porque `timestamptz + interval` es STABLE en
-- PostgreSQL (depende de la zona horaria de sesión) y GENERATED exige IMMUTABLE.

-- Mensajes: 90 días si son clínicos, 12 meses si no.
-- Quién marca `is_clinical` es el cortafuegos determinista, en la etapa 2 del
-- pipeline, antes de que el modelo genere nada.
CREATE FUNCTION motor.set_message_purge_at() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, motor
AS $$
BEGIN
  NEW.purge_at := COALESCE(NEW.created_at, now())
    + CASE WHEN NEW.is_clinical THEN interval '90 days' ELSE interval '12 months' END;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER messages_purge_at BEFORE INSERT ON motor.messages
  FOR EACH ROW EXECUTE FUNCTION motor.set_message_purge_at();--> statement-breakpoint

-- Si un mensaje se reclasifica como clínico después de entrar, su plazo se
-- acorta en consecuencia. Nunca se alarga.
CREATE FUNCTION motor.tighten_message_purge_at() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, motor
AS $$
BEGIN
  IF NEW.is_clinical AND NOT OLD.is_clinical THEN
    NEW.purge_at := LEAST(NEW.purge_at, COALESCE(NEW.created_at, now()) + interval '90 days');
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER messages_purge_at_update BEFORE UPDATE ON motor.messages
  FOR EACH ROW EXECUTE FUNCTION motor.tighten_message_purge_at();--> statement-breakpoint

CREATE FUNCTION motor.set_purge_at_interval() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, motor
AS $$
BEGIN
  NEW.purge_at := COALESCE(NEW.created_at, now()) + TG_ARGV[0]::interval;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER conversations_purge_at BEFORE INSERT ON motor.conversations
  FOR EACH ROW EXECUTE FUNCTION motor.set_purge_at_interval('12 months');--> statement-breakpoint
CREATE TRIGGER audit_log_purge_at BEFORE INSERT ON motor.audit_log
  FOR EACH ROW EXECUTE FUNCTION motor.set_purge_at_interval('12 months');--> statement-breakpoint
CREATE TRIGGER idempotency_keys_purge_at BEFORE INSERT ON motor.idempotency_keys
  FOR EACH ROW EXECUTE FUNCTION motor.set_purge_at_interval('30 days');--> statement-breakpoint

-- updated_at, para no depender de que la aplicación se acuerde.
CREATE FUNCTION motor.touch_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, motor
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint

DO $$
DECLARE
  t text;
  tablas text[] := ARRAY[
    'clients', 'patients', 'conversations', 'holds', 'appointments', 'waves', 'escalations'
  ];
BEGIN
  FOREACH t IN ARRAY tablas LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON motor.%I '
      'FOR EACH ROW EXECUTE FUNCTION motor.touch_updated_at()', t || '_touch', t);
  END LOOP;
END;
$$;
--> statement-breakpoint

--------------------------------------------------------------------------------
-- 5. La purga
--------------------------------------------------------------------------------

-- SECURITY DEFINER porque motor_app no tiene DELETE y no debe tenerlo. Recorre
-- todas las clínicas a la vez, así que se salta RLS por diseño: es el único
-- punto del sistema autorizado a hacerlo, y no acepta parámetros.
--
-- `suppression` NO aparece aquí. El registro de bajas es indefinido: es la
-- prueba de que respetamos la voluntad de quien pidió no recibir más mensajes.
CREATE FUNCTION motor.purge_expired()
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

--------------------------------------------------------------------------------
-- 6. Protocolo de salida de un cliente
--------------------------------------------------------------------------------

-- Baja de una clínica: se borra su detalle sin esperar a los 24 meses.
--
-- Sobreviven dos cosas y sólo dos: `period_metrics`, que es agregado y no lleva
-- patient_id, y `suppression`, que es indefinido por definición — quien pidió no
-- recibir más mensajes tiene derecho a que lo sigamos respetando aunque la
-- clínica se vaya. La fila de `clients` se marca inactiva, no se borra, para que
-- las bajas conserven a qué clínica pertenecían.
CREATE FUNCTION motor.offboard_client(objetivo uuid)
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

  DELETE FROM motor.idempotency_keys WHERE client_id = objetivo;
  GET DIAGNOSTICS n = ROW_COUNT; paso := 'idempotencia'; filas := n; RETURN NEXT;

  DELETE FROM motor.audit_log WHERE client_id = objetivo;
  GET DIAGNOSTICS n = ROW_COUNT; paso := 'auditoria'; filas := n; RETURN NEXT;

  -- `suppression.patient_id` es ON DELETE SET NULL: la baja sobrevive al paciente.
  DELETE FROM motor.patients WHERE client_id = objetivo;
  GET DIAGNOSTICS n = ROW_COUNT; paso := 'pacientes'; filas := n; RETURN NEXT;

  UPDATE motor.clients SET active = false WHERE id = objetivo;
  paso := 'cliente_desactivado'; filas := 1; RETURN NEXT;
END;
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION motor.offboard_client(uuid) FROM PUBLIC;--> statement-breakpoint

-- Programación automática, no tarea manual. pg_cron no existe en la base de
-- pruebas local, así que se programa sólo donde está disponible; en local la
-- función se invoca directamente desde los tests.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('motor-purga-diaria', '15 3 * * *', 'SELECT motor.purge_expired()');
  ELSE
    RAISE NOTICE 'pg_cron no está instalado: la purga diaria NO queda programada en esta base de datos.';
  END IF;
END;
$$;

--------------------------------------------------------------------------------
-- 7. Medir la tasa de corte del cortafuegos
--------------------------------------------------------------------------------

-- Los falsos positivos son baratos de uno en uno y caros en conjunto: cada corte
-- genera un escalado, y una clínica que recibe quince al día deja de mirarlos en
-- una semana. La fatiga de alertas es la forma en que este producto se degrada
-- por desuso en lugar de por fallo técnico, y no se ve si no se mide.
--
-- No es una tabla de métricas: se calcula sobre `messages`, que ya guarda la
-- categoría del corte. Un agregado que hay que mantener al día es un agregado
-- que acaba mintiendo.
CREATE FUNCTION motor.firewall_daily_rates(desde date, hasta date)
  RETURNS TABLE (
    client_id uuid,
    dia date,
    categoria text,
    cortes bigint,
    entrantes bigint,
    tasa numeric
  )
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, motor
AS $$
  WITH entrantes AS (
    SELECT m.client_id, (m.created_at AT TIME ZONE 'UTC')::date AS dia, count(*) AS total
      FROM motor.messages m
     WHERE m.direction = 'entrante'
       AND m.created_at >= desde AND m.created_at < hasta + 1
     GROUP BY 1, 2
  )
  SELECT m.client_id,
         (m.created_at AT TIME ZONE 'UTC')::date AS dia,
         m.firewall_category AS categoria,
         count(*) AS cortes,
         e.total AS entrantes,
         round(count(*)::numeric / nullif(e.total, 0), 4) AS tasa
    FROM motor.messages m
    JOIN entrantes e
      ON e.client_id = m.client_id
     AND e.dia = (m.created_at AT TIME ZONE 'UTC')::date
   WHERE m.direction = 'entrante'
     AND m.firewall_category IS NOT NULL
     AND m.created_at >= desde AND m.created_at < hasta + 1
   GROUP BY m.client_id, 2, m.firewall_category, e.total
   ORDER BY 2 DESC, 4 DESC;
$$;
