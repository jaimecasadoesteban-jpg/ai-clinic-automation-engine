import { getTableColumns } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import {
  CAMPOS_DE_PACIENTE_HACIA_EL_PROMPT,
  toPromptPatient,
  type PatientRow,
} from '../../src/agent/prompt-boundary.js';
import { patients } from '../../src/db/schema.js';

/**
 * Regla 2: el teléfono nunca entra en el prompt, ni los apellidos, ni nada de
 * otro paciente.
 *
 * Estos son los campos que NUNCA cruzan. La lista está aquí, en el test, y no
 * en el código de producción a propósito: obliga a que quien añada una columna a
 * `patients` pase por este fichero y decida a mano de qué lado cae.
 */
const CAMPOS_QUE_NUNCA_CRUZAN = [
  'id',
  'clientId',
  'seq',
  'familyName',
  'phoneE164',
  'externalRef',
  'lastVisitAt',
  'locale',
  'agentStoppedAt',
  'agentStoppedBy',
  'createdAt',
  'updatedAt',
] as const;

/** Valores reconocibles, para poder buscarlos en la salida serializada. */
const PACIENTE: PatientRow = {
  id: '9f1d3c6e-1111-4111-8111-111111111111',
  clientId: '9f1d3c6e-2222-4222-8222-222222222222',
  seq: 8371,
  publicRef: 'pac_8371',
  givenName: 'Lucía',
  familyName: 'Fernández Arrieta',
  phoneE164: '+34611223344',
  externalRef: 'HC-99812',
  lastVisitAt: new Date('2026-02-14T10:00:00.000Z'),
  locale: 'es-ES',
  agentStoppedAt: new Date('2026-03-07T17:43:00.000Z'),
  agentStoppedBy: 'chatwoot:etiqueta-interruptor',
  createdAt: new Date('2026-01-01T09:00:00.000Z'),
  updatedAt: new Date('2026-01-01T09:00:00.000Z'),
};

describe('frontera del prompt', () => {
  it('toda columna de patients está clasificada como cruza o no cruza', () => {
    const columnas = Object.keys(getTableColumns(patients)).sort();
    const clasificadas = [
      ...CAMPOS_DE_PACIENTE_HACIA_EL_PROMPT,
      ...CAMPOS_QUE_NUNCA_CRUZAN,
    ].sort();

    // Si esto falla, alguien ha añadido un campo a `patients` y no ha dicho si
    // puede llegar al modelo. Ése es exactamente el momento de decidirlo.
    expect(columnas).toEqual(clasificadas);
  });

  it('la vista del paciente tiene exactamente dos campos', () => {
    const vista = toPromptPatient(PACIENTE);

    expect(Object.keys(vista).sort()).toEqual(['nombre', 'ref']);
  });

  it('el objeto serializado no contiene apellidos ni teléfono ni ningún otro dato', () => {
    const serializado = JSON.stringify(toPromptPatient(PACIENTE));

    const prohibidos = [
      PACIENTE.familyName,
      PACIENTE.phoneE164,
      PACIENTE.externalRef,
      PACIENTE.id,
      PACIENTE.clientId,
      '2026-02-14',
    ];

    for (const valor of prohibidos) {
      expect(valor).not.toBeNull();
      expect(serializado).not.toContain(valor);
    }
  });

  it('sí lleva el nombre de pila y el identificador interno', () => {
    const vista = toPromptPatient(PACIENTE);

    expect(vista.nombre).toBe('Lucía');
    expect(vista.ref).toBe('pac_8371');
  });

  it('un paciente sin identificador público no cruza: falla en vez de ir sin identificar', () => {
    expect(() => toPromptPatient({ ...PACIENTE, publicRef: null })).toThrow(
      /identificador público/,
    );
  });
});
