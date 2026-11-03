import { describe, expect, it } from 'vitest';

import { evaluarEstilo, explicarEstilo } from '../../src/agent/estilo.js';
import { textosDe } from '../../src/config/derivar.js';
import { configDePrueba } from '../support/fakes.js';

/**
 * El detector de estilo, apuntando a los textos fijos.
 *
 * Existía para vigilar lo que escribe el modelo, y resulta que **los dos
 * mensajes que peor sonaban en la primera sesión real no los escribió el
 * modelo**: eran plantillas. Una de ellas, la de retención nocturna, incumplía
 * el límite de frases de la propia clínica —tres, con un máximo de dos— y nadie
 * se enteró porque nada las miraba.
 *
 * Lo que este test NO puede hacer es juzgar el tono: mide forma. El listón sigue
 * siendo leerlo como lo escribiría la recepcionista; esto es el suelo por debajo
 * del cual no se baja.
 *
 * **Los textos del cortafuegos quedan fuera a propósito.** Son respuestas
 * clínicas aprobadas por la clínica (regla 5) y una de ellas tiene tres frases
 * porque las necesita. Meterlas aquí crearía presión para acortar un mensaje de
 * seguridad por una cuestión de estilo, que es exactamente al revés de lo que
 * importa.
 */
describe('los textos fijos pasan por el mismo listón que el modelo', () => {
  const config = configDePrueba();
  const textos = textosDe(config);
  const HUECO = new Date('2026-08-24T09:00:00.000Z'); // lunes 24, 11:00 en Madrid
  const OTRO = new Date('2026-08-24T08:00:00.000Z'); // lunes 24, 10:00
  const MANANA = new Date('2026-08-24T07:00:00.000Z');

  const FIJOS: ReadonlyArray<{ nombre: string; texto: string }> = [
    { nombre: 'retenido', texto: textos.retenido({ hueco: HUECO, servicio: 'laser-axilas', avisoDiferidoHasta: null }) },
    {
      nombre: 'retenidoDiferido',
      texto: textos.retenido({ hueco: HUECO, servicio: 'laser-axilas', avisoDiferidoHasta: MANANA }),
    },
    {
      nombre: 'reagendado',
      texto: textos.reagendado({
        nueva: HUECO,
        anterior: OTRO,
        servicio: 'laser-axilas',
        avisoDiferidoHasta: null,
      }),
    },
    {
      nombre: 'reagendadoDiferido',
      texto: textos.reagendado({
        nueva: HUECO,
        anterior: OTRO,
        servicio: 'laser-axilas',
        avisoDiferidoHasta: MANANA,
      }),
    },
    { nombre: 'confirmada', texto: textos.confirmada({ hueco: HUECO, servicio: 'laser-axilas' }) },
    {
      nombre: 'colisionConAlternativa',
      texto: textos.colisionConAlternativa({ alternativa: OTRO, servicio: 'laser-axilas' }),
    },
    { nombre: 'colisionSinAlternativa', texto: textos.colisionSinAlternativa() },
    { nombre: 'escaladoPorValidacion', texto: textos.escaladoPorValidacion() },
    { nombre: 'proveedorCaido', texto: textos.proveedorCaido() },
    { nombre: 'agendaNoDisponible', texto: textos.agendaNoDisponible() },
    { nombre: 'fueraDeServicio', texto: textos.fueraDeServicio() },
    { nombre: 'derechosEnCurso', texto: textos.derechosEnCurso() },
    { nombre: 'soloTexto', texto: textos.soloTexto('audio') },
    { nombre: 'enPausa', texto: textos.enPausa() },
    { nombre: 'sinInformacion', texto: textos.informacion('aparcamiento', null) },
    { nombre: 'preparacionSinServicio', texto: textos.informacion('preparacion', null) },
    // Los que le escribe el sistema sin que haya escrito él.
    { nombre: 'propuestaCaducada', texto: textos.propuestaCaducada({ servicio: 'laser-axilas' }) },
    { nombre: 'retencionCaducada', texto: textos.retencionCaducada({ hueco: HUECO, servicio: 'laser-axilas' }) },
    {
      nombre: 'sinRespuestaDeRecepcion',
      texto: textos.sinRespuestaDeRecepcion({ hueco: HUECO, servicio: 'laser-axilas' }),
    },
  ];

  /**
   * Todos los que anuncian una hora dicen de qué es la cita. Si el sistema se
   * equivoca de tratamiento, es lo único que le permite al paciente darse
   * cuenta antes de presentarse.
   */
  it.each([
    'retenido',
    'retenidoDiferido',
    'reagendado',
    'reagendadoDiferido',
    'confirmada',
    'colisionConAlternativa',
    'propuestaCaducada',
    'retencionCaducada',
    'sinRespuestaDeRecepcion',
  ])('«%s» nombra el tratamiento', (nombre) => {
    const fijo = FIJOS.find((f) => f.nombre === nombre);
    expect(fijo?.texto).toMatch(/láser axilas/);
  });

  it.each(FIJOS)('«$nombre» no suena a formulario', ({ texto }) => {
    const motivos = evaluarEstilo(texto, config);

    if (motivos.length > 0) {
      throw new Error(`«${texto}» → ${explicarEstilo(motivos)}`);
    }
    expect(motivos).toEqual([]);
  });

  /**
   * Los que anuncian una hora tienen que decirla. El de retención no la decía —
   * «te he guardado ese hueco», y el paciente no sabía cuál— y es el mismo fallo
   * que ya se corrigió en el de reagendado.
   */
  it.each(['retenido', 'retenidoDiferido', 'reagendado', 'reagendadoDiferido', 'confirmada'])(
    '«%s» dice la hora de la que habla',
    (nombre) => {
      const texto = FIJOS.find((f) => f.nombre === nombre)?.texto ?? '';

      expect(texto).toMatch(/\b11:00\b/);
      expect(texto).toContain('lunes');
    },
  );

  /** Ninguno puede decir que algo está confirmado antes de que lo esté. */
  it.each(['retenido', 'retenidoDiferido', 'reagendado', 'reagendadoDiferido'])(
    '«%s» no da la cita por confirmada',
    (nombre) => {
      const texto = FIJOS.find((f) => f.nombre === nombre)?.texto ?? '';

      expect(texto).not.toMatch(/\bconfirmada\b/i);
    },
  );

  /**
   * Y el nocturno no vende inseguridad. «La clínica está cerrada ahora mismo»
   * convierte en un problema lo que es el funcionamiento normal.
   */
  it('el nocturno no dice que la clínica esté cerrada', () => {
    const texto = textos.retenido({ hueco: HUECO, servicio: 'laser-axilas', avisoDiferidoHasta: MANANA });

    expect(texto).not.toMatch(/cerrad/i);
    expect(texto).toContain('recepción');
  });
});

/**
 * Una plantilla propia que anuncia una hora y se deja la hora o el tratamiento
 * no arranca. Es preferible ver el error en el primer despliegue que enterarse
 * por un paciente que fue a depilarse creyendo que iba a una limpieza.
 */
describe('una clínica no puede quitarle a sus textos la hora ni el tratamiento', () => {
  it.each([
    ['retenido', 'Te reservo el hueco del {hueco}, te aviso cuando esté.', '{servicio}'],
    ['retenido', 'Te reservo {servicio}, te aviso cuando esté.', '{hueco}'],
    ['confirmada', 'Confirmada tu cita del {hueco}.', '{servicio}'],
    ['colisionConAlternativa', 'Se ocupó; te paso al {hueco}.', '{servicio}'],
    ['reagendado', 'Te lo cambio al {nueva} y suelto el de {anterior}.', '{servicio}'],
    ['propuestaCaducada', 'Las horas de antes ya pueden haberse ocupado.', '{servicio}'],
    ['retencionCaducada', 'Tu hora de {servicio} no llegó a reservarse.', '{hueco}'],
    ['sinRespuestaDeRecepcion', 'Tu cita del {hueco} no se ha confirmado.', '{servicio}'],
  ])('«%s» sin %s no carga', (clave, texto, falta) => {
    expect(() => configDePrueba({ textos: { [clave]: texto } })).toThrow(falta);
  });

  it('con los dos marcadores, carga', () => {
    expect(() =>
      configDePrueba({ textos: { retenido: 'Te reservo {servicio} el {hueco}.' } }),
    ).not.toThrow();
  });
});

/**
 * El horario de apertura se compone desde el YAML. Pasaba por el modelo y la
 * regla de horas lo tomaba por huecos inventados: preguntar el horario acababa
 * escalado todas las veces.
 */
describe('el horario, compuesto sin modelo', () => {
  const conHorario = (horario: ReadonlyArray<{ dia: string; abre: string; cierra: string }>) =>
    textosDe(configDePrueba({ horario })).horario();

  it('agrupa los días seguidos con el mismo horario y dice cuándo cierra', () => {
    expect(
      conHorario([
        { dia: 'lunes', abre: '10:00', cierra: '20:30' },
        { dia: 'martes', abre: '10:00', cierra: '20:30' },
        { dia: 'miercoles', abre: '10:00', cierra: '20:30' },
        { dia: 'jueves', abre: '10:00', cierra: '21:00' },
        { dia: 'viernes', abre: '10:00', cierra: '21:00' },
        { dia: 'sabado', abre: '10:00', cierra: '14:00' },
      ]),
    ).toBe(
      'Abrimos de lunes a miércoles de 10:00 a 20:30, jueves y viernes de 10:00 a 21:00 y los sábados de 10:00 a 14:00. Los domingos cerramos.',
    );
  });

  it('los tramos partidos van juntos, sin que nada caiga en la hora de comer', () => {
    expect(
      conHorario([
        { dia: 'lunes', abre: '16:00', cierra: '20:00' },
        { dia: 'lunes', abre: '09:00', cierra: '14:00' },
      ]),
    ).toBe(
      'Abrimos los lunes de 09:00 a 14:00 y de 16:00 a 20:00. Los martes, los miércoles, los jueves, los viernes, los sábados y los domingos cerramos.',
    );
  });

  it('una clínica puede envolverlo en su texto, pero no quitarlo', () => {
    expect(
      textosDe(configDePrueba({ textos: { horario: 'Te cuento: {horario}' } })).horario(),
    ).toMatch(/^Te cuento: Abrimos /);
    expect(() => configDePrueba({ textos: { horario: 'Abrimos por la mañana.' } })).toThrow(
      '{horario}',
    );
  });

  it('suena como el resto de textos fijos', () => {
    const texto = textosDe(configDePrueba()).horario();
    expect(evaluarEstilo(texto, configDePrueba())).toEqual([]);
  });
});

/**
 * Los datos prácticos de la clínica se dicen tal cual los escribió la clínica,
 * sin modelo. Sin ellos el modelo inventaba aparcamiento, formas de pago y
 * preparación previa, y nada de eso lo puede comprobar ninguna regla.
 */
describe('la información de la clínica, compuesta sin modelo', () => {
  const config = configDePrueba({
    informacion: {
      direccion: 'Calle Mayor 1.',
      aparcamiento: 'Parking público enfrente.',
      formasDePago: 'Tarjeta y Bizum.',
      cancelacion: 'Avisa con 24 horas.',
      primeraVisita: 'Valoración breve sin coste.',
    },
    servicios: [
      {
        codigo: 'laser-axilas',
        nombre: 'Láser axilas',
        precio: 39.9,
        duracionMinutos: 20,
        preparacion: 'Ven rasurada.',
      },
      { codigo: 'laser-piernas', nombre: 'Láser piernas', precio: 89, duracionMinutos: 45 },
    ],
  });
  const textos = textosDe(config);

  it.each([
    ['direccion', 'Calle Mayor 1.'],
    ['aparcamiento', 'Parking público enfrente.'],
    ['pago', 'Tarjeta y Bizum.'],
    ['cancelacion', 'Avisa con 24 horas.'],
    ['primera_visita', 'Valoración breve sin coste.'],
  ] as const)('«%s» dice el texto de la clínica, tal cual', (tema, texto) => {
    expect(textos.informacion(tema, null)).toBe(texto);
  });

  it('la preparación es la del tratamiento de la conversación', () => {
    expect(textos.informacion('preparacion', 'laser-axilas')).toBe('Ven rasurada.');
  });

  it('un tratamiento sin preparación escrita remite a recepción, no improvisa', () => {
    expect(textos.informacion('preparacion', 'laser-piernas')).toMatch(/recepción/);
  });

  it('sin saber el tratamiento, pregunta cuál: la preparación de otro sería falsa', () => {
    expect(textos.informacion('preparacion', null)).toMatch(/\?/);
  });

  it('un dato que la clínica no ha puesto remite a recepción', () => {
    expect(textosDe(configDePrueba()).informacion('direccion', null)).toMatch(/recepción/);
  });

  it('una errata en la sección no carga, como en el resto del YAML', () => {
    expect(() => configDePrueba({ informacion: { direcion: 'Calle Mayor 1.' } })).toThrow();
  });
});

/**
 * Los que le escribe el sistema sin que él haya escrito. Ni reproches ni
 * compromisos que no existen: una propuesta no estaba reservada, y una cita sin
 * confirmar no se da por hecha.
 */
describe('lo que el sistema escribe por su cuenta', () => {
  const textos = textosDe(configDePrueba());
  const HUECO = new Date('2026-08-24T09:00:00.000Z');

  it('no le reprocha que no contestara', () => {
    for (const texto of [
      textos.propuestaCaducada({ servicio: 'laser-axilas' }),
      textos.retencionCaducada({ hueco: HUECO, servicio: 'laser-axilas' }),
      textos.sinRespuestaDeRecepcion({ hueco: HUECO, servicio: 'laser-axilas' }),
    ]) {
      expect(texto).not.toMatch(/no (me )?(contestaste|respondiste|has contestado|has respondido)/i);
    }
  });

  it('la propuesta caducada no dice que se le guardara nada', () => {
    expect(textos.propuestaCaducada({ servicio: 'laser-axilas' })).not.toMatch(/guard|reserv|apunt/i);
  });

  it('la cita sin confirmar no se da por confirmada', () => {
    expect(textos.sinRespuestaDeRecepcion({ hueco: HUECO, servicio: 'laser-axilas' })).not.toMatch(
      /\bconfirmada\b|te esperamos/i,
    );
  });
});
