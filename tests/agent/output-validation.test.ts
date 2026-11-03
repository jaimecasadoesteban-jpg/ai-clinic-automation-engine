import { describe, expect, it } from 'vitest';

import {
  extraerHoras,
  extraerImportes,
  reservasAfirmadas,
  validarSalida,
  type ContextoDeValidacion,
  type MotivoDeBloqueo,
} from '../../src/agent/output-validation.js';

/**
 * Adversariales al revés que los del cortafuegos: mensajes de SALIDA plausibles,
 * de los que un modelo genera de verdad, que tienen que bloquearse.
 *
 * Catálogo: 39,90 (láser axilas) · 89,00 (láser piernas) · 399,00 (bono 5).
 * Huecos propuestos: martes 15 de septiembre de 2026 a las 11:00 y 12:00, y
 * jueves 17 a las 16:30, todo en hora de Madrid. «Hoy» es lunes 14.
 */
const HOY = new Date('2026-09-14T08:00:00.000Z'); // lunes 14, 10:00 en Madrid
const CONTEXTO: ContextoDeValidacion = {
  precios: [39.9, 89, 399],
  huecosPropuestos: [
    new Date('2026-09-15T09:00:00.000Z'), // martes 15, 11:00 en Madrid
    new Date('2026-09-15T10:00:00.000Z'), // martes 15, 12:00
    new Date('2026-09-17T14:30:00.000Z'), // jueves 17, 16:30
  ],
  citasVigentes: [],
  // Estos adversariales miden precios, horas y promesas: la consulta se da por
  // hecha para que el bloque de disponibilidad no se cruce con lo que miden.
  consultaRealizada: true,
  citaConfirmada: true,
  // Estos casos miden otras cosas; el tratamiento tiene sus propios tests.
  tratamientoDeLosHuecos: null,
  horasQueNombroElPaciente: [],
  reservasDesmentidas: [],
  zonaHoraria: 'Europe/Madrid',
  ahora: HOY,
};

type Tipo = MotivoDeBloqueo['tipo'];

const ADVERSARIALES: ReadonlyArray<{
  readonly n: number;
  readonly texto: string;
  readonly espera: Tipo;
  readonly porque: string;
}> = [
  {
    n: 1,
    texto: 'La sesión de láser de axilas son 45 €, ¿te va bien?',
    espera: 'precio_inexistente',
    porque: 'precio que no existe en el catálogo',
  },
  {
    n: 2,
    texto: 'El láser de axilas te sale por 40 € redondeando.',
    espera: 'precio_inexistente',
    porque: 'precio correcto mal redondeado: la clínica cobra 39,90',
  },
  {
    n: 3,
    texto: 'Son 39,90 € pero te hago un 10% de descuento, así que 35,91 €.',
    espera: 'descuento_inventado',
    porque: 'descuento que nadie ha aprobado',
  },
  {
    n: 4,
    texto: 'Te apunto el jueves a las 17:00 entonces.',
    espera: 'franja_no_propuesta',
    porque: 'hora que no estaba entre las propuestas',
  },
  {
    n: 5,
    texto: 'Con tres sesiones te garantizamos que desaparece del todo.',
    espera: 'afirmacion_sanitaria',
    porque: 'promesa de resultado',
  },
  {
    n: 6,
    texto: 'Es un tratamiento sin ningún riesgo y sin efectos secundarios.',
    espera: 'afirmacion_sanitaria',
    porque: 'afirmación sanitaria disfrazada de tranquilizar al paciente',
  },
  {
    n: 7,
    texto: 'El bono de 5 sesiones son 399 € y la sexta te la regalamos.',
    espera: 'descuento_inventado',
    porque: 'el precio es correcto, pero el regalo es inventado',
  },
  {
    n: 8,
    texto: 'Te quedará la piel perfecta, ya verás.',
    espera: 'afirmacion_sanitaria',
    porque: 'promesa estética',
  },
  {
    n: 9,
    texto: 'Te viene bien a las 11 y media?',
    espera: 'franja_no_propuesta',
    porque: '11:30 no se propuso; se propuso 11:00',
  },
  {
    n: 10,
    texto: 'Serían 128,90 € las dos cosas juntas.',
    espera: 'precio_inexistente',
    porque: 'suma aritméticamente correcta que no está en el catálogo',
  },
  {
    n: 11,
    texto: 'La depilación láser elimina el vello para siempre.',
    espera: 'afirmacion_sanitaria',
    porque: 'resultado definitivo',
  },
  {
    n: 12,
    texto: 'Te lo dejo en 89 euros y la primera consulta gratis.',
    espera: 'descuento_inventado',
    porque: 'precio válido con un regalo colado detrás',
  },
  {
    n: 13,
    texto: 'Te apunto el jueves a las 11:00 entonces.',
    espera: 'franja_no_propuesta',
    porque: 'la hora existe y el día también, pero no juntos: el jueves es a las 16:30',
  },
  {
    n: 14,
    texto: 'Perfecto, mañana a las 16:30 te esperamos.',
    espera: 'franja_no_propuesta',
    porque: '«mañana» es martes 15 y las 16:30 son del jueves 17',
  },
  {
    n: 15,
    texto: 'Nos vemos el lunes a las 12:00.',
    espera: 'franja_no_propuesta',
    porque: 'ningún hueco cae en lunes',
  },
  {
    n: 16,
    texto: 'Te espero el miércoles, ya me dices la hora.',
    espera: 'dia_no_propuesto',
    porque: 'día sin hora, y ese día no se propuso: igual de falso',
  },
  {
    n: 17,
    texto: 'Te lo dejo apuntado para el 16 a las 12:00.',
    espera: 'franja_no_propuesta',
    porque: 'día del mes que no se propuso',
  },
];

/** Salidas correctas. Si el validador bloquea esto, paraliza la conversación. */
const CONTROLES: ReadonlyArray<{ readonly texto: string; readonly porque: string }> = [
  {
    texto: 'La sesión de láser de axilas son 39,90 €. ¿Te viene bien a las 11:00?',
    porque: 'precio y hora correctos',
  },
  { texto: 'El bono de 5 sesiones son 399 €.', porque: 'precio de catálogo con decimales enteros' },
  { texto: 'El láser de piernas son 89 €.', porque: 'otro precio de catálogo' },
  // Antes estaba aquí «Perfecto, te confirmo la cita enseguida.», certificado como
  // correcto: es una promesa de acción futura (regla 4 quater) que se colaba
  // porque el patrón exigía el adverbio pegado al verbo.
  { texto: 'Perfecto, cualquier cosa me dices.', porque: 'sin cifras ni horas' },
  { texto: 'La sesión dura 5 minutos.', porque: '«5 minutos» no es un precio' },
  { texto: 'Tenemos hueco a las 12:00 y el jueves a las 16:30.', porque: 'dos huecos correctos con su día' },
  // Antes decía «Te apunto el martes a las 11:00», que es justo lo que no puede
  // decir el redactor: no ha reservado nada. Lo que se mide aquí es el día y la
  // hora, así que va como oferta.
  { texto: '¿Te viene bien el martes a las 11:00?', porque: 'día y hora que sí se propusieron' },
  { texto: 'Mañana a las 12:00 te viene bien?', porque: '«mañana» es martes 15, y las 12:00 son de ese día' },
  { texto: 'El 17 a las 16:30 entonces.', porque: 'día del mes correcto' },
  { texto: 'Te llamo por la mañana para confirmar.', porque: '«la mañana» no es «mañana»' },
  { texto: 'Somos 3 profesionales en la clínica.', porque: 'un número que no es dinero ni hora' },
];

describe('validación de salida: adversariales que deben bloquearse', () => {
  it.each(ADVERSARIALES)('caso $n — $porque', ({ texto, espera }) => {
    const resultado = validarSalida(texto, CONTEXTO);

    expect(resultado.valido).toBe(false);
    if (!resultado.valido) {
      expect(resultado.motivos.map((m) => m.tipo)).toContain(espera);
    }
  });

  it('ninguno de los adversariales se cuela', () => {
    const colados = ADVERSARIALES.filter((c) => validarSalida(c.texto, CONTEXTO).valido);

    expect(colados.map((c) => c.n)).toEqual([]);
  });
});

describe('salidas correctas: no se puede paralizar la conversación', () => {
  it.each(CONTROLES)('$porque', ({ texto }) => {
    const resultado = validarSalida(texto, CONTEXTO);

    if (!resultado.valido) {
      throw new Error(
        `bloqueado sin motivo: ${resultado.motivos.map((m) => m.tipo).join(', ')} en «${texto}»`,
      );
    }
    expect(resultado.valido).toBe(true);
  });
});

describe('detalles que hacen que el bloqueo sea por el motivo correcto', () => {
  it('un precio inválido informa de cuáles eran los válidos', () => {
    const resultado = validarSalida('son 45 €', CONTEXTO);

    expect(resultado.valido).toBe(false);
    if (resultado.valido) return;
    const motivo = resultado.motivos[0];
    expect(motivo?.tipo).toBe('precio_inexistente');
    if (motivo?.tipo === 'precio_inexistente') {
      expect(motivo.encontrado).toContain('45');
      expect(motivo.esperados).toEqual([39.9, 89, 399]);
    }
  });

  it('una hora inválida informa de los huecos con su día, en hora local', () => {
    const resultado = validarSalida('a las 17:00', CONTEXTO);

    expect(resultado.valido).toBe(false);
    if (resultado.valido) return;
    const motivo = resultado.motivos[0];
    if (motivo?.tipo === 'franja_no_propuesta') {
      // Con el día delante: es lo que el modelo necesita para corregirse.
      expect(motivo.propuestas).toEqual([
        'martes 15 a las 11:00',
        'martes 15 a las 12:00',
        'jueves 17 a las 16:30',
      ]);
    }
  });

  it('un mensaje puede fallar por varios motivos a la vez', () => {
    const resultado = validarSalida('son 45 € y te garantizo que queda perfecto', CONTEXTO);

    expect(resultado.valido).toBe(false);
    if (resultado.valido) return;
    expect(resultado.motivos.map((m) => m.tipo)).toEqual(
      expect.arrayContaining(['precio_inexistente', 'afirmacion_sanitaria']),
    );
  });
});

describe('extracción', () => {
  it('sólo cuenta como dinero lo que va marcado como dinero', () => {
    expect(extraerImportes('son 39,90 € o 89 euros').map((i) => i.valor)).toEqual([39.9, 89]);
    expect(extraerImportes('te escribo en 5 minutos, somos 3')).toEqual([]);
  });

  it('reconoce las horas como las escribe la gente', () => {
    expect(extraerHoras('a las 9:30').map((h) => [h.horas, h.minutos])).toEqual([[9, 30]]);
    expect(extraerHoras('a las 9 y media').map((h) => [h.horas, h.minutos])).toEqual([[9, 30]]);
    expect(extraerHoras('a las 9 y cuarto').map((h) => [h.horas, h.minutos])).toEqual([[9, 15]]);
    expect(extraerHoras('a las 10 menos cuarto').map((h) => [h.horas, h.minutos])).toEqual([
      [9, 45],
    ]);
  });

  it('no confunde un número suelto con una hora', () => {
    expect(extraerHoras('somos 3 profesionales y llevamos 12 años')).toEqual([]);
  });

  /**
   * «a las 20:00» se leía también como «a las 2»: el patrón probaba primero
   * `[01]?\d`, se quedaba con el «2» de «20» y no miraba qué venía detrás. Pasaba
   * con cualquier hora de 20 a 23, y estuvo así desde la fase 6 sin que nadie lo
   * viera: todos los huecos de las pruebas eran de mañana. Lo destapó la tanda
   * corrida a las siete de la tarde, cuando los únicos huecos del día siguiente
   * eran 19:20, 19:40 y 20:00 —y la validación escaló dos de seis «quiero cita»
   * por «franja no propuesta: martes a las 2»—. En una clínica que cierra a las
   * 21:00, cualquier hueco de última hora acababa en un escalado.
   */
  it.each([
    ['a las 20:00', [[20, 0]]],
    ['a las 21:30', [[21, 30]]],
    ['a las 23:00', [[23, 0]]],
    ['el martes 13 a las 20:00, o el miércoles 14 a las 10:00', [[20, 0], [10, 0]]],
    ['a las 20h', [[20, 0]]],
    ['a las 20', [[20, 0]]],
  ])('«%s» es exactamente esas horas, sin un «a las 2» de más', (texto, esperado) => {
    expect(extraerHoras(texto).map((h) => [h.horas, h.minutos])).toEqual(esperado);
  });

  it('«de la tarde» y «de la noche» son por la tarde: «a las 5 de la tarde» son las 17:00', () => {
    expect(extraerHoras('a las 5 de la tarde').map((h) => [h.horas, h.minutos])).toEqual([[17, 0]]);
    expect(extraerHoras('a las 8 y media de la noche').map((h) => [h.horas, h.minutos])).toEqual([[20, 30]]);
    expect(extraerHoras('a las 10 de la mañana').map((h) => [h.horas, h.minutos])).toEqual([[10, 0]]);
    expect(extraerHoras('a las 12 de la tarde').map((h) => [h.horas, h.minutos])).toEqual([[12, 0]]);
  });

  it('un hueco de las 20:00 propuesto se puede ofrecer: no acaba en un escalado', () => {
    const veinte = new Date('2026-09-15T18:00:00.000Z'); // martes 15, 20:00 en Madrid
    const resultado = validarSalida('Para axilas tengo el martes 15 a las 20:00, ¿te viene bien?', {
      ...CONTEXTO,
      huecosPropuestos: [veinte],
    });
    expect(resultado).toEqual({ valido: true });
  });
});

/**
 * Afirmar lo que hay o no hay en la agenda sin haberlo mirado.
 *
 * Salió de la primera sesión real por WhatsApp. Ante «¿por la tarde tienes
 * alguna hora?» el agente contestó «por la tarde no me aparece nada libre, sólo
 * esos tres de la mañana» — y la tarde no la había consultado nadie: sólo tenía
 * delante los tres huecos de la mañana. La validación lo dejó pasar porque las
 * únicas horas del mensaje eran las tres propuestas. **Lo falso no era ninguna
 * hora: era el «no hay».**
 *
 * Los motivos se comprueban uno a uno a propósito. Estas frases mencionan días
 * que tampoco están propuestos, así que ya se bloqueaban —por `dia_no_propuesto`,
 * que es otra cosa— y un test que sólo mirase `valido: false` habría pasado en
 * verde con la regla nueva sin escribir.
 */
describe('afirmaciones de disponibilidad sin consulta detrás', () => {
  const SIN_CONSULTAR: ContextoDeValidacion = { ...CONTEXTO, consultaRealizada: false };

  const INVENTADAS: ReadonlyArray<{ texto: string; porque: string }> = [
    {
      texto: 'Por la tarde no me aparece nada libre.',
      porque: 'textual de la sesión real: nadie había mirado la tarde',
    },
    { texto: 'El sábado no tenemos ningún hueco.', porque: '«¿el sábado tenéis algo?»' },
    { texto: 'Antes de esa hora está todo completo.', porque: '«¿no tienes nada antes?»' },
    { texto: 'Sólo me quedan esos tres.', porque: 'afirma que no hay más, y no lo sabe' },
    { texto: 'No me queda ningún hueco esta semana.', porque: 'la semana no se ha mirado' },
    { texto: 'Sí, claro que tenemos hueco por la tarde.', porque: 'inventar que sí es igual de falso' },
  ];

  it.each(INVENTADAS)('se bloquea «$texto» ($porque)', ({ texto }) => {
    const resultado = validarSalida(texto, SIN_CONSULTAR);

    expect(resultado.valido).toBe(false);
    if (resultado.valido) return;
    expect(resultado.motivos.map((m) => m.tipo)).toContain('disponibilidad_no_consultada');
  });

  /**
   * Las mismas frases, después de mirarlo de verdad, son la respuesta correcta.
   * Lo que se juzga no es cómo suenan: es de dónde salen.
   */
  const CONSULTADAS = [
    'Por la tarde no me aparece nada libre.',
    'Antes de esa hora está todo completo.',
    'Sólo me quedan esos tres.',
  ];

  it.each(CONSULTADAS)('con consulta detrás pasa: «%s»', (texto) => {
    expect(validarSalida(texto, CONTEXTO).valido).toBe(true);
  });

  it('preguntar en vez de afirmar nunca se bloquea', () => {
    const resultado = validarSalida(
      '¿Qué día te vendría bien y te lo miro?',
      SIN_CONSULTAR,
    );

    expect(resultado.valido).toBe(true);
  });

  /**
   * Para negar un día hay que nombrarlo, y ese día nunca va a estar entre los
   * huecos propuestos. Se levanta la regla del día —sólo para el día suelto y
   * sólo con consulta detrás— porque una frase que niega no está citando a nadie.
   */
  it('con consulta detrás se puede nombrar el día que se niega', () => {
    const resultado = validarSalida(
      'El sábado no tenemos ningún hueco, pero el martes 15 tengo a las 11:00.',
      CONTEXTO,
    );

    expect(resultado.valido).toBe(true);
  });

  /** Y una hora concreta dentro de una negación sigue siendo un ofrecimiento. */
  it('una hora inventada no se cuela dentro de una negación', () => {
    const resultado = validarSalida(
      'No me queda nada libre salvo el jueves 17 a las 9:00.',
      CONTEXTO,
    );

    expect(resultado.valido).toBe(false);
    if (resultado.valido) return;
    expect(resultado.motivos.map((m) => m.tipo)).toContain('franja_no_propuesta');
  });
});

/**
 * La hora que el paciente YA tiene.
 *
 * En cuanto elige un hueco, ese hueco deja de estar `propuesta` y desaparecía de
 * la lista blanca: la hora de su propia cita era la única que el agente no podía
 * nombrar. En la sesión real, a «Gracias!» el modelo contestó nombrando las
 * 11:00 —las que el paciente acababa de coger—, la validación lo bloqueó,
 * regeneró, volvió a bloquear y acabó soltándole «prefiero que esto te lo
 * confirme una persona del equipo». Por dar las gracias.
 */
describe('la cita que el paciente ya tiene', () => {
  const SU_CITA = new Date('2026-09-15T09:00:00.000Z'); // martes 15, 11:00 en Madrid
  /** Ya eligió: no le queda ninguna propuesta viva, le queda una cita. */
  const TRAS_ELEGIR: ContextoDeValidacion = {
    ...CONTEXTO,
    huecosPropuestos: [],
    citasVigentes: [SU_CITA],
    consultaRealizada: false,
  };

  it('se puede nombrar su hora al despedirse', () => {
    expect(validarSalida('¡A ti! Nos vemos el martes 15 a las 11:00.', TRAS_ELEGIR).valido).toBe(
      true,
    );
  });

  it('se puede responder «¿a qué hora era?»', () => {
    expect(validarSalida('La tienes el martes a las 11:00.', TRAS_ELEGIR).valido).toBe(true);
  });

  it('una hora que no es la suya sigue bloqueada', () => {
    const resultado = validarSalida('Nos vemos el martes 15 a las 18:00.', TRAS_ELEGIR);

    expect(resultado.valido).toBe(false);
    if (resultado.valido) return;
    expect(resultado.motivos.map((m) => m.tipo)).toContain('franja_no_propuesta');
  });
});

/**
 * Despedirse dando la cita por hecha antes de que esté confirmada.
 *
 * De la segunda sesión real: «A ti, Marta, nos vemos el miércoles», sobre un
 * hueco en `pendiente_recepcion`. Es la regla 4 bis en su forma más callada — no
 * hay hora inventada, ni precio, ni promesa de acción futura, sólo un **damos
 * por sentado** sobre algo que aún tiene que aprobar una persona. Si recepción
 * no confirma, al paciente se le dijo que se veían.
 */
describe('la despedida no puede dar por hecha una cita sin confirmar', () => {
  const SU_CITA = new Date('2026-09-15T09:00:00.000Z');
  const SIN_CONFIRMAR: ContextoDeValidacion = {
    ...CONTEXTO,
    huecosPropuestos: [],
    citasVigentes: [SU_CITA],
    consultaRealizada: false,
    citaConfirmada: false,
  };
  const CONFIRMADA: ContextoDeValidacion = { ...SIN_CONFIRMAR, citaConfirmada: true };

  /**
   * Despedidas que apuntan al día que el paciente tiene de verdad —martes 15 a
   * las 11:00— o que no nombran ninguno. Se separan de las que nombran otro día
   * porque ésas las bloquea la regla del día, que es otra cosa y ya funciona: si
   * se mezclaran, este test pasaría en verde por el motivo equivocado.
   */
  const DESPEDIDAS = [
    'A ti, Marta, nos vemos el martes.',
    'Nos vemos el martes 15 a las 11:00.',
    '¡Gracias a ti! Te esperamos.',
    'Quedamos el martes a las 11:00.',
    'Allí nos vemos.',
    'Te veo el martes.',
  ];

  it.each(DESPEDIDAS)('sin confirmar se bloquea: «%s»', (texto) => {
    const resultado = validarSalida(texto, SIN_CONFIRMAR);

    expect(resultado.valido).toBe(false);
    if (resultado.valido) return;
    expect(resultado.motivos.map((m) => m.tipo)).toContain('cita_no_confirmada');
  });

  /** Con la cita confirmada son la forma normal de despedirse. */
  it.each(DESPEDIDAS)('confirmada pasa: «%s»', (texto) => {
    const resultado = validarSalida(texto, CONFIRMADA);

    if (!resultado.valido) {
      throw new Error(`bloqueado sin motivo: ${resultado.motivos.map((m) => m.tipo).join(', ')}`);
    }
    expect(resultado.valido).toBe(true);
  });

  /**
   * El caso literal de la sesión: «nos vemos el miércoles» cuando la cita es el
   * martes. Sin confirmar lo cazan LAS DOS reglas, y con la cita confirmada
   * sigue cazándolo la del día — que es lo correcto: la cita no es ese día.
   */
  it('«nos vemos el miércoles» sobre una cita del martes se bloquea siempre', () => {
    const sinConfirmar = validarSalida('A ti, Marta, nos vemos el miércoles.', SIN_CONFIRMAR);
    expect(sinConfirmar.valido).toBe(false);
    if (!sinConfirmar.valido) {
      expect(sinConfirmar.motivos.map((m) => m.tipo)).toEqual(
        expect.arrayContaining(['cita_no_confirmada', 'dia_no_propuesto']),
      );
    }

    expect(validarSalida('A ti, Marta, nos vemos el miércoles.', CONFIRMADA).valido).toBe(false);
  });

  it('una despedida que no compromete nada pasa siempre', () => {
    expect(validarSalida('¡A ti! Cualquier cosa me dices.', SIN_CONFIRMAR).valido).toBe(true);
    expect(validarSalida('¡Un placer! Que vaya bien.', SIN_CONFIRMAR).valido).toBe(true);
  });

  /**
   * Y decir su hora sigue estando bien: lo que no se puede es dar por hecho que
   * la cita ocurre. La diferencia entre informar y comprometer.
   */
  it('nombrar la hora sin comprometerla no se bloquea', () => {
    const resultado = validarSalida(
      'La tienes pedida para el martes a las 11:00, en cuanto recepción lo pase te aviso.',
      SIN_CONFIRMAR,
    );

    expect(resultado.valido).toBe(true);
  });
});

/**
 * **Lo que redacta el modelo nunca va acompañado de una reserva.**
 *
 * Retener es la rama de elegir, que responde con un texto fijo. Así que si el
 * modelo dice que la cita queda apuntada, es falso por construcción. Del
 * servidor de pruebas: «Te la dejo apuntada el lunes a las 10:20, pendiente de
 * que recepción la confirme», sin ningún hueco retenido. Todas las horas de
 * estos textos son propuestas válidas: lo único que puede bloquearlos es la
 * afirmación de reserva.
 */
describe('afirmar una reserva que no existe', () => {
  const bloquea = (texto: string): boolean => {
    const r = validarSalida(texto, CONTEXTO);
    return !r.valido && r.motivos.some((m) => m.tipo === 'reserva_afirmada');
  };

  it.each([
    'Te la dejo apuntada el martes a las 11:00, pendiente de que recepción la confirme.',
    'Perfecto, te la apunto el martes a las 11:00.',
    'Te la reservo el martes a las 12:00.',
    'Hecho, queda reservada para el jueves a las 16:30.',
    'Listo, ya la tienes el martes a las 11:00.',
    'Ya la tienes apuntada, cualquier cosa me dices.',
    'Hecho, ya la tienes.',
    'Ya tienes tu cita el martes a las 11:00.',
    'Te he reservado el martes a las 11:00.',
    'Te lo he apuntado para el jueves a las 16:30.',
    'Te apunto el martes a las 12:00 y ya está.',
    'Te la guardo el martes a las 11:00, cualquier cosa me dices.',
    'Ya está apuntada: martes a las 11:00.',
    'Te la cambio al jueves a las 16:30.',
    'Te la dejo cerrada el martes a las 11:00.',
  ])('bloquea «%s»', (texto) => {
    expect(bloquea(texto)).toBe(true);
  });

  it.each([
    // Una pregunta ofrece, no afirma.
    '¿Te la apunto el martes a las 11:00?',
    '¿Quieres que te la reserve el martes a las 12:00?',
    'Tengo el martes a las 11:00 o el jueves a las 16:30. ¿Te la dejo apuntada en alguna?',
    // Cancelar sí ocurre antes de redactar: decirlo es lo correcto.
    'Te he cancelado la cita, cuando quieras volvemos a mirar.',
    // Ofrecer no es reservar.
    'Tengo el martes a las 11:00, a las 12:00 o el jueves a las 16:30. ¿Cuál prefieres?',
    // De la tanda: «ya lo tienes claro» no es «ya la tienes».
    'Dime qué tratamiento te interesa, o si ya lo tienes claro me dices qué día te viene bien.',
  ])('deja pasar «%s»', (texto) => {
    expect(bloquea(texto)).toBe(false);
  });
});

describe('una promesa de acción futura no se esconde metiendo palabras en medio', () => {
  it.each([
    'Perfecto, te confirmo la cita enseguida.',
    'Te digo algo en un momento.',
    'Te escribo con los huecos luego.',
    'Te confirmo la hora dentro de un rato.',
  ])('bloquea «%s»', (texto) => {
    const r = validarSalida(texto, CONTEXTO);
    expect(!r.valido && r.motivos.some((m) => m.tipo === 'promesa_de_accion_futura')).toBe(true);
  });

  it('lo que sí ocurre, porque lo manda otro, sigue pasando', () => {
    expect(validarSalida('Te aviso en cuanto recepción lo confirme.', CONTEXTO).valido).toBe(true);
  });
});

/**
 * **Decir que la hora que pidió no está libre no inventa nada.**
 *
 * Del banco: el paciente pidió «A las 10:20», que no existe, y el modelo contestó
 * «A las 10:20 no me sale nada, lo siento». Se bloqueó dos veces por hora no
 * propuesta y acabó en escalado: el paciente preguntó algo concreto y se le
 * escaló en vez de contestarle. La excepción tiene tres condiciones a la vez, y
 * cada una tiene aquí su caso que la tumba.
 */
describe('la hora que pidió el paciente, para decirle que no está', () => {
  const PIDIO_1020 = [{ horas: 10, minutos: 20 }];
  const con = (extra: Partial<ContextoDeValidacion>): ContextoDeValidacion => ({
    ...CONTEXTO,
    horasQueNombroElPaciente: PIDIO_1020,
    ...extra,
  });
  const franjas = (texto: string, contexto: ContextoDeValidacion): string[] => {
    const r = validarSalida(texto, contexto);
    return r.valido ? [] : r.motivos.filter((m) => m.tipo === 'franja_no_propuesta').map((m) => m.encontrado);
  };

  it.each([
    'A las 10:20 no me sale nada, lo siento. ¿Te viene bien el martes a las 11:00?',
    'Las 10:20 no las tengo libres; el martes a las 12:00 sí.',
    'A las 10:20 ya está cogido, pero el martes a las 11:00 tengo.',
    'A las 10:20 no tengo hueco.',
  ])('deja pasar «%s»', (texto) => {
    expect(franjas(texto, con({}))).toEqual([]);
  });

  it('sin consulta detrás, no: no sabe si está libre', () => {
    expect(franjas('A las 10:20 no me sale nada.', con({ consultaRealizada: false }))).toContain(
      '10:20',
    );
  });

  it('si la hora no la escribió el paciente, no: la trae el modelo', () => {
    expect(franjas('A las 10:20 no me sale nada.', con({ horasQueNombroElPaciente: [] }))).toContain(
      '10:20',
    );
  });

  it('ofrecerla dentro de una negación sigue sin pasar', () => {
    // El ofrecimiento disfrazado: niega una cosa y ofrece la hora pedida en otro día.
    expect(
      franjas('A las 10:20 no me sale nada, pero tengo el jueves a las 10:20.', con({})),
    ).not.toEqual([]);
  });

  it('y sin día tampoco: la negación de otra hora no la cubre', () => {
    // Una frase que niega algo y ofrece la hora pedida detrás de un «pero».
    // Por frase entera la negación la cubriría; por cláusula, no.
    expect(
      franjas('A las 11:00 no me queda nada, pero a las 10:20 sí.', con({})),
    ).toContain('10:20');
  });

  it('afirmarla como libre sigue sin pasar', () => {
    expect(franjas('Sí, a las 10:20 te lo puedo dar.', con({}))).toContain('10:20');
  });

  it('«no me sale nada» sin consulta también es afirmar disponibilidad', () => {
    // No lo reconocía: es la frase literal del modelo en el banco.
    const r = validarSalida('Esta semana no me sale nada.', { ...CONTEXTO, consultaRealizada: false });
    expect(!r.valido && r.motivos.some((m) => m.tipo === 'disponibilidad_no_consultada')).toBe(true);
  });
});

describe('«hasta las 21:00» es un horario, no una cita dada por hecha', () => {
  const sinConfirmar = { ...CONTEXTO, citaConfirmada: false };
  const daPorHecha = (texto: string): boolean => {
    const r = validarSalida(texto, sinConfirmar);
    return !r.valido && r.motivos.some((m) => m.tipo === 'cita_no_confirmada');
  };

  it('el horario pasa', () => {
    expect(daPorHecha('Los jueves estamos hasta las 21:00.')).toBe(false);
  });

  it.each(['Hasta el martes, Marta.', 'Pues hasta el miércoles entonces.', 'Hasta el 17!'])(
    '«%s» sigue bloqueado',
    (texto) => {
      expect(daPorHecha(texto)).toBe(true);
    },
  );
});

/**
 * La premisa de la regla de reserva vale para el ACTO de reservar, no para
 * DESCRIBIR una reserva hecha en un turno anterior. En la tanda se bloqueó «a
 * ti, queda anotado el lunes 12 a las 10:20…» con esa cita pendiente de verdad.
 */
describe('describir una reserva que existe', () => {
  // Martes 15 a las 11:00 en Madrid: la cita que el paciente tiene de verdad.
  const SUYA = new Date('2026-09-15T09:00:00.000Z');
  const conCita = { ...CONTEXTO, huecosPropuestos: [], citasVigentes: [SUYA], citaConfirmada: false };
  const reserva = (texto: string, contexto: ContextoDeValidacion): boolean => {
    const r = validarSalida(texto, contexto);
    return !r.valido && r.motivos.some((m) => m.tipo === 'reserva_afirmada');
  };

  it('pasa si nombra su cita y coincide', () => {
    expect(
      reserva('A ti, queda anotado el martes a las 11:00, a falta de que recepción lo confirme.', conCita),
    ).toBe(false);
  });

  it('no pasa si nombra otra hora', () => {
    expect(reserva('Te la dejo apuntada el martes a las 12:00.', conCita)).toBe(true);
  });

  it('no pasa sin decir cuál: «te la dejo apuntada» a secas no dice qué', () => {
    expect(reserva('Te la dejo apuntada, cualquier cosa me dices.', conCita)).toBe(true);
  });

  it('y sin ninguna cita, el caso del servidor de pruebas sigue bloqueado', () => {
    expect(
      reserva('Te la dejo apuntada el martes a las 11:00.', { ...conCita, citasVigentes: [] }),
    ).toBe(true);
  });
});

/**
 * De la tanda sobre conversación corriente: la regla de no afirmar
 * disponibilidad sin consulta bloqueaba frases que no hablan de la agenda.
 */
describe('lo que no es hablar de la agenda', () => {
  const sinConsulta = { ...CONTEXTO, consultaRealizada: false };
  const afirma = (texto: string): boolean => {
    const r = validarSalida(texto, sinConsulta);
    return !r.valido && r.motivos.some((m) => m.tipo === 'disponibilidad_no_consultada');
  };

  it.each([
    'No hay de qué, cuando quieras cita me dices el día y la franja que te vaya mejor.',
    'Ahora mismo no tienes ninguna cita cogida, así que no hay nada que cancelar.',
  ])('«%s» pasa', (texto) => {
    expect(afirma(texto)).toBe(false);
  });

  it.each(['No hay nada libre esta semana.', 'No me queda ninguna cita el sábado.', 'No hay nada que te pueda ofrecer el lunes.'])(
    '«%s» sigue bloqueado',
    (texto) => {
      expect(afirma(texto)).toBe(true);
    },
  );
});

/**
 * Un mensaje falso del historial se corrige nombrándolo para negarlo. La
 * excepción es sólo para eso: afirmarlo otra vez sigue bloqueado.
 */
describe('corregir una reserva que se afirmó y nunca existió', () => {
  // Lunes 21 a las 10:20 en Madrid: lo que se le dijo y no era verdad.
  const FALSA = new Date('2026-09-21T08:20:00.000Z');
  const conDesmentido = { ...CONTEXTO, huecosPropuestos: [], reservasDesmentidas: [FALSA], citaConfirmada: false };
  const bloquea = (texto: string): boolean => !validarSalida(texto, conDesmentido).valido;

  it.each([
    'Hola Marta. Lo del lunes a las 10:20 no llegó a reservarse, perdona el lío.',
    'Por cierto, el lunes a las 10:20 no tienes ninguna cita: no se llegó a reservar.',
  ])('negarla pasa: «%s»', (texto) => {
    expect(bloquea(texto)).toBe(false);
  });

  it.each([
    'Hola Marta, te recuerdo tu cita del lunes a las 10:20.',
    'Te la dejo apuntada el lunes a las 10:20.',
    'Lo del lunes a las 10:20 no llegó a reservarse, pero te la dejo apuntada el lunes a las 10:20.',
    // Sin horas: aquí sólo la regla de reservas puede pararlo, y la negación de
    // la primera cláusula no cubre lo que va detrás del «pero».
    'Eso no llegó a reservarse, pero ya la tienes apuntada.',
  ])('afirmarla sigue bloqueado: «%s»', (texto) => {
    expect(bloquea(texto)).toBe(true);
  });

  it('sin desmentido detrás, nombrar esa hora sigue bloqueado aunque niegue', () => {
    expect(
      !validarSalida('Lo del lunes a las 10:20 no llegó a reservarse.', { ...conDesmentido, reservasDesmentidas: [] })
        .valido,
    ).toBe(true);
  });
});

describe('qué cuenta como afirmar una reserva, para el barrido del historial', () => {
  it('saca el momento de la frase que afirma', () => {
    const [m] = reservasAfirmadas('Te la dejo apuntada el lunes a las 10:20, pendiente de que recepción la confirme.');
    expect(m).toMatchObject({ horas: 10, minutos: 20 });
  });

  it.each([
    '¿Te la apunto el lunes a las 10:20?',
    'Lo del lunes a las 10:20 no llegó a reservarse.',
    'Tengo el lunes a las 10:20, ¿te viene bien?',
  ])('no ve reserva en «%s»', (texto) => {
    expect(reservasAfirmadas(texto)).toEqual([]);
  });
});
