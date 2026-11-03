--------------------------------------------------------------------------------
-- Resolver la clínica a partir de su línea de WhatsApp
--------------------------------------------------------------------------------

-- n8n recibe de Meta el `phone_number_id` y necesita el `clientId` para llamar
-- al núcleo. Hasta ahora ese mapeo vivía en una tabla a mano dentro de n8n, y se
-- desincroniza el día que alguien cambia una línea en Meta — con un fallo
-- silencioso, que es la peor clase.
--
-- El dato ya existe: `canal.remitenteId` en el YAML de cada clínica. Lo que
-- faltaba era poder pasar del slug al UUID, y ahí hay un círculo: `clients`
-- tiene RLS por `id = motor.current_client_id()`, así que para leer la fila hay
-- que saber ya el id que se está buscando.
--
-- Esta función lo rompe sin abrir la tabla: SECURITY DEFINER, devuelve
-- ÚNICAMENTE el id, sólo de clínicas activas, y no expone ninguna otra columna.
-- Es el mínimo que resuelve el problema.
CREATE FUNCTION motor.id_de_clinica(buscado text)
  RETURNS uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, motor
AS $$
  SELECT c.id FROM motor.clients c WHERE c.slug = buscado AND c.active
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION motor.id_de_clinica(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION motor.id_de_clinica(text) TO motor_app;
