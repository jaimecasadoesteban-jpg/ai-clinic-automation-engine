import { describe, expect, it } from 'vitest';

import { huecosProponibles, type Intervalo } from '../../src/core/disponibilidad.js';
import { clienteConfigSchema, type ClienteConfig } from '../../src/config/cliente.js';

/**
 * Qué huecos son proponibles. Es regla de negocio y por eso vive en el núcleo,
 * con tests, y no en un lienzo visual de n8n (principio 2).
 *
 * Verificado por sabotaje: quitando el filtro de horario, el sistema propone
 * domingos en una clínica que cierra los domingos.
 */

/** Lunes a viernes con tramo partido; sábado sólo por la mañana; domingo cerrado. */
function clinica(extra: Record<string, unknown> = {}): ClienteConfig {
  return clienteConfigSchema.parse({
    slug: 'x',
    nombre: 'X',
    zonaHoraria: 'Europe/Madrid',
    canal: { tipo: 'whatsapp', remitenteId: '1' },
    agenda: { nivel: 'A', calendarioId: 'pruebas@group.calendar.google.com' },
    horario: [
      { dia: 'lunes', abre: '10:00', cierra: '14:00' },
      { dia: 'lunes', abre: '16:00', cierra: '20:00' },
      { dia: 'martes', abre: '10:00', cierra: '14:00' },
      { dia: 'martes', abre: '16:00', cierra: '20:00' },
      { dia: 'sabado', abre: '10:00', cierra: '13:00' },
    ],
    servicios: [
      { codigo: 'corto', nombre: 'Corto', precio: 30, duracionMinutos: 30 },
      { codigo: 'largo', nombre: 'Largo', precio: 90, duracionMinutos: 90 },
    ],
    escalado: {
      recepcion: [{ nombre: 'Recepción', canal: 'whatsapp', destino: '+34600111111' }],
      contactos: [{ nombre: 'R', canal: 'whatsapp', destino: '+34600000000' }],
      proteccionDeDatos: [
        { nombre: 'DPD', canal: 'email', destino: 'datos@clinica.example' },
      ],
    },
    ...extra,
  });
}

const CONFIG = clinica();
const CORTO = CONFIG.servicios[0]!;
const LARGO = CONFIG.servicios[1]!;

/** Viernes 11 de septiembre de 2026, 12:00 en Madrid. */
const AHORA = new Date('2026-09-11T10:00:00.000Z');

function generar(
  servicio = CORTO,
  ocupacion: readonly Intervalo[] = [],
  config = CONFIG,
): Intervalo[] {
  return huecosProponibles({ config, servicio, ahora: AHORA, ocupacion, dias: 10 });
}

function partes(fecha: Date): { dia: string; hora: string } {
  const dtf = new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const p = Object.fromEntries(dtf.formatToParts(fecha).map((x) => [x.type, x.value]));
  return { dia: String(p['weekday']), hora: `${String(p['hour'])}:${String(p['minute'])}` };
}

describe('días de cierre', () => {
  it('no propone NUNCA un domingo en una clínica que cierra los domingos', () => {
    const dias = generar().map((h) => partes(h.inicio).dia);

    // Éste es el fallo que el banco de pruebas dejó a la vista: la agenda
    // simulada devolvía huecos en domingo porque nadie aplicaba el horario.
    expect(dias).not.toContain('domingo');
  });

  it('tampoco propone los días sin tramos: miércoles, jueves y viernes', () => {
    const dias = new Set(generar().map((h) => partes(h.inicio).dia));

    expect([...dias].sort()).toEqual(['lunes', 'martes', 'sábado']);
  });
});

describe('tramos partidos', () => {
  it('ningún hueco cae en la hora de comer', () => {
    const enComida = generar().filter((h) => {
      const { hora } = partes(h.inicio);
      return hora >= '14:00' && hora < '16:00';
    });

    expect(enComida).toEqual([]);
  });

  it('sí hay huecos en los dos tramos del mismo día', () => {
    const lunes = generar().filter((h) => partes(h.inicio).dia === 'lunes');
    const horas = lunes.map((h) => partes(h.inicio).hora);

    expect(horas).toContain('10:00');
    expect(horas).toContain('16:00');
  });
});

describe('antelación mínima', () => {
  it('en nivel A no se propone nada dentro de las próximas 24 h', () => {
    const limite = new Date(AHORA.getTime() + 24 * 3_600_000);
    const demasiadoPronto = generar().filter((h) => h.inicio < limite);

    expect(demasiadoPronto).toEqual([]);
  });

  it('en nivel B sí se puede proponer para hoy mismo', () => {
    // Sábado 12: en nivel A queda fuera por las 24 h; en B, no.
    const nivelB = clinica({ agenda: { nivel: 'B', calendarioId: 'pruebas@group.calendar.google.com' } });
    const limite = new Date(AHORA.getTime() + 24 * 3_600_000);

    const enA = generar(CORTO, [], CONFIG).filter((h) => h.inicio < limite);
    const enB = generar(CORTO, [], nivelB).filter((h) => h.inicio < limite);

    expect(enA).toEqual([]);
    expect(enB.length).toBeGreaterThan(0);
  });
});

describe('duración del servicio', () => {
  it('el hueco tiene que caber ENTERO antes del cierre', () => {
    // El sábado cierra a las 13:00. Un servicio de 90 minutos sólo cabe a las
    // 10:00 y a las 11:30 — a las 11:30 termina justo al cierre.
    const sabado = generar(LARGO).filter((h) => partes(h.inicio).dia === 'sábado');

    expect(sabado.map((h) => partes(h.inicio).hora)).toEqual(['10:00', '11:30']);
    for (const hueco of sabado) {
      expect(partes(hueco.fin).hora <= '13:00').toBe(true);
    }
  });

  it('un servicio que no cabe en un tramo no genera huecos en él', () => {
    const soloCorto = clinica({
      horario: [{ dia: 'lunes', abre: '10:00', cierra: '11:00' }],
    });
    // 90 minutos no caben en un tramo de una hora.
    expect(generar(LARGO, [], soloCorto)).toEqual([]);
    expect(generar(CORTO, [], soloCorto).length).toBeGreaterThan(0);
  });
});

describe('ocupación', () => {
  it('descarta lo que solapa, aunque solape un solo minuto', () => {
    const sinOcupar = generar();
    const primero = sinOcupar[0]!;

    const conOcupacion = generar(CORTO, [
      {
        inicio: new Date(primero.inicio.getTime() + 29 * 60_000),
        fin: new Date(primero.inicio.getTime() + 31 * 60_000),
      },
    ]);

    expect(conOcupacion.map((h) => h.inicio.getTime())).not.toContain(primero.inicio.getTime());
    // Y sólo se pierde ése y el siguiente, no la agenda entera.
    expect(conOcupacion.length).toBeGreaterThan(sinOcupar.length - 3);
  });

  it('una ocupación que cubre todo el día lo deja sin huecos', () => {
    const lunes = generar().filter((h) => partes(h.inicio).dia === 'lunes');
    const primero = lunes[0]!;
    const finDelDia = new Date(primero.inicio.getTime() + 12 * 3_600_000);

    const conOcupacion = generar(CORTO, [{ inicio: primero.inicio, fin: finDelDia }]);
    const lunesTras = conOcupacion.filter(
      (h) => partes(h.inicio).dia === 'lunes' && h.inicio >= primero.inicio && h.inicio < finDelDia,
    );

    expect(lunesTras).toEqual([]);
  });
});

describe('orden', () => {
  it('los huecos salen de más próximo a más lejano', () => {
    const huecos = generar();
    const tiempos = huecos.map((h) => h.inicio.getTime());

    expect(tiempos).toEqual([...tiempos].sort((a, b) => a - b));
  });
});
