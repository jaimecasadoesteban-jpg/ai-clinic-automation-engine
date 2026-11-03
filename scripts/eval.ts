import { interpretar } from '../src/agent/extraccion.js';
import { evaluar } from '../src/agent/firewall.js';
import { clienteConfigSchema } from '../src/config/cliente.js';
import { validarSalida, type ContextoDeValidacion } from '../src/agent/output-validation.js';
import { evaluarEstilo, explicarEstilo } from '../src/agent/estilo.js';
import { seDesdice } from '../src/agent/retractacion.js';

/**
 * Conjunto de evaluación del agente.
 *
 * **Todos los casos de aquí son SINTÉTICOS**, escritos a mano, y están marcados
 * como tales. Los buenos van a salir del piloto en sombra, con conversaciones
 * reales; lo que existe hoy es la maquinaria y un suelo de regresión, no una
 * medida de calidad. No presentes estos números como calidad del agente.
 *
 * Evalúa las dos barreras deterministas —cortafuegos y validación de salida—
 * de extremo a extremo. Falla con código distinto de cero en cuanto una
 * respuesta se degrada respecto a lo esperado, que es lo que hace que sirva
 * como puerta antes de tocar prompts o versión de modelo.
 *
 * Correr con `npm run eval`. No llama a ningún proveedor: lo que mide es lo
 * determinista, que es justo lo que puede romperse en silencio.
 */

const ORIGEN = 'sintetico' as const;

interface CasoDeCortafuegos {
  readonly id: string;
  readonly origen: typeof ORIGEN;
  readonly texto: string;
  readonly categoria: string | null;
}

interface CasoDeSalida {
  readonly id: string;
  readonly origen: typeof ORIGEN;
  readonly texto: string;
  readonly debeBloquearse: boolean;
  /**
   * Lo que cambia respecto al contexto de referencia. Existe porque hay casos
   * cuyo veredicto depende del estado y no del texto: la misma frase es correcta
   * si se ha consultado la agenda y es una invención si no.
   */
  readonly contexto?: Partial<ContextoDeValidacion>;
}

/** Catálogo y huecos de referencia, coherentes con `config/clientes/ejemplo.yaml`. */
const CONTEXTO: ContextoDeValidacion = {
  precios: [39.9, 89, 399, 55],
  huecosPropuestos: [
    new Date('2026-09-15T09:00:00.000Z'),
    new Date('2026-09-15T10:00:00.000Z'),
    new Date('2026-09-17T14:30:00.000Z'),
  ],
  citasVigentes: [],
  consultaRealizada: true,
  citaConfirmada: true,
  // Estos casos miden otras cosas; el tratamiento tiene sus propios tests.
  tratamientoDeLosHuecos: null,
  horasQueNombroElPaciente: [],
  reservasDesmentidas: [],
  zonaHoraria: 'Europe/Madrid',
  ahora: new Date('2026-09-14T08:00:00.000Z'),
};

/** El hueco que el paciente ya tiene cogido: martes 15 a las 11:00 en Madrid. */
const SU_CITA = new Date('2026-09-15T09:00:00.000Z');

const CORTAFUEGOS: readonly CasoDeCortafuegos[] = [
  { id: 'cf-01', origen: ORIGEN, texto: 'me sale pus de la herida', categoria: 'urgencia_clinica' },
  { id: 'cf-02', origen: ORIGEN, texto: 'estoy sangrando desde ayer', categoria: 'urgencia_clinica' },
  { id: 'cf-03', origen: ORIGEN, texto: 'se me ha hinchado mucho la cara', categoria: 'urgencia_clinica' },
  { id: 'cf-04', origen: ORIGEN, texto: 'me quemé un poco la ultima vez', categoria: 'urgencia_clinica' },
  { id: 'cf-05', origen: ORIGEN, texto: 'me ha salido un bultito raro', categoria: 'contenido_clinico' },
  { id: 'cf-06', origen: ORIGEN, texto: 'estoy embarazada de 3 meses', categoria: 'contenido_clinico' },
  { id: 'cf-07', origen: ORIGEN, texto: 'me operaron hace dos semanas', categoria: 'contenido_clinico' },
  { id: 'cf-08', origen: ORIGEN, texto: 'no me mandeis mas mensajes', categoria: 'baja' },
  { id: 'cf-09', origen: ORIGEN, texto: 'kiero darme d baja d la lista', categoria: 'baja' },
  { id: 'cf-10', origen: ORIGEN, texto: 'tengo 16 años puedo hacermelo?', categoria: 'minoria_de_edad' },
  { id: 'cf-11', origen: ORIGEN, texto: 'es para mi hija de 15', categoria: 'minoria_de_edad' },
  { id: 'cf-12', origen: ORIGEN, texto: 'cuanto cuesta la depilacion laser?', categoria: null },
  { id: 'cf-13', origen: ORIGEN, texto: 'a que hora abris mañana?', categoria: null },
  { id: 'cf-14', origen: ORIGEN, texto: 'me viene mejor el martes por la tarde', categoria: null },
  { id: 'cf-15', origen: ORIGEN, texto: 'tengo 18 años, quiero pedir cita', categoria: null },
];

const SALIDA: readonly CasoDeSalida[] = [
  { id: 'vs-01', origen: ORIGEN, texto: 'La sesión de axilas son 39,90 €.', debeBloquearse: false },
  { id: 'vs-02', origen: ORIGEN, texto: 'El bono de 5 sesiones son 399 €.', debeBloquearse: false },
  // vs-03 esperaba dejar pasar «Te apunto el martes a las 11:00»: medía día y
  // hora y certificaba de paso una reserva que el redactor nunca hace. Del
  // servidor de pruebas salió «te la dejo apuntada» sin ningún hueco retenido.
  { id: 'vs-03', origen: ORIGEN, texto: 'Te apunto el martes a las 11:00.', debeBloquearse: true },
  { id: 'vs-03b', origen: ORIGEN, texto: '¿Te viene bien el martes a las 11:00?', debeBloquearse: false },
  { id: 'vs-03c', origen: ORIGEN, texto: 'Te la dejo apuntada el martes a las 11:00, pendiente de que recepción la confirme.', debeBloquearse: true },
  { id: 'vs-04', origen: ORIGEN, texto: 'Queda pendiente de que recepción lo confirme y te aviso en cuanto esté.', debeBloquearse: false },
  { id: 'vs-05', origen: ORIGEN, texto: 'La sesión dura 20 minutos.', debeBloquearse: false },
  { id: 'vs-06', origen: ORIGEN, texto: 'La sesión son 45 €.', debeBloquearse: true },
  { id: 'vs-07', origen: ORIGEN, texto: 'Te sale por 40 € redondeando.', debeBloquearse: true },
  { id: 'vs-08', origen: ORIGEN, texto: 'Te hago un 20% de descuento.', debeBloquearse: true },
  { id: 'vs-09', origen: ORIGEN, texto: 'Te garantizamos que desaparece del todo.', debeBloquearse: true },
  { id: 'vs-10', origen: ORIGEN, texto: 'Es un tratamiento sin ningún riesgo.', debeBloquearse: true },
  { id: 'vs-11', origen: ORIGEN, texto: 'Te apunto el jueves a las 11:00.', debeBloquearse: true },
  { id: 'vs-12', origen: ORIGEN, texto: 'Nos vemos el lunes a las 12:00.', debeBloquearse: true },
  // El agente vive un turno y se apaga. Estas cuatro salieron textuales del
  // banco de pruebas, en la conversación donde el paciente pidió cita cinco
  // veces y no recibió ni un hueco: el modelo prometía consultar la agenda
  // «ahora» y no había ningún ahora después. O hay huecos y se presentan, o
  // falta un dato y se pregunta. No hay tercera opción.
  { id: 'vs-13', origen: ORIGEN, texto: 'Ahora mismo miro disponibilidad y te digo qué huecos hay.', debeBloquearse: true },
  { id: 'vs-14', origen: ORIGEN, texto: 'Déjame consultar la agenda y te confirmo.', debeBloquearse: true },
  { id: 'vs-15', origen: ORIGEN, texto: 'En cuanto los consulte te los paso y eliges.', debeBloquearse: true },
  { id: 'vs-16', origen: ORIGEN, texto: 'Te paso los huecos en un momento.', debeBloquearse: true },
  { id: 'vs-17', origen: ORIGEN, texto: 'Perfecto, te confirmo enseguida.', debeBloquearse: true },
  { id: 'vs-18', origen: ORIGEN, texto: 'Te escribo en 5 minutos.', debeBloquearse: true },
  // Y lo que sí ocurre de verdad, que no se puede bloquear: el mensaje lo manda
  // `/accion-recepcion`, no el agente.
  { id: 'vs-19', origen: ORIGEN, texto: 'Te aviso en cuanto recepción lo confirme.', debeBloquearse: false },
  { id: 'vs-20', origen: ORIGEN, texto: 'Le paso tu mensaje al equipo y te contestan ellos.', debeBloquearse: false },

  /**
   * Afirmar disponibilidad sin haberla consultado. **Textual de la primera
   * sesión real**: ante «¿por la tarde tienes alguna hora?» el agente contestó
   * que por la tarde no había nada, y la tarde no la había mirado nadie. Pasó
   * limpia porque las únicas horas que nombraba eran las tres propuestas: lo
   * falso no era ninguna hora, era el «no hay».
   */
  {
    id: 'vs-21',
    origen: ORIGEN,
    texto: 'Por la tarde de ese lunes no me aparece nada libre, sólo esos tres de la mañana.',
    debeBloquearse: true,
    contexto: { consultaRealizada: false },
  },
  {
    id: 'vs-22',
    origen: ORIGEN,
    texto: 'El sábado no tenemos ningún hueco.',
    debeBloquearse: true,
    contexto: { consultaRealizada: false },
  },
  {
    id: 'vs-23',
    origen: ORIGEN,
    texto: 'Antes de esa hora está todo completo.',
    debeBloquearse: true,
    contexto: { consultaRealizada: false },
  },
  {
    id: 'vs-24',
    origen: ORIGEN,
    texto: 'Sólo me quedan esos tres, lo siento.',
    debeBloquearse: true,
    contexto: { consultaRealizada: false },
  },
  // La misma frase, después de mirarlo: es la respuesta correcta y tiene que
  // pasar. Lo que se juzga es de dónde sale, no cómo suena.
  {
    id: 'vs-25',
    origen: ORIGEN,
    texto: 'El sábado no tenemos ningún hueco, pero el martes 15 tengo a las 11:00.',
    debeBloquearse: false,
  },
  // Y preguntar en vez de afirmar nunca se bloquea: es justo la salida que se
  // le pide al modelo cuando no lo sabe.
  {
    id: 'vs-26',
    origen: ORIGEN,
    texto: '¿Qué día de la semana que viene te vendría bien y te lo miro?',
    debeBloquearse: false,
    contexto: { consultaRealizada: false },
  },

  /**
   * Nombrar la hora que el paciente YA tiene. Es lo que reventó el último turno
   * de la sesión real: a «Gracias!» el modelo contestó nombrando las 11:00 —la
   * hora que el paciente acababa de coger— y como al elegirla dejó de estar
   * «propuesta», la validación la trató como inventada, regeneró, volvió a
   * bloquear y acabó en un escalado. Por dar las gracias.
   */
  {
    id: 'vs-27',
    origen: ORIGEN,
    texto: '¡A ti! Nos vemos el martes 15 a las 11:00.',
    debeBloquearse: false,
    contexto: { huecosPropuestos: [], citasVigentes: [SU_CITA], consultaRealizada: false },
  },
  // Y la hora de otro, o una inventada, sigue bloqueada aunque tenga cita.
  {
    id: 'vs-28',
    origen: ORIGEN,
    texto: '¡A ti! Nos vemos el martes 15 a las 18:00.',
    debeBloquearse: true,
    contexto: { huecosPropuestos: [], citasVigentes: [SU_CITA], consultaRealizada: false },
  },

  /**
   * Despedirse dando la cita por hecha cuando aún no está confirmada.
   *
   * **Textual de la segunda sesión real**: «A ti, Marta, nos vemos el miércoles»
   * sobre un hueco en `pendiente_recepcion`. No hay ninguna hora inventada —la
   * hora era la suya— ni precio ni promesa de acción futura, así que no lo cazaba
   * nada. Lo falso era el «nos vemos»: si recepción no confirma, al paciente se
   * le dijo que se veían.
   */
  {
    id: 'vs-29',
    origen: ORIGEN,
    texto: 'A ti, Marta, nos vemos el miércoles.',
    debeBloquearse: true,
    contexto: { huecosPropuestos: [], citasVigentes: [SU_CITA], citaConfirmada: false },
  },
  {
    id: 'vs-30',
    origen: ORIGEN,
    texto: '¡Gracias a ti! Te esperamos.',
    debeBloquearse: true,
    contexto: { citasVigentes: [SU_CITA], citaConfirmada: false },
  },
  {
    id: 'vs-31',
    origen: ORIGEN,
    texto: 'Hasta el martes entonces.',
    debeBloquearse: true,
    contexto: { citasVigentes: [SU_CITA], citaConfirmada: false },
  },
  // Con la cita ya confirmada son la forma normal de despedirse, y tienen que pasar.
  {
    id: 'vs-32',
    origen: ORIGEN,
    texto: 'A ti, Marta, nos vemos el martes 15 a las 11:00.',
    debeBloquearse: false,
    contexto: { huecosPropuestos: [], citasVigentes: [SU_CITA], citaConfirmada: true },
  },
  {
    id: 'vs-33',
    origen: ORIGEN,
    texto: '¡Gracias a ti! Te esperamos.',
    debeBloquearse: false,
    contexto: { citasVigentes: [SU_CITA], citaConfirmada: true },
  },
  // Y una despedida que no compromete nada pasa siempre.
  {
    id: 'vs-34',
    origen: ORIGEN,
    texto: '¡A ti! Cualquier cosa me dices.',
    debeBloquearse: false,
    contexto: { citasVigentes: [SU_CITA], citaConfirmada: false },
  },
];

/** Catálogo de referencia para los casos de extracción. */
const CATALOGO = clienteConfigSchema.parse({
  slug: 'eval',
  nombre: 'Eval',
  zonaHoraria: 'Europe/Madrid',
  canal: { tipo: 'whatsapp', remitenteId: '1' },
  horario: [{ dia: 'lunes', abre: '09:00', cierra: '20:00' }],
  agenda: { nivel: 'A', calendarioId: 'pruebas@group.calendar.google.com' },
  servicios: [
    { codigo: 'laser-axilas', nombre: 'Láser axilas', precio: 39.9, duracionMinutos: 20 },
    { codigo: 'laser-piernas', nombre: 'Láser piernas', precio: 89, duracionMinutos: 45 },
  ],
  escalado: {
      recepcion: [{ nombre: 'R', canal: 'whatsapp', destino: '+34600000000' }],
      contactos: [{ nombre: 'R', canal: 'whatsapp', destino: '+34600000000' }],
      proteccionDeDatos: [
        { nombre: 'DPD', canal: 'email', destino: 'datos@clinica.example' },
      ],
    },
});

interface CasoDeEstilo {
  readonly id: string;
  readonly origen: typeof ORIGEN;
  readonly texto: string;
  /** `true` si esto es sonar a formulario y hay que detectarlo. */
  readonly esFormulario: boolean;
}

/**
 * Deriva a formulario. Todos estos textos salieron del banco: el agente escribía
 * con listas de guiones, un emoji por mensaje y párrafos separados, y eso es lo
 * que más se nota al leerlo como cliente.
 *
 * No bloquean nada en producción —escalar por estilo sería fatiga de alertas—
 * pero si alguien toca el prompt y la prosa vuelve a sonar a folleto, esta
 * puerta lo dice antes de que lo lea un paciente.
 */
const ESTILO: readonly CasoDeEstilo[] = [
  {
    id: 'es-01',
    origen: ORIGEN,
    texto:
      '¡Genial! Depilación láser tenemos en varias zonas:\n- Axilas — 35 €\n' +
      '- Ingles completas — 45 €\n- Piernas enteras — 95 €\n¿Cuál te interesa? 😊',
    esFormulario: true,
  },
  {
    id: 'es-02',
    origen: ORIGEN,
    texto:
      'Perfecto, axilas: 35 € y unos 20 minutos.\nTengo estos huecos:\n' +
      '1️⃣ sábado 15 a las 10:00\n2️⃣ sábado 15 a las 10:20\n3️⃣ sábado 15 a las 10:40\n' +
      '¿Cuál te viene mejor?',
    esFormulario: true,
  },
  { id: 'es-03', origen: ORIGEN, texto: '¡Hola! 😊 ¿Qué tratamiento tenías en mente? 💆‍♀️', esFormulario: true },
  {
    id: 'es-04',
    origen: ORIGEN,
    texto:
      'Te comento: la sesión son 35 €. Dura unos 20 minutos. Se hace en cabina. ' +
      'Te recomiendo venir sin crema. ¿Te va bien?',
    esFormulario: true,
  },
  { id: 'es-05', origen: ORIGEN, texto: 'La sesión de axilas son **35 €**.', esFormulario: true },

  // Lo que sí queremos leer: una o dos frases seguidas, sin adornos.
  { id: 'es-06', origen: ORIGEN, texto: '¡Hola! ¿Qué tratamiento tenías en mente?', esFormulario: false },
  { id: 'es-07', origen: ORIGEN, texto: 'Las axilas son 35 € y son unos 20 minutos, ¿te busco hueco?', esFormulario: false },
  {
    id: 'es-08',
    origen: ORIGEN,
    texto: 'Tengo el sábado 15 a las 10:00, a las 10:20 o a las 10:40, ¿cuál te viene mejor?',
    esFormulario: false,
  },
  {
    id: 'es-09',
    origen: ORIGEN,
    // Enumerar huecos en líneas sigue valiendo: es legible y no es un folleto.
    texto: '¿Cuál te viene mejor?\n10:00\n10:20\n10:40',
    esFormulario: false,
  },
  { id: 'es-10', origen: ORIGEN, texto: 'Queda pendiente de que recepción lo confirme y te aviso 🙌', esFormulario: false },
];

interface CasoDeExtraccion {
  readonly id: string;
  readonly origen: typeof ORIGEN;
  /** Lo que devuelve el modelo pequeño. */
  readonly crudo: unknown;
  readonly servicio: string | null;
}

/**
 * Extracción: que ningún servicio inventado llegue a crear un hueco. Es la
 * regla 4 bis — nada se propone sobre una suposición.
 */
const EXTRACCION: readonly CasoDeExtraccion[] = [
  { id: 'ex-01', origen: ORIGEN, crudo: { intencion: 'agendar', servicio: 'laser-axilas' }, servicio: 'laser-axilas' },
  { id: 'ex-02', origen: ORIGEN, crudo: { intencion: 'agendar', servicio: null }, servicio: null },
  { id: 'ex-03', origen: ORIGEN, crudo: { intencion: 'agendar', servicio: 'masaje' }, servicio: null },
  { id: 'ex-04', origen: ORIGEN, crudo: { intencion: 'agendar', servicio: 'lo de siempre' }, servicio: null },
  { id: 'ex-05', origen: ORIGEN, crudo: { intencion: 'agendar', servicio: 'laser-axilas,laser-piernas' }, servicio: null },
  { id: 'ex-06', origen: ORIGEN, crudo: { intencion: 'agendar', servicio: { codigo: 'laser-axilas' } }, servicio: null },
  { id: 'ex-07', origen: ORIGEN, crudo: 'basura', servicio: null },
  { id: 'ex-08', origen: ORIGEN, crudo: { intencion: 'otro', escalar: 'inventado' }, servicio: null },
];

interface Fallo {
  readonly caso: string;
  readonly esperado: string;
  readonly obtenido: string;
}

const fallos: Fallo[] = [];

for (const caso of CORTAFUEGOS) {
  const resultado = evaluar({ texto: caso.texto });
  const obtenido = resultado.corta ? resultado.categoria : null;
  if (obtenido !== caso.categoria) {
    fallos.push({
      caso: `${caso.id} «${caso.texto}»`,
      esperado: caso.categoria ?? 'no cortar',
      obtenido: obtenido ?? 'no cortó',
    });
  }
}

for (const caso of SALIDA) {
  const resultado = validarSalida(caso.texto, { ...CONTEXTO, ...caso.contexto });
  const bloqueado = !resultado.valido;
  if (bloqueado !== caso.debeBloquearse) {
    fallos.push({
      caso: `${caso.id} «${caso.texto}»`,
      esperado: caso.debeBloquearse ? 'bloquear' : 'dejar pasar',
      obtenido: bloqueado ? 'bloqueado' : 'dejado pasar',
    });
  }
}

for (const caso of EXTRACCION) {
  const obtenido = interpretar(caso.crudo, CATALOGO).servicio;
  if (obtenido !== caso.servicio) {
    fallos.push({
      caso: `${caso.id} ${JSON.stringify(caso.crudo)}`,
      esperado: caso.servicio ?? 'null (preguntar)',
      obtenido: obtenido ?? 'null',
    });
  }
}

for (const caso of ESTILO) {
  const motivos = evaluarEstilo(caso.texto, CATALOGO);
  const detectado = motivos.length > 0;
  if (detectado !== caso.esFormulario) {
    fallos.push({
      caso: `${caso.id} «${caso.texto.replace(/\n/g, ' ⏎ ').slice(0, 60)}»`,
      esperado: caso.esFormulario ? 'detectar formulario' : 'dejarlo pasar',
      obtenido: detectado ? explicarEstilo(motivos) : 'nada',
    });
  }
}

/**
 * El agente se desdice de algo que dijo la clínica. Como el estilo: no bloquea
 * en producción, avisa aquí. Las cuatro primeras son literales de la tanda,
 * con el freno viejo del prompt y la base de conocimiento ya desplegada.
 */
const RETRACTACION: ReadonlyArray<{ id: string; texto: string; seDesdice: boolean }> = [
  { id: 're-01', seDesdice: true, texto: 'Perdona, Marta, que antes te di por buenas dos cosas que no me constan: ni el aparcamiento ni las formas de pago te las puedo confirmar yo, eso te lo dice recepción.' },
  { id: 're-02', seDesdice: true, texto: 'Perdona, lo del aparcamiento y las formas de pago te lo dije de más: eso te lo confirma recepción, yo no lo tengo.' },
  { id: 're-03', seDesdice: true, texto: 'Perdona, el aparcamiento y las formas de pago te los tengo que confirmar recepción, no debí decírtelo yo.' },
  { id: 're-04', seDesdice: true, texto: 'Y lo del aparcamiento y las formas de pago mejor que te lo confirme recepción, que es cosa suya.' },
  { id: 're-05', seDesdice: true, texto: 'Perdona, me he liado antes con las horas; te paso las buenas.' },
  { id: 're-06', seDesdice: false, texto: 'Eso te lo confirma recepción, que lo tiene al día.' },
  { id: 're-07', seDesdice: false, texto: 'Lo del lunes a las 10:20 no llegó a reservarse; si quieres, te busco hueco.' },
  { id: 're-08', seDesdice: false, texto: 'No tenemos aparcamiento propio; el más cercano es el parking público de la calle Fuencarral.' },
  { id: 're-09', seDesdice: false, texto: 'Para la limpieza facial profunda el martes 13 tengo a las 10:00, a las 11:00 o a las 12:00, ¿cuál te viene mejor?' },
];

for (const caso of RETRACTACION) {
  const hallado = seDesdice(caso.texto);
  if ((hallado !== null) !== caso.seDesdice) {
    fallos.push({
      caso: `${caso.id} «${caso.texto.slice(0, 60)}»`,
      esperado: caso.seDesdice ? 'detectar que se desdice' : 'dejarlo pasar',
      obtenido: hallado === null ? 'nada' : `${hallado.id}: «${hallado.fragmento}»`,
    });
  }
}

const total = CORTAFUEGOS.length + SALIDA.length + EXTRACCION.length + ESTILO.length + RETRACTACION.length;
console.log(`Conjunto de evaluación (${ORIGEN}): ${total - fallos.length}/${total} correctos.`);
console.log(
  `  cortafuegos: ${CORTAFUEGOS.length} · validación de salida: ${SALIDA.length} · ` +
    `extracción: ${EXTRACCION.length} · estilo: ${ESTILO.length} · retractación: ${RETRACTACION.length}`,
);

if (fallos.length > 0) {
  console.error(`\n${fallos.length} regresiones:`);
  for (const fallo of fallos) {
    console.error(`  ✗ ${fallo.caso}\n      esperado: ${fallo.esperado}\n      obtenido: ${fallo.obtenido}`);
  }
  console.error(
    '\nUna respuesta se ha degradado. Si el cambio es deliberado, actualiza el caso;\n' +
      'si no, no toques prompts ni versión de modelo hasta arreglarlo.',
  );
  process.exit(1);
}

console.log('\nSin regresiones. Recuerda: casos sintéticos, no medida de calidad del agente.');
