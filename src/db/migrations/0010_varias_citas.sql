--------------------------------------------------------------------------------
-- Un paciente puede tener varias citas vivas
--------------------------------------------------------------------------------

-- El fallo: una paciente con una limpieza facial pendiente el miércoles pidió
-- láser de axilas para el viernes. Al elegir el viernes, el sistema soltó la
-- limpieza: cualquier elección con una cita viva se trataba como reagendado,
-- sin mirar el servicio. En una clínica real eso es perder dos citas y una
-- clienta, por pedir una segunda.
--
-- La suposición falsa era «una cita por conversación». Sin ella, «esta cita
-- sustituye a la del paciente» deja de significar nada: hay que decir A CUÁL.
-- Eso pasa a ser un dato, no una deducción.

-- La cita que sustituye este hueco. Se fija al proponer dentro del reagendado
-- de una cita concreta, o al elegir si el paciente confirma que es un cambio.
-- `set null` y no `restrict`: la purga de 24 meses borra filas por periodo, y un
-- hueco nuevo no puede impedir que se purgue el viejo al que sustituyó.
ALTER TABLE "motor"."holds" ADD COLUMN "replaces_hold_id" uuid;
--> statement-breakpoint
ALTER TABLE "motor"."holds" ADD CONSTRAINT "holds_replaces_hold_id_holds_id_fk"
  FOREIGN KEY ("replaces_hold_id") REFERENCES "motor"."holds"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

-- El hueco elegido mientras se pregunta si es en lugar de otra cita o además.
ALTER TABLE "motor"."conversations" ADD COLUMN "pending_hold_id" uuid;
--> statement-breakpoint
ALTER TABLE "motor"."conversations" ADD CONSTRAINT "conversations_pending_hold_id_holds_id_fk"
  FOREIGN KEY ("pending_hold_id") REFERENCES "motor"."holds"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

-- Una cita sólo puede sustituir a otra DEL MISMO PACIENTE, y un hueco pendiente
-- sólo puede ser de ESA conversación.
--
-- La clave foránea no basta: comprueba que la fila existe, no de quién es, y
-- además se salta RLS. Un `replaces_hold_id` que apuntara a la cita de otro
-- paciente haría que elegir un hueco le cancelara la suya a un tercero — y en
-- otra clínica, una fuga entre clientes. Como siempre aquí: la protección real
-- es una restricción, no un IF.
CREATE FUNCTION motor.check_sustituye_al_mismo() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, motor
AS $$
DECLARE
  coincide boolean;
BEGIN
  IF NEW.replaces_hold_id IS NOT NULL THEN
    SELECT h.client_id = NEW.client_id AND h.patient_id = NEW.patient_id AND h.id <> NEW.id
      INTO coincide
      FROM motor.holds h
     WHERE h.id = NEW.replaces_hold_id;

    IF coincide IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'el hold % no puede sustituir al hold %', NEW.id, NEW.replaces_hold_id
        USING ERRCODE = '23514', CONSTRAINT = 'holds_sustituye_al_mismo';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER holds_sustituye_al_mismo
  BEFORE INSERT OR UPDATE OF replaces_hold_id, client_id, patient_id ON motor.holds
  FOR EACH ROW EXECUTE FUNCTION motor.check_sustituye_al_mismo();
--> statement-breakpoint

CREATE FUNCTION motor.check_pendiente_de_la_conversacion() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, motor
AS $$
DECLARE
  coincide boolean;
BEGIN
  IF NEW.pending_hold_id IS NOT NULL THEN
    SELECT h.client_id = NEW.client_id AND h.conversation_id = NEW.id
      INTO coincide
      FROM motor.holds h
     WHERE h.id = NEW.pending_hold_id;

    IF coincide IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'el hold % no es de la conversación %', NEW.pending_hold_id, NEW.id
        USING ERRCODE = '23514', CONSTRAINT = 'conversations_pendiente_propio';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER conversations_pendiente_propio
  BEFORE INSERT OR UPDATE OF pending_hold_id, client_id ON motor.conversations
  FOR EACH ROW EXECUTE FUNCTION motor.check_pendiente_de_la_conversacion();
