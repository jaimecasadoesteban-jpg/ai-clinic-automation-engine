--------------------------------------------------------------------------------
-- Los borradores que la validación bloquea, guardados y redactados con el mensaje
--------------------------------------------------------------------------------

-- Hasta ahora `validation_result` guardaba el motivo del bloqueo y no el texto.
-- Para saber qué había escrito el modelo en un saludo que acabó escalado hubo que
-- deducir la frase a partir de «lunes 10:20». Ese tiempo se repite cada vez.
--
-- Pero un borrador es texto del modelo, y puede repetir lo que contó el paciente.
-- `motor.purge_expired()` redacta `body` y `prompt` y deja `validation_result`,
-- porque es la telemetría que la regla 6 exige conservar. Si los borradores
-- vivieran ahí sin más, sobrevivirían a la retención del propio mensaje.
--
-- Así que en el instante en que un mensaje se redacta —lo haga quien lo haga— se
-- quitan también sus borradores. La telemetría sobrevive; el texto, no.

CREATE FUNCTION motor.redactar_borradores() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, motor
AS $$
BEGIN
  IF NEW.redacted_at IS NOT NULL AND OLD.redacted_at IS NULL AND NEW.validation_result IS NOT NULL THEN
    NEW.validation_result := NEW.validation_result - 'borradores';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER messages_redactar_borradores
  BEFORE UPDATE OF redacted_at ON motor.messages
  FOR EACH ROW EXECUTE FUNCTION motor.redactar_borradores();
