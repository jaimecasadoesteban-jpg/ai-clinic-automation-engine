-- Recordatorios al paciente antes de su cita.
--
-- La marca de que el recordatorio de esta cita ya se procesó: salió como texto,
-- como plantilla, o no pudo salir y se avisó al operador. En cualquiera de los
-- tres casos no se vuelve a intentar: un recordatorio repetido es ruido, y uno
-- que falta ya lo sabe el operador.
ALTER TABLE "motor"."appointments" ADD COLUMN "reminder_sent_at" timestamptz;
