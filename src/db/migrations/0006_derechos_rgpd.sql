--------------------------------------------------------------------------------
-- Solicitudes de derechos del RGPD
--------------------------------------------------------------------------------

-- Una baja comercial se resuelve con una fila en `suppression`. Acceso,
-- rectificación, supresión, oposición, limitación y portabilidad son DERECHOS
-- con plazo legal de un mes, y los resuelve la CLÍNICA, que es la responsable
-- del tratamiento. Nosotros somos encargados: no decidimos, asistimos.
--
-- Estaban en la misma categoría que la baja, así que una solicitud de supresión
-- se «resolvía» añadiendo un teléfono a una lista y nadie tramitaba nada.
--
-- La excepción es la oposición a comunicaciones comerciales: ésa sí se ejecuta
-- al momento porque hay instrucción permanente del responsable en el contrato de
-- encargo. Eso sigue siendo `baja`.

ALTER TYPE "motor"."escalation_reason" ADD VALUE IF NOT EXISTS 'derechos_rgpd';--> statement-breakpoint

CREATE TYPE "motor"."right_kind" AS ENUM (
  'acceso',
  'rectificacion',
  'supresion',
  'oposicion',
  'limitacion',
  'portabilidad',
  -- El paciente ejerce un derecho sin decir cuál. No se adivina: lo determina
  -- la clínica al tramitarlo.
  'sin_determinar'
);--> statement-breakpoint

CREATE TYPE "motor"."right_state" AS ENUM ('recibida', 'trasladada', 'cerrada');--> statement-breakpoint

CREATE TABLE "motor"."rights_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "client_id" uuid NOT NULL REFERENCES "motor"."clients"("id") ON DELETE restrict,
  "patient_id" uuid REFERENCES "motor"."patients"("id") ON DELETE restrict,
  "conversation_id" uuid REFERENCES "motor"."conversations"("id") ON DELETE restrict,
  "kind" "motor"."right_kind" NOT NULL DEFAULT 'sin_determinar',
  "state" "motor"."right_state" NOT NULL DEFAULT 'recibida',
  -- Las cuatro fechas que el contrato de encargo obliga a registrar.
  "received_at" timestamptz NOT NULL DEFAULT now(),
  "transferred_at" timestamptz,
  "closed_at" timestamptz,
  -- Traslado a la clínica en 48 h como máximo, y respuesta en un mes. Se
  -- materializan para poder ordenar y avisar por ellos sin recalcular nada.
  "transfer_due_at" timestamptz NOT NULL DEFAULT now() + interval '48 hours',
  "answer_due_at" timestamptz NOT NULL DEFAULT now() + interval '1 month',
  "note" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

-- Las pendientes primero: es la consulta que hace el aviso de plazos.
CREATE INDEX "rights_requests_pendientes"
  ON "motor"."rights_requests" ("client_id", "state", "answer_due_at");--> statement-breakpoint

-- Y las abiertas por paciente: mientras hay una supresión o una limitación en
-- curso no se le agendan citas nuevas.
CREATE INDEX "rights_requests_por_paciente"
  ON "motor"."rights_requests" ("client_id", "patient_id", "state");--> statement-breakpoint

ALTER TABLE "motor"."rights_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "motor"."rights_requests" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "rights_requests_aislamiento" ON "motor"."rights_requests"
  USING (client_id = motor.current_client_id())
  WITH CHECK (client_id = motor.current_client_id());--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON "motor"."rights_requests" TO motor_app;--> statement-breakpoint

CREATE TRIGGER "rights_requests_touch"
  BEFORE UPDATE ON "motor"."rights_requests"
  FOR EACH ROW EXECUTE FUNCTION motor.touch_updated_at();
