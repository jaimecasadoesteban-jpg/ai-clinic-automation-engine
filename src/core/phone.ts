import { createHmac } from 'node:crypto';

import { DomainError } from './errors.js';

export class PimientaAusenteError extends DomainError {
  readonly code = 'suppression_pepper_ausente';
  readonly httpStatus = 500;

  constructor() {
    super(
      'Falta SUPPRESSION_PEPPER. Sin ella no se puede comprobar la lista de bajas, ' +
        'y escribir a quien pidió no recibir mensajes no es una opción.',
    );
  }
}

/**
 * HMAC-SHA256 del teléfono con la pimienta del servidor.
 *
 * La lista de bajas sólo necesita responder «¿está de baja este número?», así
 * que no guarda teléfonos. La pimienta es **crítica y no rotable**: no
 * conservamos los originales, no hay forma de recalcular. Ver docs/DESIGN_RULES.md.
 */
export function hashTelefono(e164: string, pimienta: string): string {
  if (pimienta.length === 0) throw new PimientaAusenteError();
  return createHmac('sha256', pimienta).update(e164.trim()).digest('hex');
}
