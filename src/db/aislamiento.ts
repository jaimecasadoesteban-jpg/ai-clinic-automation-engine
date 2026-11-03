import { DomainError } from '../core/errors.js';

/**
 * El arranque ha encontrado el aislamiento entre clínicas roto en la base a la
 * que se iba a conectar. El proceso no arranca: ver `Core.comprobarAislamiento`.
 */
export class AislamientoRotoError extends DomainError {
  readonly code = 'aislamiento_roto';
  readonly httpStatus = 500;

  constructor(readonly fallos: readonly string[]) {
    super(`El aislamiento entre clínicas está roto en esta base. No se arranca:\n- ${fallos.join('\n- ')}`);
  }
}
