/**
 * **Un paciente puede tener varias citas vivas a la vez**, de servicios
 * distintos. Limpieza facial el miércoles y láser el viernes es lo normal, no la
 * excepción.
 *
 * ## El fallo que lo trajo aquí
 *
 * Una paciente con una limpieza pendiente de recepción pidió láser de axilas
 * para el viernes. Al elegir el viernes, el sistema soltó la limpieza y le
 * escribió «te lo cambio al viernes y suelto el de miércoles»: cualquier
 * elección con una cita viva se trataba como reagendado, sin mirar el servicio.
 * El mensaje decía la verdad sobre el estado; lo falso era la decisión. En una
 * clínica real eso es perder dos citas y una clienta por pedir una segunda.
 *
 * La suposición de fondo era «una cita por conversación», y no salía de ningún
 * sitio: estaba en una consulta que devolvía UNA fila (`huecoActivo`) y en todo
 * lo que se construyó encima. Sin ella, «sustituye a la cita del paciente» deja
 * de significar nada. Hay que decir **a cuál**, y eso pasa a ser un dato
 * (`holds.replaces_hold_id`) en vez de una deducción.
 *
 * ## Las reglas
 *
 * - Pedir cita de un servicio **distinto** al de una cita viva es una cita
 *   **nueva**. Nunca un reagendado.
 * - Reagendar es mover **una cita concreta**. Si sólo hay una viva, es ésa. Si
 *   hay varias y no ha dicho cuál, se pregunta — sin proponer ni soltar nada.
 * - Pedir el **mismo** servicio que ya tiene vivo puede ser un cambio o una
 *   sesión más (un tratamiento de láser son varias). **Se pregunta antes de
 *   soltar nada**, y antes de retener: retener sin soltar le daría una cita de
 *   más si lo que quería era cambiarla.
 *
 * Funciones puras a propósito: es la decisión que más caro sale equivocar y
 * tiene que poder probarse caso por caso sin base de datos.
 */

/** Lo justo de una cita viva para decidir sobre ella. */
export interface CitaViva {
  readonly id: string;
  readonly serviceCode: string;
  readonly slotStart: Date;
  readonly state: string;
}

/** A qué cita se refiere el paciente cuando pide cambiar o cancelar. */
export type CitaAludida<C extends CitaViva = CitaViva> =
  | { readonly tipo: 'ninguna_viva' }
  | { readonly tipo: 'identificada'; readonly cita: C }
  /** Tiene varias y no ha dicho cuál. Se pregunta: no se elige por él. */
  | { readonly tipo: 'sin_identificar'; readonly candidatas: readonly C[] };

/**
 * `referida` es la posición en `vivas` de la cita que nombró —1 es la primera—,
 * o `null` si no nombró ninguna.
 *
 * **Un número que no corresponde a ninguna NO se trata como `null`: se
 * pregunta**, aunque tenga una sola cita. Si nombró una que no existe —o que ha
 * dejado de estar viva entre que se le enseñó la lista y ahora— no sabemos a
 * qué se refería, y quedarse con «la única que hay» sería cancelarle o moverle
 * una cita de la que no estaba hablando.
 */
export function citaAludida<C extends CitaViva>(
  vivas: readonly C[],
  referida: number | null,
): CitaAludida<C> {
  if (vivas.length === 0) return { tipo: 'ninguna_viva' };

  if (referida !== null) {
    const nombrada = vivas[referida - 1];
    return nombrada === undefined
      ? { tipo: 'sin_identificar', candidatas: vivas }
      : { tipo: 'identificada', cita: nombrada };
  }

  // No ha dicho cuál. Con una sola no hay nada que preguntar.
  const unica = vivas.length === 1 ? vivas[0] : undefined;
  if (unica !== undefined) return { tipo: 'identificada', cita: unica };

  return { tipo: 'sin_identificar', candidatas: vivas };
}

/** Qué hacer con las citas que ya tiene cuando elige un hueco. */
export type DestinoDeLaEleccion<C extends CitaViva = CitaViva> =
  /** Una cita más. No se toca ninguna de las que tenía. */
  | { readonly tipo: 'nueva' }
  /** La elegida sustituye a ésta, que se suelta en el mismo turno. */
  | { readonly tipo: 'sustituye'; readonly cita: C }
  /**
   * Tiene una cita viva del MISMO servicio y no ha dicho si esto es un cambio.
   * No se retiene nada todavía: se le pregunta.
   */
  | { readonly tipo: 'preguntar_si_sustituye'; readonly candidatas: readonly C[] };

/** Lo que el paciente contestó a «¿en lugar de la que tienes, o además?». */
export type Sustitucion = 'en_lugar' | 'ademas';

export function destinoDeLaEleccion<C extends CitaViva>(args: {
  /** El hueco propuesto que ha elegido. */
  readonly elegido: { readonly serviceCode: string; readonly replacesHoldId: string | null };
  /** Sus citas vivas. El elegido no está: todavía es `propuesta`. */
  readonly vivas: readonly C[];
  /** La cita que pidió cambiar en este turno, si la identificó. */
  readonly cambioPedido: C | null;
  /** Su respuesta a la pregunta de si sustituye, si se la acabamos de hacer. */
  readonly sustitucion: Sustitucion | null;
}): DestinoDeLaEleccion<C> {
  const { elegido, vivas, cambioPedido, sustitucion } = args;

  // 1. El hueco se propuso para cambiar una cita concreta, y esa cita sigue viva.
  if (elegido.replacesHoldId !== null) {
    const vinculada = vivas.find((c) => c.id === elegido.replacesHoldId);
    if (vinculada !== undefined) return { tipo: 'sustituye', cita: vinculada };
  }

  // 2. Ha pedido cambiar una cita concreta en este mismo turno. Sólo si es del
  //    mismo servicio: cambiar de tratamiento es cancelar y pedir otra, y
  //    sustituir una limpieza por un láser sería decidirlo por él.
  if (cambioPedido !== null && cambioPedido.serviceCode === elegido.serviceCode) {
    return { tipo: 'sustituye', cita: cambioPedido };
  }

  // 3. Lo que decide todo lo demás: si tiene otra cita DEL MISMO servicio.
  const mismas = vivas.filter((c) => c.serviceCode === elegido.serviceCode);
  if (mismas.length === 0) return { tipo: 'nueva' };

  if (sustitucion === 'ademas') return { tipo: 'nueva' };

  const unica = mismas.length === 1 ? mismas[0] : undefined;
  if (sustitucion === 'en_lugar' && unica !== undefined) return { tipo: 'sustituye', cita: unica };

  // Mismo servicio y no sabemos si es un cambio o una sesión más; o dice «en
  // lugar» con dos del mismo servicio delante y no sabemos de cuál.
  return { tipo: 'preguntar_si_sustituye', candidatas: mismas };
}

/**
 * ¿Cuenta como «ya tiene hora» a efectos de reproponer?
 *
 * Sólo una cita **del servicio que pide**. Con una limpieza viva, «quiero cita de
 * axilas» no es el «Gracias!» mal clasificado que esto existe para frenar: es una
 * cita nueva, y antes no se le proponía nada porque tener cualquier cita contaba.
 */
export function tieneHoraDe(vivas: readonly CitaViva[], servicio: string | null): boolean {
  return servicio !== null && vivas.some((c) => c.serviceCode === servicio);
}
