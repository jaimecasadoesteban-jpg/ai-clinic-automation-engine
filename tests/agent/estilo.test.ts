import { describe, expect, it } from 'vitest';

import { clienteConfigSchema, type ClienteConfig } from '../../src/config/cliente.js';
import { contarEmojis, contarFrases, evaluarEstilo } from '../../src/agent/estilo.js';

/**
 * La deriva a formulario.
 *
 * El agente escribía como un impreso: listas con guiones, un emoji en cada
 * mensaje, «¡Genial!» encadenados. Es lo que más se nota al leerlo como cliente,
 * y el listón es un prompt suelto sin barreras, que conversa mejor. Las barreras
 * son innegociables; la prosa robótica no es su precio.
 *
 * Esto NO bloquea en producción a propósito: escalar a un humano por un emoji de
 * más es la misma fatiga de alertas que evitamos en todo lo demás.
 */

function clinica(tono: unknown = undefined): ClienteConfig {
  return clienteConfigSchema.parse({
    slug: 'x',
    nombre: 'X',
    zonaHoraria: 'Europe/Madrid',
    canal: { tipo: 'whatsapp', remitenteId: '1' },
    agenda: { nivel: 'A', calendarioId: 'pruebas@group.calendar.google.com' },
    horario: [{ dia: 'lunes', abre: '10:00', cierra: '20:00' }],
    servicios: [{ codigo: 'a', nombre: 'A', precio: 35, duracionMinutos: 20 }],
    escalado: {
      recepcion: [{ nombre: 'Recepción', canal: 'whatsapp', destino: '+34600111111' }],
      contactos: [{ nombre: 'R', canal: 'whatsapp', destino: '+34600000000' }],
      proteccionDeDatos: [
        { nombre: 'DPD', canal: 'email', destino: 'datos@clinica.example' },
      ],
    },
    ...(tono === undefined ? {} : { tono }),
  });
}

const BASE = clinica();

describe('lo que suena a formulario se detecta', () => {
  it('la lista de precios con guiones, tal cual salió del banco', () => {
    const motivos = evaluarEstilo(
      '¡Genial! Depilación láser tenemos en varias zonas:\n- Axilas — 35 €\n' +
        '- Ingles completas — 45 €\n- Piernas enteras — 95 €\n¿Cuál te interesa? 😊',
      BASE,
    );

    expect(motivos.map((m) => m.tipo)).toContain('lista');
    expect(motivos.map((m) => m.tipo)).toContain('muletilla');
  });

  it('dos emojis en el mismo mensaje', () => {
    const motivos = evaluarEstilo('¡Hola! 😊 ¿Qué tratamiento tenías en mente? 💆‍♀️', BASE);

    expect(motivos.map((m) => m.tipo)).toContain('demasiados_emojis');
  });

  it('cinco frases seguidas', () => {
    const motivos = evaluarEstilo(
      'La sesión son 35 €. Dura unos 20 minutos. Se hace en cabina. ' +
        'Ven sin crema. ¿Te va bien?',
      BASE,
    );

    expect(motivos.map((m) => m.tipo)).toContain('demasiadas_frases');
  });

  it('negritas', () => {
    expect(evaluarEstilo('La sesión son **35 €**.', BASE).map((m) => m.tipo)).toContain('negrita');
  });

  it('los emojis de números también son emojis', () => {
    const motivos = evaluarEstilo('1️⃣ 10:00\n2️⃣ 10:20\n3️⃣ 10:40', BASE);

    expect(motivos.map((m) => m.tipo)).toContain('demasiados_emojis');
  });
});

describe('lo que escribe una recepcionista pasa', () => {
  const BUENOS = [
    '¡Hola! ¿Qué tratamiento tenías en mente?',
    'Las axilas son 35 € y son unos 20 minutos, ¿te busco hueco?',
    'Tengo el sábado 15 a las 10:00, a las 10:20 o a las 10:40, ¿cuál te viene mejor?',
    'Queda pendiente de que recepción lo confirme y te aviso 🙌',
    'Te lo apunto y te aviso en cuanto recepción lo confirme.',
  ];

  it.each(BUENOS)('no se marca: «%s»', (texto) => {
    expect(evaluarEstilo(texto, BASE)).toEqual([]);
  });

  it('enumerar los tres huecos en líneas sigue valiendo', () => {
    // La excepción explícita: enumerar huecos no es sonar a folleto, y si
    // contara como frases o como lista el detector marcaría la respuesta buena.
    expect(evaluarEstilo('¿Cuál te viene mejor?\n10:00\n10:20\n10:40', BASE)).toEqual([]);
    expect(
      evaluarEstilo(
        '¿Cuál te viene mejor?\n- sábado 15 a las 10:00\n- sábado 15 a las 10:20',
        BASE,
      ),
    ).toEqual([]);
  });

  it('«35,90 €» no son dos frases', () => {
    expect(contarFrases('La sesión son 35,90 €.')).toBe(1);
    expect(contarFrases('Son 35,90 €. ¿Te va bien?')).toBe(2);
  });

  it('«perfecto» dentro de una frase no es la muletilla', () => {
    expect(evaluarEstilo('Es el momento perfecto para empezar.', BASE)).toEqual([]);
    expect(evaluarEstilo('¡Perfecto! Te lo apunto.', BASE).map((m) => m.tipo)).toContain(
      'muletilla',
    );
  });
});

describe('los umbrales salen del YAML, no del código', () => {
  it('una clínica puede permitir listas y más frases', () => {
    const permisiva = clinica({ registro: 'formal', frasesMaximas: 6, permiteListas: true });

    const texto = 'Le detallo:\n- Axilas: 35 €\n- Ingles: 45 €\nQuedo a su disposición.';
    expect(evaluarEstilo(texto, permisiva)).toEqual([]);
    expect(evaluarEstilo(texto, BASE).length).toBeGreaterThan(0);
  });

  it('una clínica puede prohibir los emojis del todo', () => {
    const seria = clinica({ emojisMaximos: 0 });

    expect(evaluarEstilo('Hecho 🙌', seria).map((m) => m.tipo)).toContain('demasiados_emojis');
    expect(evaluarEstilo('Hecho 🙌', BASE)).toEqual([]);
  });

  it('la forma corta de siempre sigue valiendo y trae los valores sensatos', () => {
    const antigua = clinica('formal');

    expect(antigua.tono.registro).toBe('formal');
    expect(antigua.tono.frasesMaximas).toBe(2);
    expect(contarEmojis('😊 🙌')).toBe(2);
  });
});
