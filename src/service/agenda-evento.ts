import { transicionar } from '../core/hold-state-machine.js';
import { componerEvento } from './evento.js';
import { resolverEfectos, type EfectoResuelto } from './efectos.js';
import type { Tx } from '../db/client.js';
import * as q from '../db/queries.js';
import { dentroDeFranja, inicioDeFranja, resolverCliente } from './contexto.js';
import { guardarRespuesta, hashDePeticion, respuestaPrevia } from './idempotency.js';
import {
  HuecoInexistenteError,
  TransicionRechazadaError,
  type Dependencias,
  type EfectoDeSalida,
} from './pipeline.js';

/**
 * n8n cuenta qué pasó al escribir el evento en la agenda. **Modo `automatica`.**
 *
 * Es el gemelo de `/accion-recepcion`, y a propósito: el núcleo decide, alguien
 * de fuera actúa sobre la agenda real, y vuelve a llamar para contarlo. Lo único
 * que cambia es quién actúa — una persona pulsando un botón, o un workflow.
 *
 * **Aquí es donde se confirma al paciente, y no antes.** En el turno en que
 * eligió, `/mensaje-entrante` devolvió `respuesta: null`: no había nada
 * verdadero que contarle todavía.
 */

export interface EntradaEventoDeAgenda {
  readonly idempotencyKey: string;
  readonly clientId: string;
  readonly holdId: string;
  readonly creado: boolean;
  /** Identificador del evento en el proveedor. Sólo cuando `creado`. */
  readonly eventoId?: string | undefined;
  /**
   * Por qué no se pudo, cuando `creado` es `false`. **La distinción manda:**
   * `ocupado` es una colisión de verdad y se pasa a la segunda opción; los otros
   * dos significan que no sabemos si el evento existe, y entonces no se toca
   * nada suyo y lo mira una persona.
   */
  readonly motivo?: 'ocupado' | 'rechazado' | 'error' | undefined;
}

export interface SalidaEventoDeAgenda {
  readonly holdId: string;
  readonly estado: 'confirmada' | 'colisionada' | 'pendiente_recepcion';
  readonly citaId: string | null;
  /** Qué mandarle al paciente. Nunca «confirmada» si el evento no existe. */
  readonly respuesta: string | null;
  /** Qué decirle a recepción, que no es lo mismo. */
  readonly mensajeParaRecepcion: string | null;
  readonly efectos: EfectoResuelto[];
  readonly alternativaHoldId?: string | undefined;
}

/** Lo mismo antes de resolver a quién va cada efecto. Ver `service/efectos.ts`. */
export interface SalidaEventoDeAgendaCruda extends Omit<SalidaEventoDeAgenda, 'efectos'> {
  readonly efectos: EfectoDeSalida[];
}

export async function eventoDeAgenda(
  deps: Dependencias,
  entrada: EntradaEventoDeAgenda,
): Promise<{ statusCode: number; cuerpo: SalidaEventoDeAgenda }> {
  const ahora = deps.reloj();
  const hash = hashDePeticion({
    clientId: entrada.clientId,
    holdId: entrada.holdId,
    creado: entrada.creado,
  });

  return deps.core.withClient(entrada.clientId, async (tx) => {
    const previa = await respuestaPrevia(entrada.clientId, tx, entrada.idempotencyKey, hash);
    if (previa !== undefined) {
      return { statusCode: previa.statusCode, cuerpo: previa.cuerpo as SalidaEventoDeAgenda };
    }

    const crudo = await resolver(deps, tx, entrada, ahora);
    const cliente = await resolverCliente(entrada.clientId, tx, deps.configuracion);
    const salida: SalidaEventoDeAgenda = {
      ...crudo,
      efectos: await resolverEfectos(entrada.clientId, tx, cliente, crudo.efectos),
    };

    await guardarRespuesta(entrada.clientId, tx, {
      clave: entrada.idempotencyKey,
      endpoint: '/evento-de-agenda',
      hash,
      statusCode: 200,
      cuerpo: salida,
    });

    return { statusCode: 200, cuerpo: salida };
  });
}

async function resolver(
  deps: Dependencias,
  tx: Tx,
  entrada: EntradaEventoDeAgenda,
  ahora: Date,
): Promise<SalidaEventoDeAgendaCruda> {
  const { clientId } = entrada;
  const cliente = await resolverCliente(clientId, tx, deps.configuracion);

  // Con cerrojo, por lo mismo que en `/accion-recepcion`: el paciente puede
  // estar cancelando en el mismo segundo en que n8n contesta.
  const hueco = await q.buscarHuecoBloqueando(clientId, tx, entrada.holdId);
  if (hueco === undefined) throw new HuecoInexistenteError('Ese hueco no existe.');

  /**
   * El hueco ya no espera a n8n. Pasa de forma rutinaria: el vencimiento de
   * `retenida` pudo degradarlo a `pendiente_recepcion` mientras la llamada
   * estaba en vuelo, o el paciente canceló entre medias.
   *
   * **No es un error y no se deshace nada.** Si ya está en manos de recepción,
   * ahí se queda: dos caminos escribiendo sobre el mismo hueco es exactamente lo
   * que no puede pasar.
   */
  if (hueco.state !== 'retenida') {
    await q.anotarAuditoria(clientId, tx, {
      entity: 'holds',
      entityId: hueco.id,
      action: 'evento_de_agenda_fuera_de_tiempo',
      fromState: hueco.state,
      toState: hueco.state,
      actor: 'sistema',
      idempotencyKey: entrada.idempotencyKey,
    });

    return {
      holdId: hueco.id,
      estado: hueco.state === 'confirmada' ? 'confirmada' : 'pendiente_recepcion',
      citaId: null,
      respuesta: null,
      mensajeParaRecepcion:
        hueco.state === 'confirmada'
          ? null
          : 'Ese hueco ya había pasado a confirmación manual. Mira si la cita está en la agenda.',
      efectos: [],
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
    evento: {
      tipo: 'agenda_responde',
      resultado: entrada.creado
        ? 'creado'
        : entrada.motivo === 'ocupado'
          ? 'ocupado'
          : 'no_se_pudo',
    },
    ahora,
    politica: cliente.politica,
  });
  if (!resultado.ok) throw new TransicionRechazadaError(resultado.error.message);

  const { transicion } = resultado;

  if (transicion.hasta === 'confirmada') {
    return confirmar(tx, { entrada, hueco, ahora, cliente });
  }
  if (transicion.hasta === 'colisionada') {
    return colisionar(tx, { entrada, hueco, ahora, cliente });
  }
  return degradar(tx, { entrada, hueco, ahora, cliente });
}

async function confirmar(
  tx: Tx,
  ctx: {
    entrada: EntradaEventoDeAgenda;
    hueco: q.HoldRow;
    ahora: Date;
    cliente: Awaited<ReturnType<typeof resolverCliente>>;
  },
): Promise<SalidaEventoDeAgendaCruda> {
  const { entrada, hueco, ahora, cliente } = ctx;
  const { clientId } = entrada;

  await q.actualizarHueco(clientId, tx, hueco.id, {
    state: 'confirmada',
    stateChangedAt: ahora,
    expiresAt: null,
    // La cita ya está en la agenda: para los plazos de recepción, esto está
    // atendido. Que se entere es informativo, no una tarea suya.
    receptionNotifiedAt: ahora,
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
    action: `evento_creado:${entrada.eventoId ?? 'sin_id'}`,
    fromState: 'retenida',
    toState: 'confirmada',
    actor: 'sistema',
    idempotencyKey: entrada.idempotencyKey,
  });

  return {
    holdId: hueco.id,
    estado: 'confirmada',
    citaId: cita.id,
    respuesta,
    mensajeParaRecepcion: null,
    efectos: [{ tipo: 'informar_a_recepcion', holdId: hueco.id }],
  };
}

/**
 * El hueco estaba cogido en la agenda de la clínica. Colisión de verdad.
 *
 * Se pasa a la segunda opción **y se vuelve a intentar automáticamente**: que
 * las 11:00 estuvieran ocupadas no dice nada sobre las 12:00, y degradar aquí
 * perdería el modo entero por un choque normal. El intento está acotado: como
 * mucho hay tres propuestas, y cada vuelta consume una.
 *
 * El paciente sigue sin recibir nada: se le contará cuando haya algo cierto.
 */
async function colisionar(
  tx: Tx,
  ctx: {
    entrada: EntradaEventoDeAgenda;
    hueco: q.HoldRow;
    ahora: Date;
    cliente: Awaited<ReturnType<typeof resolverCliente>>;
  },
): Promise<SalidaEventoDeAgendaCruda> {
  const { entrada, hueco, ahora, cliente } = ctx;
  const { clientId } = entrada;

  await q.actualizarHueco(clientId, tx, hueco.id, {
    state: 'colisionada',
    stateChangedAt: ahora,
    collisionDetectedAt: ahora,
  });
  await q.anotarAuditoria(clientId, tx, {
    entity: 'holds',
    entityId: hueco.id,
    action: 'colision_al_crear_evento',
    fromState: 'retenida',
    toState: 'colisionada',
    actor: 'sistema',
    idempotencyKey: entrada.idempotencyKey,
  });

  // Del mismo tratamiento: con varias citas en marcha puede haber propuestas
  // vivas de otro servicio, y ésas no son una segunda opción de ésta.
  const alternativas = await q.huecosPropuestos(clientId, tx, hueco.conversationId, {
    ahora,
    politica: cliente.politica,
  });
  const alternativa = alternativas.find((h) => h.serviceCode === hueco.serviceCode);

  if (alternativa === undefined) {
    const respuesta = cliente.textos.colisionSinAlternativa();
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
      mensajeParaRecepcion:
        'Ese hueco ya estaba ocupado y no había segunda opción guardada. ' +
        'No metas nada: le escribimos al paciente con horas nuevas.',
      efectos: [{ tipo: 'proponer_alternativa' }],
    };
  }

  await q.actualizarHueco(clientId, tx, alternativa.id, {
    state: 'retenida',
    stateChangedAt: ahora,
    expiresAt: new Date(ahora.getTime() + cliente.politica.agendaMinutos * 60_000),
    replacesHoldId: hueco.replacesHoldId,
  });

  const nombreServicio =
    cliente.config.servicios.find((s) => s.codigo === alternativa.serviceCode)?.nombre ?? 'Cita';
  const paciente = await q.buscarPaciente(clientId, tx, alternativa.patientId);
  if (paciente === undefined) throw new HuecoInexistenteError('El hueco no tiene paciente.');
  const evento = componerEvento({ config: cliente.config, paciente, servicio: nombreServicio });

  return {
    holdId: hueco.id,
    estado: 'colisionada',
    citaId: null,
    // Todavía nada: la alternativa aún no existe en la agenda.
    respuesta: null,
    mensajeParaRecepcion: null,
    efectos: [
      {
        tipo: 'crear_evento_agenda',
        holdId: alternativa.id,
        calendarioId: cliente.config.agenda.calendarioId,
        idempotencyKey: `evento-${alternativa.id}`,
        inicio: alternativa.slotStart.toISOString(),
        fin: alternativa.slotEnd.toISOString(),
        resumen: evento.resumen,
        descripcion: evento.descripcion,
      },
    ],
    alternativaHoldId: alternativa.id,
  };
}

/**
 * No sabemos si el evento existe. **El modo de fallo del modo nuevo es el modo
 * viejo**, que lleva meses probado.
 *
 * No se suelta el hueco ni se pasa a la segunda opción: si el evento sí llegó a
 * crearse, el paciente acabaría en otra hora y quedaría un evento fantasma
 * quitándole capacidad real a la clínica. Una persona comprueba si está o no.
 */
async function degradar(
  tx: Tx,
  ctx: {
    entrada: EntradaEventoDeAgenda;
    hueco: q.HoldRow;
    ahora: Date;
    cliente: Awaited<ReturnType<typeof resolverCliente>>;
  },
): Promise<SalidaEventoDeAgendaCruda> {
  const { entrada, hueco, ahora, cliente } = ctx;
  const { clientId } = entrada;
  const enFranja = dentroDeFranja(ahora, cliente);

  await q.actualizarHueco(clientId, tx, hueco.id, {
    state: 'pendiente_recepcion',
    stateChangedAt: ahora,
    // Igual que en el camino normal: de madrugada no se le reclama nada a
    // recepción, y el plazo no arranca hasta que se le avisa de verdad.
    expiresAt: enFranja ? cliente.politica.finDeJornada(ahora) : null,
    receptionNotifiedAt: enFranja ? ahora : null,
  });

  const escaladoId = await q.crearEscalado(clientId, tx, {
    conversationId: hueco.conversationId,
    patientId: hueco.patientId,
    holdId: hueco.id,
    reason: 'agenda_no_escrita',
    severity: 2,
    notifiedAt: ahora,
    createdAt: ahora,
  });

  // El paciente SÍ recibe algo aquí, y en el momento: lleva esperando desde que
  // eligió. Es el mismo texto del modo de recepción, que dice la verdad.
  const respuesta = cliente.textos.retenido({
    hueco: hueco.slotStart,
    servicio: hueco.serviceCode,
    avisoDiferidoHasta: enFranja ? null : inicioDeFranja(ahora, cliente),
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
    action: `agenda_no_escrita:${entrada.motivo ?? 'sin_motivo'}`,
    fromState: 'retenida',
    toState: 'pendiente_recepcion',
    actor: 'sistema',
    idempotencyKey: entrada.idempotencyKey,
  });

  const efectos: EfectoDeSalida[] = [
    {
      tipo: 'escalar_a_humano',
      escaladoId,
      severidad: 2,
      motivo: 'agenda_no_escrita',
    },
  ];
  if (enFranja) efectos.push({ tipo: 'avisar_a_recepcion', holdId: hueco.id });

  return {
    holdId: hueco.id,
    estado: 'pendiente_recepcion',
    citaId: null,
    respuesta,
    mensajeParaRecepcion:
      'No hemos podido dejar esta cita en la agenda automáticamente. ' +
      'Comprueba si el evento existe y, si no, mételo tú.',
    efectos,
  };
}
