--------------------------------------------------------------------------------
-- Un mensaje falso del historial no se oculta: se desmiente
--------------------------------------------------------------------------------

-- El caso: el agente escribió «te la dejo apuntada el lunes a las 10:20» sin que
-- se hubiera reservado nada. Al día siguiente, a un «Hola», el modelo leyó ese
-- mensaje y quiso recordarle al paciente su cita del lunes. La validación lo
-- bloqueó con razón y se escaló como «validación fallida», que no le dice nada a
-- recepción. Un mensaje falso no caduca ni se corrige solo: cada turno siguiente
-- hereda la mentira.
--
-- No se oculta: si desaparece de la ventana, el modelo no entiende «¿entonces lo
-- del lunes?» y el paciente sigue creyéndoselo. Se marca, y entra anotado.

ALTER TABLE "motor"."messages" ADD COLUMN "disproved_at" timestamp with time zone;
--> statement-breakpoint
-- La verdad que lo corrige, en una frase. Es texto derivado del mensaje, así
-- que se redacta con él (ver la función de abajo).
ALTER TABLE "motor"."messages" ADD COLUMN "disproved_note" text;
--> statement-breakpoint

-- Qué tiene que aclarar recepción, dicho en concreto. «Validación fallida» no
-- le dice nada; «se le dijo que tenía cita el lunes a las 10:20 y no existe», sí.
ALTER TABLE "motor"."escalations" ADD COLUMN "detail" text;
--> statement-breakpoint

-- `ADD VALUE IF NOT EXISTS` sin usarlo en esta misma transacción, como en 0007.
ALTER TYPE "motor"."escalation_reason" ADD VALUE IF NOT EXISTS 'historial_falso';
--> statement-breakpoint

-- Al redactar un mensaje también se va lo que se dedujo de su texto.
CREATE OR REPLACE FUNCTION motor.redactar_borradores() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, motor
AS $$
BEGIN
  IF NEW.redacted_at IS NOT NULL AND OLD.redacted_at IS NULL THEN
    IF NEW.validation_result IS NOT NULL THEN
      NEW.validation_result := NEW.validation_result - 'borradores';
    END IF;
    NEW.disproved_note := NULL;
  END IF;
  RETURN NEW;
END;
$$;
