ALTER TABLE "motor"."conversations" ADD COLUMN "service_code" text;--> statement-breakpoint

--------------------------------------------------------------------------------
-- Consolidación de period_metrics
--------------------------------------------------------------------------------

-- La purga de los 24 meses sólo borra el detalle de periodos YA CONSOLIDADOS.
-- Sin esta función no se consolidaba ninguno, así que la purga no borraba nada:
-- el lado seguro, pero el detalle se acumulaba indefinidamente.
--
-- Idempotente: volver a consolidar un periodo recalcula sus cifras. Se puede
-- llamar tantas veces como haga falta, y hay que llamarla ANTES de que el
-- detalle cumpla 24 meses.
CREATE FUNCTION motor.consolidar_periodo(objetivo uuid, periodo text)
  -- Las columnas de salida van con prefijo a propósito: en plpgsql son
  -- variables, y llamarlas igual que las columnas de period_metrics hace que
  -- el INSERT de abajo no compile («client_id is ambiguous»).
  RETURNS TABLE (
    res_client_id uuid,
    res_period text,
    res_citas_generadas integer,
    res_huecos_propuestos integer,
    res_conversaciones integer,
    res_no_shows integer
  )
  LANGUAGE plpgsql
  -- INVOKER a propósito, no DEFINER: así RLS sigue aplicando y el `WITH CHECK`
  -- de period_metrics rechaza en la base cualquier intento de consolidar una
  -- clínica que no sea la del contexto. La regla 1 la impone Postgres, no un IF.
  SECURITY INVOKER
  SET search_path = pg_catalog, motor
AS $$
DECLARE
  desde timestamptz;
  hasta timestamptz;
BEGIN
  IF periodo !~ '^\d{4}-\d{2}$' THEN
    RAISE EXCEPTION 'el periodo debe ser YYYY-MM, no %', periodo USING ERRCODE = '22023';
  END IF;

  desde := to_timestamp(periodo || '-01', 'YYYY-MM-DD');
  hasta := desde + interval '1 month';

  INSERT INTO motor.period_metrics
    (client_id, period, citas_generadas, huecos_propuestos, conversaciones, no_shows, consolidated_at)
  SELECT
    objetivo,
    periodo,
    (SELECT count(*) FROM motor.appointments a
      WHERE a.client_id = objetivo AND a.counts_as_generated
        AND a.slot_start >= desde AND a.slot_start < hasta),
    (SELECT count(*) FROM motor.holds h
      WHERE h.client_id = objetivo AND h.created_at >= desde AND h.created_at < hasta),
    (SELECT count(*) FROM motor.conversations c
      WHERE c.client_id = objetivo AND c.created_at >= desde AND c.created_at < hasta),
    (SELECT count(*) FROM motor.appointments a
      WHERE a.client_id = objetivo AND a.outcome = 'no_asistida'
        AND a.slot_start >= desde AND a.slot_start < hasta),
    now()
  ON CONFLICT (client_id, period) DO UPDATE
    SET citas_generadas = excluded.citas_generadas,
        huecos_propuestos = excluded.huecos_propuestos,
        conversaciones = excluded.conversaciones,
        no_shows = excluded.no_shows,
        consolidated_at = now();

  RETURN QUERY
    SELECT pm.client_id, pm.period, pm.citas_generadas, pm.huecos_propuestos,
           pm.conversaciones, pm.no_shows
      FROM motor.period_metrics pm
     WHERE pm.client_id = objetivo AND pm.period = periodo;
END;
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION motor.consolidar_periodo(uuid, text) FROM PUBLIC;--> statement-breakpoint
-- La llama el núcleo desde `/consolidar-periodo`, no sólo pg_cron.
GRANT EXECUTE ON FUNCTION motor.consolidar_periodo(uuid, text) TO motor_app;
