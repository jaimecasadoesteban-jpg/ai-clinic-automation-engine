import type { ClienteConfig } from '../config/cliente.js';
import type { PromptPatient } from './prompt-boundary.js';
import { TURNOS_EN_VENTANA } from './models.js';

/**
 * Construcción del prompt. **Único camino hacia el modelo.**
 *
 * Regla 2: lo que entra aquí como paciente es un `PromptPatient` —dos campos,
 * `ref` y `nombre`— y no hay sobrecarga que acepte una fila de `patients`. El
 * teléfono y los apellidos no pueden llegar hasta aquí ni por descuido, porque
 * el tipo no los transporta.
 *
 * Sin RAG: la base de conocimiento de una clínica cabe en el prompt (5-15k
 * tokens) y va entera y versionada en el YAML.
 */

export interface TurnoDeConversacion {
  readonly rol: 'paciente' | 'clinica';
  readonly texto: string;
}

export interface EstadoDelSistema {
  readonly faltaServicio: boolean;
  readonly servicio: string | null;
  readonly preferencia: string | null;
  readonly preferenciaNoSatisfecha: boolean;
  readonly servicioCambiado: boolean;
  /** La cita que está cambiando, descrita, o `null`. */
  readonly reagendando: string | null;
  /** Se acaba de soltar su cita, y no hay nada nuevo todavía. */
  readonly cancelada: boolean;
  /** Hay huecos propuestos y no se sabe cuál quiere. */
  readonly faltaOpcion: boolean;
  /** `true` si la 2ª o la 3ª opción se apartan de lo que pidió. */
  readonly alternativasAlejadas: boolean;
  /** `true` si en este turno se ha consultado la agenda de verdad. */
  readonly consultada: boolean;
  /** Las citas que el paciente ya tiene: puede tener varias. */
  readonly citasVigentes: readonly { readonly descripcion: string; readonly confirmada: boolean }[];
  /** Tiene varias y no ha dicho cuál quiere cambiar o cancelar. */
  readonly preguntarCual: 'cambiar' | 'cancelar' | null;
  /** Lo que se le dijo y no era verdad, ya corregido. */
  readonly desmentidos: readonly string[];
  /** Eligió un hueco del mismo tratamiento que una cita suya: ¿en lugar o además? */
  readonly preguntarSiSustituye: {
    readonly nueva: string;
    readonly citas: readonly string[];
  } | null;
}

export interface EntradaDePrompt {
  readonly config: ClienteConfig;
  readonly paciente: PromptPatient;
  readonly turnos: readonly TurnoDeConversacion[];
  readonly resumen: string | null;
  readonly huecos?: readonly { inicio: Date; fin: Date }[];
  readonly estado?: EstadoDelSistema;
}

/** El catálogo, tal cual, para que el modelo no tenga que recordar un precio. */
function catalogo(config: ClienteConfig): string {
  return config.servicios
    .map((s) => {
      const bono = s.esBono ? ` (bono de ${s.sesiones} sesiones)` : '';
      return `- ${s.nombre}${bono}: ${s.precio.toFixed(2)} € · ${s.duracionMinutos} min`;
    })
    .join('\n');
}

function horario(config: ClienteConfig): string {
  return config.horario.map((h) => `- ${h.dia}: ${h.abre} a ${h.cierra}`).join('\n');
}

/**
 * Los datos prácticos de la clínica, con el nombre con que se le enseñan al
 * modelo. El orden es el del YAML.
 */
const TEMAS_DE_LA_CLINICA = [
  ['direccion', 'dirección'],
  ['aparcamiento', 'aparcamiento'],
  ['formasDePago', 'formas de pago'],
  ['cancelacion', 'política de cancelación'],
  ['primeraVisita', 'primera visita'],
] as const;

/**
 * **Lo que el modelo sabe de la clínica es exactamente lo que tiene el YAML.**
 *
 * Aquí hubo un freno —«dirección, aparcamiento, formas de pago… NO lo sabes,
 * dile que se lo confirma recepción»— puesto cuando la base de conocimiento no
 * existía y el modelo la inventaba. Se construyó la base, se compuso desde el
 * YAML, y el freno siguió aquí. En la primera conversación con las dos cosas
 * desplegadas, el paciente preguntó por el aparcamiento y el pago, recibió las
 * respuestas compuestas —verdaderas—, pidió cita, y el modelo, que veía en el
 * historial a «la clínica» hablando de lo que su prompt decía que no sabía, se
 * desdijo de las dos: «antes te di por buenas dos cosas que no me constan».
 *
 * Por eso lo conocido y lo desconocido salen **del mismo sitio**: lo que tiene
 * dato se le enseña, y sólo lo que no lo tiene se le dice que no lo sabe. No hay
 * una lista escrita a mano que pueda quedarse atrás.
 */
export function datosDeLaClinica(config: ClienteConfig): {
  sabidos: string[];
  desconocidos: string[];
} {
  const sabidos: string[] = [];
  const desconocidos: string[] = [];
  for (const [campo, nombre] of TEMAS_DE_LA_CLINICA) {
    const valor = config.informacion[campo];
    if (valor === undefined) desconocidos.push(nombre);
    else sabidos.push(`- ${nombre[0]?.toUpperCase() ?? ''}${nombre.slice(1)}: ${valor}`);
  }

  const conPreparacion = config.servicios.filter((s) => s.preparacion !== undefined);
  const sinPreparacion = config.servicios.filter((s) => s.preparacion === undefined);
  for (const s of conPreparacion) sabidos.push(`- Cómo venir a ${s.nombre}: ${s.preparacion ?? ''}`);
  if (sinPreparacion.length === config.servicios.length) {
    desconocidos.push('cómo prepararse para un tratamiento');
  } else if (sinPreparacion.length > 0) {
    desconocidos.push(`cómo prepararse para ${sinPreparacion.map((s) => s.nombre).join(', ')}`);
  }
  // No hay campo para esto en ninguna clínica: depende de cada paciente.
  desconocidos.push('cuántas sesiones hacen falta');
  return { sabidos, desconocidos };
}

function huecosPropuestos(
  huecos: readonly { inicio: Date; fin: Date }[],
  zonaHoraria: string,
): string {
  const dtf = new Intl.DateTimeFormat('es-ES', {
    timeZone: zonaHoraria,
    weekday: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return huecos.map((h, i) => `${i + 1}. ${dtf.format(h.inicio)}`).join('\n');
}

function conocimiento(config: ClienteConfig): string[] {
  const { sabidos, desconocidos } = datosDeLaClinica(config);
  return [
    ...(sabidos.length === 0
      ? []
      : [
          'DATOS DE LA CLÍNICA (escritos y aprobados por la clínica; si sale el tema,',
          'dilo con estas palabras y no añadas nada):',
          ...sabidos,
          '',
          'Si en la conversación la clínica ya ha contestado algo de esto, salió de',
          'aquí y es verdad: no te desdigas ni lo pongas en duda.',
          '',
        ]),
    'DE LA CLÍNICA SÓLO SABES LO QUE PONE AQUÍ. No supongas ni cuentes «lo',
    'habitual»: lo que digas lo lee el paciente como palabra de la clínica.',
    `NO SABES: ${desconocidos.join('; ')}. Si te preguntan por eso, dile que se lo confirma recepción.`,
  ];
}

const REGISTRO: Record<ClienteConfig['tono']['registro'], string> = {
  cercano: 'Cercano y natural, como quien conoce al paciente. Tutea.',
  neutro: 'Neutro y claro. Tutea.',
  formal: 'Formal y cuidado. Trata de usted.',
};

/**
 * Cómo se escribe, no sólo con qué actitud.
 *
 * El agente escribía como un formulario —listas con guiones, emoji en cada
 * mensaje, párrafos separados, «¡Genial!» encadenados— y eso es lo que más se
 * nota al leerlo como cliente. El listón es un prompt suelto sin barreras, que
 * conversa mejor: las barreras son innegociables, pero la prosa robótica no es
 * el precio de tenerlas.
 *
 * Todo esto sale del YAML (regla 7): una clínica puede querer usted, tres frases
 * o cero emojis.
 */
function estilo(config: ClienteConfig): string[] {
  const t = config.tono;
  const lineas = [
    'CÓMO ESCRIBES:',
    `- Escribes por WhatsApp, como la recepcionista de la clínica. ${REGISTRO[t.registro]}`,
    `- ${t.frasesMaximas} frase${t.frasesMaximas === 1 ? '' : 's'} como mucho por mensaje,` +
      ' seguidas, sin saltos de línea. La excepción es enumerar huecos.',
  ];

  if (!t.permiteListas) {
    lineas.push(
      '- Nada de listas con guiones ni numeradas, nada de negritas, nada de',
      '  títulos. Si tienes que dar varias cosas, van en la frase.',
    );
  }

  lineas.push(
    t.emojisMaximos === 0
      ? '- Sin emojis.'
      : `- Como mucho ${t.emojisMaximos} emoji, y NO en todos los mensajes. Si el` +
        ' anterior llevaba, éste no.',
    '- Los precios se dicen dentro de la frase («las axilas son 35 €»), nunca en' +
      ' una ficha ni en una lista.',
    `- No empieces con muletillas tipo ${t.muletillasProhibidas
      .map((m) => `«${m}»`)
      .join(', ')}, y menos aún encadenadas.`,
    '- Cuando des tres huecos, que se lean de corrido y breves. Nada de emojis de',
    '  números ni de una ficha por hueco.',
    '- No repitas lo que acaba de decir el paciente antes de contestarle.',
    // Medido en el banco: al pedir otra franja u otro día, 2 de cada 6 respuestas
    // empezaban con «perdona, me he liado antes» o «me he equivocado con las
    // horas de antes». No había ningún error. Una clínica que lee eso en sus
    // conversaciones entiende que el sistema se equivoca.
    '- No pidas perdón ni digas que te has liado o equivocado si no hay, en esta',
    '  conversación, algo concreto que dijiste mal y estás corrigiendo. Que ahora',
    '  tengas otros huecos porque el paciente pide otro día u otra franja NO es un',
    '  error tuyo: preséntalos sin más.',
  );

  return lineas;
}

/**
 * El prompt de sistema. Estable entre turnos a propósito: nada de fechas ni de
 * identificadores aquí, para que la caché de prefijo del proveedor pueda servir
 * de algo cuando haya tráfico seguido.
 */
export function construirSistema(entrada: EntradaDePrompt): string {
  const { config } = entrada;
  const partes = [
    `Eres quien atiende el WhatsApp de ${config.nombre}, una clínica de medicina estética.`,
    '',
    ...estilo(config),
    '',
    'CATÁLOGO Y PRECIOS (los únicos válidos):',
    catalogo(config),
    '',
    'HORARIO:',
    horario(config),
    '',
    'REGLAS QUE NO PUEDES SALTARTE:',
    '- Los precios son EXACTAMENTE los del catálogo. No redondees, no sumes, no estimes.',
    '- No ofrezcas descuentos, regalos, promociones ni sesiones gratis. No existen.',
    '- No prometas resultados, no digas que algo es definitivo, permanente, seguro o sin riesgo.',
    '- No des consejo sanitario, ni diagnostiques, ni valores síntomas.',
    // Las horas que puede nombrar son las mismas que acepta la validación, ni
    // una menos: si el prompt le prohíbe algo que luego ve en el historial —la
    // hora de su propia cita—, lo que sale es una retractación o un silencio raro.
    '- Las únicas horas que puedes OFRECER son las de los huecos propuestos. Además',
    '  puedes nombrar las citas que el paciente ya tiene (están en el ESTADO) y, para',
    '  decirle que no está libre, la hora que él mismo te acaba de pedir.',
    '- Una cita sólo está confirmada si el ESTADO dice que lo está. Si no lo dice,',
    '  no la des por confirmada.',
    '- Mensajes cortos, de WhatsApp. Una idea por mensaje.',
    '',
    ...conocimiento(config),
    '',
    'NO AFIRMES LO QUE HAY O NO HAY EN LA AGENDA SI NO TE LO DICE EL SISTEMA.',
    'Tú no ves la agenda: ves lo que este mensaje te pone delante. Los huecos',
    'propuestos son los que se le han buscado, NO son todo lo que existe, y de',
    'lo que no aparece ahí no sabes nada. Prohibido decir «por la tarde no hay',
    'nada», «está todo lleno», «sólo me quedan ésos» o «el sábado no tenemos',
    'hueco» si el sistema no te ha dicho que se ha mirado.',
    'Si te preguntan por un día o una franja que no tienes delante, no lo',
    'resuelvas por tu cuenta: dile que se lo miras si te confirma qué día o qué',
    'franja quiere, y deja que el sistema consulte en el turno siguiente.',
    '',
    'NO PROMETAS NADA QUE VAYAS A HACER DESPUÉS.',
    'Sólo existes durante este mensaje: no puedes consultar nada más tarde, ni',
    'escribir por tu cuenta, ni volver. Prohibido decir «ahora miro», «déjame',
    'consultar», «te paso los huecos», «en cuanto lo mire te digo», «te escribo',
    'luego» o cualquier variante. Dejarías al paciente esperando algo que no va',
    'a llegar nunca.',
    'En cada mensaje: o hay huecos y se los presentas, o falta un dato y se lo',
    'preguntas. No hay una tercera opción.',
  ];

  // Regla 4 bis: el mensaje y el estado del sistema tienen que coincidir. Estas
  // líneas describen lo que el sistema HA HECHO de verdad, para que el modelo no
  // pueda dar a entender otra cosa.
  const estado = entrada.estado;
  if (estado?.faltaServicio === true) {
    partes.push(
      '',
      'ESTADO: NO se ha reservado ni propuesto ningún hueco, porque todavía no',
      'se sabe qué tratamiento quiere. Tu único trabajo en este mensaje es',
      'preguntárselo, ofreciéndole las opciones del catálogo.',
      'NO menciones horas, días ni huecos: no existe ninguno.',
    );
  }

  if (estado?.reagendando !== null && estado?.reagendando !== undefined) {
    partes.push(
      '',
      `ESTADO: el paciente quiere CAMBIAR esta cita: ${estado.reagendando}. Esa cita`,
      'sigue en pie hasta que elija una nueva, así que no le digas que la ha',
      'perdido. Preséntale las opciones con naturalidad. Sus otras citas, si tiene,',
      'no se tocan.',
    );
  }

  if (estado !== undefined && estado.desmentidos.length > 0) {
    partes.push(
      '',
      'ESTADO: en esta conversación la clínica le dijo algo que NO era verdad:',
      ...estado.desmentidos.map((d) => `- ${d}`),
      'Si el paciente lo menciona o habla como si fuera cierto, aclárale la verdad',
      'con naturalidad y en una frase («lo del lunes a las 10:20 no llegó a',
      'reservarse»). Si no sale, no lo saques tú. Nunca lo vuelvas a dar por hecho.',
    );
  }

  if (estado?.faltaOpcion === true) {
    partes.push(
      '',
      'ESTADO: hay huecos propuestos pero NO se sabe cuál quiere, así que no se',
      'ha reservado ninguno. Pregúntale cuál prefiere. No des por hecho que',
      'quiere el primero.',
    );
  }

  if (estado?.preguntarCual !== null && estado?.preguntarCual !== undefined) {
    const accion = estado.preguntarCual === 'cambiar' ? 'cambiar' : 'cancelar';
    partes.push(
      '',
      `ESTADO: quiere ${accion} una cita pero tiene varias y no ha dicho cuál. NO se`,
      `ha tocado ninguna. Tu único trabajo es preguntarle cuál quiere ${accion},`,
      'nombrándolas por tratamiento y día. No propongas horas.',
    );
  }

  if (estado?.preguntarSiSustituye !== null && estado?.preguntarSiSustituye !== undefined) {
    const p = estado.preguntarSiSustituye;
    partes.push(
      '',
      `ESTADO: ha elegido ${p.nueva}, pero ya tiene una cita del mismo tratamiento`,
      `(${p.citas.join('; ')}). Puede ser un cambio o una sesión más, así que`,
      'TODAVÍA NO SE HA RESERVADO NADA y su cita sigue en pie. Pregúntale, en una',
      'frase, si la quiere en lugar de la que tiene o además. No digas que está',
      'guardada ni apuntada.',
    );
  }

  if (estado !== undefined && estado.citasVigentes.length === 0) {
    // Del banco de pruebas: sin ninguna cita cogida, «quiero cambiar la cita»
    // hizo que el modelo preguntara «¿la facial o la de axilas?», leyendo el
    // historial como si lo hablado fueran citas. Lo que dice el estado manda.
    partes.push(
      '',
      'ESTADO: este paciente NO tiene ninguna cita cogida ahora mismo. Si habla de',
      '«su cita», de cambiarla o de cancelarla, díselo: no hay ninguna que tocar.',
      'Lo que se haya hablado antes en la conversación no son citas.',
    );
  }

  if (estado !== undefined && estado.citasVigentes.length > 0) {
    const citas = estado.citasVigentes;
    partes.push(
      '',
      citas.length === 1
        ? `ESTADO: este paciente YA tiene hora cogida: ${citas[0]?.descripcion ?? ''}.`
        : 'ESTADO: este paciente YA tiene estas citas:',
      ...(citas.length === 1 ? [] : citas.map((c) => `- ${c.descripcion}`)),
      'Puedes nombrarlas con toda tranquilidad: son suyas y son reales. No le',
      'propongas otras horas ni le ofrezcas cambiarlas si no te lo pide. Si sólo',
      'se despide o da las gracias, despídete tú también y ya está.',
    );

    if (citas.every((c) => c.confirmada)) {
      partes.push(
        citas.length === 1
          ? 'Su cita está CONFIRMADA, así que puedes despedirte contando con ella.'
          : 'Todas están CONFIRMADAS, así que puedes despedirte contando con ellas.',
      );
    } else {
      partes.push(
        '',
        citas.length === 1
          ? 'PERO esa cita NO está confirmada todavía: la tiene que pasar a la agenda'
          : 'PERO no todas están confirmadas todavía: las tiene que pasar a la agenda',
        'una persona de la clínica. Así que al despedirte NO des por hecho que',
        'ocurre. Prohibido «nos vemos», «te espero», «hasta el miércoles»,',
        '«quedamos el jueves» y cualquier variante. Si recepción no la confirma,',
        'le habrás dicho que os veíais. Despídete sin comprometer la cita: un',
        '«cualquier cosa me dices» sirve.',
      );
    }
  }

  if (estado?.consultada === false && (entrada.huecos ?? []).length === 0) {
    partes.push(
      '',
      'ESTADO: en este mensaje NO se ha consultado la agenda. No afirmes que hay',
      'ni que no hay disponibilidad, ni en un día ni en una franja: no lo sabes.',
    );
  }

  if (estado?.cancelada === true) {
    partes.push(
      '',
      'ESTADO: su cita queda cancelada y el hueco liberado. Confírmaselo en una',
      'frase y ofrécele volver a pedir cuando quiera. No le propongas horas.',
    );
  }

  if (entrada.huecos !== undefined && entrada.huecos.length > 0) {
    if (estado?.servicioCambiado === true) {
      partes.push(
        '',
        'ESTADO: el paciente ha cambiado de tratamiento. Los huecos que se le',
        'habían propuesto antes ya NO valen; dilo con naturalidad.',
      );
    }
    if (estado?.preferenciaNoSatisfecha === true) {
      partes.push(
        '',
        `ESTADO: pidió «${estado.preferencia ?? ''}» y no hay nada disponible así.`,
        'Reconócelo antes de proponerle lo que sí hay. No se lo ocultes.',
      );
    } else if (estado?.preferencia !== null && estado?.preferencia !== undefined) {
      partes.push('', `El paciente prefiere: ${estado.preferencia}.`);
    }
    if (estado?.alternativasAlejadas === true) {
      partes.push(
        '',
        'ESTADO: la PRIMERA opción es la que pidió; las otras NO lo son, están',
        'antes en el tiempo. Dilo con naturalidad, en la misma frase, tipo «y si',
        'te corre prisa, tengo…». No las presentes como si también encajaran con',
        'lo que pidió: sería hacerle creer que le hemos buscado eso y no había.',
      );
    }
    if (estado?.servicio !== null && estado?.servicio !== undefined) {
      partes.push(
        '',
        `Tratamiento: ${estado.servicio}. NÓMBRALO en la frase en que das los huecos:`,
        'el paciente tiene que saber de qué es la cita, no sólo cuándo.',
      );
    }
    partes.push(
      '',
      // Regla 4 bis. El agente escribió «te lo dejo apuntado» sobre un hueco que
      // sólo estaba propuesto: el mensaje prometía un compromiso que el estado
      // no tenía, y el paciente se quedó creyendo que tenía cita.
      'ESTADO: estos huecos están PROPUESTOS, no reservados. Todavía no hay nada',
      'apuntado ni guardado. No digas «te lo dejo apuntado», «te lo guardo»,',
      '«queda reservado» ni nada que suene a compromiso: son opciones, y hasta',
      'que el paciente elija una no hay cita de ninguna clase.',
      '',
      'Si no son los mismos que ofreciste antes, es porque se han buscado de nuevo',
      'con lo que acaba de pedir. NO es un error tuyo: no pidas perdón ni digas que',
      'te has liado. Preséntalos sin más.',
      '',
      'HUECOS PROPUESTOS (los únicos que puedes ofrecer):',
      huecosPropuestos(entrada.huecos, config.zonaHoraria),
    );
  }

  return partes.join('\n');
}

/**
 * La ventana de conversación: 8 turnos más resumen.
 *
 * El paciente se identifica con `ref` y nombre de pila, y con nada más.
 */
export function construirMensajes(
  entrada: EntradaDePrompt,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const mensajes: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  const encabezado = [
    entrada.resumen === null ? null : `Resumen de lo anterior: ${entrada.resumen}`,
    `Paciente: ${entrada.paciente.nombre} (${entrada.paciente.ref}).`,
  ]
    .filter((x): x is string => x !== null)
    .join('\n');

  mensajes.push({ role: 'user', content: encabezado });
  mensajes.push({ role: 'assistant', content: 'Entendido.' });

  for (const turno of entrada.turnos.slice(-TURNOS_EN_VENTANA)) {
    mensajes.push({
      role: turno.rol === 'paciente' ? 'user' : 'assistant',
      content: turno.texto,
    });
  }

  // El proveedor exige que el último turno sea del usuario.
  const ultimo = mensajes[mensajes.length - 1];
  if (ultimo === undefined || ultimo.role !== 'user') {
    mensajes.push({ role: 'user', content: '(sin texto)' });
  }

  return mensajes;
}
