import { describe, expect, it } from 'vitest';

import { esConsultaDeDisponibilidad } from '../../src/agent/consulta.js';

/**
 * Una consulta no es una elección. Determinista y antes del modelo: la etiqueta
 * del clasificador no puede decidir sola reservar un hueco.
 *
 * «¿Viernes a las 17:00 lo tienes libre?» acabó en un hueco retenido que el
 * paciente nunca vio. Al escribir uno nuevo, la pregunta es cómo lo diría quien
 * está preguntando y no eligiendo — casi nunca con interrogación en WhatsApp.
 */
describe('consulta de disponibilidad: consulta y propone, no retiene', () => {
  it.each([
    '¿Viernes a las 17:00 lo tienes libre?',
    '¿tenéis las 17:00?',
    '¿hay algo a las 11?',
    '¿el jueves a las 10 está libre?',
    'tenéis las 17:00',
    'hay algo a las 11',
    'Tienes hueco el viernes a las 5?',
    'y a las 12 queda algo?',
    'Quedaría libre la de las 10:20?',
    'la de las 11, si sigue libre',
    '¿está disponible el martes a las 10?',
    'tendrías a las 18:00',
  ])('«%s» es consulta', (texto) => {
    expect(esConsultaDeDisponibilidad(texto)).toBe(true);
  });

  it.each([
    'A las 10:20',
    'las 17:00',
    'me quedo con la de las 11',
    'Me quedo con la primera que me has dicho',
    'La del miércoles a las 10',
    'Vale, el viernes a las 16:00',
    'la segunda',
    // Peticiones con cortesía: al reagendar, nombrar una hora así ES elegir.
    '¿Puede ser a las 10:20?',
    'No puedo a las 10, ¿puede ser a las 10:20?',
    '¿Me la pones a las 11?',
  ])('«%s» NO es consulta', (texto) => {
    expect(esConsultaDeDisponibilidad(texto)).toBe(false);
  });
});
