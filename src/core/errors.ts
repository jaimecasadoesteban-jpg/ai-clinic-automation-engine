/**
 * Errores tipados del dominio. Convención del proyecto: nunca `throw new Error("algo falló")`.
 *
 * Cada error lleva un `code` estable (para logs, métricas y n8n) y un `patientMessage`
 * opcional en español: el texto que puede enviarse al paciente si esta ruta muere aquí.
 * Regla 4 — ninguna ruta termina en silencio.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;

  /** Texto en español apto para enviar al paciente. `null` = no se envía nada al paciente. */
  readonly patientMessage: string | null = null;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Entrada que no cumple su esquema Zod. */
export class ValidationError extends DomainError {
  readonly code = 'validation_error';
  readonly httpStatus = 400;

  constructor(
    message: string,
    readonly issues: readonly string[] = [],
  ) {
    super(message);
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
