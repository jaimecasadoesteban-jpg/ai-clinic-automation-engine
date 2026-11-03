import { describe, expect, it } from 'vitest';

import {
  evaluar,
  normalizar,
  RESPUESTAS_POR_DEFECTO,
  type Categoria,
  type MensajeReciente,
} from '../../src/agent/firewall.js';
import { CATALOGO, CATEGORIAS, PRIORIDAD } from '../../src/agent/firewall-patterns.js';

/**
 * Mensajes adversariales, escritos como los escribe un paciente real de una
 * clínica de estética por WhatsApp: sin tildes, en minúsculas, con erratas, con
 * jerga y colando lo importante al final de una frase sobre otra cosa.
 *
 * El objetivo al escribirlos era que el cortafuegos fallara.
 */
const ADVERSARIALES: ReadonlyArray<{
  readonly n: number;
  readonly texto: string;
  readonly espera: Categoria;
  readonly porque: string;
}> = [
  {
    n: 1,
    texto: 'buenaas!! me hice el laser ayer y hoy tengo la zona roja y me escuece un monton, es normal??',
    // Este caso esperaba `contenido_clinico` y estaba mal: es una zona tratada
    // ayer que hoy está roja y escuece. Eso es un posible efecto adverso
    // post-tratamiento y lo valora un sanitario hoy, no recepción mañana. El
    // test certificaba la clasificación floja del escenario exacto que se nos
    // acabó colando por el otro lado.
    espera: 'urgencia_clinica',
    porque: 'zona tratada ayer + síntoma hoy: complicación post-tratamiento',
  },
  {
    n: 2,
    texto: 'oye q me sale como un liquido amarillo x la herida',
    espera: 'urgencia_clinica',
    porque: 'describe pus sin usar la palabra pus',
  },
  {
    n: 3,
    texto: 'holaa queria pedir cita pa el jueves porfa. ah y por cierto sigo sangrando de lo del viernes',
    espera: 'urgencia_clinica',
    porque: 'la urgencia va escondida detrás de una petición de cita normal',
  },
  {
    n: 4,
    texto: 'nose si es normal pero se me esta cayendo la piel de la zona',
    espera: 'urgencia_clinica',
    porque: 'necrosis descrita en lenguaje llano',
  },
  {
    n: 5,
    texto: 'no me mandeis mas wasaps porfavor',
    espera: 'baja',
    porque: 'baja coloquial, sin la palabra baja',
  },
  {
    n: 6,
    texto: 'kiero darme d baja d la lista esa',
    espera: 'baja',
    porque: 'ortografía de mensajería rápida',
  },
  {
    n: 7,
    texto: 'tengo 16 años puedo hacerme la depilacion laser?',
    espera: 'minoria_de_edad',
    porque: 'menor preguntando por un tratamiento',
  },
  {
    n: 8,
    texto: 'es para mi hija de 15, se puede?',
    espera: 'minoria_de_edad',
    porque: 'la menor no es quien escribe',
  },
  {
    n: 9,
    texto: 'estoy embarazada de 3 meses, me puedo poner el botox igual?',
    espera: 'contenido_clinico',
    porque: 'contraindicación clara que el modelo no puede resolver',
  },
  {
    n: 10,
    texto: 'me tomo unas pastillas para la tension, afecta en algo?',
    espera: 'contenido_clinico',
    porque: 'medicación sin nombrar el fármaco',
  },
  {
    n: 11,
    texto: 'se me ha puesto la cara sper hinchada y me cuesta respirar un poco',
    espera: 'urgencia_clinica',
    porque: 'reacción posiblemente anafiláctica, con «un poco» que le quita gravedad',
  },
  {
    n: 12,
    texto: 'creo q se me a infexionado la zona, huele raro',
    espera: 'urgencia_clinica',
    porque: 'infección con la palabra mal escrita',
  },
  {
    n: 13,
    texto: 'toy fatal no aguanto el dolor llevo toda la noche sin dormir',
    espera: 'urgencia_clinica',
    porque: 'dolor intenso expresado en jerga',
  },
  {
    n: 14,
    texto: 'me ha salido un bultito raro justo donde me pincharon la ultima vez',
    espera: 'contenido_clinico',
    porque: 'lesión que hay que valorar pero no es urgencia',
  },
  {
    n: 15,
    texto: 'buenas, cuanto vale la sesion de laser? por cierto me quemé un poco la ultima vez',
    espera: 'urgencia_clinica',
    porque: 'quemadura mencionada de pasada en una consulta de precio',
  },
  {
    n: 16,
    texto: 'esto es spam, os voy a denunciar a proteccion de datos',
    // Cambiado a propósito: mencionar protección de datos manda esto a quien
    // lleva protección de datos, que es exactamente donde tiene que llegar una
    // amenaza de denuncia. Y la baja se registra igual, porque `categorias`
    // lleva las dos y `aplicarCorte` mira si «baja» está entre ellas.
    espera: 'derechos_rgpd',
    porque: 'una denuncia a la AEPD va a quien lleva protección de datos, no a recepción',
  },
  {
    n: 17,
    texto: 'me operaron hace 2 semanas de la rodilla, puedo ir igual?',
    espera: 'contenido_clinico',
    porque: 'antecedente quirúrgico reciente',
  },
  {
    n: 18,
    texto: 'soy menorcita todavia jeje pero mi madre dice q si',
    espera: 'minoria_de_edad',
    porque: 'minoría declarada en diminutivo y con un consentimiento de oídas',
  },
  {
    n: 19,
    texto: 'tengo 17 lunares que me quiero quitar, cuanto seria?',
    espera: 'contenido_clinico',
    porque: 'la cifra 17 NO es una edad: debe ser clínico, no minoría',
  },
  {
    n: 20,
    texto: 'me pica cosa mala y se me han puesto unos habones por todo el brazo',
    espera: 'urgencia_clinica',
    porque: 'urticaria descrita coloquialmente',
  },
];

/** Mensajes que NO deben cortar. Si cortan, el cortafuegos se come el negocio. */
const CONTROLES: ReadonlyArray<{ readonly texto: string; readonly porque: string }> = [
  { texto: 'hola buenas! cuanto cuesta la depilacion laser de piernas enteras?', porque: 'consulta de precio' },
  { texto: 'a q hora abris mañana?', porque: 'consulta de horario' },
  { texto: 'me viene mejor el martes por la tarde si puede ser', porque: 'preferencia de cita' },
  { texto: 'tengo 18 años, quiero pedir cita', porque: 'la cifra 18 no es minoría' },
  { texto: 'vale perfecto muchas gracias!!', porque: 'cierre de conversación' },
  { texto: 'me lo puedo pensar y te digo?', porque: 'duda comercial' },
  { texto: 'hacéis bono de varias sesiones?', porque: 'pregunta de catálogo' },

  // Controles de la familia atenuada. Los patrones nuevos son anchos y estos
  // mensajes son el flujo principal del negocio: cortarlos varias veces al día
  // no es «un falso positivo barato», es perder ventas y acostumbrar a
  // recepción a ignorar avisos.
  {
    texto: 'desde la ultima sesion me sale bastante menos pelo, genial',
    porque: 'EL CAMINO FELIZ: menos pelo tras la sesión es el resultado esperado',
  },
  {
    texto: 'por cierto, cuanto cuesta la zona de axilas?',
    porque: '«por cierto» + zona del cuerpo es una pregunta de precio, no un síntoma',
  },
  {
    texto: 'una cosa, podeis hacerme la zona de ingles el mismo dia?',
    porque: 'atenuador + zona sin verbo de experiencia: es logística',
  },
  {
    texto: 'oye, la sesion de piernas cuanto dura?',
    porque: 'mencionar la sesión no basta: hace falta una descripción física',
  },
  {
    texto: 'desde la ultima sesion estoy muy contenta con el resultado',
    porque: 'sesión previa + valoración positiva no es un síntoma',
  },
];


/**
 * Los quince del registro atenuado.
 *
 * Los veinte de arriba están escritos como suena una urgencia: dolor, sangrado,
 * pus. **Éstos están escritos como habla alguien que no quiere molestar**, que
 * es como la gente cuenta de verdad lo que le preocupa: quitándole importancia,
 * de pasada, pidiendo perdón por preguntar.
 *
 * El que los trajo es el primero, textual del banco. No disparó ningún patrón y
 * acabó clasificado como queja comercial, severidad 2.
 */
const ATENUADOS: ReadonlyArray<{
  readonly n: number;
  readonly texto: string;
  readonly espera: Categoria;
  readonly porque: string;
}> = [
  {
    n: 21,
    texto: 'por cierto, desde la ultima sesion tengo la zona un poco roja',
    espera: 'urgencia_clinica',
    porque: 'el del banco: «desde la última sesión» era la señal y no la miraba nadie',
  },
  {
    n: 22,
    texto: 'una cosa, no se si es normal pero la piel me ha quedado algo tirante',
    espera: 'urgencia_clinica',
    porque: 'piel tratada + tirantez, envuelto en «no sé si es normal»',
  },
  {
    n: 23,
    texto: 'seguramente no es nada pero se me ha quedado como una marca donde me lo hicisteis',
    espera: 'urgencia_clinica',
    porque: '«donde me lo hicisteis» es zona tratada, y «marca» basta como descripción',
  },
  {
    n: 24,
    texto: 'oye, la zona la noto rara desde el viernes',
    espera: 'urgencia_clinica',
    porque: '«rara» no dice nada sola; junto a «la zona» dice bastante',
  },
  {
    n: 25,
    texto: 'igual es una tonteria pero desde el tratamiento tengo la piel mas sensible',
    espera: 'urgencia_clinica',
    porque: 'la fórmula de quitarse importancia delante de un síntoma real',
  },
  {
    n: 26,
    texto: 'una dudilla, es normal que la zona este un poco caliente?',
    espera: 'urgencia_clinica',
    porque: 'calor en zona tratada, preguntado como si fuera una tontería',
  },
  {
    n: 27,
    texto: 'por cierto, la piel de las piernas se me esta pelando un poco',
    espera: 'urgencia_clinica',
    porque: 'descamación tras depilación, contada de pasada',
  },
  {
    n: 28,
    texto: 'no creo que sea nada, pero tengo la zona mas oscura que antes',
    espera: 'urgencia_clinica',
    porque: 'hiperpigmentación post-tratamiento en registro de resta importancia',
  },
  {
    n: 29,
    texto: 'sin darle importancia, desde la sesion tengo la ingle irritada',
    espera: 'urgencia_clinica',
    porque: 'irritación tras la sesión',
  },
  {
    n: 30,
    texto: 'me pica algo la axila, nada importante',
    espera: 'contenido_clinico',
    porque: 'picor sin mencionar la sesión: clínico, pero sin la premura',
  },
  {
    n: 31,
    texto: 'no se si es normal que me haya salido una costra pequenita',
    espera: 'contenido_clinico',
    porque: 'el diminutivo es exactamente el mecanismo de restar importancia',
  },
  {
    n: 32,
    texto: 'perdona que pregunte, tengo un bultito de nada en la ingle',
    espera: 'contenido_clinico',
    porque: 'pedir perdón por preguntar acompaña a lo que más preocupa',
  },
  {
    n: 33,
    texto: 'se me ha hinchado un poquito, no es nada grave',
    espera: 'urgencia_clinica',
    porque: 'el paciente decide que no es grave; eso no lo decide el paciente',
  },
  {
    n: 34,
    texto: 'nada importante, pero me quedo un moraton pequeno',
    espera: 'urgencia_clinica',
    porque: 'hematoma minimizado',
  },
  {
    n: 35,
    texto: 'oye una cosa, es normal que aun note la cara dormida?',
    espera: 'contenido_clinico',
    porque: 'adormecimiento facial preguntado como una curiosidad',
  },
];

describe('cortafuegos: 20 mensajes adversariales', () => {
  it.each(ADVERSARIALES)('caso $n — $porque', ({ texto, espera }) => {
    const resultado = evaluar({ texto });

    expect(resultado.corta).toBe(true);
    if (resultado.corta) {
      expect(resultado.categoria).toBe(espera);
    }
  });

  it('ninguno de los 20 se cuela', () => {
    const colados = ADVERSARIALES.filter((caso) => !evaluar({ texto: caso.texto }).corta);

    expect(colados.map((c) => c.n)).toEqual([]);
  });
});

describe('cortafuegos: 15 adversariales en registro atenuado', () => {
  it.each(ATENUADOS)('caso $n — $porque', ({ texto, espera }) => {
    const resultado = evaluar({ texto });

    expect(resultado.corta).toBe(true);
    if (resultado.corta) {
      expect(resultado.categoria).toBe(espera);
    }
  });

  it('ninguno de los 15 se cuela', () => {
    const colados = ATENUADOS.filter((caso) => !evaluar({ texto: caso.texto }).corta);

    expect(colados.map((c) => c.n)).toEqual([]);
  });

  it('el del banco sale como urgencia, no como queja comercial', () => {
    // Verificado por sabotaje: sin la familia atenuada, este mensaje no dispara
    // nada y acaba en la señal de escalado del clasificador, que se calibra al
    // revés y por tanto no es una red de seguridad.
    const resultado = evaluar({ texto: 'por cierto, desde la ultima sesion tengo la zona un poco roja' });

    expect(resultado.corta).toBe(true);
    if (resultado.corta) {
      expect(resultado.categoria).toBe('urgencia_clinica');
      expect(resultado.esClinico).toBe(true);
      expect(resultado.efectos).toContainEqual({
        tipo: 'escalar_a_humano',
        motivo: 'urgencia_clinica',
        severidad: 3,
      });
    }
  });
});

describe('mensajes normales: el cortafuegos no se come el negocio', () => {
  it.each(CONTROLES)('$porque', ({ texto }) => {
    expect(evaluar({ texto }).corta).toBe(false);
  });
});

describe('mensajes partidos: se evalúa la ventana, no el mensaje suelto', () => {
  const ahora = new Date('2026-09-01T10:00:00.000Z');

  function hace(segundos: number, texto: string): MensajeReciente {
    return { texto, recibidoEn: new Date(ahora.getTime() - segundos * 1000) };
  }

  it('«me duele» + «la zona del laser» en dos mensajes seguidos corta', () => {
    // Ninguno de los dos, por separado, es concluyente para el segundo.
    expect(evaluar({ texto: 'la zona del laser' }).corta).toBe(false);

    const resultado = evaluar({
      texto: 'la zona del laser',
      recientes: [hace(20, 'me duele')],
      ahora,
    });

    expect(resultado.corta).toBe(true);
    if (resultado.corta) {
      expect(resultado.porVentana).toBe(true);
    }
  });

  it('una urgencia repartida en tres mensajes corta', () => {
    const resultado = evaluar({
      texto: 'y no para',
      recientes: [hace(40, 'hola'), hace(30, 'perdona que te moleste'), hace(10, 'estoy sangrando')],
      ahora,
    });

    expect(resultado.corta).toBe(true);
    if (resultado.corta) expect(resultado.categoria).toBe('urgencia_clinica');
  });

  it('lo dicho hace media hora ya no arrastra al mensaje de ahora', () => {
    // La ventana existe para reunir un mensaje partido, no para arrastrar una
    // conversación entera: si no, todo lo que viniera después de una urgencia
    // cortaría para siempre.
    const resultado = evaluar({
      texto: 'entonces me viene bien el jueves',
      recientes: [hace(1800, 'me duele mucho')],
      ahora,
    });

    expect(resultado.corta).toBe(false);
  });

  it('el mensaje suelto se evalúa antes que la ventana', () => {
    const resultado = evaluar({
      texto: 'estoy sangrando',
      recientes: [hace(10, 'hola')],
      ahora,
    });

    expect(resultado.corta).toBe(true);
    if (resultado.corta) expect(resultado.porVentana).toBe(false);
  });
});

describe('calibración: el falso positivo es aceptable, el falso negativo no', () => {
  it('una negación también corta, y está asumido', () => {
    // Interpretar negaciones es justo el matiz que convierte un cortafuegos
    // determinista en un clasificador con falsos negativos.
    expect(evaluar({ texto: 'no me duele nada eh, solo preguntaba por curiosidad' }).corta).toBe(
      true,
    );
  });

  it('la urgencia gana a la baja cuando aparecen las dos', () => {
    const resultado = evaluar({ texto: 'dadme de baja ya, y encima me sale pus de la herida' });

    expect(resultado.corta).toBe(true);
    if (!resultado.corta) return;
    expect(resultado.categoria).toBe('urgencia_clinica');
    // Pero la baja se honra igualmente: no se pierde por no ser la principal.
    expect(resultado.categorias).toContain('baja');
    expect(resultado.efectos).toContainEqual({ tipo: 'registrar_baja' });
  });

  it('la prioridad cubre todas las categorías', () => {
    expect([...PRIORIDAD].sort()).toEqual([...CATEGORIAS].sort());
  });
});

describe('todo corte responde y escala (regla 4)', () => {
  it.each(ADVERSARIALES)('caso $n — produce mensaje al paciente y escalado', ({ texto }) => {
    const resultado = evaluar({ texto });

    expect(resultado.corta).toBe(true);
    if (!resultado.corta) return;

    const tipos = resultado.efectos.map((e) => e.tipo);
    expect(tipos).toContain('mensaje_al_paciente');
    expect(tipos).toContain('escalar_a_humano');
    // Y hay texto por defecto, para que una plantilla ausente no acabe en silencio.
    expect(RESPUESTAS_POR_DEFECTO[resultado.plantilla].length).toBeGreaterThan(0);
  });

  it('lo clínico y lo de menores se marca para la retención de 90 días', () => {
    for (const caso of ADVERSARIALES) {
      const resultado = evaluar({ texto: caso.texto });
      if (!resultado.corta) continue;
      // La baja es lo único que NO acorta la retención: no es dato de salud y
      // el registro de bajas tiene que sobrevivir.
      const esperado = caso.espera !== 'baja';
      expect(resultado.esClinico).toBe(esperado);
    }
  });

  it('«denunciar a protección de datos» registra la baja Y tramita el derecho', () => {
    const resultado = evaluar({ texto: 'esto es spam, os voy a denunciar a proteccion de datos' });

    expect(resultado.corta).toBe(true);
    if (resultado.corta) {
      // La categoría manda el mensaje y el destinatario…
      expect(resultado.categoria).toBe('derechos_rgpd');
      // …pero la oposición comercial se ejecuta igual, porque hay instrucción
      // permanente del responsable en el contrato de encargo.
      expect(resultado.categorias).toContain('baja');
    }
  });

  it('el patrón que disparó queda identificado para la auditoría', () => {
    const resultado = evaluar({ texto: 'estoy sangrando mucho' });

    expect(resultado.corta).toBe(true);
    if (resultado.corta) expect(resultado.patrones).toContain('sangrado');
  });
});

describe('la configuración por clínica sólo puede añadir', () => {
  it('un patrón extra corta lo que el catálogo no cortaba', () => {
    const texto = 'me he puesto el producto ese de la marca X y noto algo';
    expect(evaluar({ texto }).corta).toBe(false);

    const resultado = evaluar({
      texto,
      patronesAdicionales: [
        { id: 'producto_retirado', categoria: 'contenido_clinico', regex: /\bmarca\s+x\b/ },
      ],
    });

    expect(resultado.corta).toBe(true);
  });

  it('no hay forma de que la configuración desactive un patrón del catálogo', () => {
    // `evaluar` concatena catálogo y extras; no acepta exclusiones ni
    // sustituciones. El peor error posible en un YAML es cortar de más.
    const resultado = evaluar({
      texto: 'estoy sangrando',
      patronesAdicionales: [{ id: 'sangrado', categoria: 'baja', regex: /nunca_coincide/ }],
    });

    expect(resultado.corta).toBe(true);
    if (resultado.corta) expect(resultado.categoria).toBe('urgencia_clinica');
  });
});

describe('normalización', () => {
  it('quita tildes, mayúsculas, puntuación y repeticiones', () => {
    expect(normalizar('¡¡Me DUELEEEE muchísimo!!')).toBe('me duelee muchisimo');
  });

  it('la eñe se convierte en n, que es como la gente escribe de verdad', () => {
    expect(normalizar('tengo 16 años')).toBe(normalizar('tengo 16 anos'));
  });
});

describe('el catálogo está sano', () => {
  it('no hay identificadores de patrón repetidos', () => {
    const ids = CATALOGO.map((p) => p.id);

    expect(ids.length).toBe(new Set(ids).size);
  });

  it('ningún patrón coincide con la cadena vacía', () => {
    const vacios = CATALOGO.filter((p) => p.regex.test('')).map((p) => p.id);

    expect(vacios).toEqual([]);
  });

  it('todas las categorías tienen al menos un patrón', () => {
    for (const categoria of CATEGORIAS) {
      expect(CATALOGO.filter((p) => p.categoria === categoria).length).toBeGreaterThan(0);
    }
  });
});
