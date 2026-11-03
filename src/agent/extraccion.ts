import { z } from 'zod';

import type { ClienteConfig } from '../config/cliente.js';

/**
 * Extracción del modelo pequeño. **Salida cerrada, nunca texto libre.**
 *
 * Esto es lo que sustituye a las herramientas del agente: en vez de darle al
 * modelo grande la capacidad de decidir qué hacer, el pequeño extrae datos con
 * un esquema cerrado y una rama determinista del código elige la acción. El
 * modelo no puede retener un hueco cuando no toca porque no tiene con qué.
 *
 * La regla que gobierna todo esto: **nada se propone sobre una suposición**. Si
 * el servicio no se determina, no se crean huecos; se pregunta. Preguntar cuesta
 * un turno; decidir sobre información que no se tiene cuesta una cita mal dada.
 *
 * ## La señal de escalado se calibra al revés que el cortafuegos
 *
 * El cortafuegos (`firewall.ts`) corta ante la duda. Aquí, ante la duda, NO se
 * escala. Parece una incoherencia y no lo es: **las dos protegen lo mismo, que
 * recepción siga mirando los avisos.**
 *
 * Allí un falso positivo cuesta un mensaje derivado que no hacía falta, y el
 * suelo es que se cuele una urgencia. Aquí un falso positivo cuesta un aviso más
 * en la bandeja de recepción, y el suelo es la fatiga de alertas: si se escala
 * por cada paciente que suena algo seco, en una semana nadie mira la bandeja y
 * el escalado no sirve el día que llega el caso de verdad.
 *
 * Dicho de otro modo: cortar de más protege a un paciente concreto; escalar de
 * más gasta una atención que es finita y que hará falta después.
 */

export const INTENCIONES = [
  'precio',
  'horario',
  'servicio',
  'agendar',
  'elegir_hueco',
  'cancelar',
  'reagendar',
  'otro',
] as const;

export type Intencion = (typeof INTENCIONES)[number];

export const DIAS = [
  'lunes',
  'martes',
  'miercoles',
  'jueves',
  'viernes',
  'sabado',
  'domingo',
] as const;

export type Dia = (typeof DIAS)[number];

export const FRANJAS = ['manana', 'mediodia', 'tarde'] as const;
export type Franja = (typeof FRANJAS)[number];

/** Motivos de escalado no clínico. Lista fija: el modelo no inventa motivos. */
export const MOTIVOS_DE_ESCALADO = ['queja', 'pide_persona', 'agente_atascado'] as const;

/**
 * La respuesta a «¿es en lugar de la cita que ya tienes, o además?». Lista
 * cerrada, y `null` cuando no contesta a eso o no queda claro: un «vale» ante
 * una pregunta de dos opciones no elige ninguna.
 */
export const SUSTITUCIONES = ['en_lugar', 'ademas'] as const;

/**
 * Los datos prácticos de la clínica que se contestan sin modelo, desde
 * `informacion` del YAML. Lista cerrada: si pregunta otra cosa, `null`, y la
 * pregunta va al modelo, que tiene dicho que de la clínica sólo sabe lo que se
 * le pone delante.
 */
export const TEMAS_DE_INFORMACION = [
  'direccion',
  'aparcamiento',
  'pago',
  'cancelacion',
  'primera_visita',
  'preparacion',
] as const;
export type TemaDeInformacion = (typeof TEMAS_DE_INFORMACION)[number];
export type MotivoDeEscalado = (typeof MOTIVOS_DE_ESCALADO)[number];

/** Horas locales que cubre cada franja, en formato `[desde, hasta)`. */
export const HORAS_DE_FRANJA: Readonly<Record<Franja, readonly [number, number]>> = {
  manana: [0, 13],
  mediodia: [13, 16],
  tarde: [16, 24],
};

export interface Preferencia {
  readonly dias: readonly Dia[];
  readonly diasExcluidos: readonly Dia[];
  readonly franjas: readonly Franja[];
  /** `YYYY-MM-DD`. «a partir del jueves». */
  readonly desde: string | null;
  /**
   * `HH:MM` en hora de la clínica. «¿podría ser a las 10:45?».
   *
   * Hace falta porque `desde` sólo tiene resolución de día, y pedir una hora
   * concreta es la petición más frecuente al reagendar. Sin este campo la única
   * salida era escalar, que es fatiga de alertas por algo trivial.
   */
  readonly horaExacta: string | null;
  readonly cuantoAntes: boolean;
}

export interface Extraccion {
  readonly intencion: Intencion;
  /** Código del catálogo, o `null` si no se ha determinado. NUNCA texto libre. */
  readonly servicio: string | null;
  readonly opcion: number | null;
  readonly preferencia: Preferencia | null;
  readonly escalar: MotivoDeEscalado | null;
  /**
   * A cuál de sus citas vivas se refiere, por su número en la lista que se le
   * enseñó al clasificador (1 es la primera), o `null`.
   *
   * Hace falta porque **un paciente puede tener varias**: «quiero cambiar la
   * cita» con una limpieza y un láser vivos no dice cuál. Es un índice sobre una
   * lista cerrada y no texto libre; uno que no exista se trata como `null` y se
   * pregunta.
   */
  readonly cita: number | null;
  /** Su respuesta a si la cita nueva sustituye a la que tiene, o `null`. */
  readonly sustitucion: (typeof SUSTITUCIONES)[number] | null;
  /** Si pregunta un dato práctico de la clínica, cuál; si no, `null`. */
  readonly tema: TemaDeInformacion | null;
}

const preferenciaSchema = z.object({
  dias: z.array(z.enum(DIAS)).max(7).default([]),
  diasExcluidos: z.array(z.enum(DIAS)).max(7).default([]),
  franjas: z.array(z.enum(FRANJAS)).max(3).default([]),
  desde: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .default(null),
  horaExacta: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .nullable()
    .catch(null)
    .default(null),
  cuantoAntes: z.boolean().default(false),
});

/**
 * El esquema con el que se valida lo que devuelve el modelo.
 *
 * `servicio` se valida **contra el catálogo de esta clínica**: si el modelo
 * devuelve un código que no existe, se convierte en `null` y el sistema
 * pregunta. Un código inventado no puede llegar a crear un hueco.
 */
export function esquemaDeExtraccion(config: ClienteConfig) {
  const codigos = config.servicios.map((s) => s.codigo);

  return z.object({
    intencion: z.enum(INTENCIONES).catch('otro'),
    servicio: z
      .string()
      .nullable()
      .catch(null)
      .transform((valor) => (valor !== null && codigos.includes(valor) ? valor : null)),
    opcion: z.number().int().min(1).max(3).nullable().catch(null),
    preferencia: preferenciaSchema.nullable().catch(null),
    escalar: z.enum(MOTIVOS_DE_ESCALADO).nullable().catch(null),
    // Los dos campos nuevos admiten no venir: un proveedor que los omita no
    // puede tumbar la extracción entera y dejar al paciente sin entender.
    cita: z.number().int().min(1).max(20).nullable().catch(null).default(null),
    sustitucion: z.enum(SUSTITUCIONES).nullable().catch(null).default(null),
    tema: z.enum(TEMAS_DE_INFORMACION).nullable().catch(null).default(null),
  });
}

/**
 * Esquema JSON que se le manda al proveedor, con los códigos REALES del catálogo.
 *
 * **Los campos que admiten nulo van con `anyOf`, no con `type: ['x', 'null']`.**
 * La forma de array no está entre las que acepta la API de salidas estructuradas
 * y devuelve un 400; el clasificador cae entonces a la extracción de reserva y
 * todo mensaje queda como «intención otro, servicio no determinado». Falla en
 * silencio: la conversación sigue, sólo que el agente deja de entender nada.
 */
export function esquemaJsonDeExtraccion(config: ClienteConfig): Record<string, unknown> {
  const oNulo = (esquema: Record<string, unknown>): Record<string, unknown> => ({
    anyOf: [esquema, { type: 'null' }],
  });

  return {
    type: 'object',
    properties: {
      intencion: { type: 'string', enum: [...INTENCIONES] },
      // Salida cerrada: sólo códigos de este catálogo, o null. Si el paciente
      // menciona dos servicios, o uno que no existe, o «lo de siempre», la
      // respuesta correcta es null y el sistema preguntará.
      servicio: oNulo({ type: 'string', enum: config.servicios.map((s) => s.codigo) }),
      opcion: oNulo({ type: 'integer', enum: [1, 2, 3] }),
      preferencia: oNulo({
        type: 'object',
        properties: {
          dias: { type: 'array', items: { type: 'string', enum: [...DIAS] } },
          diasExcluidos: { type: 'array', items: { type: 'string', enum: [...DIAS] } },
          franjas: { type: 'array', items: { type: 'string', enum: [...FRANJAS] } },
          desde: oNulo({ type: 'string' }),
          horaExacta: oNulo({ type: 'string' }),
          cuantoAntes: { type: 'boolean' },
        },
        required: ['dias', 'diasExcluidos', 'franjas', 'desde', 'horaExacta', 'cuantoAntes'],
        additionalProperties: false,
      }),
      escalar: oNulo({ type: 'string', enum: [...MOTIVOS_DE_ESCALADO] }),
      cita: oNulo({ type: 'integer' }),
      sustitucion: oNulo({ type: 'string', enum: [...SUSTITUCIONES] }),
      tema: oNulo({ type: 'string', enum: [...TEMAS_DE_INFORMACION] }),
    },
    required: ['intencion', 'servicio', 'opcion', 'preferencia', 'escalar', 'cita', 'sustitucion', 'tema'],
    additionalProperties: false,
  };
}

/** La extracción segura cuando el modelo no responde o devuelve basura. */
export const EXTRACCION_DE_RESERVA: Extraccion = {
  intencion: 'otro',
  // `null` a propósito: preguntar es siempre la salida segura. Mejor un turno de
  // más que un hueco propuesto sobre una suposición.
  servicio: null,
  opcion: null,
  preferencia: null,
  escalar: null,
  cita: null,
  sustitucion: null,
  tema: null,
};

export function interpretar(crudo: unknown, config: ClienteConfig): Extraccion {
  const resultado = esquemaDeExtraccion(config).safeParse(crudo);
  if (!resultado.success) return EXTRACCION_DE_RESERVA;

  const datos = resultado.data;
  return {
    intencion: datos.intencion,
    servicio: datos.servicio,
    opcion: datos.opcion,
    preferencia: datos.preferencia,
    escalar: datos.escalar,
    cita: datos.cita,
    sustitucion: datos.sustitucion,
    tema: datos.tema,
  };
}

/**
 * Las instrucciones del clasificador. Salida cerrada y ninguna adivinanza.
 *
 * Recibe la conversación reciente, no sólo el último mensaje: **el servicio no
 * es una propiedad del mensaje**. Un paciente al que la clínica acaba de
 * ofrecerle la limpieza facial y contesta «sí por favor» está determinando el
 * servicio, aunque no lo nombre.
 */
export function instruccionesDeExtraccion(
  config: ClienteConfig,
  servicioVigente: string | null = null,
  /**
   * Las citas que el paciente ya tiene, descritas —tratamiento, día y hora— y
   * en el orden en que se resuelve `cita`. Sin identificadores ni datos del
   * paciente: el clasificador es un tercero, igual que el redactor.
   */
  citasVivas: readonly string[] = [],
  /**
   * Los huecos que la clínica le ha ofrecido y siguen vivos, ya descritos y
   * numerados como `opcion`. Sin esto el clasificador sólo tenía el texto de
   * los últimos turnos: si la oferta quedaba fuera de la ventana, «la segunda»
   * no tenía a qué referirse.
   */
  huecosOfrecidos: readonly string[] = [],
): string {
  return [
    'Extraes datos de una conversación entre una clínica de estética y un paciente.',
    'Se te da la conversación reciente y el último mensaje del paciente.',
    'Devuelve SÓLO el JSON pedido.',
    '',
    'Servicios del catálogo (los únicos códigos válidos):',
    ...config.servicios.map(
      (s) =>
        `- ${s.codigo}: ${s.nombre}` +
        (s.alias.length === 0 ? '' : ` (también lo llaman: ${s.alias.join(', ')})`),
    ),
    '',
    servicioVigente === null
      ? 'Todavía no hay ningún servicio determinado en esta conversación.'
      : `Servicio ya determinado en esta conversación: ${servicioVigente}.`,
    '',
    'REGLAS:',
    '- `intencion`:',
    '    · elegir_hueco: ESCOGE uno de los huecos que la clínica le acaba de',
    '      ofrecer, por su número, por su día u hora, o diciendo cuál («la',
    '      primera», «la del miércoles a las 10», «me quedo con la de las 16:00»,',
    '      «vale, el viernes»).',
    '    · agendar: pide cita o busca hueco sin escoger uno de los ofrecidos. Una',
    '      PREGUNTA por una hora («¿tenéis a las 17:00?», «¿el jueves a las 10',
    '      está libre?») es agendar, no elegir: pregunta, no escoge.',
    '    · reagendar / cancelar: cambiar o anular una cita que YA tiene.',
    '    · horario: pregunta cuándo abre la clínica («¿qué horario tenéis?»,',
    '      «¿abrís los sábados?»). Preguntar si hay HUECO un día o una franja',
    '      («¿tienes algo por la tarde?») es agendar, no horario.',
    '    · precio, servicio: pregunta por eso. otro: lo demás.',
    '- `servicio`: el código del catálogo del que se está hablando. Devuélvelo:',
    '    · si el paciente lo nombra en su mensaje;',
    '    · si la clínica se lo ha ofrecido en un turno anterior y el paciente',
    '      ACEPTA («sí», «vale», «sí por favor», «quiero una cita»). Ése es el',
    '      caso más frecuente y el que NO puedes fallar;',
    '    · si el paciente pide cambiar a otro distinto.',
    '    · si pide un tratamiento NUEVO además del que se hablaba («también»,',
    '      «además», «y otra de…»): devuelve el nuevo. Pide uno, aunque tenga otro.',
    '  Devuelve null si en ESTE mensaje pide dos a la vez («axilas e ingles»), si',
    '  menciona uno que no está en la lista, si',
    '  dice algo vago («lo de siempre») sin que se haya hablado de ninguno, o si',
    '  no hay forma de saberlo. NO adivines: null hace que se le pregunte.',
    servicioVigente === null
      ? ''
      : `  Si el paciente no cambia de tratamiento, devuelve «${servicioVigente}».`,
    '- `preferencia`: sólo lo que el paciente diga explícitamente. Si no dice nada',
    '  de días ni de horas, devuelve null. «los lunes no puedo» va en diasExcluidos.',
    '- `escalar`: sólo ante una señal CLARA. `queja` si se queja o está molesto,',
    '  `pide_persona` si pide hablar con alguien del equipo, `agente_atascado` si',
    '  lleva varios turnos sin que se le resuelva. Ante la duda, null: escalar de',
    '  más satura a recepción y deja de servir el día que llega el caso de verdad.',
    '- `opcion`: 1, 2 o 3 sólo si está eligiendo uno de los huecos propuestos.',
    huecosOfrecidos.length === 0
      ? 'Ahora mismo no tiene ningún hueco ofrecido delante.'
      : 'Huecos que tiene delante ahora mismo (`opcion` es su número):',
    ...huecosOfrecidos,
    '  Si elige por día y hora, devuelve el número: dos opciones pueden ser a la',
    '  misma hora en días distintos.',
    '',
    citasVivas.length === 0
      ? 'El paciente no tiene ninguna cita cogida.'
      : 'Citas que el paciente YA tiene:',
    ...citasVivas.map((c, i) => `${i + 1}. ${c}`),
    '- `cita`: sólo si pide CAMBIAR o CANCELAR una de esas citas y dice cuál (por',
    '  el tratamiento, el día o la hora, o contestando a qué cita se refiere): su',
    '  número en esa lista. Si no dice cuál, null: NO adivines, se le preguntará.',
    '  Elegir uno de los huecos que le acaba de ofrecer la clínica no es nombrar',
    '  una de sus citas: ahí `cita` es null.',
    '- `sustitucion`: sólo si la clínica le acaba de preguntar si la cita nueva es',
    '  EN LUGAR de una que ya tiene o ADEMÁS. «en lugar», «cámbiala», «quita la',
    '  otra» → en_lugar; «además», «las dos», «otra más», «una sesión más» →',
    '  ademas. Si no contesta a eso, o no queda claro cuál de las dos («sí»,',
    '  «vale», «gracias»), null.',
    '- `tema`: si pregunta un dato práctico de la clínica: direccion (dónde estáis,',
    '  cómo llegar), aparcamiento, pago (formas de pago, tarjeta, Bizum, plazos),',
    '  cancelacion (qué pasa si cancela o cambia, con cuánta antelación),',
    '  primera_visita (si hay valoración o consulta previa), preparacion (cómo ir',
    '  o qué hacer antes de un tratamiento). Si no pregunta nada de eso, null.',
    '  Pedir cancelar SU cita es la intención cancelar, no el tema cancelacion.',
  ].join('\n');
}
