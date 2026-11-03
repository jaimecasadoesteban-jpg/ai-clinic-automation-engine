import type { InferSelectModel } from 'drizzle-orm';

import { DomainError } from '../core/errors.js';
import type { patients } from '../db/schema.js';

export type PatientRow = InferSelectModel<typeof patients>;

/**
 * La frontera del prompt. Regla 2: al modelo van nombre de pila e identificador
 * interno, y nada más — ni teléfono, ni apellidos, ni DNI, ni historia clínica,
 * ni datos de otro paciente.
 *
 * La protección está aquí y en su test, no en no guardar el dato: recepción
 * necesita apellidos para dar de alta a un paciente nuevo como paciente real.
 *
 * Esta función es el ÚNICO sitio autorizado a construir la representación de un
 * paciente que cruza hacia el modelo. Si añades un campo a `patients`, el test
 * `tests/agent/prompt-boundary.test.ts` falla hasta que decidas conscientemente
 * de qué lado de esta frontera cae.
 */
export const CAMPOS_DE_PACIENTE_HACIA_EL_PROMPT = ['publicRef', 'givenName'] as const;

/** Lo que ve el modelo de un paciente. Nada más que esto. */
export interface PromptPatient {
  /** `pac_8371`. Identificador interno, no reversible a nadie desde el prompt. */
  readonly ref: string;
  /** Nombre de pila. */
  readonly nombre: string;
}

export class PromptBoundaryError extends DomainError {
  readonly code = 'prompt_boundary_error';
  readonly httpStatus = 500;
}

export function toPromptPatient(patient: PatientRow): PromptPatient {
  // `publicRef` es una columna generada: en la práctica nunca es nula, pero si
  // lo fuera preferimos fallar a mandar al modelo un paciente sin identificar.
  if (patient.publicRef === null || patient.publicRef === '') {
    throw new PromptBoundaryError(
      'El paciente no tiene identificador público; no puede cruzar hacia el prompt.',
    );
  }

  return {
    ref: patient.publicRef,
    nombre: patient.givenName,
  };
}
