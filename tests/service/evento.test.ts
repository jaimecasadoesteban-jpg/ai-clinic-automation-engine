import { describe, expect, it } from 'vitest';

import { toPromptPatient } from '../../src/agent/prompt-boundary.js';
import { componerEvento } from '../../src/service/evento.js';
import type { PatientRow } from '../../src/db/queries.js';
import { configDePrueba } from '../support/fakes.js';

/**
 * El contenido del evento de la agenda.
 *
 * **Dos fronteras, dos criterios**, y se parecen lo justo para confundirlas —
 * la primera versión de esto las confundió y el resultado era que recepción
 * abría la agenda el lunes y leía «Limpieza facial — pac_8371»: sin saber a
 * quién llamar para mover la cita ni a quién esperar.
 *
 * - El **prompt** va a un tercero. Minimización obligatoria: nombre de pila y
 *   referencia. Eso no se toca nunca.
 * - El **evento** va a la agenda de la clínica, que es la responsable del
 *   tratamiento y ya tiene la ficha del paciente con nombre y teléfono.
 */

const PACIENTE: PatientRow = {
  id: '11111111-1111-4111-8111-111111111111',
  clientId: '22222222-2222-4222-8222-222222222222',
  seq: 8371,
  publicRef: 'pac_8371',
  givenName: 'Rocío',
  familyName: 'Llanes Vega',
  phoneE164: '+34600123456',
  externalRef: null,
  lastVisitAt: null,
  locale: 'es',
  agentStoppedAt: null,
  agentStoppedBy: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

describe('lo que lee recepción en su agenda', () => {
  const config = configDePrueba();

  it('por defecto lleva nombre completo y teléfono: es su agenda y los necesita', () => {
    const evento = componerEvento({ config, paciente: PACIENTE, servicio: 'Láser axilas' });

    expect(evento.resumen).toBe('Láser axilas — Rocío Llanes Vega');
    expect(evento.descripcion).toContain('Rocío Llanes Vega');
    expect(evento.descripcion).toContain('+34600123456');
    // La referencia interna sigue estando, para poder cruzarlo con el panel.
    expect(evento.descripcion).toContain('pac_8371');
  });

  it('un paciente sin apellidos no deja un espacio colgando', () => {
    const evento = componerEvento({
      config,
      paciente: { ...PACIENTE, familyName: null },
      servicio: 'Láser axilas',
    });

    expect(evento.resumen).toBe('Láser axilas — Rocío');
  });

  /**
   * Una recepción con la pantalla a la vista del público puede querer lo
   * contrario, y es su decisión. Por eso son marcadores y no un interruptor.
   */
  it('la clínica puede quitar todo dato personal si su pantalla se ve', () => {
    const discreta = configDePrueba({
      agenda: {
        nivel: 'A',
        calendarioId: 'pruebas@group.calendar.google.com',
        confirmacion: 'automatica',
        tituloDelEvento: 'Cita — {ref}',
        descripcionDelEvento: 'Paciente {ref}. Consultar ficha.',
      },
    });

    const evento = componerEvento({ config: discreta, paciente: PACIENTE, servicio: 'Láser axilas' });

    expect(evento.resumen).toBe('Cita — pac_8371');
    expect(`${evento.resumen} ${evento.descripcion}`).not.toContain('+34600123456');
    expect(`${evento.resumen} ${evento.descripcion}`).not.toContain('Rocío');
  });

  it('un marcador repetido se sustituye todas las veces', () => {
    const config2 = configDePrueba({
      agenda: { nivel: 'A', calendarioId: 'pruebas@group.calendar.google.com', tituloDelEvento: '{nombre} {nombre}' },
    });

    expect(componerEvento({ config: config2, paciente: PACIENTE, servicio: 'X' }).resumen).toBe(
      'Rocío Rocío',
    );
  });
});

/**
 * La que importa de verdad: que tocar una frontera no mueva la otra. Son dos
 * funciones separadas a propósito, y este test es el que lo vigila.
 */
describe('las dos fronteras son independientes', () => {
  it('al modelo sigue yendo sólo nombre de pila y referencia', () => {
    const vista = toPromptPatient(PACIENTE);

    expect(vista).toEqual({ ref: 'pac_8371', nombre: 'Rocío' });
    expect(JSON.stringify(vista)).not.toContain('+34600123456');
    expect(JSON.stringify(vista)).not.toContain('Llanes');
  });

  it('el evento lleva lo que el prompt no puede llevar', () => {
    const evento = componerEvento({
      config: configDePrueba(),
      paciente: PACIENTE,
      servicio: 'Láser axilas',
    });
    const vista = toPromptPatient(PACIENTE);

    // Lo que separa las dos: el teléfono está en una y no puede estar en la otra.
    expect(evento.descripcion).toContain(PACIENTE.phoneE164);
    expect(Object.values(vista).join(' ')).not.toContain(PACIENTE.phoneE164);
  });
});
