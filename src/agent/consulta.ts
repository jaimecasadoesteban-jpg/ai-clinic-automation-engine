/**
 * ¿Pregunta el paciente si algo está libre, en vez de escogerlo?
 *
 * **Una consulta no es una elección.** «¿Viernes a las 17:00 lo tienes libre?»
 * acabó con un hueco retenido que el paciente nunca vio: el clasificador lo
 * etiquetó `elegir_hueco` y el sistema reservó. Y al revés, «A las 10:20» salió
 * `agendar` y no se retuvo nada mientras el modelo decía «te la dejo apuntada».
 * La etiqueta no puede decidir sola algo que no se puede deshacer, así que la
 * forma del mensaje se mira aquí, sin modelo, igual que el cortafuegos.
 *
 * ## Consultar no es pedir
 *
 * «¿Tenéis las 17:00?», «¿hay algo a las 11?», «¿el jueves a las 10 está
 * libre?» preguntan por la agenda: se consulta y se propone, no se retiene.
 *
 * «¿Puede ser a las 10:20?» o «¿me la pones a las 11?» son peticiones con
 * cortesía, y docs/DESIGN_RULES.md ya decidió que al reagendar nombrar una hora así ES
 * elegir. Por eso esto no mira sólo el signo de interrogación: mira si la frase
 * pregunta por la disponibilidad.
 *
 * ## Calibración
 *
 * Hacia «es consulta» ante la duda. Equivocarse ahí cuesta un turno —se le
 * ofrece la hora y la confirma—; equivocarse al revés cuesta una cita que no
 * pidió. «La de las 11, si sigue libre» se trata como consulta, y está bien.
 */

/** Palabras que preguntan por la agenda, no por una hora concreta para sí. */
const DE_DISPONIBILIDAD =
  /\b(tienes|tiene|teneis|tendrias|tendriais|tendras|tendreis|hay|habria|queda|quedan|quedaria|libre|libres|disponible|disponibles)\b/;

/** Una frase que EMPIEZA preguntando, aunque no lleve interrogación: en WhatsApp casi nunca la lleva. */
const EMPIEZA_PREGUNTANDO =
  /^\s*(y\s+)?(tienes|teneis|tendrias|tendriais|hay|habria|queda|quedan|quedaria)\b/;

/** Libre o disponible no aparecen en una elección firme: «si está libre» condiciona. */
const CONDICIONA = /\b(libre|libres|disponible|disponibles)\b/;

function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

export function esConsultaDeDisponibilidad(texto: string): boolean {
  const t = normalizar(texto);
  const pregunta = /[?¿]/.test(t);
  return (
    (pregunta && DE_DISPONIBILIDAD.test(t)) || EMPIEZA_PREGUNTANDO.test(t) || CONDICIONA.test(t)
  );
}
