/**
 * Etapa 5: validación de salida. **Obligatoria antes de devolver cualquier
 * mensaje.**
 *
 * El modelo nunca recuerda un precio: lo recibe. Un precio inventado por escrito
 * en el WhatsApp de la clínica es la clase de error más embarazosa del producto,
 * y una promesa de resultado sanitario es bastante peor que embarazosa.
 *
 * Misma calibración que el cortafuegos, y por el mismo motivo: **ante la duda,
 * bloquear.** Un bloqueo cuesta una regeneración; una cifra falsa enviada cuesta
 * una discusión con un paciente que tiene el mensaje por escrito. Por eso una
 * hora que no se sabe interpretar se bloquea en vez de dejarse pasar.
 */

export type MotivoDeBloqueo =
  | { readonly tipo: 'precio_inexistente'; readonly encontrado: string; readonly esperados: number[] }
  | { readonly tipo: 'franja_no_propuesta'; readonly encontrado: string; readonly propuestas: string[] }
  | { readonly tipo: 'dia_no_propuesto'; readonly encontrado: string; readonly propuestas: string[] }
  | { readonly tipo: 'descuento_inventado'; readonly encontrado: string }
  | { readonly tipo: 'afirmacion_sanitaria'; readonly encontrado: string; readonly patron: string }
  | { readonly tipo: 'promesa_de_accion_futura'; readonly encontrado: string; readonly patron: string }
  | {
      readonly tipo: 'disponibilidad_no_consultada';
      readonly encontrado: string;
      readonly patron: string;
    }
  | {
      readonly tipo: 'cita_no_confirmada';
      readonly encontrado: string;
      readonly patron: string;
    }
  | { readonly tipo: 'reserva_afirmada'; readonly encontrado: string; readonly patron: string }
  | { readonly tipo: 'tratamiento_no_nombrado'; readonly encontrado: string; readonly tratamiento: string };

export type ResultadoDeValidacion =
  | { readonly valido: true }
  | { readonly valido: false; readonly motivos: MotivoDeBloqueo[] };

export interface ContextoDeValidacion {
  /** Precios del catálogo de la clínica, tal cual. */
  readonly precios: readonly number[];
  /** Los huecos REALMENTE propuestos en esta conversación. */
  readonly huecosPropuestos: readonly Date[];
  /**
   * Las horas que el paciente **ya tiene**: retenida, pendiente de recepción o
   * confirmada.
   *
   * Sin esto, la hora de su propia cita era la única que el agente no podía
   * nombrar. En cuanto elige un hueco, ese hueco deja de estar `propuesta` y
   * desaparecía de la lista blanca: a «Gracias!» el modelo contestó nombrando
   * las 11:00 —la hora que el paciente acababa de coger— y la validación lo
   * bloqueó dos veces por «franja no propuesta» hasta acabar en un escalado.
   *
   * Decir la hora que alguien tiene cogida no es inventarse nada; es lo más útil
   * que se puede decir en ese momento.
   */
  readonly citasVigentes: readonly Date[];
  /**
   * `true` si en ESTE turno se ha consultado la disponibilidad de verdad.
   *
   * Va obligatorio y sin valor por defecto a propósito: es la única forma de
   * que nadie construya un contexto de validación sin declarar de dónde sale lo
   * que el mensaje va a afirmar. Con `false`, cualquier afirmación de que hay o
   * no hay hueco se bloquea, porque no habría nada detrás que la sostenga.
   */
  readonly consultaRealizada: boolean;
  /**
   * `true` sólo si el paciente tiene una cita **confirmada**.
   *
   * Con `false` —tenga un hueco pendiente de recepción o no tenga nada— el
   * mensaje no puede dar por hecho que la cita ocurre. El caso: el agente cerró
   * con «A ti, Marta, nos vemos el miércoles» sobre un hueco en
   * `pendiente_recepcion`. No mencionaba ninguna hora inventada, así que no lo
   * cazaba nada — la hora era la suya de verdad. Lo falso era el «nos vemos»:
   * si recepción no confirma, al paciente se le dijo que se veían.
   */
  readonly citaConfirmada: boolean;
  /**
   * El tratamiento de los huecos que el mensaje tiene delante, o `null` si no
   * tiene ninguno.
   *
   * Obligatorio y sin valor por defecto, como `consultaRealizada`. Con huecos
   * delante, el mensaje tiene que decir de qué son: «para el lunes tengo a las
   * 10:00, 10:20 o 10:40» salió con huecos de láser de axilas mientras el
   * paciente creía estar pidiendo una limpieza facial. El tratamiento es lo
   * único que le habría permitido darse cuenta.
   */
  readonly tratamientoDeLosHuecos: string | null;
  /**
   * Las horas que el paciente ha escrito en ESTE mensaje. Obligatorio y sin
   * valor por defecto, como el resto.
   *
   * Permite una sola cosa: **decirle que la hora que pidió no está libre**,
   * cuando se ha consultado. «A las 10:20 no me sale nada» acababa en un
   * escalado porque 10:20 no estaba entre los propuestos, y el paciente había
   * preguntado algo concreto. Ver la regla de las horas en `validarSalida`.
   */
  readonly horasQueNombroElPaciente: ReadonlyArray<{ readonly horas: number; readonly minutos: number }>;
  /**
   * Los huecos de reservas que se le afirmaron al paciente y nunca existieron
   * (`service/desmentidos.ts`). Obligatorio, como el resto.
   *
   * Permite una sola cosa: **nombrarlos para negarlos**. La corrección de un
   * mensaje falso del historial —«lo del lunes a las 10:20 no llegó a
   * reservarse»— nombra una hora que ya no está entre las propuestas; sin esto
   * se bloquearía justo la frase que deshace la mentira. Afirmarla otra vez
   * sigue bloqueado por la regla de reservas y por la de horas.
   */
  readonly reservasDesmentidas: readonly Date[];
  readonly zonaHoraria: string;
  /** Necesario para resolver «mañana» y «el jueves». */
  readonly ahora: Date;
}

/** A qué día apunta el texto. */
export type ReferenciaDeDia =
  | { readonly tipo: 'relativo'; readonly dias: number }
  | { readonly tipo: 'dia_semana'; readonly indice: number }
  | { readonly tipo: 'dia_mes'; readonly dia: number; readonly mes?: number };

/**
 * Afirmaciones sanitarias de resultado. Determinista, como el cortafuegos: esto
 * no lo decide el modelo.
 */
const AFIRMACIONES_SANITARIAS: ReadonlyArray<{ id: string; regex: RegExp }> = [
  { id: 'garantia', regex: /\bgarantiz\w*|\bte\s+lo\s+garantizo\b|\bresultados?\s+garantizad\w*/ },
  { id: 'sin_riesgo', regex: /\bsin\s+(ningun\s+)?riesgos?\b|\bno\s+tiene\s+riesgos?\b|\bes\s+totalmente\s+segur\w*|\bsin\s+efectos?\s+secundari\w*|\bno\s+duele\s+nada\b|\bsin\s+dolor\b/ },
  { id: 'resultado_definitivo', regex: /\bdefinitiv\w*|\bpara\s+siempre\b|\bdesaparec\w*\s+(del\s+todo|por\s+completo|para\s+siempre)|\belimina\s+(el|la|los|las)?\s*\w*\s*(del\s+todo|por\s+completo)|\bpermanente\w*/ },
  // Con hueco entre medias: «te quedará la piel perfecta» es la forma normal de
  // decirlo, y la versión pegada («te quedará perfecta») es la excepción.
  { id: 'promesa_estetica', regex: /\bte\s+(quedara|va\s+a\s+quedar)\b[^.]{0,30}?\b(perfect\w*|inmejorable|genial|espectacular|increible)\b|\bquedaras\s+perfect\w*/ },
  { id: 'certeza_absoluta', regex: /\b100\s*%\b|\bseguro\s+que\s+(te\s+)?(funciona|va\s+bien|desaparece)\b|\bcura\b|\bcurar\w*/ },
  { id: 'diagnostico', regex: /\blo\s+que\s+tienes\s+es\b|\beso\s+es\s+(una?\s+)?(infeccion|alergia|dermatitis|quemadura)\b/ },
];

/**
 * Promesas de hacer algo después.
 *
 * El agente vive un turno y se apaga: no puede consultar la agenda más tarde ni
 * escribir por iniciativa propia. Decir «ahora mismo miro disponibilidad y te
 * digo» deja al paciente esperando algo que no va a llegar nunca, que es
 * exactamente lo que prohíbe la regla 4.
 *
 * Ojo con lo que NO es una promesa falsa: «te aviso en cuanto recepción lo
 * confirme» sí ocurre —lo manda `/accion-recepcion`— y no se bloquea. Lo que se
 * bloquea es que el AGENTE prometa una consulta o un mensaje suyo posterior.
 */
const PROMESAS_FUTURAS: ReadonlyArray<{ id: string; regex: RegExp }> = [
  { id: 'consulto_luego', regex: /\b(ahora|luego|despues|enseguida|en\s+un\s+momento|en\s+un\s+rato|en\s+breve)\s+(mismo\s+)?(te\s+)?(miro|consulto|reviso|busco|compruebo|verifico)\b/ },
  { id: 'voy_a_mirar', regex: /\b(voy\s+a|dejame|permiteme|deja\s+que|dame\s+un\s+momento\s+y)\s+(que\s+)?(mire|mirar|consulte|consultar|revise|revisar|busque|buscar|compruebe|comprobar)\b/ },
  { id: 'te_paso_huecos', regex: /\bte\s+(paso|mando|envio|digo|comparto|doy)\b[^.]{0,25}\b(huecos?|opciones|horarios?|disponibilidad|citas?)\b/ },
  { id: 'en_cuanto_consulte', regex: /\ben\s+cuanto\b[^.]{0,20}\b(consulte|mire|revise|tenga|compruebe|sepa)\b/ },
  { id: 'lo_miro_y', regex: /\b(lo|la|los|las)\s+(miro|consulto|reviso|compruebo)\s+y\s+te\b/ },
  { id: 'estoy_mirando', regex: /\b(estoy|voy)\s+(mirando|consultando|revisando|buscando)\b/ },
];

/**
 * Promesas de escribir después. **Éstas sí tienen una versión legítima**, y por
 * eso van aparte: `/accion-recepcion` manda un mensaje de verdad, así que «te
 * aviso en cuanto recepción lo confirme» describe algo que ocurre.
 *
 * Lo que las separa es el anclaje: si la frase dice quién va a escribir —
 * recepción, el equipo, una persona— es un mensaje del sistema y pasa. Si no lo
 * dice, el que promete es el agente, y el agente no tiene un después.
 *
 * Las de consulta de arriba no admiten anclaje: el agente no consulta la agenda
 * más tarde ni aunque diga que se lo pasa a recepción.
 */
const PROMESAS_DE_MENSAJE: ReadonlyArray<{ id: string; regex: RegExp }> = [
  { id: 'te_escribo_luego', regex: /\bte\s+(escribo|contesto|respondo|aviso|confirmo|digo)\s+(?:\w+\s+){0,3}(luego|mas\s+tarde|en\s+un\s+rato|despues)\b/ },
  { id: 'te_escribo_en_un_rato', regex: /\bte\s+(escribo|contesto|respondo|aviso|confirmo|digo)\s+(?:\w+\s+){0,3}(en|dentro\s+de)\s+(un|unos|\d+)\s+(rato|momento|minuto|minutos|segundo|segundos|hora|horas|ratito|momentito)\b/ },
  { id: 'te_confirmo_enseguida', regex: /\bte\s+(escribo|contesto|respondo|aviso|confirmo|digo)\s+(?:\w+\s+){0,3}(enseguida|ahora\s+mismo|en\s+seguida|en\s+breve|en\s+nada|en\s+un\s+momento)\b/ },
];

/** Quién escribe de verdad. Si la frase lo nombra, no promete el agente. */
const ANCLAJE_REAL =
  /\brecepcion\b|\bel\s+equipo\b|\buna?\s+(persona|compañer\w+)\b|\bla\s+clinica\b/;

/**
 * Afirmaciones sobre lo que hay o no hay en la agenda.
 *
 * **Sólo valen si en este turno se ha consultado de verdad.** Es la regla 4 bis
 * en la forma que la validación no cazaba: ante «¿por la tarde tienes alguna
 * hora?» el agente contestó «por la tarde no me aparece nada libre, sólo esos
 * tres de la mañana» sin que nadie hubiera mirado la tarde. Pasó limpia porque
 * las únicas horas que nombraba eran las tres propuestas, y lo falso no era
 * ninguna hora: era el «no hay».
 *
 * El sistema no puede saber si una frase así es cierta, pero sí sabe si detrás
 * hay una consulta. Sin consulta, el agente no lo sabe, y lo que no sabe no lo
 * afirma: pregunta, o se calla.
 */
const AFIRMACIONES_DE_DISPONIBILIDAD: ReadonlyArray<{ id: string; regex: RegExp }> = [
  {
    id: 'no_hay_nada',
    // «no me sale nada» y «no las tengo libres» no se reconocían: el primero es
    // literalmente la frase que escribió el modelo en el banco.
    //
    // Dos cosas que no son la agenda, cazadas por la tanda sobre conversación
    // corriente: «no hay de qué» (cortesía, con «cita» detrás en la misma
    // frase) y «no hay nada que cancelar» (habla de SUS citas, que el sistema
    // sí conoce, no de la agenda).
    regex: /\bno\s+(me\s+|nos\s+)?(la\s+|las\s+|lo\s+|los\s+)?(hay(?!\s+de\s+que\b)|queda\w*|tengo|tenemos|aparece\w*|veo|encuentro|sale\w*)\b(?!\s+nada\s+que\s+(cancelar|anular|cambiar|mover))[^.!?]{0,30}\b(nada|ningun\w*|hueco\w*|libre\w*|disponible\w*|disponibilidad|sitio|cita\w*)\b/,
  },
  {
    id: 'agenda_llena',
    regex: /\b(esta|lo\s+tengo|la\s+tenemos|tenemos)\b[^.!?]{0,20}\b(llen\w+|complet\w+|ocupad\w+|petad\w+|cogid\w+)\b|\bagenda\s+(llena|completa)\b/,
  },
  {
    id: 'solo_esos',
    regex: /\b(solo|unicamente|nada\s+mas)\b[^.!?]{0,20}\b(me\s+|nos\s+)?(queda\w*|tengo|tenemos|hay)\b|\b(eso|esos|esas)\s+son\s+(los|las)\s+unic\w+/,
  },
  {
    id: 'si_hay_hueco',
    regex: /\b(si|claro|pues\s+si)\b[^.!?]{0,20}\b(tengo|tenemos|hay|me\s+queda\w*|nos\s+queda\w*)\s+(hueco\w*|sitio|disponibilidad|libre)\b/,
  },
];

/**
 * ¿Esta frase NIEGA disponibilidad?
 *
 * Hace falta porque las dos reglas se pisan: para decir «el sábado no tenemos
 * hueco» hay que nombrar el sábado, y el sábado no es ninguno de los huecos
 * propuestos. La regla del día existe para que el agente no cite al paciente un
 * día que no es el suyo — y una frase que niega no está citando a nadie.
 *
 * Se levanta **sólo para el día suelto y sólo con consulta detrás**. Una hora
 * concreta sigue exigiendo estar en la lista: «no tengo nada salvo el jueves a
 * las 9:00» es un ofrecimiento disfrazado de negación, y ése no pasa.
 */
function niegaDisponibilidad(frase: string): boolean {
  return AFIRMACIONES_DE_DISPONIBILIDAD.some(
    (p) => p.id !== 'si_hay_hueco' && p.regex.test(frase),
  );
}

/**
 * Dar por hecho que la cita ocurre.
 *
 * Es la regla 4 bis en su forma más callada: no hay ninguna hora inventada, no
 * hay ningún precio, no hay ninguna promesa de acción futura. Hay un **damos por
 * sentado** sobre algo que todavía tiene que aprobar una persona.
 *
 * Sólo se bloquea sin cita confirmada. Con ella son la forma normal de
 * despedirse y tienen que pasar.
 */
const CITA_DADA_POR_HECHA: ReadonlyArray<{ id: string; regex: RegExp }> = [
  { id: 'nos_vemos', regex: /\bnos\s+vemos\b|\bte\s+veo\b|\bnos\s+vemos\s+el\b/ },
  { id: 'te_esperamos', regex: /\b(te|le|os)\s+esper(o|amos)\b|\baqui\s+te\s+esperamos\b/ },
  // Sólo días. «Hasta las …» cazaba «jueves y viernes hasta las 21:00», que es
  // el horario de la clínica y no una cita dada por hecha.
  {
    id: 'hasta_el_dia',
    regex: /\bhasta\s+(el\s+)?(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b|\bhasta\s+el\s+(dia\s+)?\d{1,2}\b/,
  },
  { id: 'quedamos', regex: /\bquedamos\s+(el|la|los|las|a\s+las)\b/ },
  { id: 'ahi_nos_vemos', regex: /\b(ahi|alli)\s+(nos\s+vemos|te\s+esperamos)\b/ },
];

/**
 * Decir que la cita queda apuntada, reservada o guardada.
 *
 * **Lo que redacta el modelo nunca va acompañado de una reserva.** Retener un
 * hueco es la rama de elegir, que responde con un texto fijo y no pasa por aquí;
 * así que si este texto dice «te la dejo apuntada», es falso por construcción.
 *
 * Del servidor de pruebas: el paciente contestó «A las 10:20», el clasificador
 * lo etiquetó `agendar`, no se retuvo nada, y el modelo escribió «Te la dejo
 * apuntada el lunes a las 10:20, pendiente de que recepción la confirme». La
 * respuesta salió sin `holdId` y sin efectos: recepción no se enteró, y el
 * paciente se habría presentado a una cita que no existía. La prohibición
 * estaba en el prompt y sólo cuando el turno traía huecos; éste no los traía.
 * **Lo que no puede pasar no se pide: se impide**, como en el cortafuegos.
 *
 * Una PREGUNTA no afirma nada —«¿te la apunto?» ofrece— y no se bloquea.
 *
 * **Cancelar no está en la lista, a propósito.** Es lo único que sí ocurre antes
 * de redactar: el código suelta la cita y le pide al modelo que lo confirme.
 * «Te la he cancelado» es verdad en esa rama; bloquearlo sería obligarle a no
 * decirle al paciente lo que acaba de pasar.
 */
const RESERVA_AFIRMADA: ReadonlyArray<{ id: string; regex: RegExp }> = [
  {
    id: 'te_la_apunto',
    regex: /\bte\s+(la|lo|las|los)\s+(apunto|reservo|guardo|anoto|bloqueo|cojo|cambio|muevo)\b/,
  },
  { id: 'te_apunto', regex: /\bte\s+(apunto|reservo|guardo|anoto|bloqueo)\b/ },
  {
    id: 'te_la_dejo_apuntada',
    regex:
      /\bte\s+(la|lo|las|los)\s+(dejo|he\s+dejado|deje)\s+(apuntad|reservad|guardad|anotad|bloquead|cogid|hech|cerrad|cambiad|movid)\w*/,
  },
  {
    id: 'te_la_he_apuntado',
    regex:
      /\b(te\s+)?(la|lo|las|los)?\s*(he|hemos)\s+(apuntado|reservado|guardado|anotado|bloqueado|cogido|cambiado|movido)\b/,
  },
  {
    id: 'queda_reservada',
    regex:
      /\b(queda|quedan|quedaria|ha\s+quedado|han\s+quedado|esta|estan|ya\s+esta)\s+(reservad|apuntad|guardad|anotad|bloquead|cogid)\w*/,
  },
  // «Ya la tienes» como reserva: seguido de un participio, de un final de frase o
  // de una fecha. «Si ya lo tienes claro» no es una reserva: la tanda lo cazó.
  {
    id: 'ya_la_tienes',
    regex:
      /\bya\s+(la|lo|las|los)\s+tienes(\s+(reservad|apuntad|cogid|guardad|anotad|hech|cerrad)\w*|\s*[.,;!)]|\s*$|\s+(el|para|a\s+las)\b)/,
  },
  { id: 'ya_tienes_cita', regex: /\bya\s+tienes\s+(tu\s+)?(cita|hora|hueco|sesion)\b/ },
];

/**
 * Las frases que afirman, sin las que preguntan. «¿Te la apunto?» es una oferta;
 * «te la apunto» es una afirmación. Se parte por final de frase y se descartan
 * las que llevan signo de interrogación.
 */
function frasesAfirmativas(t: string): string[] {
  return t
    .split(/(?<=[.!?\n])/)
    .filter((frase) => !frase.includes('?') && !frase.includes('¿'));
}

/**
 * La cláusula del texto en la que cae una posición. Por posición y no buscando
 * el literal: con día y hora juntos el literal se sintetiza («lunes 10:20») y no
 * aparece tal cual en el texto («el lunes a las 10:20»).
 */
function clausulaEn(t: string, posicion: number): string {
  let inicio = 0;
  let fin = t.length;
  for (const corte of t.matchAll(/[.!?\n,;]|\bpero\b|\baunque\b|\bsin\s+embargo\b/g)) {
    const desde = corte.index;
    if (desde < posicion) inicio = desde + corte[0].length;
    else {
      fin = desde;
      break;
    }
  }
  return t.slice(inicio, fin);
}

/** Una frase partida en cláusulas, para que una negación no cubra lo que va detrás de un «pero». */
function clausulas(frase: string): string[] {
  return frase.split(/[,;]|\bpero\b|\baunque\b|\bsin\s+embargo\b/);
}

/**
 * ¿Niega esta cláusula que haya una reserva? «Esa cita no está reservada», «lo
 * del lunes no llegó a reservarse», «no tienes ninguna cita el lunes». Hace falta
 * para poder CORREGIR un mensaje falso del historial: la corrección nombra la
 * hora que se dijo, y negarla no es afirmarla.
 */
const NIEGA_LA_RESERVA =
  /\bno\s+(\w+\s+){0,3}?(esta|estan|queda\w*|llego|llegamos|existe|existen|tienes|tenias|hay|se\s+(llego|reservo|apunto|guardo))\b/;

/**
 * Los momentos que un texto da por reservados: frases que afirman, cláusulas que
 * no lo niegan, y alguno de los patrones de reserva. Lo usa también el barrido
 * del historial (`service/desmentidos.ts`), para no tener dos definiciones de
 * «afirmar una reserva» que puedan decir cosas distintas.
 */
export function reservasAfirmadas(texto: string): MomentoDelTexto[] {
  const t = normalizar(texto);
  return frasesAfirmativas(t)
    .flatMap(clausulas)
    .filter((c) => !NIEGA_LA_RESERVA.test(c))
    .filter((c) => RESERVA_AFIRMADA.some((p) => p.regex.test(c)))
    .flatMap((c) => extraerMomentos(c));
}

/** ¿Este momento del texto es esta fecha? Mismo criterio que la validación de horas. */
export function momentoCoincideCon(
  momento: MomentoDelTexto,
  fecha: Date,
  ahora: Date,
  zonaHoraria: string,
): boolean {
  const slot = partesLocales(fecha, zonaHoraria);
  return (
    (momento.horas === null || (slot.horas === momento.horas && slot.minutos === momento.minutos)) &&
    (momento.dia === null || coincideDia(momento.dia, slot, ahora, zonaHoraria))
  );
}

/**
 * Palabras de un nombre de tratamiento que no lo distinguen de otro. «Láser
 * axilas» se reconoce por «axilas», no por «láser», que comparten todos los de
 * depilación.
 */
const PALABRAS_GENERICAS = new Set([
  'laser',
  'sesion',
  'sesiones',
  'bono',
  'tratamiento',
  'completa',
  'completas',
  'entera',
  'enteras',
  'profunda',
  'medico',
  'medica',
]);

/** «axilas» y «axila», «piernas» y «pierna»: el modelo no copia el catálogo letra a letra. */
function raiz(palabra: string): string {
  return palabra.replace(/(es|s)$/, '');
}

/**
 * ¿Nombra el texto el tratamiento? Basta con una palabra que lo distinga, en
 * cualquier forma razonable: «la depilación de axilas» nombra «Láser axilas».
 * Si el nombre sólo tiene palabras genéricas, valen ésas.
 */
export function nombraElTratamiento(texto: string, tratamiento: string): boolean {
  const palabras = normalizar(tratamiento)
    .split(/[^a-z0-9]+/)
    .filter((p) => p.length >= 4);
  const distintivas = palabras.filter((p) => !PALABRAS_GENERICAS.has(p));
  const buscadas = (distintivas.length > 0 ? distintivas : palabras).map(raiz);
  const delTexto = normalizar(texto)
    .split(/[^a-z0-9]+/)
    .map(raiz);
  return buscadas.some((b) => delTexto.includes(b));
}

/** Descuentos, regalos y ofertas que nadie ha aprobado. */
const DESCUENTOS: ReadonlyArray<{ id: string; regex: RegExp }> = [
  { id: 'porcentaje', regex: /\b\d{1,2}\s*%\s*(de\s+)?(descuento|dto|rebaja)/ },
  { id: 'descuento', regex: /\b(te\s+)?(hago|hacemos|aplico|aplicamos)\s+(un|una)\s+\w*\s*(descuento|rebaja|oferta)/ },
  { id: 'regalo', regex: /\b(te\s+)?(regalo|regalamos|invitamos)\b|\bgratis\b|\bsin\s+coste\b|\bde\s+regalo\b/ },
  { id: 'promocion', regex: /\bpromocion\s+especial\b|\bsolo\s+por\s+hoy\b|\boferta\s+exclusiva\b/ },
];

function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * Cifras monetarias del texto.
 *
 * Sólo cuenta lo que va marcado como dinero — con `€` o con «euros». Un «te
 * escribo en 5 minutos» no es un precio, y bloquearlo sería paralizar la
 * conversación por nada.
 */
export function extraerImportes(texto: string): Array<{ literal: string; valor: number }> {
  const encontrados: Array<{ literal: string; valor: number }> = [];
  const regex = /(\d{1,6}(?:[.,]\d{1,2})?)\s*(?:€|eur\b|euros?\b)/gi;

  for (const coincidencia of texto.matchAll(regex)) {
    const crudo = coincidencia[1];
    if (crudo === undefined) continue;
    encontrados.push({
      literal: coincidencia[0],
      valor: Number.parseFloat(crudo.replace(',', '.')),
    });
  }
  return encontrados;
}

const DIAS_SEMANA = [
  'domingo',
  'lunes',
  'martes',
  'miercoles',
  'jueves',
  'viernes',
  'sabado',
] as const;

const MESES = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
] as const;

export interface MomentoDelTexto {
  readonly literal: string;
  /** `null` cuando el texto menciona un día sin hora. */
  readonly horas: number | null;
  readonly minutos: number;
  readonly dia: ReferenciaDeDia | null;
  /** Posición en el texto, para emparejar día y hora por cercanía. */
  readonly desde: number;
}

interface PartesLocales {
  anio: number;
  mes: number;
  dia: number;
  diaSemana: number;
  horas: number;
  minutos: number;
}

function partesLocales(fecha: Date, zonaHoraria: string): PartesLocales {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: zonaHoraria,
    hour12: false,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(fecha).map((x) => [x.type, x.value]));
  const corto = String(p['weekday'] ?? '').toLowerCase().slice(0, 3);
  const indice = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(corto);
  const horas = Number(p['hour']);

  return {
    anio: Number(p['year']),
    mes: Number(p['month']),
    dia: Number(p['day']),
    diaSemana: indice === -1 ? 0 : indice,
    horas: horas === 24 ? 0 : horas,
    minutos: Number(p['minute']),
  };
}

function etiquetaLocal(fecha: Date, zonaHoraria: string): string {
  const p = partesLocales(fecha, zonaHoraria);
  return `${DIAS_SEMANA[p.diaSemana] ?? '?'} ${String(p.dia).padStart(2, '0')} a las ${String(
    p.horas,
  ).padStart(2, '0')}:${String(p.minutos).padStart(2, '0')}`;
}

/** Referencias a un día: «mañana», «el jueves», «el 15 de septiembre». */
export function extraerDias(texto: string): Array<{ literal: string; dia: ReferenciaDeDia; desde: number }> {
  const t = normalizar(texto);
  const encontrados: Array<{ literal: string; dia: ReferenciaDeDia; desde: number }> = [];

  for (const m of t.matchAll(/\bpasado\s+manana\b/g)) {
    encontrados.push({ literal: m[0], dia: { tipo: 'relativo', dias: 2 }, desde: m.index });
  }
  // «mañana» es el día siguiente, salvo cuando es la mañana: «por la mañana».
  for (const m of t.matchAll(/(?<!pasado\s)(?<!la\s)\bmanana\b/g)) {
    encontrados.push({ literal: m[0], dia: { tipo: 'relativo', dias: 1 }, desde: m.index });
  }
  for (const m of t.matchAll(/\bhoy\b/g)) {
    encontrados.push({ literal: m[0], dia: { tipo: 'relativo', dias: 0 }, desde: m.index });
  }
  for (const m of t.matchAll(
    /\b(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/g,
  )) {
    const indice = DIAS_SEMANA.indexOf((m[1] ?? '') as (typeof DIAS_SEMANA)[number]);
    if (indice === -1) continue;
    encontrados.push({ literal: m[0], dia: { tipo: 'dia_semana', indice }, desde: m.index });
  }
  for (const m of t.matchAll(
    /\bel\s+(\d{1,2})(?:\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre))?\b/g,
  )) {
    const dia = Number(m[1]);
    if (dia < 1 || dia > 31) continue;
    const mes = m[2] === undefined ? undefined : MESES.indexOf(m[2] as (typeof MESES)[number]) + 1;
    encontrados.push({
      literal: m[0],
      dia: mes === undefined ? { tipo: 'dia_mes', dia } : { tipo: 'dia_mes', dia, mes },
      desde: m.index,
    });
  }

  return encontrados.sort((a, b) => a.desde - b.desde);
}

/** Horas mencionadas: «a las 9», «9:30», «9 y media», «10 menos cuarto». */
export function extraerHoras(texto: string): Array<{ literal: string; horas: number; minutos: number; desde: number }> {
  const t = normalizar(texto);
  const encontradas: Array<{ literal: string; horas: number; minutos: number; desde: number }> = [];

  // `2[0-3]` primero: con `[01]?\d` delante, «20» se partía en «2» y «0».
  for (const m of t.matchAll(/\b(2[0-3]|[01]?\d)\s*[:.]\s*([0-5]\d)\b/g)) {
    encontradas.push({
      literal: m[0],
      horas: Number(m[1]),
      minutos: Number(m[2]),
      desde: m.index,
    });
  }

  /**
   * «a las 9», «a las 9 y media», «a las 5 de la tarde».
   *
   * La hora tiene que acabar ahí: ni otra cifra detrás ni «:30», que es la forma
   * de arriba. Sin eso, «a las 20:00» se leía además como «a las 2» —el patrón
   * probaba `[01]?\d` primero y se quedaba con el «2»— y cualquier hueco de 20 a
   * 23 acababa en «franja no propuesta». Estuvo así desde la fase 6: todos los
   * huecos de las pruebas eran de mañana.
   */
  for (const m of t.matchAll(
    /\b(?:a\s+las?\s+)(2[0-3]|[01]?\d)(?!\d)(?!\s*[:.]\s*\d)(?:\s*(h\b|horas\b))?(?:\s+(y\s+media|y\s+cuarto|menos\s+cuarto))?(\s+de\s+la\s+(?:tarde|noche))?/g,
  )) {
    const enPunto = Number(m[1]);
    // «de la tarde» o «de la noche» con una hora de reloj de doce: las 5 de la
    // tarde son las 17:00. Las 12 de la tarde siguen siendo las 12.
    const horas = m[4] !== undefined && enPunto < 12 ? enPunto + 12 : enPunto;
    if (encontradas.some((h) => h.horas === horas)) continue;

    const modificador = m[3];
    let minutos = 0;
    let horaFinal = horas;
    if (modificador === 'y media') minutos = 30;
    else if (modificador === 'y cuarto') minutos = 15;
    else if (modificador === 'menos cuarto') {
      minutos = 45;
      horaFinal = horas === 0 ? 23 : horas - 1;
    }
    encontradas.push({ literal: m[0], horas: horaFinal, minutos, desde: m.index });
  }

  return encontradas.sort((a, b) => a.desde - b.desde);
}

/**
 * Momentos del texto: cada hora se empareja con la referencia de día más cercana
 * que la precede, que es como se escribe («el jueves a las 11»). Un día
 * mencionado sin hora también cuenta: «te espero el martes» es igual de falso si
 * el hueco es el jueves.
 */
export function extraerMomentos(texto: string): MomentoDelTexto[] {
  const dias = extraerDias(texto);
  const horas = extraerHoras(texto);
  const momentos: MomentoDelTexto[] = [];
  const diasUsados = new Set<number>();

  for (const hora of horas) {
    const candidatos = dias.filter((d) => d.desde <= hora.desde);
    const cercano = candidatos[candidatos.length - 1];
    if (cercano !== undefined) diasUsados.add(cercano.desde);
    momentos.push({
      literal: cercano === undefined ? hora.literal : `${cercano.literal} ${hora.literal}`.trim(),
      horas: hora.horas,
      minutos: hora.minutos,
      dia: cercano?.dia ?? null,
      desde: hora.desde,
    });
  }

  for (const dia of dias) {
    if (diasUsados.has(dia.desde)) continue;
    momentos.push({ literal: dia.literal, horas: null, minutos: 0, dia: dia.dia, desde: dia.desde });
  }

  return momentos.sort((a, b) => a.desde - b.desde);
}

function coincideDia(
  referencia: ReferenciaDeDia,
  slot: PartesLocales,
  ahora: Date,
  zonaHoraria: string,
): boolean {
  switch (referencia.tipo) {
    case 'relativo': {
      const objetivo = partesLocales(
        new Date(ahora.getTime() + referencia.dias * 86_400_000),
        zonaHoraria,
      );
      return (
        slot.anio === objetivo.anio && slot.mes === objetivo.mes && slot.dia === objetivo.dia
      );
    }
    case 'dia_semana':
      return slot.diaSemana === referencia.indice;
    case 'dia_mes':
      return (
        slot.dia === referencia.dia && (referencia.mes === undefined || slot.mes === referencia.mes)
      );
  }
}

export function validarSalida(
  texto: string,
  contexto: ContextoDeValidacion,
): ResultadoDeValidacion {
  const motivos: MotivoDeBloqueo[] = [];
  const t = normalizar(texto);

  // 1. Cifra en euros → debe coincidir con la configuración del cliente.
  //    Coincidencia exacta: 59,90 redondeado a «60 €» es un precio distinto del
  //    que la clínica cobra, y sale por escrito en su WhatsApp.
  for (const importe of extraerImportes(texto)) {
    const coincide = contexto.precios.some(
      (precio) => Math.abs(precio - importe.valor) < 0.005,
    );
    if (!coincide) {
      motivos.push({
        tipo: 'precio_inexistente',
        encontrado: importe.literal,
        esperados: [...contexto.precios],
      });
    }
  }

  // 2. Franja horaria → debe existir entre los huecos propuestos, **con su día**.
  //    Validar sólo la hora era una protección aparente: «el martes a las 11:00»
  //    pasaba cuando el hueco era el jueves a las 11:00, que es exactamente el
  //    error que un modelo comete al resumir tres opciones.
  //
  //    Las horas mencionables son dos conjuntos, no uno: lo que se le ha
  //    propuesto y lo que ya tiene cogido. Con sólo el primero, en cuanto elegía
  //    un hueco la hora de su propia cita pasaba a ser inmencionable.
  const mencionables = [...contexto.huecosPropuestos, ...contexto.citasVigentes];
  const slots = mencionables.map((h) => partesLocales(h, contexto.zonaHoraria));
  const etiquetas = mencionables.map((h) => etiquetaLocal(h, contexto.zonaHoraria));

  /**
   * Las frases que niegan, para poder nombrar el día que se niega. Se calcula
   * una vez y sobre el texto normalizado, igual que los patrones.
   */
  const frasesQueNiegan = contexto.consultaRealizada
    ? t.split(/[.!?\n]+/).filter((frase) => niegaDisponibilidad(frase))
    : [];
  const negado = (momento: MomentoDelTexto): boolean =>
    momento.horas === null &&
    frasesQueNiegan.some((frase) => frase.includes(normalizar(momento.literal)));

  /**
   * **La hora que pidió el paciente, para decirle que no está.**
   *
   * La regla de las horas existe para que el modelo no se invente horas libres.
   * Decir que una hora NO está libre no inventa disponibilidad, y callarlo es
   * peor: el paciente preguntó algo concreto —«¿a las 10:20?»— y se le escalaba
   * en vez de contestarle. No es relajar la regla, es corregir su alcance, y por
   * eso se acota con tres condiciones a la vez:
   * - la hora la ha escrito el paciente en este mensaje, no la trae el modelo;
   * - hay consulta detrás (`consultaRealizada`);
   * - se nombra en una cláusula que NIEGA. Se parte también por comas y por
   *   «pero», para que «a las 10:20 no me sale nada, pero tengo el martes a las
   *   10:20» no cuele el ofrecimiento dentro de la negación.
   *
   * Ofrecerla como disponible sigue exigiendo que esté en la lista.
   */
  const desmentidaYNegada = (momento: MomentoDelTexto): boolean =>
    momento.horas !== null &&
    contexto.reservasDesmentidas.some((f) =>
      momentoCoincideCon(momento, f, contexto.ahora, contexto.zonaHoraria),
    ) &&
    NIEGA_LA_RESERVA.test(clausulaEn(t, momento.desde));

  const horaPedidaYNegada = (momento: MomentoDelTexto): boolean =>
    momento.horas !== null &&
    contexto.horasQueNombroElPaciente.some(
      (h) => h.horas === momento.horas && h.minutos === momento.minutos,
    ) &&
    contexto.consultaRealizada &&
    niegaDisponibilidad(clausulaEn(t, momento.desde));

  for (const momento of extraerMomentos(texto)) {
    if (negado(momento) || horaPedidaYNegada(momento) || desmentidaYNegada(momento)) continue;
    const coincide = slots.some((slot) => {
      const horaOk =
        momento.horas === null ||
        (slot.horas === momento.horas && slot.minutos === momento.minutos);
      const diaOk =
        momento.dia === null ||
        coincideDia(momento.dia, slot, contexto.ahora, contexto.zonaHoraria);
      return horaOk && diaOk;
    });

    if (!coincide) {
      motivos.push({
        tipo: momento.horas === null ? 'dia_no_propuesto' : 'franja_no_propuesta',
        encontrado: momento.literal.trim(),
        propuestas: etiquetas,
      });
    }
  }

  // 3. Descuentos y regalos que nadie ha aprobado.
  for (const patron of DESCUENTOS) {
    if (patron.regex.test(t)) {
      motivos.push({ tipo: 'descuento_inventado', encontrado: patron.id });
    }
  }

  // 4. Promesas de hacer algo después: el agente no tiene un después.
  for (const patron of PROMESAS_FUTURAS) {
    if (patron.regex.test(t)) {
      motivos.push({
        tipo: 'promesa_de_accion_futura',
        encontrado: texto.slice(0, 120),
        patron: patron.id,
      });
    }
  }

  // 4 bis. Promesas de escribir después, frase a frase: se perdona la que dice
  // quién escribe de verdad, no la que deja al paciente esperando al agente.
  for (const frase of t.split(/[.!?\n]+/)) {
    if (ANCLAJE_REAL.test(frase)) continue;
    for (const patron of PROMESAS_DE_MENSAJE) {
      if (patron.regex.test(frase)) {
        motivos.push({
          tipo: 'promesa_de_accion_futura',
          encontrado: texto.slice(0, 120),
          patron: patron.id,
        });
      }
    }
  }

  // 4 ter. Afirmar lo que hay o no hay en la agenda sin haberlo mirado.
  //
  //   No se mira el contenido de la frase para decidir si es verdad —eso no se
  //   puede saber desde aquí— sino si detrás hay una consulta. Con `true` estas
  //   frases son legítimas y frecuentes: «el sábado no tengo nada» después de
  //   haber mirado el sábado es la respuesta correcta.
  if (!contexto.consultaRealizada) {
    for (const patron of AFIRMACIONES_DE_DISPONIBILIDAD) {
      if (patron.regex.test(t)) {
        motivos.push({
          tipo: 'disponibilidad_no_consultada',
          encontrado: texto.slice(0, 120),
          patron: patron.id,
        });
      }
    }
  }

  // 4 quater. Dar la cita por hecha cuando todavía no está confirmada.
  if (!contexto.citaConfirmada) {
    for (const patron of CITA_DADA_POR_HECHA) {
      if (patron.regex.test(t)) {
        motivos.push({
          tipo: 'cita_no_confirmada',
          encontrado: texto.slice(0, 120),
          patron: patron.id,
        });
      }
    }
  }

  // 4 bis, en la validación y no en el prompt. Lo que redacta el modelo nunca
  // va acompañado de una reserva: si dice que la hay, miente. Sin excepciones
  // por estado, porque no hay estado en el que esto sea verdad.
  //
  // **Salvo que describa una reserva que existe.** La premisa vale para el acto
  // de reservar, no para describir una reserva hecha en un turno anterior: «a
  // ti, queda anotado el lunes 12 a las 10:20, a falta de que recepción lo
  // confirme» se bloqueó en la tanda con esa cita `pendiente_recepcion` de
  // verdad. Pasa sólo si la frase nombra día u hora y TODO lo que nombra
  // coincide con una cita viva suya. Sin momento no pasa: «te la dejo apuntada»
  // a secas no dice cuál, y ante la duda se bloquea.
  const citasDelPaciente = contexto.citasVigentes.map((h) => partesLocales(h, contexto.zonaHoraria));
  const respaldadaPorUnaCita = (frase: string): boolean => {
    const momentos = extraerMomentos(frase);
    return (
      momentos.length > 0 &&
      momentos.every((m) =>
        citasDelPaciente.some(
          (slot) =>
            (m.horas === null || (slot.horas === m.horas && slot.minutos === m.minutos)) &&
            (m.dia === null || coincideDia(m.dia, slot, contexto.ahora, contexto.zonaHoraria)),
        ),
      )
    );
  };
  const afirmativas = frasesAfirmativas(t)
    .flatMap(clausulas)
    .filter((c) => !NIEGA_LA_RESERVA.test(c))
    .filter((c) => !respaldadaPorUnaCita(c));
  for (const patron of RESERVA_AFIRMADA) {
    if (afirmativas.some((frase) => patron.regex.test(frase))) {
      motivos.push({
        tipo: 'reserva_afirmada',
        encontrado: texto.slice(0, 120),
        patron: patron.id,
      });
    }
  }

  // Con huecos delante, el mensaje dice de qué son. Ofrecer «lunes a las 10:20»
  // sin el tratamiento es dejar al paciente sin la única pista que le permite
  // ver que el sistema se ha equivocado de servicio.
  if (
    contexto.tratamientoDeLosHuecos !== null &&
    !nombraElTratamiento(texto, contexto.tratamientoDeLosHuecos)
  ) {
    motivos.push({
      tipo: 'tratamiento_no_nombrado',
      encontrado: texto.slice(0, 120),
      tratamiento: contexto.tratamientoDeLosHuecos,
    });
  }

  // 5. Afirmación sanitaria de resultado → se bloquea.
  for (const patron of AFIRMACIONES_SANITARIAS) {
    if (patron.regex.test(t)) {
      motivos.push({
        tipo: 'afirmacion_sanitaria',
        encontrado: texto.slice(0, 120),
        patron: patron.id,
      });
    }
  }

  return motivos.length === 0 ? { valido: true } : { valido: false, motivos };
}

/** Resumen legible para pedirle al modelo que se corrija. */
export function explicar(motivos: readonly MotivoDeBloqueo[]): string {
  return motivos
    .map((m) => {
      switch (m.tipo) {
        case 'precio_inexistente':
          return `La cifra «${m.encontrado}» no está en el catálogo. Precios válidos: ${m.esperados.join(', ')}.`;
        case 'franja_no_propuesta':
          return `«${m.encontrado}» no coincide con ninguno de los huecos propuestos: ${m.propuestas.join(' · ')}.`;
        case 'dia_no_propuesto':
          return `El día «${m.encontrado}» no coincide con ninguno de los huecos propuestos: ${m.propuestas.join(' · ')}.`;
        case 'descuento_inventado':
          return `No se pueden ofrecer descuentos, regalos ni promociones (${m.encontrado}).`;
        case 'afirmacion_sanitaria':
          return `No se pueden hacer afirmaciones sanitarias de resultado (${m.patron}).`;
        case 'promesa_de_accion_futura':
          return (
            `No puedes prometer que harás algo después (${m.patron}): sólo existes ` +
            'durante este mensaje. O presentas los huecos ahora, o preguntas lo que falta.'
          );
        case 'tratamiento_no_nombrado':
          return (
            `Le estás ofreciendo huecos sin decir de qué tratamiento son. Nómbralo ` +
            `(«${m.tratamiento}») en la misma frase en que das las horas.`
          );
        case 'reserva_afirmada':
          return (
            `No puedes decir que la cita queda apuntada o reservada (${m.patron}): en este ` +
            'mensaje no se ha reservado nada. Si quiere uno de los huecos, pregúntale cuál ' +
            'de los propuestos quiere, sin darlo por hecho.'
          );
        case 'cita_no_confirmada':
          return (
            `No puedes dar la cita por hecha (${m.patron}): todavía tiene que ` +
            'confirmarla recepción, y si no lo hace le habrás dicho que os veíais. ' +
            'Despídete sin dar por sentado que la cita ocurre.'
          );
        case 'disponibilidad_no_consultada':
          return (
            `No puedes afirmar lo que hay o no hay en la agenda (${m.patron}): en este ` +
            'mensaje no se ha consultado. Si no lo sabes, pregúntale por qué día o franja ' +
            'le interesa en vez de darlo por hecho.'
          );
      }
    })
    .join(' ');
}
