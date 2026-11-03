-- Un fallo de la agenda ya no pierde el turno del paciente: se le contesta con
-- un texto fijo y queda un escalado con este motivo.
ALTER TYPE "motor"."escalation_reason" ADD VALUE IF NOT EXISTS 'agenda_no_disponible';
