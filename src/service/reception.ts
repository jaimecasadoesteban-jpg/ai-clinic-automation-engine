import { sigueVivo, transicionar } from '../core/hold-state-machine.js';
import type { Tx } from '../db/client.js';
import * as q from '../db/queries.js';
import { resolverCliente } from './contexto.js';
import { guardarRespuesta, hashDePeticion, respuestaPrevia } from './idempotency.js';
import {
  HuecoInexistenteError,
  TransicionRechazadaError,
  type Dependencias,
  type EfectoDeSalida,
} from './pipeline.js';
import { resolverEfectos, type EfectoResuelto } from './efectos.js';
import { AgendaNoDisponibleError } from './agenda-n8n.js';

/**
 * Recepción declara que ya metió la cita en la agenda.
 *
 * **El paso 6 es innegociable:** antes de escribir al paciente se relee la
 * agenda. Si el hueco ya no está libre, no se confirma nada: se marca
 * `colisionada` y se pasa a la 2ª opción. Confirmar al paciente antes de que la
 * cita exista en el programa de la clínica es el fallo que cuesta el cliente.
 *
 * El tipo lo impone: `recepcion_confirma` no se puede construir sin
 * `huecoSigueLibre`, y ese dato sólo se obtiene releyendo.
 */

export interface EntradaAccionRecepcion {
  readonly idempotencyKey: string;
  readonly clientId: string;
  readonly holdId: string;
}

export interface SalidaAccionRecepcion {
  readonly holdId: string;
  /**
   * `anulada`: el aviso que tenía recepción ya no vale porque el paciente
   * cambió o canceló esa cita. No es un error: es información que recepción
   * necesita para no meter en su agenda algo que nadie va a usar.
   */
  readonly estado: 'confirmada' | 'colisionada' | 'anulada' | 'agenda_no_disponible';
  readonly citaId: string | null;
  /**
   * Qué decirle al paciente. Nunca «confirmada» si hubo colisión, y `null`
   * cuando el aviso estaba anulado: al paciente ya se le contestó en el turno en
   * que pidió el cambio, y repetírselo sólo confunde.
   */
  readonly respuesta: string | null;
  /**
   * Qué decirle a RECEPCIÓN, que no es lo mismo que decirle al paciente.
   *
   * Se rellena cuando el aviso pulsado ya no valía. Y dice **qué hacer**, no
   * qué ha pasado: «esa cita se cambió al sábado 15 a las 10:20, es la que hay
   * que meter» sirve; «anulada» a secas obliga a recepción a investigar, y lo
   * que hace la gente con prisa cuando algo obliga a investigar es ignorarlo.
   */
  readonly mensajeParaRecepcion: string | null;
  readonly efectos: EfectoResuelto[];
  /** El hueco al que se ha pasado tras una colisión, si había alternativa. */
  readonly alternativaHoldId?: string | undefined;
}

/** Lo mismo antes de resolver a quién va cada efecto. Ver `service/efectos.ts`. */
export interface SalidaAccionRecepcionCruda extends Omit<SalidaAccionRecepcion, 'efectos'> {
  readonly efectos: EfectoDeSalida[];
}

/** «sábado 15 a las 10:20», en hora de la clínica. */
function cuando(fecha: Date, zonaHoraria: string): string {
  const dtf = new Intl.DateTimeFormat('es-ES', {
    timeZone: zonaHoraria,
    weekday: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return dtf.format(fecha);
}

/** Por qué un aviso ya no vale. Cada motivo pide una instrucción distinta. */
type PorQueNoVale = 'cancelada' | 'caducada' | 'pasada';

/**
 * Qué tiene que hacer recepción con un aviso que ya no vale.
 *
 * Cinco situaciones y cinco instrucciones distintas. La que evita el peor caso:
 * recepción ya metió la cita buena y ahora pulsa la vieja — si el mensaje no le
 * dijera que ya está hecha, la metería otra vez.
 *
 * `caducada` decía antes «el paciente canceló esa cita», que es falso: nadie
 * canceló nada, se agotó el plazo. Recepción se lo podría repetir al paciente.
 */
function queHacerConElAvisoViejo(
  motivo: PorQueNoVale,
  hueco: { slotStart: Date },
  sustituto: { slotStart: Date; state: string } | undefined,
  zonaHoraria: string,
): string {
  if (motivo === 'pasada') {
    return `Esa cita era el ${cuando(hueco.slotStart, zonaHoraria)} y ya pasó. No hay que meter nada en la agenda.`;
  }
  if (sustituto === undefined) {
    return motivo === 'caducada'
      ? 'Esa cita caducó sin confirmarse a tiempo. No la metas en la agenda.'
      : 'El paciente canceló esa cita. No hay que meter nada en la agenda.';
  }

  const momento = cuando(sustituto.slotStart, zonaHoraria);
  return sustituto.state === 'confirmada'
    ? `Esa cita se cambió al ${momento} y ya la diste por metida. No hay que hacer nada más.`
    : `Esa cita se cambió al ${momento}. Ésa es la que hay que meter en la agenda.`;
}

export async function accionRecepcion(
  deps: Dependencias,
  entrada: EntradaAccionRecepcion,
  /**
   * Para quien envía desde el núcleo (el panel): corre **dentro** de la
   * transacción, así la confirmación al paciente se encola junto con el cambio
   * de estado (regla 3). Por HTTP no se pasa y la salida vuelve a quien llamó.
   */
  alTerminar?: (tx: Tx, salida: SalidaAccionRecepcion) => Promise<void>,
): Promise<{ statusCode: number; cuerpo: SalidaAccionRecepcion }> {
  const ahora = deps.reloj();
  const hash = hashDePeticion({ clientId: entrada.clientId, holdId: entrada.holdId });

  return deps.core.withClient(entrada.clientId, async (tx) => {
    const previa = await respuestaPrevia(entrada.clientId, tx, entrada.idempotencyKey, hash);
    if (previa !== undefined) {
      return { statusCode: previa.statusCode, cuerpo: previa.cuerpo as SalidaAccionRecepcion };
    }

    const crudo = await confirmar(deps, tx, entrada, ahora);
    // Los efectos salen resueltos, igual que en `/mensaje-entrante`.
    const cliente = await resolverCliente(entrada.clientId, tx, deps.configuracion);
    const salida: SalidaAccionRecepcion = {
      ...crudo,
      efectos: await resolverEfectos(entrada.clientId, tx, cliente, crudo.efectos),
    };

    await alTerminar?.(tx, salida);

    // Una agenda caída no es una respuesta definitiva: el reintento, con la
    // misma clave, tiene que volver a intentarlo y no recibir lo mismo.
    if (salida.estado === 'agenda_no_disponible') return { statusCode: 200, cuerpo: salida };

    await guardarRespuesta(entrada.clientId, tx, {
      clave: entrada.idempotencyKey,
      endpoint: '/accion-recepcion',
      hash,
      statusCode: 200,
      cuerpo: salida,
    });

    return { statusCode: 200, cuerpo: salida };
  });
}

async function confirmar(
  deps: Dependencias,
  tx: Tx,
  entrada: EntradaAccionRecepcion,
  ahora: Date,
): Promise<SalidaAccionRecepcionCruda> {
  const { clientId } = entrada;
  const cliente = await resolverCliente(clientId, tx, deps.configuracion);

  /**
   * Con cerrojo, y ésta es la mitad de la carrera que vive aquí.
   *
   * Recepción puede pulsar «ya la he metido» en el mismo segundo en que el
   * paciente pide otra hora. Sin el cerrojo los dos leen `pendiente_recepcion`,
   * los dos deciden y gana el último en escribir, mientras el otro cree que ha
   * ganado él: recepción con una cita metida que el paciente ya descartó.
   *
   * Con él, uno espera al otro y lee el estado que le deja. Aquí abajo se
   * resuelve el caso de perder.
   */
  const hueco = await q.buscarHuecoBloqueando(clientId, tx, entrada.holdId);
  if (hueco === undefined) throw new HuecoInexistenteError('Ese hueco no existe.');

  /**
   * El aviso pulsado ya no vale. **Esto es normal y esperado, no un error.**
   *
   * En WhatsApp no se puede retirar un mensaje con botones ya entregado: el
   * aviso original sigue en el hilo de recepción, pulsable, aunque le hayamos
   * mandado otro encima diciendo que quedó sin efecto. Con prisa se pulsa el
   * primero que se ve. Así que esto **va a pasar de forma rutinaria** y el
   * núcleo tiene que aguantarlo, no confiar en que n8n lo impida.
   *
   * Aguantarlo significa tres cosas: no crear nada, no deshacer nada de lo que
   * ya esté bien, y decirle a recepción qué tiene que meter en la agenda.
   */
  /**
   * **Y uno cuyo estado dice que vale pero que ya no está vivo**: su hora ya
   * pasó, o caducó y el cron todavía no lo ha anotado. La fila dice
   * `pendiente_recepcion`, pero confirmarla sería crear una cita del 28 de
   * agosto en octubre. Un cron materializa el estado; no decide qué es verdad.
   *
   * No se materializa aquí: si se pasara a `caducada` en silencio, el cron ya
   * no le mandaría al paciente el aviso de caducidad, y ese silencio es la
   * regla 4 por otra puerta. Se responde lo que es y el cron lo anota.
   */
  const porQueNoVale: PorQueNoVale | null =
    hueco.state === 'liberada'
      ? 'cancelada'
      : hueco.slotStart <= ahora
        ? 'pasada'
        : hueco.state === 'caducada' || !sigueVivo(hueco, ahora, cliente.politica)
          ? 'caducada'
          : null;

  if (porQueNoVale !== null && hueco.state !== 'confirmada') {
    // Sin bloquear: sólo se lee para componer el mensaje. Bloquear aquí
    // retendría la cita buena mientras recepción pulsa un botón viejo.
    //
    // La que la sustituye DE VERDAD, no «la que tenga viva»: un paciente puede
    // tener varias, y la otra puede ser de otro tratamiento. Decirle a recepción
    // «esa cita se cambió al viernes» señalando el láser cuando el aviso era de
    // la limpieza le haría meter una cita que nadie ha pedido.
    const sustituto = await q.sustitutoDe(clientId, tx, hueco.id, {
      ahora,
      politica: cliente.politica,
    });

    await q.anotarAuditoria(clientId, tx, {
      entity: 'holds',
      entityId: hueco.id,
      action: 'aviso_sin_efecto',
      fromState: hueco.state,
      toState: hueco.state,
      actor: 'recepcion',
      idempotencyKey: entrada.idempotencyKey,
    });

    return {
      holdId: hueco.id,
      estado: 'anulada',
      citaId: null,
      respuesta: null,
      mensajeParaRecepcion: queHacerConElAvisoViejo(
        porQueNoVale,
        hueco,
        sustituto,
        cliente.config.zonaHoraria,
      ),
      efectos: [
        {
          tipo: 'avisar_a_recepcion_de_anulacion',
          holdId: hueco.id,
          sustituidoPorHoldId: sustituto?.id ?? null,
        },
      ],
    };
  }

  /**
   * Paso 6. Antes de escribir al paciente, se relee.
   *
   * **Si la agenda no responde, no se confirma nada y no se toca la cita**: el
   * paso 6 es innegociable, y sin él no hay confirmación. Pero tampoco un error:
   * recepción recibe qué hacer —volver a pulsar en unos minutos—, el operador lo
   * sabe por el escalado (`agenda_no_disponible` va a su correo), y la respuesta
   * no se guarda como definitiva para que el reintento funcione.
   */
  let sigueLibre: boolean;
  try {
    sigueLibre = await deps.agenda.sigueLibre({
      clientId,
      calendarioId: cliente.config.agenda.calendarioId,
      inicio: hueco.slotStart,
      fin: hueco.slotEnd,
    });
  } catch (error: unknown) {
    if (!(error instanceof AgendaNoDisponibleError)) throw error;
    const efectos: EfectoDeSalida[] = [];
    if (!(await q.escaladoAbiertoPorMotivo(clientId, tx, hueco.conversationId, 'agenda_no_disponible'))) {
      const escaladoId = await q.crearEscalado(clientId, tx, {
        conversationId: hueco.conversationId,
        patientId: hueco.patientId,
        holdId: hueco.id,
        reason: 'agenda_no_disponible',
        detail: `Recepción confirmó una cita y no se pudo releer la agenda: ${error.message}`,
        severity: 2,
        notifiedAt: ahora,
        createdAt: ahora,
      });
      efectos.push({ tipo: 'escalar_a_humano', escaladoId, severidad: 2, motivo: 'agenda_no_disponible' });
    }
    await q.anotarAuditoria(clientId, tx, {
      entity: 'holds',
      entityId: hueco.id,
      action: 'recepcion_confirma:agenda_no_disponible',
      actor: 'recepcion',
      idempotencyKey: entrada.idempotencyKey,
    });
    return {
      holdId: hueco.id,
      estado: 'agenda_no_disponible',
      citaId: null,
      respuesta: null,
      mensajeParaRecepcion:
        'No he podido comprobar la agenda ahora mismo, así que todavía no le he confirmado nada al paciente. ' +
        'La cita sigue pendiente: vuelve a pulsar en unos minutos.',
      efectos,
    };
  }

  const resultado = transicionar({
    hueco: {
      state: hueco.state,
      stateChangedAt: hueco.stateChangedAt,
      slotStart: hueco.slotStart,
      reminderSentAt: hueco.reminderSentAt,
      escalatedAt: hueco.escalatedAt,
      receptionNotifiedAt: hueco.receptionNotifiedAt,
    },
    evento: { tipo: 'recepcion_confirma', huecoSigueLibre: sigueLibre },
    ahora,
    politica: cliente.politica,
  });
  if (!resultado.ok) throw new TransicionRechazadaError(resultado.error.message);

  const { transicion } = resultado;

  if (transicion.hasta === 'colisionada') {
    return colisionar(tx, { entrada, hueco, ahora, cliente });
  }

  await q.actualizarHueco(clientId, tx, hueco.id, {
    state: 'confirmada',
    stateChangedAt: ahora,
    expiresAt: null,
    receptionAckAt: ahora,
  });

  const cita = await q.crearCita(clientId, tx, {
    patientId: hueco.patientId,
    conversationId: hueco.conversationId,
    holdId: hueco.id,
    slotStart: hueco.slotStart,
    slotEnd: hueco.slotEnd,
    serviceCode: hueco.serviceCode,
    confirmedAt: ahora,
    outcome: 'pendiente',
  });

  const respuesta = cliente.textos.confirmada({
    hueco: hueco.slotStart,
    servicio: hueco.serviceCode,
  });
  await q.guardarMensaje(clientId, tx, {
    conversationId: hueco.conversationId,
    direction: 'saliente',
    body: respuesta,
    isClinical: false,
    createdAt: ahora,
  });
  await q.anotarAuditoria(clientId, tx, {
    entity: 'holds',
    entityId: hueco.id,
    action: 'recepcion_confirma',
    fromState: hueco.state,
    toState: 'confirmada',
    actor: 'recepcion',
    idempotencyKey: entrada.idempotencyKey,
  });

  return {
    holdId: hueco.id,
    estado: 'confirmada',
    citaId: cita.id,
    respuesta,
    mensajeParaRecepcion: null,
    efectos: [],
  };
}

async function colisionar(
  tx: Tx,
  ctx: {
    entrada: EntradaAccionRecepcion;
    hueco: q.HoldRow;
    ahora: Date;
    cliente: Awaited<ReturnType<typeof resolverCliente>>;
  },
): Promise<SalidaAccionRecepcionCruda> {
  const { entrada, hueco, ahora, cliente } = ctx;
  const { clientId } = entrada;

  await q.actualizarHueco(clientId, tx, hueco.id, {
    state: 'colisionada',
    stateChangedAt: ahora,
    collisionDetectedAt: ahora,
    receptionAckAt: ahora,
  });
  await q.anotarAuditoria(clientId, tx, {
    entity: 'holds',
    entityId: hueco.id,
    action: 'colision_al_releer',
    fromState: hueco.state,
    toState: 'colisionada',
    actor: 'sistema',
    idempotencyKey: entrada.idempotencyKey,
  });

  // 2ª opción: la siguiente propuesta de la misma conversación **y del mismo
  // tratamiento**. Con varias citas en marcha puede haber propuestas vivas de
  // otro servicio, y pasarle a ésas sería darle un láser a quien pidió limpieza.
  const alternativas = await q.huecosPropuestos(clientId, tx, hueco.conversationId, {
    ahora,
    politica: cliente.politica,
  });
  const alternativa = alternativas.find((h) => h.serviceCode === hueco.serviceCode);
  const efectos: EfectoDeSalida[] = [{ tipo: 'proponer_alternativa' }];

  if (alternativa !== undefined) {
    await q.actualizarHueco(clientId, tx, alternativa.id, {
      state: 'pendiente_recepcion',
      stateChangedAt: ahora,
      expiresAt: cliente.politica.finDeJornada(ahora),
      receptionNotifiedAt: ahora,
      // Hereda a quién sustituía: si el hueco caído venía de un reagendado, su
      // alternativa también, y recepción tiene que poder saberlo después.
      replacesHoldId: hueco.replacesHoldId,
    });
    efectos.push({ tipo: 'avisar_a_recepcion', holdId: alternativa.id });
  }

  /**
   * Con la hora de la alternativa dentro. Sin ella, el paciente se enteraba de
   * que su cita había cambiado y no de a qué hora — que es justo lo que estaba
   * preguntando.
   */
  const respuesta =
    alternativa === undefined
      ? cliente.textos.colisionSinAlternativa()
      : cliente.textos.colisionConAlternativa({
          alternativa: alternativa.slotStart,
          servicio: alternativa.serviceCode,
        });

  await q.guardarMensaje(clientId, tx, {
    conversationId: hueco.conversationId,
    direction: 'saliente',
    body: respuesta,
    isClinical: false,
    createdAt: ahora,
  });

  return {
    holdId: hueco.id,
    estado: 'colisionada',
    citaId: null,
    respuesta,
    /**
     * Mismo patrón que en `anulada`, y por eso se cierra aquí: informar de qué
     * ha pasado sin decir qué hacer deja a recepción investigando, y lo que
     * obliga a investigar con prisa se acaba ignorando.
     */
    mensajeParaRecepcion:
      alternativa === undefined
        ? 'Ese hueco ya estaba ocupado y no había segunda opción guardada. ' +
          'No metas nada: le escribimos al paciente con horas nuevas.'
        : `Ese hueco ya estaba ocupado. La cita pasa al ${cuando(alternativa.slotStart, cliente.config.zonaHoraria)}. ` +
          'Ésa es la que hay que meter en la agenda.',
    efectos,
    ...(alternativa === undefined ? {} : { alternativaHoldId: alternativa.id }),
  };
}
