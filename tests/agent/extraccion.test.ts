import { describe, expect, it } from 'vitest';

import {
  EXTRACCION_DE_RESERVA,
  esquemaJsonDeExtraccion,
  instruccionesDeExtraccion,
  interpretar,
  MOTIVOS_DE_ESCALADO,
} from '../../src/agent/extraccion.js';
import {
  describirPreferencia,
  elegirPropuestas,
  filtrarPorPreferencia,
} from '../../src/agent/preferencia.js';
import { configDePrueba } from '../support/fakes.js';

/**
 * Adversariales de extracción.
 *
 * Aquí se prueba **qué hace el código con lo que devuelve el modelo**, que es la
 * parte determinista y la que puede romperse en silencio. Si el modelo real
 * produce o no la extracción correcta para cada mensaje es lo que mide
 * `npm run eval`; esto asegura que, produzca lo que produzca, nunca acabe
 * creando un hueco sobre una suposición.
 */

const CONFIG = configDePrueba();
const CODIGOS = CONFIG.servicios.map((s) => s.codigo);

describe('el servicio es salida cerrada contra el catálogo', () => {
  it('un código del catálogo pasa tal cual', () => {
    const r = interpretar({ intencion: 'agendar', servicio: 'laser-axilas' }, CONFIG);
    expect(r.servicio).toBe('laser-axilas');
  });

  it('un código que NO está en el catálogo se convierte en null', () => {
    // El modelo se ha inventado un servicio. No puede llegar a crear un hueco.
    const r = interpretar({ intencion: 'agendar', servicio: 'masaje-tailandes' }, CONFIG);
    expect(r.servicio).toBeNull();
  });

  it('texto libre en vez de código también es null', () => {
    const r = interpretar({ intencion: 'agendar', servicio: 'la depilación de las piernas' }, CONFIG);
    expect(r.servicio).toBeNull();
  });

  it('un código de OTRA clínica es null aquí', () => {
    const otra = configDePrueba({ servicios: [{ codigo: 'exclusivo', nombre: 'X', precio: 10, duracionMinutos: 10 }] });
    const r = interpretar({ intencion: 'agendar', servicio: 'laser-axilas' }, otra);
    expect(r.servicio).toBeNull();
  });

  it('el esquema JSON que se manda al modelo sólo lleva códigos reales', () => {
    const esquema = esquemaJsonDeExtraccion(CONFIG);
    const propiedades = esquema['properties'] as Record<string, { anyOf?: Array<{ enum?: unknown[] }> }>;

    expect(propiedades['servicio']?.anyOf?.[0]?.enum).toEqual(CODIGOS);
  });

  it('ningún campo usa `type: [x, null]`, que la API rechaza con un 400', () => {
    // Lo encontró el banco de pruebas en su primer turno: con la forma de array
    // el clasificador falla, cae a la extracción de reserva, y todo mensaje
    // queda como «intención otro, servicio no determinado». En silencio.
    const tiposEnArray: string[] = [];
    const recorrer = (nodo: unknown, ruta: string): void => {
      if (typeof nodo !== 'object' || nodo === null) return;
      const objeto = nodo as Record<string, unknown>;
      if (Array.isArray(objeto['type'])) tiposEnArray.push(ruta);
      for (const [clave, valor] of Object.entries(objeto)) {
        if (Array.isArray(valor)) valor.forEach((v, i) => recorrer(v, `${ruta}.${clave}[${i}]`));
        else recorrer(valor, `${ruta}.${clave}`);
      }
    };
    recorrer(esquemaJsonDeExtraccion(CONFIG), '$');

    expect(tiposEnArray).toEqual([]);
  });

  it('los campos que admiten nulo lo hacen con anyOf', () => {
    const propiedades = esquemaJsonDeExtraccion(CONFIG)['properties'] as Record<
      string,
      Record<string, unknown>
    >;

    for (const campo of ['servicio', 'opcion', 'preferencia', 'escalar']) {
      const anyOf = propiedades[campo]?.['anyOf'] as Array<{ type?: string }> | undefined;
      expect(anyOf?.some((x) => x.type === 'null'), campo).toBe(true);
    }
  });

  it('las instrucciones dicen explícitamente que no adivine', () => {
    const texto = instruccionesDeExtraccion(CONFIG);
    expect(texto).toContain('NO adivines');
    expect(texto).toContain('lo de siempre');
    for (const codigo of CODIGOS) expect(texto).toContain(codigo);
  });
});

describe('adversariales de extracción', () => {
  const CASOS: ReadonlyArray<{
    readonly n: number;
    readonly porque: string;
    readonly crudo: unknown;
    readonly servicioEsperado: string | null;
  }> = [
    {
      n: 1,
      porque: 'ambiguo: «lo de siempre» — el modelo debe devolver null y el código lo respeta',
      crudo: { intencion: 'agendar', servicio: null },
      servicioEsperado: null,
    },
    {
      n: 2,
      porque: 'el modelo se salta la regla y devuelve texto libre por «lo de siempre»',
      crudo: { intencion: 'agendar', servicio: 'lo de siempre' },
      servicioEsperado: null,
    },
    {
      n: 3,
      porque: 'dos servicios mencionados: el esquema sólo admite uno, y si el modelo concatena, no vale',
      crudo: { intencion: 'agendar', servicio: 'laser-axilas,laser-piernas' },
      servicioEsperado: null,
    },
    {
      n: 4,
      porque: 'servicio que no existe en el catálogo de esta clínica',
      crudo: { intencion: 'agendar', servicio: 'depilacion-cera' },
      servicioEsperado: null,
    },
    {
      n: 5,
      porque: 'el modelo devuelve un objeto en vez de una cadena',
      crudo: { intencion: 'agendar', servicio: { codigo: 'laser-axilas' } },
      servicioEsperado: null,
    },
    {
      n: 6,
      porque: 'el modelo devuelve basura entera: se usa la extracción de reserva',
      crudo: 'esto no es JSON de extracción',
      servicioEsperado: null,
    },
    {
      n: 7,
      porque: 'un servicio válido con espacios alrededor no cuela: es otro código',
      crudo: { intencion: 'agendar', servicio: ' laser-axilas ' },
      servicioEsperado: null,
    },
    {
      n: 8,
      porque: 'un servicio válido sí pasa, para que la prueba no sea vacua',
      crudo: { intencion: 'agendar', servicio: 'laser-piernas' },
      servicioEsperado: 'laser-piernas',
    },
  ];

  it.each(CASOS)('caso $n — $porque', ({ crudo, servicioEsperado }) => {
    expect(interpretar(crudo, CONFIG).servicio).toBe(servicioEsperado);
  });

  it('ninguno de los adversariales acaba con un servicio inventado', () => {
    const inventados = CASOS.filter((c) => {
      const s = interpretar(c.crudo, CONFIG).servicio;
      return s !== null && !CODIGOS.includes(s);
    });

    expect(inventados).toEqual([]);
  });
});

describe('la extracción de reserva es la salida segura', () => {
  it('no lleva servicio: preguntar antes que suponer', () => {
    expect(EXTRACCION_DE_RESERVA.servicio).toBeNull();
    expect(EXTRACCION_DE_RESERVA.intencion).toBe('otro');
    expect(EXTRACCION_DE_RESERVA.escalar).toBeNull();
  });

  it('no nombra ninguna cita ni contesta a la sustitución', () => {
    // Si el clasificador cae, nada puede acabar soltando una cita.
    expect(EXTRACCION_DE_RESERVA.cita).toBeNull();
    expect(EXTRACCION_DE_RESERVA.sustitucion).toBeNull();
  });
});

/**
 * Un paciente puede tener varias citas, así que hace falta saber a cuál se
 * refiere y si una cita nueva sustituye a otra. Son campos cerrados: lo que no
 * encaje es `null`, y `null` hace que se le pregunte.
 */
describe('a qué cita se refiere y si sustituye: salida cerrada', () => {
  it('un número de cita pasa; uno que no es entero o es absurdo es null', () => {
    expect(interpretar({ intencion: 'cancelar', cita: 2 }, CONFIG).cita).toBe(2);
    expect(interpretar({ intencion: 'cancelar', cita: 1.5 }, CONFIG).cita).toBeNull();
    expect(interpretar({ intencion: 'cancelar', cita: 0 }, CONFIG).cita).toBeNull();
    expect(interpretar({ intencion: 'cancelar', cita: 'la de limpieza' }, CONFIG).cita).toBeNull();
  });

  it('la sustitución sólo admite sus dos valores', () => {
    expect(interpretar({ intencion: 'otro', sustitucion: 'en_lugar' }, CONFIG).sustitucion).toBe(
      'en_lugar',
    );
    expect(interpretar({ intencion: 'otro', sustitucion: 'ademas' }, CONFIG).sustitucion).toBe(
      'ademas',
    );
    expect(interpretar({ intencion: 'otro', sustitucion: 'si' }, CONFIG).sustitucion).toBeNull();
  });

  it('si el proveedor no los manda, la extracción NO se cae entera', () => {
    // Un campo nuevo ausente no puede tumbar todo lo demás: el paciente se
    // quedaría con «intención otro, servicio sin determinar» en cada mensaje.
    const r = interpretar({ intencion: 'agendar', servicio: 'laser-axilas' }, CONFIG);
    expect(r.servicio).toBe('laser-axilas');
    expect(r.cita).toBeNull();
    expect(r.sustitucion).toBeNull();
  });

  it('las instrucciones enseñan sus citas, numeradas, y piden no adivinar', () => {
    const texto = instruccionesDeExtraccion(CONFIG, null, [
      'Limpieza facial, miércoles, 26, 16:00',
      'Láser axilas, viernes, 28, 17:00',
    ]);
    expect(texto).toContain('1. Limpieza facial, miércoles, 26, 16:00');
    expect(texto).toContain('2. Láser axilas, viernes, 28, 17:00');
    expect(texto).toMatch(/NO adivines/);
    // Elegir un hueco ofrecido no es nombrar una cita suya.
    expect(texto).toMatch(/Elegir uno de los huecos[\s\S]*`cita` es null/);
  });

  /**
   * **Las intenciones están definidas, y esto es lo que lo vigila.**
   *
   * El clasificador recibía sólo la lista de etiquetas. Medido contra el modelo
   * real, con la conversación de la sesión que destapó el fallo y 10 ejecuciones
   * por mensaje: «La del miércoles a las 10» salía `elegir_hueco` 1 de 10 veces
   * —el resto `agendar`, que repropone y le caduca la opción que estaba
   * eligiendo—, y «¿Viernes a las 17:00 lo tienes libre?» salía `elegir_hueco`
   * 7 de 10: una pregunta convertida en reserva. Con las definiciones, 10 de 10
   * y 0 de 10.
   *
   * Y una frase que NO debe volver: «pedir cita de OTRO tratamiento es una cita
   * nueva (`agendar`)». Se escribió para las varias citas y bajó «me quedo con
   * la primera» de 9 a 1 de cada 10 como `elegir_hueco`: en una conversación
   * donde acaba de pedir otro tratamiento, empujaba todo hacia `agendar`.
   */
  it('define elegir_hueco y dice que una PREGUNTA por una hora no es elegir', () => {
    const texto = instruccionesDeExtraccion(CONFIG, null, []);
    expect(texto).toMatch(/elegir_hueco: ESCOGE uno de los huecos/);
    expect(texto).toMatch(/PREGUNTA por una hora[\s\S]*es agendar, no elegir/);
    expect(texto).not.toMatch(/OTRO tratamiento es una\s+cita nueva \(`agendar`\)/);
  });

  it('el esquema JSON lleva los dos campos, también como obligatorios', () => {
    const esquema = esquemaJsonDeExtraccion(CONFIG);
    expect(esquema['required']).toEqual(expect.arrayContaining(['cita', 'sustitucion']));
  });
});

describe('el reparto de las tres opciones', () => {
  const ZONA_R = 'Europe/Madrid';
  /** Martes 15, 22 y 29 a las 12:00, y un jueves 10 a las 11:00 (antes que todos). */
  const AGENDA = [
    { inicio: new Date('2026-09-10T09:00:00.000Z'), fin: new Date('2026-09-10T09:30:00.000Z') },
    { inicio: new Date('2026-09-11T08:00:00.000Z'), fin: new Date('2026-09-11T08:30:00.000Z') },
    { inicio: new Date('2026-09-15T10:00:00.000Z'), fin: new Date('2026-09-15T10:30:00.000Z') },
    { inicio: new Date('2026-09-22T10:00:00.000Z'), fin: new Date('2026-09-22T10:30:00.000Z') },
    { inicio: new Date('2026-09-29T10:00:00.000Z'), fin: new Date('2026-09-29T10:30:00.000Z') },
  ];

  function conPreferencia(extra: Record<string, unknown> = {}) {
    return {
      dias: ['martes'],
      diasExcluidos: [],
      franjas: [],
      desde: null,
      horaExacta: '12:00',
      cuantoAntes: false,
      ...extra,
    } satisfies NonNullable<Parameters<typeof filtrarPorPreferencia>[1]>;
  }

  function dias(huecos: readonly { inicio: Date }[]): string[] {
    const dtf = new Intl.DateTimeFormat('es-ES', {
      timeZone: ZONA_R,
      weekday: 'long',
      day: 'numeric',
    });
    return huecos.map((h) => dtf.format(h.inicio));
  }

  it('NO ofrece la misma hora tres semanas seguidas', () => {
    // El fallo que lo trae: «martes a las 12» daba martes 15, martes 22 y
    // martes 29. Tres veces la misma opción, y ninguna esta semana.
    const r = elegirPropuestas(AGENDA, conPreferencia(), ZONA_R, {
      cuantos: 3,
      reparto: 'cercania',
    });

    expect(r.huecos).toHaveLength(3);
    expect(new Set(dias(r.huecos)).size).toBe(3);
    expect(dias(r.huecos)).not.toEqual(['martes 15', 'martes 22', 'martes 29']);
  });

  it('la PRIMERA sigue siendo la que pidió', () => {
    const r = elegirPropuestas(AGENDA, conPreferencia(), ZONA_R, {
      cuantos: 3,
      reparto: 'cercania',
    });

    expect(dias(r.huecos)[0]).toBe('martes 15');
  });

  it('las otras dos están ANTES en el tiempo, y se avisa de que se apartan', () => {
    const r = elegirPropuestas(AGENDA, conPreferencia(), ZONA_R, {
      cuantos: 3,
      reparto: 'cercania',
    });

    const resto = r.huecos.slice(1);
    expect(resto.every((h) => h.inicio < r.huecos[0]!.inicio)).toBe(true);
    // El mensaje tiene que decirlo: ofrecer un jueves a quien pidió martes sin
    // avisar es hacerle creer que le hemos buscado martes y no había.
    expect(r.alternativasAlejadas).toBe(true);
  });

  it('«los jueves no puedo» NO se relaja nunca, ni en las alternativas', () => {
    const r = elegirPropuestas(
      AGENDA,
      conPreferencia({ diasExcluidos: ['jueves'] }),
      ZONA_R,
      { cuantos: 3, reparto: 'cercania' },
    );

    // Una exclusión es una imposibilidad, no un gusto.
    expect(dias(r.huecos).some((d) => d.startsWith('jueves'))).toBe(false);
  });

  it('una clínica puede pedir fidelidad y entonces las tres respetan lo pedido', () => {
    const r = elegirPropuestas(AGENDA, conPreferencia(), ZONA_R, {
      cuantos: 3,
      reparto: 'fidelidad',
    });

    expect(dias(r.huecos)).toEqual(['martes 15', 'martes 22', 'martes 29']);
    expect(r.alternativasAlejadas).toBe(false);
  });

  it('sin preferencia, salen los tres más próximos y no se avisa de nada', () => {
    const r = elegirPropuestas(AGENDA, null, ZONA_R, { cuantos: 3, reparto: 'cercania' });

    expect(r.huecos[0]?.inicio).toEqual(AGENDA[0]?.inicio);
    expect(r.alternativasAlejadas).toBe(false);
  });
});

describe('preferencia de día y hora', () => {
  const ZONA = 'Europe/Madrid';
  /** Jueves 17 de septiembre de 2026: 09:00, 14:00 y 18:00 en Madrid. */
  const HUECOS = [
    { inicio: new Date('2026-09-17T07:00:00.000Z'), fin: new Date('2026-09-17T07:30:00.000Z') },
    { inicio: new Date('2026-09-17T12:00:00.000Z'), fin: new Date('2026-09-17T12:30:00.000Z') },
    { inicio: new Date('2026-09-17T16:00:00.000Z'), fin: new Date('2026-09-17T16:30:00.000Z') },
    // Lunes 21, 10:00.
    { inicio: new Date('2026-09-21T08:00:00.000Z'), fin: new Date('2026-09-21T08:30:00.000Z') },
  ];

  /** Una hora que sí está entre los huecos de arriba. */
  const HORA_EXISTENTE = '14:00';

  function pref(extra: Partial<Parameters<typeof filtrarPorPreferencia>[1]> = {}) {
    return {
      dias: [],
      diasExcluidos: [],
      franjas: [],
      desde: null,
      horaExacta: null,
      cuantoAntes: false,
      ...extra,
    } satisfies NonNullable<Parameters<typeof filtrarPorPreferencia>[1]>;
  }

  it('«¿podría ser a las 10:45?» pone esa hora la primera si existe', () => {
    // La petición trivial que antes acababa en un escalado.
    const r = filtrarPorPreferencia(HUECOS, pref({ horaExacta: HORA_EXISTENTE }), ZONA);

    const primera = new Intl.DateTimeFormat('es-ES', {
      timeZone: ZONA,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(r.huecos[0]!.inicio);
    expect(primera).toBe(HORA_EXISTENTE);
    expect(r.preferenciaNoSatisfecha).toBe(false);
  });

  it('si esa hora no existe, propone las más cercanas y lo reconoce', () => {
    const r = filtrarPorPreferencia(HUECOS, pref({ horaExacta: '03:07' }), ZONA);

    // Ni un escalado ni una lista vacía: se le ofrece lo más próximo, diciendo
    // que no es lo que pidió.
    expect(r.huecos.length).toBe(HUECOS.length);
    expect(r.preferenciaNoSatisfecha).toBe(true);
  });

  it('sin preferencia devuelve todos los huecos', () => {
    const r = filtrarPorPreferencia(HUECOS, null, ZONA);
    expect(r.huecos).toHaveLength(4);
    expect(r.preferenciaNoSatisfecha).toBe(false);
  });

  it('«por la tarde» deja sólo el de las 18:00', () => {
    const r = filtrarPorPreferencia(HUECOS, pref({ franjas: ['tarde'] }), ZONA);
    expect(r.huecos).toHaveLength(1);
    expect(r.huecos[0]?.inicio.toISOString()).toBe('2026-09-17T16:00:00.000Z');
  });

  it('«los lunes no puedo» descarta el lunes', () => {
    const r = filtrarPorPreferencia(HUECOS, pref({ diasExcluidos: ['lunes'] }), ZONA);
    expect(r.huecos).toHaveLength(3);
  });

  it('«a partir del 20» descarta el jueves 17', () => {
    const r = filtrarPorPreferencia(HUECOS, pref({ desde: '2026-09-20' }), ZONA);
    expect(r.huecos).toHaveLength(1);
  });

  it('preferencia contradictoria: no queda nada, pero NO se le oculta', () => {
    // «el lunes, pero los lunes no puedo».
    const r = filtrarPorPreferencia(HUECOS, pref({ dias: ['lunes'], diasExcluidos: ['lunes'] }), ZONA);

    // Se le proponen los disponibles, y la bandera obliga al mensaje a
    // reconocer que no son los que pidió (regla 4 bis).
    expect(r.huecos).toHaveLength(4);
    expect(r.preferenciaNoSatisfecha).toBe(true);
  });

  it('una franja sin huecos también marca la bandera', () => {
    const soloManana = [HUECOS[0]!];
    const r = filtrarPorPreferencia(soloManana, pref({ franjas: ['tarde'] }), ZONA);

    expect(r.huecos).toHaveLength(1);
    expect(r.preferenciaNoSatisfecha).toBe(true);
  });

  it('la preferencia se describe en texto para el redactor', () => {
    expect(describirPreferencia(null)).toBeNull();
    expect(describirPreferencia(pref({ franjas: ['tarde'], diasExcluidos: ['lunes'] }))).toContain(
      'tarde',
    );
  });
});

describe('señal de escalado no clínica', () => {
  it('los motivos son una lista fija y cerrada', () => {
    expect([...MOTIVOS_DE_ESCALADO]).toEqual(['queja', 'pide_persona', 'agente_atascado']);
  });

  it('un motivo inventado por el modelo se descarta', () => {
    const r = interpretar({ intencion: 'otro', escalar: 'esta_muy_enfadado' }, CONFIG);
    expect(r.escalar).toBeNull();
  });

  it('un motivo de la lista pasa', () => {
    expect(interpretar({ intencion: 'otro', escalar: 'pide_persona' }, CONFIG).escalar).toBe(
      'pide_persona',
    );
  });

  it('las instrucciones piden prudencia, no escalar de más', () => {
    // Al revés que el cortafuegos: aquí un falso positivo satura a recepción, y
    // la fatiga de alertas es lo que hace que dejen de mirarlos.
    expect(instruccionesDeExtraccion(CONFIG)).toContain('Ante la duda, null');
  });
});

/**
 * Contexto estructurado para el clasificador. Medido contra el modelo real, 5
 * repeticiones por mensaje: de 64/80 a 76/80. Lo que más movió:
 * - «¿Tenéis higienes faciales?» 0/5 → 5/5, con alias en el YAML.
 * - «Quiero también depilación de axilas» con otro tratamiento vigente 0/5 →
 *   5/5: «null si menciona dos» se leía como «también = dos».
 * Las elecciones ya salían 40/40; los huecos numerados no las movieron, pero
 * quitan el punto ciego de una oferta que ha salido de la ventana de turnos.
 */
describe('lo que el clasificador tiene delante', () => {
  const conAlias = configDePrueba({
    servicios: [
      {
        codigo: 'limpieza-facial',
        nombre: 'Limpieza facial profunda',
        alias: ['higiene facial', 'limpieza de cara'],
        precio: 55,
        duracionMinutos: 60,
      },
    ],
  });

  it('los alias del YAML van junto a su código', () => {
    expect(instruccionesDeExtraccion(conAlias)).toContain(
      '- limpieza-facial: Limpieza facial profunda (también lo llaman: higiene facial, limpieza de cara)',
    );
  });

  it('un servicio sin alias no lleva paréntesis vacío', () => {
    expect(instruccionesDeExtraccion(CONFIG)).not.toContain('también lo llaman: )');
  });

  it('los huecos que tiene delante van numerados como `opcion`', () => {
    const texto = instruccionesDeExtraccion(CONFIG, null, [], [
      '1) Láser axilas, miércoles, 14, 10:00',
      '2) Láser axilas, sábado, 10, 10:00',
    ]);
    expect(texto).toContain('2) Láser axilas, sábado, 10, 10:00');
    expect(texto).toMatch(/dos opciones pueden ser a la\s+misma hora en días distintos/);
  });

  it('pedir un tratamiento ADEMÁS no es «mencionar dos»', () => {
    const texto = instruccionesDeExtraccion(CONFIG, 'limpieza-facial', []);
    expect(texto).toMatch(/tratamiento NUEVO además del que se hablaba/);
    expect(texto).toMatch(/en ESTE mensaje pide dos a la vez/);
  });
});

describe('el tema de un dato práctico: salida cerrada', () => {
  it('admite sólo los temas que se componen desde el YAML', () => {
    expect(interpretar({ intencion: 'otro', tema: 'aparcamiento' }, CONFIG).tema).toBe('aparcamiento');
    expect(interpretar({ intencion: 'otro', tema: 'wifi' }, CONFIG).tema).toBeNull();
  });

  it('si el proveedor no lo manda, es null y no tumba lo demás', () => {
    const r = interpretar({ intencion: 'agendar', servicio: 'laser-axilas' }, CONFIG);
    expect(r.tema).toBeNull();
    expect(r.servicio).toBe('laser-axilas');
  });

  it('la reserva no trae tema', () => {
    expect(EXTRACCION_DE_RESERVA.tema).toBeNull();
  });

  it('las instrucciones separan el tema cancelación de la intención de cancelar', () => {
    expect(instruccionesDeExtraccion(CONFIG)).toMatch(/Pedir cancelar SU cita es la intención cancelar/);
  });
});
