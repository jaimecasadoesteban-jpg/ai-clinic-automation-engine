import { DomainError } from './errors.js';

/**
 * La máquina de estados del hueco. Es el activo central del producto, así que
 * es una función pura: no toca base de datos, no llama a nadie y no mira el
 * reloj — `ahora` entra como parámetro. Se puede probar entera sin Postgres.
 *
 * Quien la usa se encarga de persistir el resultado y de ejecutar los efectos.
 * Esta función decide; no hace.
 */

export const ESTADOS = [
  'propuesta',
  'retenida',
  'pendiente_recepcion',
  'confirmada',
  'liberada',
  'caducada',
  'colisionada',
] as const;

export type HoldState = (typeof ESTADOS)[number];

/** De aquí no se sale. Cualquier evento sobre un estado terminal se rechaza. */
export const ESTADOS_TERMINALES = ['liberada', 'caducada', 'colisionada'] as const;

/**
 * Los estados que bloquean el hueco. Coinciden exactamente con los que cubre
 * el índice `holds_slot_unico`: si esta lista y el índice divergen, la
 * aplicación y la base de datos dejan de estar de acuerdo sobre qué está libre.
 *
 * `propuesta` no bloquea a propósito: proponer 3 huecos a 5 personas no puede
 * bloquear 15 huecos de una clínica que tiene 20 al día.
 */
export const ESTADOS_QUE_BLOQUEAN = ['retenida', 'pendiente_recepcion', 'confirmada'] as const;

export type ReleaseReason = 'cancelacion' | 'ciclo_cerrado';

export const EVENTOS = [
  'paciente_elige',
  'recepcion_avisada',
  'recepcion_confirma',
  'agenda_responde',
  'cita_cancelada',
  'ciclo_cerrado',
  'tiempo',
] as const;

export type TipoDeEvento = (typeof EVENTOS)[number];

export type HoldEvent =
  /** El paciente elige uno de los tres huecos propuestos. */
  | { readonly tipo: 'paciente_elige' }
  /** Ya se ha avisado a recepción. El botón dice «Ya la he metido en agenda». */
  | { readonly tipo: 'recepcion_avisada' }
  /**
   * Recepción ha pulsado.
   *
   * `huecoSigueLibre` es obligatorio, y ése es el punto: el paso 6 del flujo
   * exige releer la agenda ANTES de escribir al paciente, y aquí no hay forma
   * de confirmar sin haberla releído. Confirmar sobre información vieja es el
   * fallo que cuesta el cliente.
   */
  | { readonly tipo: 'recepcion_confirma'; readonly huecoSigueLibre: boolean }
  /**
   * n8n dice qué pasó al escribir el evento en la agenda. **Sólo en modo
   * `automatica`**, y sólo desde `retenida`.
   *
   * Es el gemelo de `recepcion_confirma`: alguien de fuera actúa sobre la agenda
   * real y viene a contarlo. Lo que cambia es quién —una persona o un workflow—
   * y por eso el dato obligatorio es otro.
   *
   * Tres desenlaces, no dos, y la diferencia importa:
   *
   * - `creado`: la cita existe. Se confirma.
   * - `ocupado`: el hueco estaba cogido. Es una colisión de verdad y se pasa a la
   *   segunda opción, que puede estar perfectamente libre.
   * - `no_se_pudo`: la escritura falló, o n8n no llegó a contestar. **No sabemos
   *   si el evento existe.** Tratarlo como colisión podría dejar un evento
   *   fantasma quitándole capacidad real a la clínica mientras el paciente se va
   *   a otra hora, que es justo el fallo que la regla 3 existía para evitar. Se
   *   degrada al camino de recepción y lo mira una persona.
   */
  | {
      readonly tipo: 'agenda_responde';
      readonly resultado: 'creado' | 'ocupado' | 'no_se_pudo';
    }
  | { readonly tipo: 'cita_cancelada' }
  /** La cita se cerró: `appointments.outcome` pasó a asistida o no_asistida. */
  | { readonly tipo: 'ciclo_cerrado' }
  /** Pasa el tiempo. Puede no provocar nada, y eso no es un error. */
  | { readonly tipo: 'tiempo' };

export type PlantillaPaciente =
  | 'hueco_retenido'
  | 'cita_confirmada'
  | 'propuesta_caducada'
  | 'retencion_caducada'
  | 'sin_respuesta_de_recepcion'
  | 'hueco_ocupado_proponemos_alternativa'
  | 'cancelacion_confirmada';

export type MotivoEscalado = 'sin_respuesta_recepcion' | 'agenda_no_escrita';

/**
 * Lo que hay que hacer. El núcleo no habla con el exterior: devuelve qué hacer
 * y los efectos los ejecuta n8n.
 *
 * Las plantillas son claves, no textos: el texto de cara al paciente vive en el
 * YAML de cada clínica (regla 7).
 */
export type Efecto =
  | { readonly tipo: 'mensaje_al_paciente'; readonly plantilla: PlantillaPaciente }
  | { readonly tipo: 'avisar_a_recepcion' }
  /**
   * Modo `automatica`: que n8n cree el evento en la agenda de la clínica.
   *
   * **El núcleo no escribe: emite esto y lo ejecuta n8n.** El puerto `Agenda`
   * no tiene ni tendrá un método de escritura, y eso es lo que hace que la
   * frontera se sostenga sola en vez de depender de que nadie la cruce.
   */
  | { readonly tipo: 'crear_evento_agenda' }
  /**
   * Modo `automatica`: decirle a recepción que hay una cita nueva **ya metida**.
   *
   * Nombre distinto de `avisar_a_recepcion` a propósito. Si compartieran nombre,
   * un workflow viejo pintaría la tarjeta con el botón «ya la he metido», y ese
   * botón sobre una cita ya confirmada es un 409 y una recepcionista confundida.
   * Con un nombre nuevo, el workflow que no lo conozca no hace nada — que es el
   * fallo correcto.
   */
  | { readonly tipo: 'informar_a_recepcion' }
  | { readonly tipo: 'recordar_a_recepcion' }
  | { readonly tipo: 'escalar_a_humano'; readonly motivo: MotivoEscalado }
  | { readonly tipo: 'proponer_alternativa' }
  /** Hueco soltado con poca antelación: material para el relleno de cancelaciones. */
  | { readonly tipo: 'encolar_relleno_de_cancelacion'; readonly horasDeAntelacion: number };

/**
 * Quién deja la cita metida en la agenda de la clínica.
 *
 * **`retenida` significa dos cosas distintas según esto, y conviene saberlo antes
 * de leer el grafo:**
 *
 * - En `recepcion` es un estado **de paso**. `retenerOpcion` entra y sale de él
 *   en la misma llamada: se retiene y acto seguido se pasa a
 *   `pendiente_recepcion`. Nadie descansa nunca ahí.
 * - En `automatica` es un estado **de espera**. El hueco se queda en `retenida`
 *   mientras n8n escribe el evento, y sale cuando n8n dice qué pasó.
 *
 * Se reutiliza el estado en vez de añadir uno nuevo porque ya significa
 * exactamente eso —el paciente lo eligió, lo tenemos bloqueado, nadie de fuera
 * lo ha registrado todavía—, ya está en `ESTADOS_QUE_BLOQUEAN` y ya está dentro
 * de `holds_slot_unico`. Un estado nuevo habría costado un `ALTER TYPE` y
 * rehacer el índice único, a cambio de nada.
 */
export type ModoDeConfirmacion = 'recepcion' | 'automatica';

/** Vencimientos. Salen del YAML de la clínica, no de constantes en el código. */
export interface PoliticaDeVencimientos {
  readonly propuestaMinutos: number;
  readonly retenidaMinutos: number;
  /**
   * Cuánto se espera a que n8n diga si creó el evento. Sólo en `automatica`.
   * Es el respaldo de «n8n no contesta nunca», no el reloj que nota el paciente.
   */
  readonly agendaMinutos: number;
  /** Qué rama del grafo se toma al elegir hueco. */
  readonly confirmacion: ModoDeConfirmacion;
  readonly recordatorioRecepcionMinutos: number;
  readonly escaladoRecepcionMinutos: number;
  /** Fin de la jornada de la clínica a partir de un instante dado. */
  readonly finDeJornada: (desde: Date) => Date;
  /** Por debajo de esta antelación, un hueco liberado dispara el relleno. */
  readonly ventanaDeRellenoHoras: number;
}

/** Los valores de docs/DESIGN_RULES.md. `finDeJornada` no está: depende del horario de cada clínica. */
export const VENCIMIENTOS_POR_DEFECTO = {
  propuestaMinutos: 6 * 60,
  retenidaMinutos: 30,
  agendaMinutos: 3,
  confirmacion: 'recepcion',
  recordatorioRecepcionMinutos: 2 * 60,
  escaladoRecepcionMinutos: 4 * 60,
  ventanaDeRellenoHoras: 72,
} as const;

export interface Hueco {
  readonly state: HoldState;
  readonly stateChangedAt: Date;
  readonly slotStart: Date;
  readonly reminderSentAt: Date | null;
  readonly escalatedAt: Date | null;
  /**
   * Cuándo se avisó a recepción. **Los plazos de `pendiente_recepcion` cuentan
   * desde aquí, no desde el cambio de estado.**
   *
   * La atención es 24/7: un paciente puede elegir hueco a las 22:30 y el hueco
   * queda retenido esa misma noche. Pero a recepción no se le avisa hasta la
   * mañana, así que empezar a contarle las 2 h de recordatorio y las 4 h de
   * escalado desde las 22:30 sería reclamarle a las 00:30 algo que todavía no
   * sabe. Mientras esto sea `null`, el tiempo no corre.
   */
  readonly receptionNotifiedAt: Date | null;
}

export interface Transicion {
  readonly desde: HoldState;
  readonly hasta: HoldState;
  /** Vencimiento del estado resultante. `null` = no vence. */
  readonly expiresAt: Date | null;
  readonly efectos: readonly Efecto[];
  readonly motivoLiberacion: ReleaseReason | null;
}

export class TransicionInvalida extends DomainError {
  readonly code = 'transicion_invalida';
  readonly httpStatus = 409;

  constructor(
    readonly desde: HoldState,
    readonly evento: TipoDeEvento,
  ) {
    super(`El evento «${evento}» no es aplicable a un hueco en estado «${desde}».`);
  }
}

export type ResultadoDeTransicion =
  | { readonly ok: true; readonly transicion: Transicion }
  | { readonly ok: false; readonly error: TransicionInvalida };

export function esTerminal(estado: HoldState): boolean {
  return (ESTADOS_TERMINALES as readonly HoldState[]).includes(estado);
}

export function bloqueaElHueco(estado: HoldState): boolean {
  return (ESTADOS_QUE_BLOQUEAN as readonly HoldState[]).includes(estado);
}

/** `true` si la transición cambia de estado; `false` si sólo produce efectos. */
export function cambiaDeEstado(transicion: Transicion): boolean {
  return transicion.desde !== transicion.hasta;
}

function sumarMinutos(desde: Date, minutos: number): Date {
  return new Date(desde.getTime() + minutos * 60_000);
}

function horasHasta(desde: Date, hasta: Date): number {
  return (hasta.getTime() - desde.getTime()) / 3_600_000;
}

/** Cuándo vence un estado recién alcanzado. */
function vencimientoDe(
  estado: HoldState,
  desde: Date,
  politica: PoliticaDeVencimientos,
): Date | null {
  switch (estado) {
    case 'propuesta':
      return sumarMinutos(desde, politica.propuestaMinutos);
    case 'retenida':
      // En automática lo que corre es el plazo de n8n, que es mucho más corto:
      // mientras corre, el paciente está esperando en silencio.
      return sumarMinutos(
        desde,
        politica.confirmacion === 'automatica'
          ? politica.agendaMinutos
          : politica.retenidaMinutos,
      );
    case 'pendiente_recepcion':
      return politica.finDeJornada(desde);
    case 'confirmada':
    case 'liberada':
    case 'caducada':
    case 'colisionada':
      return null;
  }
}

function invalida(desde: HoldState, evento: TipoDeEvento): ResultadoDeTransicion {
  return { ok: false, error: new TransicionInvalida(desde, evento) };
}

function transita(args: {
  hueco: Hueco;
  hasta: HoldState;
  ahora: Date;
  politica: PoliticaDeVencimientos;
  efectos: readonly Efecto[];
  motivoLiberacion?: ReleaseReason;
}): ResultadoDeTransicion {
  const cambia = args.hasta !== args.hueco.state;
  return {
    ok: true,
    transicion: {
      desde: args.hueco.state,
      hasta: args.hasta,
      // Si no hay cambio de estado, el vencimiento sigue contando desde cuando
      // se entró en él, no desde ahora.
      expiresAt: vencimientoDe(
        args.hasta,
        cambia ? args.ahora : args.hueco.stateChangedAt,
        args.politica,
      ),
      efectos: args.efectos,
      motivoLiberacion: args.motivoLiberacion ?? null,
    },
  };
}

/** El paso del tiempo sobre un hueco. Puede no provocar nada. */
function porTiempo(
  hueco: Hueco,
  ahora: Date,
  politica: PoliticaDeVencimientos,
): ResultadoDeTransicion {
  const nada = transita({ hueco, hasta: hueco.state, ahora, politica, efectos: [] });

  switch (hueco.state) {
    case 'propuesta': {
      const vence = sumarMinutos(hueco.stateChangedAt, politica.propuestaMinutos);
      if (ahora < vence) return nada;
      return transita({
        hueco,
        hasta: 'caducada',
        ahora,
        politica,
        efectos: [{ tipo: 'mensaje_al_paciente', plantilla: 'propuesta_caducada' }],
      });
    }

    case 'retenida': {
      /**
       * En automática esto es el respaldo de «n8n no contestó nunca»: se murió el
       * workflow, se reinició el contenedor, se perdió la llamada. **No sabemos
       * si el evento existe**, así que se hace lo mismo que ante un fallo
       * declarado: degradar al camino de recepción y que lo mire una persona.
       *
       * El hueco NO se suelta. Sigue siendo suyo y sigue bloqueado; lo único que
       * cambia es quién lo deja metido en la agenda.
       */
      if (politica.confirmacion === 'automatica') {
        const venceAgenda = sumarMinutos(hueco.stateChangedAt, politica.agendaMinutos);
        if (ahora < venceAgenda) return nada;
        return transita({
          hueco,
          hasta: 'pendiente_recepcion',
          ahora,
          politica,
          efectos: [
            { tipo: 'mensaje_al_paciente', plantilla: 'hueco_retenido' },
            { tipo: 'avisar_a_recepcion' },
            { tipo: 'escalar_a_humano', motivo: 'agenda_no_escrita' },
          ],
        });
      }

      const vence = sumarMinutos(hueco.stateChangedAt, politica.retenidaMinutos);
      if (ahora < vence) return nada;
      return transita({
        hueco,
        hasta: 'caducada',
        ahora,
        politica,
        efectos: [{ tipo: 'mensaje_al_paciente', plantilla: 'retencion_caducada' }],
      });
    }

    case 'pendiente_recepcion': {
      // Aún no se ha avisado a recepción — el hueco espera a que abra la
      // clínica. No se le puede reclamar nada a quien todavía no sabe nada.
      const avisado = hueco.receptionNotifiedAt;
      if (avisado === null) return nada;

      // El orden importa: primero si ya se acabó la jornada, después el escalado
      // y por último el recordatorio.
      if (ahora >= politica.finDeJornada(avisado)) {
        return transita({
          hueco,
          hasta: 'caducada',
          ahora,
          politica,
          efectos: [
            { tipo: 'mensaje_al_paciente', plantilla: 'sin_respuesta_de_recepcion' },
            { tipo: 'escalar_a_humano', motivo: 'sin_respuesta_recepcion' },
          ],
        });
      }

      const tocaEscalar = sumarMinutos(avisado, politica.escaladoRecepcionMinutos);
      if (ahora >= tocaEscalar && hueco.escalatedAt === null) {
        return transita({
          hueco,
          hasta: hueco.state,
          ahora,
          politica,
          efectos: [{ tipo: 'escalar_a_humano', motivo: 'sin_respuesta_recepcion' }],
        });
      }

      const tocaRecordar = sumarMinutos(avisado, politica.recordatorioRecepcionMinutos);
      if (ahora >= tocaRecordar && hueco.reminderSentAt === null) {
        return transita({
          hueco,
          hasta: hueco.state,
          ahora,
          politica,
          efectos: [{ tipo: 'recordar_a_recepcion' }],
        });
      }

      return nada;
    }

    // Una cita confirmada no vence por sí sola: sale de aquí cuando alguien
    // cancela o cuando se cierra el ciclo.
    case 'confirmada':
      return nada;

    case 'liberada':
    case 'caducada':
    case 'colisionada':
      return invalida(hueco.state, 'tiempo');
  }
}

/**
 * ¿Sigue vivo este hueco AHORA, haya pasado o no el cron?
 *
 * **Un cron materializa el estado; no lo define.** Si la verdad sobre qué está
 * vivo dependiera de que `/caducar-retenciones` haya pasado por ahí, cada caída
 * convertiría datos viejos en datos aparentemente válidos. Pasó: sin crons, el
 * agente ofreció como disponibles huecos propuestos en agosto y recordó tres
 * veces una cita del 28 de agosto como si fuera futura. Las filas decían
 * `propuesta` y `pendiente_recepcion`, y las lecturas se lo creían.
 *
 * Así que las lecturas preguntan aquí, y aquí se responde con **la misma regla
 * que aplica el cron** —`porTiempo`—, no con una paralela que pueda decir otra
 * cosa. Muerto es:
 * - un estado terminal;
 * - un hueco cuya hora ya ha pasado, esté en el estado que esté;
 * - uno al que el paso del tiempo llevaría a `caducada`.
 *
 * `retenida` en automática que ha agotado su plazo NO está muerta: degrada a
 * `pendiente_recepcion`, y el hueco sigue siendo del paciente. Por eso esto
 * mira a dónde lleva el tiempo, y no si el estado «ha vencido».
 */
export function sigueVivo(
  hueco: Hueco,
  ahora: Date,
  politica: PoliticaDeVencimientos,
): boolean {
  if (esTerminal(hueco.state)) return false;
  if (hueco.slotStart <= ahora) return false;
  const resultado = porTiempo(hueco, ahora, politica);
  return resultado.ok && resultado.transicion.hasta !== 'caducada';
}

export function transicionar(entrada: {
  readonly hueco: Hueco;
  readonly evento: HoldEvent;
  readonly ahora: Date;
  readonly politica: PoliticaDeVencimientos;
}): ResultadoDeTransicion {
  const { hueco, evento, ahora, politica } = entrada;

  if (esTerminal(hueco.state)) {
    return invalida(hueco.state, evento.tipo);
  }

  switch (evento.tipo) {
    case 'paciente_elige':
      if (hueco.state !== 'propuesta') return invalida(hueco.state, evento.tipo);
      /**
       * **El único punto del grafo que mira la configuración.** El resto de
       * aristas son las mismas en los dos modos.
       *
       * En automática no sale mensaje al paciente todavía: no hay nada que
       * contarle hasta que el evento exista. Confirmarle antes sería prometer
       * sobre una escritura que aún no ha ocurrido, y deshacerlo después es
       * exactamente el fallo de confianza que costó más caro.
       */
      return transita({
        hueco,
        hasta: 'retenida',
        ahora,
        politica,
        efectos:
          politica.confirmacion === 'automatica'
            ? [{ tipo: 'crear_evento_agenda' }]
            : [
                { tipo: 'mensaje_al_paciente', plantilla: 'hueco_retenido' },
                { tipo: 'avisar_a_recepcion' },
              ],
      });

    case 'agenda_responde': {
      if (hueco.state !== 'retenida') return invalida(hueco.state, evento.tipo);

      if (evento.resultado === 'creado') {
        return transita({
          hueco,
          hasta: 'confirmada',
          ahora,
          politica,
          efectos: [
            { tipo: 'mensaje_al_paciente', plantilla: 'cita_confirmada' },
            { tipo: 'informar_a_recepcion' },
          ],
        });
      }

      // El hueco estaba cogido: colisión de verdad, y la segunda opción puede
      // estar perfectamente libre. Mismo camino que el paso 6 de recepción.
      if (evento.resultado === 'ocupado') {
        return transita({
          hueco,
          hasta: 'colisionada',
          ahora,
          politica,
          efectos: [
            { tipo: 'mensaje_al_paciente', plantilla: 'hueco_ocupado_proponemos_alternativa' },
            { tipo: 'proponer_alternativa' },
          ],
        });
      }

      /**
       * `no_se_pudo`: la escritura falló y **no sabemos si el evento existe**.
       *
       * No se suelta el hueco ni se pasa a la segunda opción: si el evento sí
       * llegó a crearse, el paciente acabaría en otra hora y quedaría un evento
       * fantasma quitándole capacidad a la clínica. Se degrada al camino de
       * recepción —el que lleva meses probado— y una persona comprueba si esa
       * cita está o no está.
       */
      return transita({
        hueco,
        hasta: 'pendiente_recepcion',
        ahora,
        politica,
        efectos: [
          { tipo: 'mensaje_al_paciente', plantilla: 'hueco_retenido' },
          { tipo: 'avisar_a_recepcion' },
          { tipo: 'escalar_a_humano', motivo: 'agenda_no_escrita' },
        ],
      });
    }

    case 'recepcion_avisada':
      if (hueco.state !== 'retenida') return invalida(hueco.state, evento.tipo);
      return transita({ hueco, hasta: 'pendiente_recepcion', ahora, politica, efectos: [] });

    case 'recepcion_confirma': {
      if (hueco.state !== 'pendiente_recepcion') return invalida(hueco.state, evento.tipo);

      if (!evento.huecoSigueLibre) {
        // Paso 6: se releyó la agenda y el hueco ya no está. No se confirma
        // nada al paciente; se pasa a la 2ª opción.
        return transita({
          hueco,
          hasta: 'colisionada',
          ahora,
          politica,
          efectos: [
            { tipo: 'mensaje_al_paciente', plantilla: 'hueco_ocupado_proponemos_alternativa' },
            { tipo: 'proponer_alternativa' },
          ],
        });
      }

      return transita({
        hueco,
        hasta: 'confirmada',
        ahora,
        politica,
        efectos: [{ tipo: 'mensaje_al_paciente', plantilla: 'cita_confirmada' }],
      });
    }

    case 'cita_cancelada': {
      /**
       * Se puede cancelar antes de que recepción confirme, no sólo después.
       * Antes sólo valía desde `confirmada`, así que «déjalo, que al final no
       * puedo» a los cinco minutos de elegir no tenía salida y acababa en un
       * escalado por algo trivial.
       */
      const CANCELABLES = ['retenida', 'pendiente_recepcion', 'confirmada'] as const;
      if (!(CANCELABLES as readonly string[]).includes(hueco.state)) {
        return invalida(hueco.state, evento.tipo);
      }

      const antelacion = horasHasta(ahora, hueco.slotStart);
      const efectos: Efecto[] = [
        { tipo: 'mensaje_al_paciente', plantilla: 'cancelacion_confirmada' },
      ];
      // Un hueco que se suelta con poca antelación es la señal del relleno de
      // cancelaciones: por eso `liberada` no es limpieza, es un evento de
      // negocio. Sólo cuenta si la cita llegó a existir: soltar una retención
      // que recepción ni había visto no le quita capacidad a nadie.
      if (
        hueco.state === 'confirmada' &&
        antelacion >= 0 &&
        antelacion <= politica.ventanaDeRellenoHoras
      ) {
        efectos.push({ tipo: 'encolar_relleno_de_cancelacion', horasDeAntelacion: antelacion });
      }

      return transita({
        hueco,
        hasta: 'liberada',
        ahora,
        politica,
        efectos,
        motivoLiberacion: 'cancelacion',
      });
    }

    case 'ciclo_cerrado':
      if (hueco.state !== 'confirmada') return invalida(hueco.state, evento.tipo);
      // Sin mensaje al paciente a propósito: la cita ya ocurrió. Es el único
      // camino a un estado terminal que no le dice nada a nadie, y es correcto.
      return transita({
        hueco,
        hasta: 'liberada',
        ahora,
        politica,
        efectos: [],
        motivoLiberacion: 'ciclo_cerrado',
      });

    case 'tiempo':
      return porTiempo(hueco, ahora, politica);
  }
}
