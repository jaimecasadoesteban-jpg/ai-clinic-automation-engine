import { describe, expect, it } from 'vitest';

import {
  componerAviso,
  destinatariosDeEscalado,
  destinatariosDeRecepcion,
} from '../../src/service/avisos.js';
import type { PatientRow } from '../../src/db/queries.js';
import { configDePrueba } from '../support/fakes.js';

/**
 * A quién va cada aviso y qué dice.
 *
 * Vive en el núcleo y no en n8n por la misma razón que el horario: si n8n
 * mantuviera su propia tabla de contactos, sería la misma configuración en dos
 * sitios, uno sin tests y sin diff legible. El día que alguien cambiara el número
 * de recepción en uno y no en el otro, **no fallaría nada**: los avisos se irían
 * a un móvil que ya no mira nadie y dejarían de llegar en silencio.
 */

const CONFIG = configDePrueba({
  escalado: {
    recepcion: [{ nombre: 'Recepción', canal: 'whatsapp', destino: '+34600111111' }],
    contactos: [
      { nombre: 'Mostrador', canal: 'whatsapp', destino: '+34600222222', severidadMinima: 1 },
      { nombre: 'Dra. Ruiz', canal: 'whatsapp', destino: '+34600333333', severidadMinima: 3 },
    ],
    proteccionDeDatos: [{ nombre: 'DPD', canal: 'email', destino: 'lopd@clinica.example' }],
  },
});

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

describe('a quién va un escalado', () => {
  it('severidad 2 no despierta a quien sólo quiere las urgencias', () => {
    const destinos = destinatariosDeEscalado(CONFIG, 'queja', 2).map((d) => d.destino);

    expect(destinos).toEqual(['+34600222222']);
  });

  it('severidad 3 llega a todos', () => {
    const destinos = destinatariosDeEscalado(CONFIG, 'urgencia_clinica', 3).map((d) => d.destino);

    expect(destinos).toEqual(['+34600222222', '+34600333333']);
  });

  /**
   * **Las solicitudes de derechos NO van a recepción.** La clínica designa a
   * alguien para protección de datos y el contrato de encargo compromete el
   * traslado a esa persona; mandarlo «a los de siempre» sería incumplirlo en
   * silencio, que es la peor forma de incumplir algo con plazo legal.
   */
  it('los derechos van a protección de datos y a nadie más', () => {
    const destinos = destinatariosDeEscalado(CONFIG, 'derechos_rgpd', 3).map((d) => d.destino);

    expect(destinos).toEqual(['lopd@clinica.example']);
    expect(destinos).not.toContain('+34600222222');
  });

  /** Y los avisos de cita nunca se caen a los contactos de escalado. */
  it('recepción es recepción, no «los de siempre»', () => {
    expect(destinatariosDeRecepcion(CONFIG).map((d) => d.destino)).toEqual(['+34600111111']);
  });
});

describe('qué dice el aviso', () => {
  it('el de cita nueva lleva a quién llamar y cuándo es', () => {
    const texto = componerAviso({
      plantilla: CONFIG.avisos.citaNueva,
      config: CONFIG,
      paciente: PACIENTE,
      servicio: 'Láser axilas',
      hueco: new Date('2026-08-26T14:00:00.000Z'),
    });

    expect(texto).toContain('Rocío Llanes Vega');
    expect(texto).toContain('+34600123456');
    expect(texto).toContain('Láser axilas');
    expect(texto).toContain('16:00');
    expect(texto).toContain('miércoles');
  });

  /** El de urgencia se distingue de un vistazo, que es para lo que sirve. */
  it('la severidad 3 va marcada, y la 2 no', () => {
    const urgente = componerAviso({
      plantilla: CONFIG.avisos.escalado,
      config: CONFIG,
      paciente: PACIENTE,
      motivo: 'urgencia_clinica',
      severidad: 3,
    });
    const normal = componerAviso({
      plantilla: CONFIG.avisos.escalado,
      config: CONFIG,
      paciente: PACIENTE,
      motivo: 'queja',
      severidad: 2,
    });

    expect(urgente).toContain('ATENDER AHORA');
    expect(urgente).toContain('POSIBLE URGENCIA');
    expect(normal).not.toContain('ATENDER AHORA');
    expect(normal).toContain('Paciente molesto');
  });

  /**
   * Un escalado sin paciente —`latido_perdido` lo emite un cron— tiene que salir
   * igual. Que no haya a quién nombrar no puede impedir que el aviso llegue.
   */
  it('un escalado sin paciente no revienta', () => {
    const texto = componerAviso({
      plantilla: CONFIG.avisos.escalado,
      config: CONFIG,
      motivo: 'latido_perdido',
      severidad: 2,
    });

    expect(texto).toContain('proceso automático');
    expect(texto).toContain('Sin paciente');
  });

  it('el motivo se traduce a algo que se entiende en un móvil', () => {
    const texto = componerAviso({
      plantilla: '{motivo}',
      config: CONFIG,
      motivo: 'agenda_no_escrita',
    });

    expect(texto).toBe('No se pudo dejar la cita en la agenda');
  });

  /** La clínica puede reescribirlo entero: es su YAML (regla 7). */
  it('la clínica manda sobre el texto', () => {
    const suyo = configDePrueba({
      avisos: { citaNueva: 'NUEVA: {paciente} el {hueco}' },
    });

    const texto = componerAviso({
      plantilla: suyo.avisos.citaNueva,
      config: suyo,
      paciente: PACIENTE,
      hueco: new Date('2026-08-26T14:00:00.000Z'),
    });

    // Sin fijar el literal de la fecha: depende del ICU del sistema, y un test
    // que se rompe al actualizar Node no protege nada.
    expect(texto).toMatch(/^NUEVA: Rocío Llanes Vega el /);
    expect(texto).toContain('miércoles');
    expect(texto).toContain('16:00');
  });
});

describe('un escalado con detalle dice qué hay que aclarar', () => {
  it('el detalle va detrás del motivo, sin tocar la plantilla de la clínica', () => {
    const texto = componerAviso({
      plantilla: '{marca}{motivo} · {paciente}',
      config: configDePrueba(),
      motivo: 'historial_falso',
      detalle: 'No existe ninguna cita el lunes 12 a las 10:20: nunca llegó a reservarse.',
      severidad: 2,
    });
    expect(texto).toBe(
      'Al paciente se le dijo algo que no es verdad: No existe ninguna cita el lunes 12 a las 10:20: nunca llegó a reservarse. · Sin paciente',
    );
  });
});
