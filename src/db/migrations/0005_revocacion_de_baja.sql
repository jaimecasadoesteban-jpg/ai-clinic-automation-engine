--------------------------------------------------------------------------------
-- Revocar una baja sin borrarla
--------------------------------------------------------------------------------

-- El registro de bajas es lo único que NUNCA se purga: es la prueba de que
-- respetamos el opt-out. Así que salir de la lista no puede ser un DELETE —se
-- destruiría la prueba— y además `motor_app` no tiene permiso de borrado, a
-- propósito.
--
-- Se marca la revocación y se conserva todo: cuándo se dio de baja, cuándo la
-- levantó y con qué constancia. La fila sigue ahí para siempre.
ALTER TABLE "motor"."suppression"
  ADD COLUMN "revoked_at" timestamptz,
  ADD COLUMN "revoked_note" text;
--> statement-breakpoint

-- El índice único seguía impidiendo volver a darse de baja tras revocar, porque
-- la fila revocada ocupa el sitio. Ahora sólo aplica a las bajas vigentes: una
-- persona puede darse de baja, volver, y darse de baja otra vez.
DROP INDEX IF EXISTS "motor"."suppression_unico";--> statement-breakpoint
CREATE UNIQUE INDEX "suppression_unico"
  ON "motor"."suppression" ("client_id", "phone_hash")
  WHERE revoked_at IS NULL;
