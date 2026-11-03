--------------------------------------------------------------------------------
-- Un hueco ocupado no se vuelve a proponer
--------------------------------------------------------------------------------

-- El fallo: recepción confirmaba las 10:20, el paciente preguntaba «¿está
-- confirmada?» y el turno siguiente volvía a PROPONER las 10:20. Dos filas para
-- el mismo hueco, una `propuesta` y otra `confirmada`. El agente leyó ese estado
-- incoherente y se contradijo sobre una cita real.
--
-- `holds_slot_unico` no lo impedía porque `propuesta` no está en su WHERE: cubría
-- la doble reserva, no la doble fila. Y no se puede arreglar ampliando el índice,
-- porque proponer el mismo hueco a varias personas es legítimo y deliberado
-- —`propuesta` no bloquea— así que la regla no es «una fila por hueco» sino
-- «ninguna propuesta sobre un hueco ya dado».
--
-- Va en la base y no en el código a propósito: el arreglo del pipeline evita
-- crearlas, pero cualquier camino futuro que proponga huecos volvería a poder
-- hacerlo. La protección real es una restricción, no un IF.
--
-- Además compara por SOLAPE y no por slot_start, que es lo que el índice único
-- no puede expresar: un servicio de 20 minutos y otro de 90 que empiezan a horas
-- distintas se pisan sin compartir slot_start.

CREATE FUNCTION motor.check_hueco_libre() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, motor
AS $$
DECLARE
  chocado uuid;
BEGIN
  SELECT h.id INTO chocado
    FROM motor.holds h
   WHERE h.client_id = NEW.client_id
     AND h.id <> NEW.id
     AND h.state IN ('retenida', 'pendiente_recepcion', 'confirmada')
     AND h.slot_start < NEW.slot_end
     AND h.slot_end > NEW.slot_start
   LIMIT 1;

  IF chocado IS NOT NULL THEN
    RAISE EXCEPTION
      'el hueco % ya está ocupado por el hold %', NEW.slot_start, chocado
      -- Mismo código y un nombre propio: el pipeline ya sabe distinguir una
      -- colisión de hueco de cualquier otro error, y esto entra por ahí.
      USING ERRCODE = '23505', CONSTRAINT = 'holds_hueco_ocupado';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- Sobre `propuesta`: no se propone lo que ya está dado.
CREATE TRIGGER holds_no_proponer_ocupado
  BEFORE INSERT OR UPDATE OF state, slot_start, slot_end ON motor.holds
  FOR EACH ROW WHEN (NEW.state = 'propuesta')
  EXECUTE FUNCTION motor.check_hueco_libre();
--> statement-breakpoint

-- Y sobre los estados que bloquean: el índice único sólo compara slot_start, así
-- que dos citas de duración distinta podían solaparse sin que nada lo impidiera.
-- Esto es la misma doble reserva que el índice existe para evitar.
CREATE TRIGGER holds_no_solapar_ocupado
  BEFORE INSERT OR UPDATE OF state, slot_start, slot_end ON motor.holds
  FOR EACH ROW WHEN (NEW.state IN ('retenida', 'pendiente_recepcion', 'confirmada'))
  EXECUTE FUNCTION motor.check_hueco_libre();
