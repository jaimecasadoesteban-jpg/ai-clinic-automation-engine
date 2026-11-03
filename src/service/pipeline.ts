import { esConsultaDeDisponibilidad } from '../agent/consulta.js';
import { anclaDeEleccion } from '../agent/eleccion.js';
import { evaluar, type Categoria } from '../agent/firewall.js';
import type { Extraccion } from '../agent/extraccion.js';
import { revisarLatidos } from './vigilancia.js';
import {
  describirPreferencia,
  elegirPropuestas,
  filtrarPorPreferencia,
} from '../agent/preferencia.js';
import { DIAS_DE_BUSQUEDA, huecosProponibles } from '../core/disponibilidad.js';
import { PRESUPUESTO, TURNOS_EN_VENTANA } from '../agent/models.js';
import {
  explicar,
  extraerHoras,
  validarSalida,
  type ContextoDeValidacion,
  type MotivoDeBloqueo,
} from '../agent/output-validation.js';
import { isDomainError } from '../core/errors.js';
import { toPromptPatient } from '../agent/prompt-boundary.js';
import { componerEvento } from './evento.js';
import { desmentirReservasFalsas } from './desmentidos.js';
import { AgendaNoDisponibleError } from './agenda-n8n.js';
import { preciosDelCatalogo, type Plantillas, type UsoDePlantilla, type VariableDePlantilla } from '../config/cliente.js';
import type { RegistroDeConfiguracion } from '../config/registry.js';
import { DomainError } from '../core/errors.js';
import { transicionar, type Efecto as EfectoDeHueco, type PlantillaPaciente } from '../core/hold-state-machine.js';
import {
  citaAludida,
  destinoDeLaEleccion,
  tieneHoraDe,
  type Sustitucion,
} from '../core/varias-citas.js';
import { hashTelefono } from '../core/phone.js';
import { resolverEfectos, type EfectoResuelto } from './efectos.js';
import type { Destinatario } from './avisos.js';
import type { Core, Tx } from '../db/client.js';
import type { CanalDelPaciente } from '../db/schema.js';
import * as q from '../db/queries.js';
import { dentroDeFranja, inicioDeFranja, resolverCliente, type ContextoDeCliente } from './contexto.js';
import { guardarRespuesta, hashDePeticion, respuestaPrevia } from './idempotency.js';
import type { Agente, Agenda, EstadoParaRedactar, FabricaDeAgente, Redaccion } from './ports.js';

/**
 * Orquestación del mensaje entrante. Etapas 1 a 6 del pipeline de docs/DESIGN_RULES.md,
 * con el cortafuegos real en su sitio y las piezas no deterministas detrás de
 * puertos.
 *
 * Todo ocurre dentro de una única transacción con contexto de cliente: si algo
 * falla a mitad, no queda una cita a medias ni un hueco retenido sin conversación.
 */

export interface Dependencias {
  readonly core: Core;
  /**
   * Fábrica del clasificador y el redactor. Se construyen por conversación
   * porque necesitan catálogo, ventana de turnos y presupuesto ya gastado.
   */
  readonly agente: FabricaDeAgente;
  readonly agenda: Agenda;
  /**
   * Vencimientos, textos, catálogo y patrones extra salen de aquí, por clínica.
   * Regla 7: ninguna capa de servicio conoce horarios ni precios de nadie.
   */
  readonly configuracion: RegistroDeConfiguracion;
  readonly pimienta: string;
  readonly reloj: () => Date;
}

export class SalidaNoValidaError extends DomainError {
  readonly code = 'salida_no_valida';
  readonly httpStatus = 502;
}

export type EfectoDeSalida =
  | { readonly tipo: 'avisar_a_recepcion'; readonly holdId: string }
  /**
   * Modo `automatica`: n8n crea el evento en la agenda de la clínica y **vuelve
   * a llamar** a `/evento-de-agenda` con el resultado.
   *
   * Va con todo lo que hace falta para escribirlo, ya compuesto: n8n no tiene
   * que saber nada del catálogo ni del formato del título. Y con
   * `idempotencyKey`, que es lo que hace que un reintento no cree dos eventos:
   * se usa como identificador del evento en el proveedor.
   */
  | {
      readonly tipo: 'crear_evento_agenda';
      readonly holdId: string;
      /** En qué calendario. Del YAML: n8n no lo decide. */
      readonly calendarioId: string;
      readonly idempotencyKey: string;
      readonly inicio: string;
      readonly fin: string;
      readonly resumen: string;
      readonly descripcion: string;
    }
  /** Modo `automatica`: cita nueva ya metida. Informativo, sin botón. */
  | { readonly tipo: 'informar_a_recepcion'; readonly holdId: string }
  | {
      readonly tipo: 'escalar_a_humano';
      readonly escaladoId: string;
      readonly severidad: number;
      /**
       * A quién va. Sin esto n8n sólo tiene la severidad, y severidad 2 son
       * cosas que van a personas distintas: una queja a recepción y una
       * solicitud de derechos a quien lleva protección de datos.
       */
      readonly motivo: string;
    }
  | { readonly tipo: 'registrar_baja' }
  | { readonly tipo: 'proponer_alternativa' }
  /**
   * Manda a recepción un mensaje diciendo que el aviso anterior quedó sin
   * efecto. **No lo retira: en WhatsApp eso no se puede.**
   *
   * Se llamaba `retirar_aviso_de_recepcion` y el nombre prometía algo que el
   * canal no permite. Un mensaje con botones ya entregado **no se puede quitar
   * del hilo**: se puede mandar otro encima, pero el original sigue ahí con sus
   * botones pulsables, y recepción, con prisa, pulsa el primero que ve.
   *
   * De ahí la consecuencia de diseño: **el botón de un aviso anulado se va a
   * pulsar, de forma rutinaria**, y el núcleo no puede confiar en que n8n lo
   * impida. Quien aguanta eso es `/accion-recepcion`, que trata ese pulsado
   * como caso normal y responde qué hay que meter en la agenda.
   */
  | {
      readonly tipo: 'avisar_a_recepcion_de_anulacion';
      /** El aviso que queda sin efecto. */
      readonly holdId: string;
      /** La cita que sí hay que meter, si el paciente cambió a otra hora. */
      readonly sustituidoPorHoldId: string | null;
    }
  | { readonly tipo: 'encolar_relleno_de_cancelacion'; readonly horasDeAntelacion: number };

export interface SalidaDeMensaje {
  readonly conversacionId: string;
  readonly estadoConversacion: 'abierta' | 'pausada' | 'cerrada';
  /** `null` = no se envía nada. Ocurre sólo tras una baja. */
  readonly respuesta: string | null;
  readonly corte: { categoria: Categoria; patrones: string[] } | null;
  /**
   * Lo que n8n tiene que ejecutar, **ya resuelto**: los que van a una persona
   * llevan `destinatarios` y `texto`, así que n8n envía y no decide nada.
   */
  readonly efectos: EfectoResuelto[];
  readonly holdId?: string | undefined;
}

/**
 * Lo mismo, antes de resolver a quién va cada efecto y qué dice.
 *
 * La orquestación produce esto: los emisores dicen **qué ha pasado** y nada más.
 * Quién lo recibe y con qué texto lo resuelve `resolverEfectos` una sola vez, al
 * borde, para que no haya trece sitios donde olvidarse.
 */
export interface SalidaCruda extends Omit<SalidaDeMensaje, 'efectos'> {
  readonly efectos: EfectoDeSalida[];
}

/** Lo que puede mandar un paciente. Sólo el texto lo entiende el agente. */
export type TipoDeMensaje = 'texto' | 'audio' | 'imagen' | 'documento' | 'ubicacion' | 'otro';

export interface EntradaDeMensaje {
  readonly idempotencyKey: string;
  readonly clientId: string;
  readonly telefono: string;
  readonly nombre: string;
  /** Ausente en todo lo que no sea texto: no hay nada que leer. */
  readonly texto?: string | undefined;
  readonly tipo?: TipoDeMensaje | undefined;
  readonly proveedorMensajeId?: string | undefined;
  readonly servicio?: string | undefined;
}

export class HuecoNoDisponibleError extends DomainError {
  readonly code = 'hueco_no_disponible';
  readonly httpStatus = 409;
  /**
   * «Te propongo otro en un momento» era una promesa que nadie iba a cumplir: el
   * agente no tiene un después. Lo que sí puede hacer es pedirle otra hora.
   *
   * Va aquí y no en el YAML porque es propiedad de una clase de error, sin
   * contexto de clínica donde mirar. Es la única excepción conocida a la regla 7
   * en textos de cara al paciente, y por eso conviene que sean pocas.
   */
  override readonly patientMessage =
    'Ese hueco se acaba de ocupar justo ahora; dime qué otra hora te viene bien y te la busco.';
}

export class HuecoInexistenteError extends DomainError {
  readonly code = 'hueco_inexistente';
  readonly httpStatus = 404;
}

export class TransicionRechazadaError extends DomainError {
  readonly code = 'transicion_rechazada';
  readonly httpStatus = 409;
}

/**
 * Por qué se (re)proponen huecos en este turno. `null` = no hay motivo, y
 * entonces **no se toca nada**.
 *
 * Proponer no es una consulta inocente: caduca los huecos que el paciente tenía
 * delante y crea otros nuevos. Hacerlo sin motivo es la regla 4 bis por la
 * puerta de atrás, y así se rompió en la primera sesión real: a «Gracias!» el
 * clasificador contestó `agendar`, y el sistema caducó las dos opciones vivas y
 * creó tres huecos nuevos —10:00, 12:00 y 13:00— de los que el paciente no supo
 * nunca nada, porque lo que leyó fue un escalado. Tres filas de basura que nadie
 * limpia, por dar las gracias.
 *
 * Al revés también fallaba, y es el mismo agujero visto del otro lado: ante «¿y
 * por la tarde?» la intención salió `horario`, nadie consultó la tarde, y el
 * modelo se inventó que no había nada. **Preguntar por una franja que las
 * propuestas vivas no cubren es cambiar de preferencia**, exactamente igual que
 * al reagendar, y se resuelve consultando, no adivinando.
 *
 * De ahí que el motivo se decida por el ESTADO —qué hay propuesto y qué se
 * pide— y no por la etiqueta que le ponga el clasificador al mensaje.
 */
export type MotivoDePropuesta =
  | 'sin_propuestas'
  | 'cambio_de_servicio'
  | 'preferencia_nueva'
  | 'refresco';

/**
 * ¿Cubren las propuestas vivas lo que el paciente acaba de pedir?
 *
 * Se responde con el mismo filtro que se usa para elegirlas, no con uno paralelo:
 * si algún día cambia qué cuenta como «por la tarde», cambia en los dos sitios a
 * la vez.
 */
export function cubrenLaPreferencia(
  propuestas: readonly HuecoPropuesto[],
  preferencia: Extraccion['preferencia'],
  zonaHoraria: string,
): boolean {
  if (preferencia === null) return true;
  if (propuestas.length === 0) return false;

  /**
   * «¿no tienes nada antes?» no se puede responder mirando lo ya propuesto: lo
   * que pregunta es justo por lo que NO se le enseñó. La única respuesta honesta
   * sale de volver a consultar.
   */
  if (preferencia.cuantoAntes) return false;

  const huecos = propuestas.map((h) => ({ inicio: h.slotStart, fin: h.slotEnd }));
  return !filtrarPorPreferencia(huecos, preferencia, zonaHoraria).preferenciaNoSatisfecha;
}

/**
 * Lo justo que hace falta de un hueco para decidir esto. No se pide una fila de
 * `holds` entera: la decisión es de negocio y se prueba con tres campos.
 */
export interface HuecoPropuesto {
  readonly serviceCode: string;
  readonly slotStart: Date;
  readonly slotEnd: Date;
}

export function motivoParaProponer(args: {
  readonly intencion: string;
  readonly servicio: string | null;
  readonly preferencia: Extraccion['preferencia'];
  readonly propuestasVivas: readonly HuecoPropuesto[];
  /**
   * `true` si el paciente ya tiene hueco cogido —retenido, pendiente de
   * recepción o confirmado—. **Es la línea que separa los dos casos.**
   *
   * Quien todavía no tiene hora y vuelve a pedir cita no pierde nada porque se
   * mire otra vez: se le enseñan tres huecos frescos en vez de tres que llevan
   * horas propuestos y pueden haberse ocupado en la agenda de la clínica.
   *
   * Quien YA tiene hora sí pierde. Reproponerle caduca las opciones que quedan
   * como alternativa ante una colisión, le crea huecos que no ha visto y da a
   * entender que le ofrecemos cambiar la cita. Ahí apareció el daño de verdad
   * —«Gracias!» clasificado como `agendar`— y ahí no se toca nada sin motivo.
   */
  readonly tieneHoraCogida: boolean;
  readonly zonaHoraria: string;
}): MotivoDePropuesta | null {
  // Sin servicio no se propone nada: se pregunta. Nada sobre una suposición.
  if (args.servicio === null) return null;

  if (args.propuestasVivas.some((h) => h.serviceCode !== args.servicio)) {
    return 'cambio_de_servicio';
  }
  if (!cubrenLaPreferencia(args.propuestasVivas, args.preferencia, args.zonaHoraria)) {
    return 'preferencia_nueva';
  }
  const pideCita = args.intencion === 'agendar' || args.intencion === 'reagendar';
  if (!pideCita || args.tieneHoraCogida) return null;

  // El primer turno, y también el de quien vuelve a pedir sin tener nada cogido:
  // se mira la agenda otra vez, que es barato y no le rompe nada suyo.
  return args.propuestasVivas.length === 0 ? 'sin_propuestas' : 'refresco';
}

/**
 * El servicio del que se está hablando, si todavía se está hablando de él.
 *
 * **El servicio vigente caduca con la conversación.** Existe para entender las
 * continuaciones cortas —«sí, por favor» tras ofrecerle la limpieza, «¿y por la
 * tarde?»— dentro de un mismo intercambio. Sin plazo, un `laser-axilas` de
 * agosto se usó en octubre para «quiero una nueva cita para el lunes»: se
 * propusieron huecos de axilas sin nombrar el tratamiento, y el paciente creía
 * estar pidiendo una limpieza facial. Y no sólo por el respaldo: el clasificador
 * recibía «servicio ya determinado: laser-axilas; si no cambia de tratamiento,
 * devuélvelo», y lo devolvía como si lo hubiera dicho él.
 *
 * El plazo es lo que vive una propuesta (`vencimientos.propuestaMinutos`),
 * contado desde el último mensaje: un intercambio de agendado dura lo que sus
 * propuestas, y pasado eso el paciente vuelve en frío y hay que preguntarle. No
 * es un parámetro nuevo: sale del YAML como los demás. Y se decide al leer, no
 * con un proceso que lo borre (regla 8).
 */
export function servicioVigente(
  conversacion: { readonly serviceCode: string | null; readonly lastMessageAt: Date | null },
  ahora: Date,
  minutos: number,
): string | null {
  if (conversacion.serviceCode === null || conversacion.lastMessageAt === null) return null;
  const caduca = conversacion.lastMessageAt.getTime() + minutos * 60_000;
  return ahora.getTime() < caduca ? conversacion.serviceCode : null;
}

/** Las categorías que dejan la conversación en pausa hasta que actúe una persona. */
const PAUSAN: readonly Categoria[] = ['urgencia_clinica', 'minoria_de_edad'];

const MOTIVO_ESCALADO: Readonly<
  Record<
    Categoria,
    | 'urgencia_clinica'
    | 'contenido_clinico'
    | 'peticion_paciente'
    | 'menor_de_edad'
    | 'derechos_rgpd'
  >
> = {
  urgencia_clinica: 'urgencia_clinica',
  contenido_clinico: 'contenido_clinico',
  minoria_de_edad: 'menor_de_edad',
  baja: 'peticion_paciente',
  derechos_rgpd: 'derechos_rgpd',
};

const SEVERIDAD: Readonly<Record<Categoria, number>> = {
  urgencia_clinica: 3,
  minoria_de_edad: 2,
  contenido_clinico: 2,
  baja: 1,
  derechos_rgpd: 2,
};

/**
 * Suelta UNA cita del paciente y deja el mundo coherente.
 *
 * Lo usan cancelar y reagendar, y hace las tres cosas que hay que hacer juntas o
 * ninguna: soltar la fila, cancelar la cita si llegó a existir, y **retirar el
 * aviso de recepción si ya había salido**. Ese último es el que faltaba: desde
 * `pendiente_recepcion` el aviso está en manos de recepción y no se retira solo.
 *
 * Recibe la cita concreta, nunca «la del paciente»: puede tener varias, y elegir
 * cuál se suelta es de quien llama, que es quien sabe a cuál se refería.
 */
async function soltarCita(
  clientId: string,
  tx: Tx,
  cita: q.HoldRow,
  ahora: Date,
  motivo: 'cita_cancelada' | 'reagendada',
  /** El hueco que la sustituye, si el paciente se ha quedado con otra hora. */
  sustituidoPorHoldId: string | null,
): Promise<EfectoDeSalida[]> {
  await q.actualizarHueco(clientId, tx, cita.id, {
    state: 'liberada',
    stateChangedAt: ahora,
    releasedAt: ahora,
    releaseReason: 'cancelacion',
    expiresAt: null,
  });

  const creada = await q.citaDeHueco(clientId, tx, cita.id);
  if (creada !== undefined) {
    await q.actualizarCita(clientId, tx, creada.id, { outcome: 'cancelada' });
  }

  await q.anotarAuditoria(clientId, tx, {
    entity: 'holds',
    entityId: cita.id,
    action: motivo,
    fromState: cita.state,
    toState: 'liberada',
    actor: 'paciente',
  });

  // Sólo si el aviso llegó a salir. Desde `retenida` no ha salido nada y
  // avisar de que queda sin efecto algo que nadie recibió es ruido, que es la
  // forma en que recepción deja de leer lo que le mandamos.
  return cita.state === 'pendiente_recepcion' || cita.state === 'confirmada'
    ? [{ tipo: 'avisar_a_recepcion_de_anulacion', holdId: cita.id, sustituidoPorHoldId }]
    : [];
}

/**
 * Avisa a una persona de que al paciente se le dijo algo que no era verdad, y
 * de qué.
 *
 * Dos usos con criterio distinto, y por eso `deduplicar` es explícito:
 * - El barrido escala cada mensaje la PRIMERA vez que lo desmiente. Es
 *   información nueva: si se le dijeron dos cosas falsas, recepción tiene que
 *   saber las dos. Deduplicar ahí perdía la segunda en silencio.
 * - La validación que falla por el historial habla de algo ya avisado: con uno
 *   abierto no se repite, y queda rastro, porque un escalado que no aparece
 *   tiene que distinguirse de uno que se perdió.
 */
async function escalarHistorialFalso(
  clientId: string,
  tx: Tx,
  datos: {
    conversationId: string;
    patientId: string;
    detalle: string;
    ahora: Date;
    deduplicar: boolean;
  },
): Promise<EfectoDeSalida[]> {
  if (
    datos.deduplicar &&
    (await q.escaladoAbiertoPorMotivo(clientId, tx, datos.conversationId, 'historial_falso'))
  ) {
    await q.anotarAuditoria(clientId, tx, {
      entity: 'conversations',
      entityId: datos.conversationId,
      action: 'escalado_no_duplicado:historial_falso',
      actor: 'sistema',
    });
    return [];
  }
  const escaladoId = await q.crearEscalado(clientId, tx, {
    conversationId: datos.conversationId,
    patientId: datos.patientId,
    reason: 'historial_falso',
    detail: datos.detalle,
    severity: 2,
    notifiedAt: datos.ahora,
    createdAt: datos.ahora,
  });
  return [{ tipo: 'escalar_a_humano', escaladoId, severidad: 2, motivo: 'historial_falso' }];
}

/**
 * La agenda no responde y el paciente pedía hueco: se le contesta, se guarda el
 * turno y queda un escalado. Ninguna ruta termina en silencio (regla 4), y
 * tampoco se pierde lo que escribió.
 *
 * Un escalado por conversación mientras siga abierto: si el paciente insiste, se
 * le contesta cada vez —quien pide cita y recibe silencio asume que no ha
 * llegado— pero no se avisa cada vez, y queda rastro de que no se duplicó.
 */
async function responderAgendaCaida(
  clientId: string,
  tx: Tx,
  datos: {
    conversationId: string;
    patientId: string;
    intencion: Extraccion['intencion'];
    detalle: string;
    cliente: ContextoDeCliente;
    efectosPrevios: EfectoDeSalida[];
    ahora: Date;
  },
): Promise<SalidaCruda> {
  const texto = datos.cliente.textos.agendaNoDisponible();
  await q.guardarMensaje(clientId, tx, {
    conversationId: datos.conversationId,
    direction: 'saliente',
    body: texto,
    isClinical: false,
    intent: datos.intencion,
    createdAt: datos.ahora,
  });
  await q.actualizarConversacion(clientId, tx, datos.conversationId, { lastMessageAt: datos.ahora });

  const efectos: EfectoDeSalida[] = [...datos.efectosPrevios];
  if (await q.escaladoAbiertoPorMotivo(clientId, tx, datos.conversationId, 'agenda_no_disponible')) {
    await q.anotarAuditoria(clientId, tx, {
      entity: 'conversations',
      entityId: datos.conversationId,
      action: 'escalado_no_duplicado:agenda_no_disponible',
      actor: 'sistema',
    });
  } else {
    const escaladoId = await q.crearEscalado(clientId, tx, {
      conversationId: datos.conversationId,
      patientId: datos.patientId,
      reason: 'agenda_no_disponible',
      detail: datos.detalle,
      severity: 2,
      notifiedAt: datos.ahora,
      createdAt: datos.ahora,
    });
    efectos.push({ tipo: 'escalar_a_humano', escaladoId, severidad: 2, motivo: 'agenda_no_disponible' });
  }

  return {
    conversacionId: datos.conversationId,
    estadoConversacion: 'abierta',
    respuesta: texto,
    corte: null,
    efectos,
  };
}

/**
 * ¿El hueco lo ha rechazado la base de datos por estar ya dado?
 *
 * Dos guardianes, mismo significado: `holds_slot_unico` impide la doble reserva
 * y `holds_hueco_ocupado` impide proponer o solapar sobre un hueco vivo.
 */
/**
 * «Láser axilas, viernes, 28, 17:00»: tratamiento, día y hora, en hora de la
 * clínica. Es como se nombra una cita ante el clasificador y el redactor, que
 * ahora tienen que poder distinguir entre varias. Sin nada del paciente.
 */
function describirCita(
  cita: { readonly serviceCode: string; readonly slotStart: Date },
  cliente: ContextoDeCliente,
): string {
  const nombre =
    cliente.config.servicios.find((s) => s.codigo === cita.serviceCode)?.nombre ?? 'Cita';
  return `${nombre}, ${momentoLocal(cita.slotStart, cliente.config.zonaHoraria)}`;
}

/** «lunes 24 a las 11:00», en hora de la clínica. */
function momentoLocal(fecha: Date, zonaHoraria: string): string {
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: zonaHoraria,
    weekday: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(fecha);
}

const COLISIONES = new Set(['holds_slot_unico', 'holds_hueco_ocupado']);

function esColisionDeHueco(error: unknown): boolean {
  // Drizzle envuelve el error de Postgres, así que hay que mirar también el
  // `cause`: quedarse en la capa de fuera es no reconocer nunca la colisión.
  for (let e: unknown = error; e !== null && e !== undefined; e = (e as { cause?: unknown }).cause) {
    if (typeof e !== 'object') break;
    const pg = e as { code?: unknown; constraint_name?: unknown };
    if (pg.code === '23505' && COLISIONES.has(String(pg.constraint_name))) return true;
  }
  return false;
}

/**
 * Quién envía lo que salga de este turno.
 *
 * - `n8n` (por defecto): lo devuelve en la respuesta HTTP y lo envía n8n. Es lo
 *   que entra por `POST /mensaje-entrante`.
 * - `nucleo`: lo encola en la tabla de salida **dentro de la transacción del
 *   turno**, y lo envía el ejecutor (regla 3). Es lo que entra por el webhook de
 *   WhatsApp del núcleo.
 *
 * Lo decide la puerta de entrada, no la clínica: así n8n y el núcleo conviven
 * hasta el cambio de URL en Meta sin que nada se envíe dos veces.
 */
export type QuienEnvia = 'n8n' | 'nucleo' | PorChatwoot;

/**
 * - `chatwoot`: como `nucleo`, pero lo que sale va a la conversación de
 *   Chatwoot de la que vino el mensaje. La respuesta al paciente, como mensaje;
 *   los avisos a la clínica, como **nota privada** en esa misma conversación,
 *   que es donde trabaja el equipo. Es lo que entra por `/chatwoot`.
 */
export type PorChatwoot = Extract<CanalDelPaciente, { por: 'chatwoot' }>;

export async function procesarMensajeEntrante(
  deps: Dependencias,
  entrada: EntradaDeMensaje,
  envia: QuienEnvia = 'n8n',
): Promise<{ statusCode: number; cuerpo: SalidaDeMensaje }> {
  const ahora = deps.reloj();
  const hash = hashDePeticion({ ...entrada, idempotencyKey: undefined });

  return deps.core.withClient(entrada.clientId, async (tx) => {
    // 1. Idempotencia: si Meta reintenta, devuelve lo mismo que la primera vez.
    const previa = await respuestaPrevia(entrada.clientId, tx, entrada.idempotencyKey, hash);
    if (previa !== undefined) {
      return { statusCode: previa.statusCode, cuerpo: previa.cuerpo as SalidaDeMensaje };
    }

    const crudo = await procesar(deps, tx, entrada, ahora);
    /**
     * Los efectos salen resueltos: a quién van y con qué texto. Se hace aquí, una
     * vez y para todos, en vez de en los nueve sitios que los emiten — olvidarse
     * en uno no rompería nada, sólo dejaría un aviso sin llegar.
     *
     * Y se guarda ya resuelto en la respuesta idempotente: si Meta reintenta,
     * tiene que recibir exactamente lo mismo, destinatarios incluidos.
     */
    const cliente = await resolverCliente(entrada.clientId, tx, deps.configuracion);
    const salida: SalidaDeMensaje = {
      ...crudo,
      efectos: await resolverEfectos(entrada.clientId, tx, cliente, crudo.efectos),
    };

    if (envia !== 'n8n') {
      const canal: CanalDelPaciente =
        envia === 'nucleo' ? { por: 'meta', telefono: entrada.telefono, remitenteId: cliente.config.canal.remitenteId } : envia;
      // Para lo que el sistema le escriba después por su cuenta (un cron).
      await q.guardarCanal(entrada.clientId, tx, salida.conversacionId, canal);
      await encolarParaElPaciente(entrada.clientId, tx, {
        clave: entrada.idempotencyKey,
        conversationId: salida.conversacionId,
        plantillas: cliente.config.plantillas,
        canal,
        clinica: cliente.config.nombre,
        respuesta: salida.respuesta,
        efectos: salida.efectos,
        ahora,
      });
    }

    await guardarRespuesta(entrada.clientId, tx, {
      clave: entrada.idempotencyKey,
      endpoint: '/mensaje-entrante',
      hash,
      statusCode: 200,
      cuerpo: salida,
    });

    return { statusCode: 200, cuerpo: salida };
  });
}

/**
 * Lo que sale del turno, a la tabla de salida, en la misma transacción (regla
 * 3): la respuesta al paciente, los avisos a la clínica y el evento de agenda.
 * Si el turno revierte, no se encola nada; si confirma, sale aunque el proceso
 * caiga. Lo usan el turno y el ejecutor, que encola por aquí lo que sale cuando
 * Google contesta.
 *
 * - **Por Meta**, los avisos a la clínica van por WhatsApp a cada destinatario.
 * - **Por Chatwoot**, como **una nota privada por aviso** en la conversación del
 *   paciente, que es donde el equipo ya está mirando: desde la línea de la
 *   clínica, a un móvil que no le ha escrito en 24 h, Meta no lo entrega sin
 *   plantilla. Los avisos de infraestructura (del operador, sin destinatarios
 *   en la clínica) no dejan nota: ya salen por correo y al equipo no le dicen
 *   nada. Y **una urgencia clínica no puede depender de que alguien mire
 *   Chatwoot de madrugada**: además de la nota, el operador recibe un correo,
 *   sin datos del paciente.
 * - **El evento de agenda** (modo `automatica`) va con el canal del paciente:
 *   la confirmación no sale del turno sino del ejecutor, cuando el evento
 *   existe, y tiene que llegar por donde vino el mensaje.
 */
export async function encolarParaElPaciente(
  clientId: string,
  tx: Tx,
  datos: {
    clave: string;
    canal: CanalDelPaciente;
    clinica: string;
    respuesta: string | null;
    efectos: readonly EfectoParaEncolar[];
    ahora: Date;
    /** Para lo que el sistema le escribe por su cuenta: de quién es la ventana de 24 h. */
    conversationId?: string | null;
    plantillas?: Plantillas;
  },
): Promise<void> {
  const { canal } = datos;
  if (datos.respuesta !== null && datos.respuesta !== '') {
    await alPaciente(clientId, tx, { canal, texto: datos.respuesta, dedupeKey: `respuesta:${datos.clave}`, ahora: datos.ahora });
  }

  for (const [i, efecto] of datos.efectos.entries()) {
    if (efecto.tipo === 'crear_evento_agenda') {
      if (!('idempotencyKey' in efecto)) continue;
      await q.encolarSalida(clientId, tx, {
        kind: 'evento_agenda',
        // Un evento por cita, venga del turno o de una colisión: el mismo
        // hueco no se encola dos veces.
        dedupeKey: efecto.idempotencyKey,
        payload: {
          holdId: efecto.holdId,
          calendarioId: efecto.calendarioId,
          idempotencyKey: efecto.idempotencyKey,
          inicio: efecto.inicio,
          fin: efecto.fin,
          resumen: efecto.resumen,
          descripcion: efecto.descripcion,
          canal,
          clinica: datos.clinica,
        },
        ahora: datos.ahora,
      });
      continue;
    }
    if (efecto.texto === '') continue;

    // Lo que el sistema le escribe al paciente por su cuenta (un cron): a él,
    // por su canal, nunca como nota del equipo. Y con plantilla si han pasado
    // las 24 h desde su último mensaje.
    if (efecto.tipo === 'mensaje_al_paciente') {
      const uso = 'plantilla' in efecto ? usoDePlantilla(efecto.plantilla) : null;
      await encolarAvisoAlPaciente(clientId, tx, {
        canal,
        conversationId: datos.conversationId ?? null,
        uso,
        texto: efecto.texto,
        variables: 'variables' in efecto && efecto.variables !== undefined ? efecto.variables : {},
        plantillas: datos.plantillas ?? {},
        clinica: datos.clinica,
        dedupeKey: `efecto:${datos.clave}:${i}`,
        ahora: datos.ahora,
      });
      continue;
    }

    // Quien tiene el correo como canal lo recibe por correo, sea cual sea el
    // canal del paciente: protección de datos, por ejemplo, no mira Chatwoot.
    for (const d of efecto.destinatarios) {
      if (d.canal !== 'email') continue;
      await q.encolarSalida(clientId, tx, {
        kind: 'correo',
        dedupeKey: `efecto:${datos.clave}:${i}:${d.destino}`,
        payload: { correoA: d.destino, asunto: `[${datos.clinica}] ${asuntoDelAviso(efecto.tipo)}`, cuerpo: efecto.texto },
        ahora: datos.ahora,
      });
    }

    if (canal.por === 'meta') {
      for (const d of efecto.destinatarios) {
        if (d.canal !== 'whatsapp') continue;
        await q.encolarSalida(clientId, tx, {
          kind: 'whatsapp',
          dedupeKey: `efecto:${datos.clave}:${i}:${d.destino}`,
          payload: { para: d.destino, texto: efecto.texto, remitenteId: canal.remitenteId },
          ahora: datos.ahora,
        });
      }
      continue;
    }

    if (efecto.destinatarios.length === 0) continue;
    await q.encolarSalida(clientId, tx, {
      kind: 'chatwoot',
      dedupeKey: `nota:${datos.clave}:${i}`,
      payload: { cuentaId: canal.cuentaId, conversacionId: canal.conversacionId, texto: efecto.texto, privado: true },
      ahora: datos.ahora,
    });
    if (efecto.tipo === 'escalar_a_humano' && 'severidad' in efecto && efecto.severidad >= 3) {
      await q.encolarSalida(clientId, tx, {
        kind: 'correo_operador',
        dedupeKey: `urgente:${efecto.escaladoId}`,
        payload: {
          asunto: `[Motor de Citas] Escalado urgente · ${datos.clinica}`,
          cuerpo: [
            `Hay un escalado de severidad ${efecto.severidad} que necesita a una persona ya.`,
            `Está como nota privada en Chatwoot: cuenta ${canal.cuentaId}, conversación n.º ${canal.conversacionId}.`,
            `Escalado: ${efecto.escaladoId}`,
            `Hora: ${datos.ahora.toISOString()}`,
          ].join('\n'),
        },
        ahora: datos.ahora,
      });
    }
  }
}

/**
 * Un efecto que puede salir por la tabla de salida: los del turno y los de la
 * máquina de estados que emiten los crons (un aviso de caducidad al paciente,
 * un recordatorio a recepción), ya resueltos —a quién y qué dicen—.
 */
export type EfectoParaEncolar =
  | EfectoResuelto
  | (EfectoDeHueco & {
      readonly destinatarios: readonly Destinatario[];
      readonly texto: string;
      readonly variables?: Readonly<Partial<Record<VariableDePlantilla, string>>>;
    });

/** El uso de plantilla de un aviso de la máquina de estados, si tiene. */
function usoDePlantilla(plantilla: PlantillaPaciente): UsoDePlantilla | null {
  switch (plantilla) {
    case 'propuesta_caducada':
    case 'retencion_caducada':
    case 'sin_respuesta_de_recepcion':
    case 'hueco_retenido':
      return plantilla;
    case 'cita_confirmada':
    case 'hueco_ocupado_proponemos_alternativa':
    case 'cancelacion_confirmada':
      return null;
  }
}

/** Margen sobre las 24 h de WhatsApp: un envío que tarda en salir no puede caer justo fuera. */
export const HORAS_DE_VENTANA = 23;

/**
 * **Un aviso que el sistema le manda al paciente por su cuenta** (un cron, un
 * recordatorio, una reseña). WhatsApp sólo entrega texto libre en las 24 h
 * siguientes a su último mensaje; pasado eso, sólo plantillas aprobadas.
 *
 * - Dentro de la ventana: texto normal, como siempre.
 * - Fuera, con plantilla para ese uso en el YAML: la plantilla, con sus
 *   variables en el orden que diga la configuración.
 * - Fuera y sin plantilla: **no se manda** —Chatwoot lo aceptaría y Meta lo
 *   rechazaría después, en silencio—, y el operador recibe un correo sin datos
 *   del paciente diciendo qué plantilla falta.
 *
 * Por Meta directo todavía no hay plantillas: fuera de la ventana, el mismo aviso.
 */
export async function encolarAvisoAlPaciente(
  clientId: string,
  tx: Tx,
  datos: {
    canal: CanalDelPaciente;
    conversationId: string | null;
    uso: UsoDePlantilla | null;
    texto: string;
    variables: Readonly<Partial<Record<VariableDePlantilla, string>>>;
    plantillas: Plantillas;
    clinica: string;
    dedupeKey: string;
    ahora: Date;
  },
): Promise<'texto' | 'plantilla' | 'sin_plantilla'> {
  const ultimo = datos.conversationId === null ? null : await q.ultimoMensajeDelPaciente(clientId, tx, datos.conversationId);
  const dentro = ultimo !== null && datos.ahora.getTime() - ultimo.getTime() < HORAS_DE_VENTANA * 3_600_000;
  if (dentro) {
    await alPaciente(clientId, tx, { canal: datos.canal, texto: datos.texto, dedupeKey: datos.dedupeKey, ahora: datos.ahora });
    return 'texto';
  }

  const plantilla = datos.uso === null ? undefined : datos.plantillas[datos.uso];
  const parametros = plantilla?.variables.map((v) => datos.variables[v]);
  if (datos.canal.por === 'chatwoot' && plantilla !== undefined && parametros !== undefined && parametros.every((p) => p !== undefined && p !== '')) {
    await q.encolarSalida(clientId, tx, {
      kind: 'chatwoot',
      dedupeKey: datos.dedupeKey,
      payload: {
        cuentaId: datos.canal.cuentaId,
        conversacionId: datos.canal.conversacionId,
        texto: datos.texto,
        privado: false,
        plantilla: { nombre: plantilla.nombre, idioma: plantilla.idioma, parametros: parametros as string[] },
      },
      ahora: datos.ahora,
    });
    return 'plantilla';
  }

  const falta =
    datos.uso === null
      ? 'este aviso no tiene uso de plantilla'
      : plantilla === undefined
        ? `falta la plantilla «${datos.uso}» en el YAML (plantillas.${datos.uso})`
        : datos.canal.por !== 'chatwoot'
          ? 'por Meta directo todavía no se mandan plantillas'
          : `a la plantilla «${datos.uso}» le falta un dato: ${plantilla.variables.filter((v) => !datos.variables[v]).join(', ')}`;
  await q.encolarSalida(clientId, tx, {
    kind: 'correo_operador',
    dedupeKey: `sin_plantilla:${datos.dedupeKey}`,
    payload: {
      asunto: `[Motor de Citas] Un aviso no se ha enviado: fuera de las 24 h · ${datos.clinica}`,
      cuerpo: [
        `Han pasado más de ${HORAS_DE_VENTANA} h desde el último mensaje del paciente y WhatsApp sólo entrega plantillas aprobadas.`,
        `No se ha enviado: ${falta}.`,
        `Uso: ${datos.uso ?? '—'}`,
        `Conversación: ${datos.conversationId ?? '—'}`,
        `Hora: ${datos.ahora.toISOString()}`,
      ].join('\n'),
    },
    ahora: datos.ahora,
  });
  return 'sin_plantilla';
}

function asuntoDelAviso(tipo: string): string {
  switch (tipo) {
    case 'escalar_a_humano':
      return 'Necesita a una persona';
    case 'avisar_a_recepcion':
    case 'recordar_a_recepcion':
      return 'Cita para meter en la agenda';
    case 'informar_a_recepcion':
      return 'Cita nueva en la agenda';
    case 'avisar_a_recepcion_de_anulacion':
      return 'Un aviso de cita ya no vale';
    default:
      return 'Aviso';
  }
}

async function alPaciente(
  clientId: string,
  tx: Tx,
  datos: { canal: CanalDelPaciente; texto: string; dedupeKey: string; ahora: Date },
): Promise<void> {
  const { canal } = datos;
  await (canal.por === 'chatwoot'
    ? q.encolarSalida(clientId, tx, {
        kind: 'chatwoot',
        dedupeKey: datos.dedupeKey,
        payload: { cuentaId: canal.cuentaId, conversacionId: canal.conversacionId, texto: datos.texto, privado: false },
        ahora: datos.ahora,
      })
    : q.encolarSalida(clientId, tx, {
        kind: 'whatsapp',
        dedupeKey: datos.dedupeKey,
        payload: { para: canal.telefono, texto: datos.texto, remitenteId: canal.remitenteId },
        ahora: datos.ahora,
      }));
}

/**
 * Lo que emite un cron, a la tabla de salida, **dentro de su transacción**
 * (regla 3) y por el canal de cada conversación. Un cron no tiene mensaje
 * entrante del que sacar a quién contestar: lo saca de la conversación
 * (`reply_channel`), que dejó ahí el último turno.
 *
 * Una conversación sin canal es una que sólo entró por n8n. Lo que fuera para
 * el paciente no tiene por dónde salir, y eso no se calla: el operador recibe
 * un correo, sin datos del paciente.
 */
export async function encolarEfectosDelSistema(
  clientId: string,
  tx: Tx,
  datos: {
    clave: string;
    conversationId: string | null;
    clinica: string;
    efectos: readonly EfectoParaEncolar[];
    ahora: Date;
    plantillas?: Plantillas;
  },
): Promise<void> {
  if (datos.efectos.length === 0) return;
  const canal = datos.conversationId === null ? null : await q.canalDeLaConversacion(clientId, tx, datos.conversationId);
  if (canal !== null) {
    await encolarParaElPaciente(clientId, tx, { ...datos, canal, respuesta: null });
    return;
  }
  const sinSalida = datos.efectos.filter((e) => e.texto !== '' && (e.tipo === 'mensaje_al_paciente' || e.destinatarios.length > 0));
  if (sinSalida.length === 0) return;
  await q.encolarSalida(clientId, tx, {
    kind: 'correo_operador',
    dedupeKey: `sin_canal:${datos.clave}`,
    payload: {
      asunto: `[Motor de Citas] Un aviso no tiene por dónde salir · ${datos.clinica}`,
      cuerpo: [
        `${sinSalida.length} aviso(s) (${[...new Set(sinSalida.map((e) => e.tipo))].join(', ')}) son de una conversación que nunca ha entrado por Chatwoot ni por Meta en el núcleo.`,
        `Conversación: ${datos.conversationId ?? 'ninguna'}`,
        `Origen: ${datos.clave}`,
        `Hora: ${datos.ahora.toISOString()}`,
      ].join('\n'),
    },
    ahora: datos.ahora,
  });
}

async function procesar(
  deps: Dependencias,
  tx: Tx,
  entrada: EntradaDeMensaje,
  ahora: Date,
): Promise<SalidaCruda> {
  const { clientId } = entrada;
  const cliente = await resolverCliente(clientId, tx, deps.configuracion);
  const paciente = await q.upsertPatient(clientId, tx, {
    phoneE164: entrada.telefono,
    givenName: entrada.nombre,
  });
  let conversacion = await q.conversacionAbierta(clientId, tx, paciente.id);
  /** Efectos generados antes de decidir la ruta del mensaje. */
  const efectosPrevios: EfectoDeSalida[] = [];
  const phoneHash = hashTelefono(entrada.telefono, deps.pimienta);

  /**
   * Lo que no es texto se registra igual, con una etiqueta legible.
   *
   * El hilo que lee una persona de la clínica tiene que decir que ahí hubo una
   * nota de voz; un hueco en blanco haría pensar que no llegó nada.
   */
  const tipo: TipoDeMensaje = entrada.tipo ?? 'texto';
  const ETIQUETA: Readonly<Record<TipoDeMensaje, string>> = {
    texto: '',
    audio: '[nota de voz]',
    imagen: '[imagen]',
    documento: '[documento]',
    ubicacion: '[ubicación]',
    otro: '[mensaje no compatible]',
  };
  const cuerpoDelMensaje = tipo === 'texto' ? (entrada.texto ?? '') : ETIQUETA[tipo];

  // El cortafuegos ve la ventana reciente, no sólo este mensaje: en WhatsApp la
  // gente parte lo que escribe.
  const ventana = {
    mensajes: cliente.config.cortafuegos.ventanaMensajes,
    segundos: cliente.config.cortafuegos.ventanaSegundos,
  };
  const desde = new Date(ahora.getTime() - ventana.segundos * 1000);
  const recientes = await q.entrantesRecientes(clientId, tx, conversacion.id, desde);
  /**
   * El cortafuegos no evalúa lo que no puede leer.
   *
   * Y ése es el límite honesto de esto: **una urgencia contada en una nota de
   * voz no la detecta nadie**. No se transcribe —sería sacar audio de salud a un
   * tercero— y no se escala cada audio, porque en esta clínica la gente manda
   * audios a todas horas y eso es la fatiga de alertas de siempre. Lo que sí se
   * hace es pedirle que lo escriba, que es lo único que devuelve el mensaje al
   * camino donde sí hay barreras.
   */
  const corte = evaluar({
    texto: tipo === 'texto' ? (entrada.texto ?? '') : '',
    recientes,
    ahora,
    ventana,
    patronesAdicionales: cliente.patronesAdicionales,
  });

  // Se registra SIEMPRE, corte o no (regla 6), y con la marca clínica que
  // decide su retención.
  const mensajeEntranteId = await q.guardarMensaje(clientId, tx, {
    conversationId: conversacion.id,
    direction: 'entrante',
    body: cuerpoDelMensaje,
    isClinical: corte.corta ? corte.esClinico : false,
    providerMessageId: entrada.proveedorMensajeId ?? null,
    firewallRule: corte.corta ? corte.patrones.join(',') : null,
    firewallCategory: corte.corta ? corte.categoria : null,
    createdAt: ahora,
  });

  const suprimido = await q.estaSuprimido(clientId, tx, phoneHash);

  /**
   * Baja previa: **la supresión bloquea lo que enviamos nosotros, no lo que él
   * nos pide.**
   *
   * Antes esto era silencio absoluto y un escalado por cada mensaje. El propio
   * texto de la baja dice «escríbenos cuando quieras», el paciente escribía
   * treinta segundos después pidiendo cita, y no había salida: se perdía el
   * paciente y recepción recibía cinco avisos idénticos.
   *
   * Confundíamos dos cosas. Honrar el opt-out es no escribirle **por iniciativa
   * nuestra** —nada de oleadas ni de recordatorios comerciales— y eso lo
   * garantiza la comprobación de la lista de bajas en el momento del envío de
   * cada oleada. Contestar a quien nos escribe pidiendo algo no es una
   * comunicación comercial: es atender una petición suya.
   *
   * **Pedir cita NO revoca la baja comercial.** Se le atiende, se le da cita si
   * la pide, y sigue fuera de las oleadas mientras no lo diga explícitamente.
   * Deducir un consentimiento de una acción que no lo expresa es exactamente lo
   * que no se puede hacer: para volver a las oleadas hace falta que lo pida, y
   * eso es `POST /reactivar-comunicaciones`, no un efecto lateral de reservar.
   */
  if (conversacion.status === 'cerrada') {
    await q.actualizarConversacion(clientId, tx, conversacion.id, {
      status: 'abierta',
      closedAt: null,
    });
    conversacion = { ...conversacion, status: 'abierta', closedAt: null };

    // Una vez, no una por mensaje: que la clínica sepa que alguien que se dio
    // de baja ha vuelto a escribir es útil; que lo sepa cinco veces es ruido.
    const yaAvisado = await q.escaladoAbiertoPorMotivo(
      clientId,
      tx,
      conversacion.id,
      'peticion_paciente',
    );
    if (yaAvisado) {
      await q.anotarAuditoria(clientId, tx, {
        entity: 'conversations',
        entityId: conversacion.id,
        action: 'escalado_no_duplicado:peticion_paciente',
        actor: 'sistema',
      });
    } else {
      const escaladoId = await q.crearEscalado(clientId, tx, {
        conversationId: conversacion.id,
        patientId: paciente.id,
        reason: 'peticion_paciente',
        severity: 1,
        notifiedAt: ahora,
        createdAt: ahora,
      });
      efectosPrevios.push({
        tipo: 'escalar_a_humano',
        escaladoId,
        severidad: 1,
        motivo: 'peticion_paciente',
      });
    }

    await q.anotarAuditoria(clientId, tx, {
      entity: 'conversations',
      entityId: conversacion.id,
      // La baja sigue en pie: lo que se reabre es la conversación, no el
      // consentimiento comercial.
      action: suprimido ? 'reabierta_por_paciente_con_baja_vigente' : 'reabierta_por_paciente',
      actor: 'paciente',
    });
  }

  /**
   * **El cortafuegos se aplica SIEMPRE, también en pausa.**
   *
   * Antes la rama de pausa devolvía antes de llegar aquí, así que un mensaje
   * como «desde la última sesión tengo la zona irritada» entraba en una
   * conversación pausada por una queja y no se miraba: el escalado seguía
   * siendo `pide_persona` severidad 2, sujeto a la franja de contacto y dirigido
   * a contactos comerciales. Un enrojecimiento contado a las 23:00 esperaba a
   * las 09:00.
   *
   * El cortafuegos sí se ejecutaba —es determinista y no cuesta nada— pero su
   * resultado se tiraba. Lo que hay que suprimir en pausa es **la duplicación de
   * escalados equivalentes**, no la evaluación, y desde luego no la respuesta al
   * paciente.
   *
   * Esto arregla de paso un agujero que nadie había mirado: **una baja pedida en
   * pausa se ignoraba**. No honrar una baja es de las cosas que más caro salen.
   */
  /**
   * Los crons se vigilan con el tráfico de pacientes, no con otro cron: si los
   * crons se mueren, un cron que los vigile se muere con ellos. Un mensaje
   * entrante lo provoca el paciente, así que es una señal de vida independiente
   * de nuestra infraestructura.
   */
  efectosPrevios.push(
    ...(await revisarLatidos(tx, {
      clientId,
      conversationId: conversacion.id,
      patientId: paciente.id,
      ahora,
      cliente,
    })),
  );

  /** Une lo que se decidió antes de enrutar con lo que produzca la ruta. */
  const conEfectosPrevios = (salida: SalidaCruda): SalidaCruda =>
    efectosPrevios.length === 0
      ? salida
      : { ...salida, efectos: [...efectosPrevios, ...salida.efectos] };

  if (corte.corta) {
    return conEfectosPrevios(
      await aplicarCorte(deps, tx, { entrada, paciente, conversacion, corte, ahora, cliente }),
    );
  }

  /**
   * **El agente parado no contesta**, y eso es lo único que hace el
   * interruptor. Lo para una persona —hoy con una etiqueta de Chatwoot, mañana
   * con un botón— porque va a llevar ella la conversación, y hasta que no lo
   * reactive el agente no dice nada: ni modelo, ni textos de relleno.
   *
   * No es la regla 4 rota: el silencio es del agente, no del sistema, y lo ha
   * decidido una persona que está en la conversación. Lo que el interruptor
   * **no** apaga está arriba: el mensaje se guarda (regla 6) y el cortafuegos
   * corre igual (regla 5). Quien lo paró puede habérselo dejado así a las tres
   * de la mañana, y una urgencia contada entonces recibe su texto aprobado y su
   * escalado, como siempre.
   */
  if (paciente.agentStoppedAt !== null) {
    return conEfectosPrevios({
      conversacionId: conversacion.id,
      estadoConversacion: conversacion.status,
      respuesta: null,
      corte: null,
      efectos: [],
    });
  }

  /**
   * En pausa y **sin corte**: el agente no vuelve a responder solo. Al paciente
   * se le dice que su mensaje está siendo atendido, pero no una vez por mensaje
   * — duplicar avisos es lo que hace que dejen de mirarlos.
   *
   * El límite de 30 minutos vale para estos mensajes de relleno y sólo para
   * ellos. Un mensaje que dispara el cortafuegos no pasa por aquí: se responde
   * siempre, arriba, con el texto de su categoría.
   */
  if (conversacion.status === 'pausada') {
    const minutos = cliente.config.cortafuegos.minutosEntreAvisosEnPausa;
    const ultimo = conversacion.lastAutoReplyAt;
    const tocaAvisar =
      ultimo === null || ahora.getTime() - ultimo.getTime() >= minutos * 60_000;

    if (tocaAvisar) {
      const texto = cliente.textos.enPausa();
      await q.guardarMensaje(clientId, tx, {
        conversationId: conversacion.id,
        direction: 'saliente',
        body: texto,
        isClinical: false,
        createdAt: ahora,
      });
      await q.actualizarConversacion(clientId, tx, conversacion.id, { lastAutoReplyAt: ahora });
      return conEfectosPrevios({
        conversacionId: conversacion.id,
        estadoConversacion: 'pausada',
        respuesta: texto,
        corte: null,
        efectos: [],
      });
    }

    return conEfectosPrevios({
      conversacionId: conversacion.id,
      estadoConversacion: 'pausada',
      respuesta: null,
      corte: null,
      efectos: [],
    });
  }

  /**
   * Lo que no es texto: se le contesta y se acaba aquí.
   *
   * Va **después** de la rama de pausa a propósito. Si la conversación está en
   * manos de una persona, ésa sí puede escuchar el audio, así que el mensaje de
   * pausa es el correcto y decirle «ponmelo en texto» sería mandarle a repetir
   * algo que alguien ya está atendiendo.
   *
   * No pasa por el modelo: no hay nada que interpretar, y una llamada al
   * proveedor para producir un texto fijo es gasto sin contrapartida.
   */
  if (tipo !== 'texto') {
    const texto = cliente.textos.soloTexto(tipo);
    await q.guardarMensaje(clientId, tx, {
      conversationId: conversacion.id,
      direction: 'saliente',
      body: texto,
      isClinical: false,
      createdAt: ahora,
    });
    await q.actualizarConversacion(clientId, tx, conversacion.id, { lastMessageAt: ahora });

    return conEfectosPrevios({
      conversacionId: conversacion.id,
      estadoConversacion: 'abierta',
      respuesta: texto,
      corte: null,
      efectos: [],
    });
  }

  return conEfectosPrevios(
    await atenderYRegistrar(deps, tx, { entrada, paciente, conversacion, ahora, cliente, mensajeEntranteId }),
  );
}

/**
 * Atiende el mensaje y, salga por la rama que salga, deja registrado todo lo
 * que se le preguntó al modelo en este turno (regla 6) y pone al día el resumen.
 *
 * Envuelve a `atender` en vez de repartir el registro por sus quince salidas:
 * olvidarse en una no fallaría nada, simplemente ese turno no dejaría rastro.
 */
async function atenderYRegistrar(
  deps: Dependencias,
  tx: Tx,
  ctx: {
    entrada: EntradaDeMensaje;
    paciente: q.PatientRow;
    conversacion: q.ConversationRow;
    ahora: Date;
    cliente: ContextoDeCliente;
    mensajeEntranteId: string;
  },
): Promise<SalidaCruda> {
  let agente: Agente | undefined;
  const salida = await atender(deps, tx, { ...ctx, alConstruirAgente: (a) => (agente = a) });
  if (agente === undefined) return salida;

  await actualizarResumen(ctx.entrada.clientId, tx, {
    conversacion: ctx.conversacion,
    resumidor: agente.resumidor,
    ahora: ctx.ahora,
  });
  await q.registrarLlamadas(ctx.entrada.clientId, tx, ctx.mensajeEntranteId, agente.llamadas());
  return salida;
}

/** Cuántos mensajes tienen que haber salido de la ventana para resumir. */
const RESUMIR_CADA = 4;

/**
 * **Ventana de 8 turnos más resumen**, como dice docs/DESIGN_RULES.md. Lo segundo no
 * existía: la columna estaba, el prompt la leía y nada la escribía, así que a
 * partir del noveno turno el modelo no sabía lo que se había hablado antes.
 *
 * Se resume por tandas —cuando han salido de la ventana al menos cuatro
 * mensajes— para no gastar una llamada por turno. Lo clínico no entra: el
 * resumen vive lo que la conversación y lo clínico, noventa días. Tampoco lo que
 * se desmintió: resumir una mentira la volvería a poner en el prompt sin la
 * corrección al lado.
 */
async function actualizarResumen(
  clientId: string,
  tx: Tx,
  datos: { conversacion: q.ConversationRow; resumidor: Agente['resumidor']; ahora: Date },
): Promise<void> {
  const fuera = await q.mensajesFueraDeLaVentana(clientId, tx, {
    conversationId: datos.conversacion.id,
    ventana: TURNOS_EN_VENTANA * 2,
    desde: datos.conversacion.summaryUntil,
  });
  if (fuera.length < RESUMIR_CADA) return;

  const resumibles = fuera.filter(
    (m) => m.body !== null && !m.isClinical && m.disprovedAt === null && m.redactedAt === null && m.purgeAt > datos.ahora,
  );
  const hasta = fuera[fuera.length - 1]?.createdAt ?? null;

  let resumen = datos.conversacion.summary;
  if (resumibles.length > 0) {
    const nuevo = await datos.resumidor.resumir({
      resumenAnterior: datos.conversacion.purgeAt > datos.ahora ? datos.conversacion.summary : null,
      turnos: resumibles.map((m) => ({
        rol: m.direction === 'entrante' ? ('paciente' as const) : ('clinica' as const),
        texto: m.body ?? '',
      })),
    });
    // Si no se pudo, se deja como estaba y se reintenta en otro turno.
    if (nuevo === null) return;
    resumen = nuevo;
  }
  await q.actualizarConversacion(clientId, tx, datos.conversacion.id, { summary: resumen, summaryUntil: hasta });
}

/**
 * Severidad de lo que dejó la conversación en pausa.
 *
 * `pause_reason` guarda o una categoría del cortafuegos o una señal del
 * clasificador, y hay que poder compararlas: es lo que distingue «esto ya lo
 * está viendo alguien» de «esto es más grave que lo que lo está viendo».
 */
function severidadDePausa(motivo: string | null): number {
  return motivo === 'urgencia_clinica' ? 3 : 2;
}

/** ¿Va al responsable clínico, o a quien lleva quejas y peticiones? */
function esRutaClinica(motivo: string | null): boolean {
  return motivo === 'urgencia_clinica' || motivo === 'contenido_clinico';
}

/**
 * ¿Hay que abrir un escalado nuevo aunque la conversación ya esté en pausa?
 *
 * No duplicar es correcto —la fatiga de alertas es cómo este producto se
 * degrada— pero se estaba aplicando también a lo único que nunca puede esperar.
 * Dos motivos para volver a escalar, y los dos están decididos, no ocurren por
 * casualidad:
 *
 * 1. **Sube la severidad.** Una urgencia clínica dentro de una conversación
 *    pausada por una queja es severidad 3 donde había un 2: cambia el contacto,
 *    y cambia que la franja horaria deje de aplicar.
 * 2. **Cambia la ruta a clínica.** Misma severidad pero distinto destinatario:
 *    un contenido clínico aparcado con el contacto comercial es exactamente el
 *    fallo que acabamos de arreglar en el cortafuegos, por otra puerta.
 *
 * Lo que NO vuelve a escalar: una urgencia dentro de una conversación ya pausada
 * por otra urgencia. Misma severidad y mismo destinatario, y ya hay una persona
 * mirándolo — el segundo aviso no le dice nada que no vaya a ver. **Al paciente
 * sí se le responde igualmente**, así que el mensaje queda en el hilo que esa
 * persona está leyendo.
 */
function debeEscalarEnPausa(
  motivoDePausa: string | null,
  categoriaNueva: Categoria,
): boolean {
  return (
    SEVERIDAD[categoriaNueva] > severidadDePausa(motivoDePausa) ||
    (esRutaClinica(categoriaNueva) && !esRutaClinica(motivoDePausa))
  );
}

/**
 * Qué derecho se está ejerciendo, según el patrón que disparó.
 *
 * `sin_determinar` no es un fallo: si el paciente dice «quiero ejercer mis
 * derechos» sin decir cuál, **eso es lo que hay que registrar**. Adivinarlo
 * sería decidir por el responsable del tratamiento, y nosotros somos
 * encargados: no decidimos, asistimos.
 */
const DERECHO_POR_PATRON: Readonly<Record<string, q.RightsRequestRow['kind']>> = {
  derecho_supresion: 'supresion',
  derecho_acceso: 'acceso',
  derecho_rectificacion: 'rectificacion',
  derecho_portabilidad: 'portabilidad',
  derecho_limitacion: 'limitacion',
};

function derechoEjercido(patrones: readonly string[]): q.RightsRequestRow['kind'] {
  for (const patron of patrones) {
    const derecho = DERECHO_POR_PATRON[patron];
    if (derecho !== undefined) return derecho;
  }
  return 'sin_determinar';
}

async function aplicarCorte(
  deps: Dependencias,
  tx: Tx,
  ctx: {
    entrada: EntradaDeMensaje;
    paciente: q.PatientRow;
    conversacion: q.ConversationRow;
    corte: Extract<ReturnType<typeof evaluar>, { corta: true }>;
    ahora: Date;
    cliente: ContextoDeCliente;
  },
): Promise<SalidaCruda> {
  const { entrada, paciente, conversacion, corte, ahora, cliente } = ctx;
  const { clientId } = entrada;
  const efectos: EfectoDeSalida[] = [];

  const yaEnPausa = conversacion.status === 'pausada';
  const escalar = !yaEnPausa || debeEscalarEnPausa(conversacion.pauseReason, corte.categoria);

  if (escalar) {
    const escaladoId = await q.crearEscalado(clientId, tx, {
      conversationId: conversacion.id,
      patientId: paciente.id,
      reason: MOTIVO_ESCALADO[corte.categoria],
      severity: SEVERIDAD[corte.categoria],
      notifiedAt: ahora,
      createdAt: ahora,
    });
    efectos.push({
      tipo: 'escalar_a_humano',
      escaladoId,
      severidad: SEVERIDAD[corte.categoria],
      motivo: MOTIVO_ESCALADO[corte.categoria],
    });
  } else {
    await q.anotarAuditoria(clientId, tx, {
      entity: 'conversations',
      entityId: conversacion.id,
      // Queda el rastro de que se decidió no duplicar. Sin esto, un escalado
      // que no aparece es indistinguible de un escalado que se perdió.
      action: `escalado_no_duplicado:${corte.categoria}`,
      actor: 'sistema',
    });
  }

  let estado: 'abierta' | 'pausada' | 'cerrada' = conversacion.status;

  /**
   * Solicitud de derechos: se registra con sus cuatro fechas.
   *
   * Sin este registro no hay forma de acreditar que se cumplió el plazo, y el
   * plazo es una obligación del responsable que nosotros tenemos que poder
   * demostrar. El traslado se marca aquí porque sale en los efectos de esta
   * misma respuesta: devolverlo es trasladarlo.
   */
  if (corte.categorias.includes('derechos_rgpd')) {
    const solicitud = await q.crearSolicitudDeDerechos(clientId, tx, {
      patientId: paciente.id,
      conversationId: conversacion.id,
      kind: derechoEjercido(corte.patrones),
      ahora,
      note: null,
    });
    await q.anotarAuditoria(clientId, tx, {
      entity: 'rights_requests',
      entityId: solicitud.id,
      action: `derecho_recibido:${solicitud.kind}`,
      actor: 'paciente',
    });
  }

  if (corte.categorias.includes('baja')) {
    await q.registrarBaja(clientId, tx, {
      patientId: paciente.id,
      phoneHash: hashTelefono(entrada.telefono, deps.pimienta),
    });
    efectos.push({ tipo: 'registrar_baja' });
  }

  if (corte.categoria === 'baja') {
    estado = 'cerrada';
    await q.actualizarConversacion(clientId, tx, conversacion.id, {
      status: 'cerrada',
      closedAt: ahora,
    });
  } else if (PAUSAN.includes(corte.categoria)) {
    estado = 'pausada';
    await q.actualizarConversacion(clientId, tx, conversacion.id, {
      status: 'pausada',
      pausedAt: ahora,
      // Se reescribe el motivo: si estaba pausada por una queja y entra una
      // urgencia, lo que la tiene pausada ahora es la urgencia, y de ahí sale
      // la severidad con la que se compara el siguiente mensaje.
      pauseReason: corte.categoria,
      lastAutoReplyAt: ahora,
    });
  } else if (yaEnPausa) {
    // Un corte que no pausa —clínico, sobre todo— dentro de una conversación ya
    // pausada. Se le ha respondido, así que la ventana de los mensajes de
    // relleno se reinicia: si no, recibiría el texto de derivación y detrás el
    // «tu mensaje está en manos del equipo», pegados y diciendo lo mismo.
    await q.actualizarConversacion(clientId, tx, conversacion.id, {
      lastAutoReplyAt: ahora,
    });
  }
  // `contenido_clinico` no pausa: se responde el texto fijo, se escala, y la
  // conversación sigue con normalidad para todo lo que no sea clínico. Si
  // vuelve a tocar terreno clínico, vuelve a cortar.

  const texto = cliente.textos.corte(corte.categoria);
  await q.guardarMensaje(clientId, tx, {
    conversationId: conversacion.id,
    direction: 'saliente',
    body: texto,
    isClinical: corte.esClinico,
    firewallRule: corte.patrones.join(','),
    firewallCategory: corte.categoria,
    createdAt: ahora,
  });
  await q.anotarAuditoria(clientId, tx, {
    entity: 'conversations',
    entityId: conversacion.id,
    action: `cortafuegos:${corte.categoria}`,
    fromState: conversacion.status,
    toState: estado,
    actor: 'sistema',
  });

  return {
    conversacionId: conversacion.id,
    estadoConversacion: estado,
    respuesta: texto,
    corte: { categoria: corte.categoria, patrones: [...corte.patrones] },
    efectos,
  };
}

async function atender(
  deps: Dependencias,
  tx: Tx,
  ctx: {
    entrada: EntradaDeMensaje;
    paciente: q.PatientRow;
    conversacion: q.ConversationRow;
    ahora: Date;
    cliente: ContextoDeCliente;
    /** Para que quien llama pueda registrar lo que el agente hizo en este turno. */
    alConstruirAgente: (agente: Agente) => void;
  },
): Promise<SalidaCruda> {
  const { entrada, paciente, conversacion, ahora, cliente } = ctx;
  const { clientId } = entrada;
  // Aquí sólo llega texto: lo que no lo es se contestó antes y no siguió.
  const textoDelPaciente = entrada.texto ?? '';
  const vistaDelPaciente = toPromptPatient(paciente);

  /**
   * Las citas que tiene, tal como se le enseñan al clasificador. Sin cerrojo: no
   * se retienen filas mientras se espera al modelo. La decisión se toma más
   * abajo sobre una lectura con cerrojo, y el número que devuelva el
   * clasificador se traduce por `id` contra ESTA lista, no por posición contra
   * aquélla: si entre medias caduca una, las posiciones se mueven y «la 2»
   * señalaría otra cita.
   */
  /**
   * El instante y las reglas con que se decide qué sigue vivo. Se fija una vez
   * por turno y va a TODAS las lecturas de huecos: lo que el cron no haya
   * materializado todavía no se da por vivo aquí.
   */
  const vigencia: q.Vigencia = { ahora, politica: cliente.politica };

  /** Sólo si se sigue hablando de él; ver `servicioVigente`. */
  const vigente = servicioVigente(conversacion, ahora, cliente.politica.propuestaMinutos);

  const mostradas = await q.citasVivas(clientId, tx, conversacion.id, {
    bloquear: false,
    ...vigencia,
  });

  /** Lo que tiene delante, para que el clasificador sepa a qué se refiere «la segunda». */
  const ofrecidos = await q.huecosPropuestos(clientId, tx, conversacion.id, vigencia);

  /**
   * **El historial, revisado antes de que el modelo lo lea.** Un mensaje que
   * afirmó una reserva que nunca existió se marca y entra en la ventana anotado
   * con la verdad: si no, cada turno hereda la mentira —el «Hola» que escaló
   * porque el modelo quería recordarle una cita del lunes que no existía—. La
   * primera vez que se descubre, se avisa a una persona diciéndole qué aclarar:
   * el agente no puede escribirle al paciente por su cuenta.
   */
  const historial = await desmentirReservasFalsas(clientId, tx, {
    conversationId: conversacion.id,
    ahora,
    zonaHoraria: cliente.config.zonaHoraria,
  });
  const efectosDelHistorial: EfectoDeSalida[] = [];
  if (historial.nuevos.length > 0) {
    efectosDelHistorial.push(
      ...(await escalarHistorialFalso(clientId, tx, {
        conversationId: conversacion.id,
        patientId: paciente.id,
        detalle: historial.nuevos.map((d) => d.nota).join(' '),
        ahora,
        deduplicar: false,
      })),
    );
  }

  // El agente se construye para ESTA conversación: catálogo de la clínica,
  // ventana de 8 turnos más resumen, y lo que ya se ha gastado en llamadas.
  const agente = deps.agente.para({
    config: cliente.config,
    turnos: await q.turnosRecientes(clientId, tx, conversacion.id, TURNOS_EN_VENTANA * 2, ahora),
    // El resumen caduca con la conversación, igual que los turnos: lo redacta la
    // purga diaria, pero no hay que esperarla para dejar de mandarlo.
    resumen: conversacion.purgeAt > ahora ? conversacion.summary : null,
    // En las últimas `ventanaHoras`, no en toda la vida de la conversación.
    llamadasPrevias: await q.llamadasAlModelo(clientId, tx, {
      conversationId: conversacion.id,
      desde: new Date(ahora.getTime() - PRESUPUESTO.ventanaHoras * 3_600_000),
    }),
    // El servicio ya determinado en esta conversación. Sin esto, «sí por favor»
    // tras haberle ofrecido la limpieza facial no determina nada.
    servicioVigente: vigente,
    citasVivas: mostradas.map((c) => describirCita(c, cliente)),
    // Con el número de `rank`, que es el que resuelve `opcion` al elegir.
    huecosOfrecidos: ofrecidos.map(
      (h) => `${h.rank ?? '?'}) ${describirCita(h, cliente)}`,
    ),
  });
  ctx.alConstruirAgente(agente);
  const { clasificador, redactor } = agente;

  // Etapa 3: clasificación de intención. Salida cerrada.
  const clasificacion = await clasificador.clasificar({
    texto: textoDelPaciente,
    paciente: vistaDelPaciente,
  });

  const efectos: EfectoDeSalida[] = [...efectosDelHistorial];
  let holdId: string | undefined;
  let huecos: Array<{ inicio: Date; fin: Date }> = [];

  /**
   * El servicio NO es una propiedad del mensaje: es estado de la conversación.
   *
   * Orden: lo que fije n8n, lo que se extraiga de este turno —que incluye el
   * caso de aceptar el que acaba de ofrecer el agente—, y si no, el que ya
   * estaba vigente. Persiste hasta que se cambie explícitamente.
   */
  const servicioPedido = entrada.servicio ?? clasificacion.servicio ?? vigente;

  // Señal de escalado no clínica: queja, petición de hablar con una persona, o
  // el agente atascado. La detecta el modelo PEQUEÑO con salida cerrada, igual
  // que el cortafuegos pero para lo que no es clínico.
  if (clasificacion.escalar !== null) {
    const escaladoId = await q.crearEscalado(clientId, tx, {
      conversationId: conversacion.id,
      patientId: paciente.id,
      reason: clasificacion.escalar,
      severity: 2,
      notifiedAt: ahora,
      createdAt: ahora,
    });
    // Si se le dice que le escribe una persona, el agente tiene que callarse de
    // verdad: mensaje y estado del sistema tienen que coincidir (regla 4 bis).
    await q.actualizarConversacion(clientId, tx, conversacion.id, {
      status: 'pausada',
      pausedAt: ahora,
      pauseReason: clasificacion.escalar,
      lastAutoReplyAt: ahora,
    });
    const texto = cliente.textos.enPausa();
    await q.guardarMensaje(clientId, tx, {
      conversationId: conversacion.id,
      direction: 'saliente',
      body: texto,
      isClinical: false,
      intent: clasificacion.intencion,
      createdAt: ahora,
    });
    await q.anotarAuditoria(clientId, tx, {
      entity: 'conversations',
      entityId: conversacion.id,
      action: `senal_de_escalado:${clasificacion.escalar}`,
      actor: 'sistema',
    });

    return {
      conversacionId: conversacion.id,
      estadoConversacion: 'pausada',
      respuesta: texto,
      corte: null,
      efectos: [
        { tipo: 'escalar_a_humano', escaladoId, severidad: 2, motivo: clasificacion.escalar },
      ],
    };
  }

  /**
   * Cancelar y reagendar son las dos peticiones frecuentes que no tenían flujo.
   * La intención se extraía bien y no la atendía nadie, así que caían al modelo
   * grande, la validación bloqueaba por franja no propuesta y acababa en un
   * escalado. Escalar «¿podría ser a las 10:45?» es exactamente la fatiga de
   * alertas que hace que recepción deje de mirar los avisos.
   */
  /**
   * **Con una supresión, limitación u oposición en curso no se agenda nada
   * nuevo.**
   *
   * Seguir dándole hora mientras pide que dejemos de tratar sus datos es
   * contradecirse: el tratamiento queda limitado hasta que el responsable
   * resuelva (art. 18 RGPD es exactamente ese mecanismo). Lo que **no** se hace
   * es cancelarle lo que ya tenía: ejercer un derecho no deshace un acuerdo
   * anterior, y una cita ya confirmada sigue en pie.
   *
   * Acceso, rectificación y portabilidad no limitan nada: pedir una copia de tus
   * datos no suspende tu relación con la clínica.
   */
  const AGENDAN: readonly string[] = ['agendar', 'reagendar', 'elegir_hueco'];
  if (AGENDAN.includes(clasificacion.intencion)) {
    const limitado = await q.tieneDerechoQueLimita(clientId, tx, paciente.id);
    if (limitado) {
      const texto = cliente.textos.derechosEnCurso();
      await q.guardarMensaje(clientId, tx, {
        conversationId: conversacion.id,
        direction: 'saliente',
        body: texto,
        isClinical: false,
        intent: clasificacion.intencion,
        createdAt: ahora,
      });
      await q.actualizarConversacion(clientId, tx, conversacion.id, { lastMessageAt: ahora });
      await q.anotarAuditoria(clientId, tx, {
        entity: 'conversations',
        entityId: conversacion.id,
        action: 'agendado_bloqueado_por_derecho_en_curso',
        actor: 'sistema',
      });

      return {
        conversacionId: conversacion.id,
        estadoConversacion: 'abierta',
        respuesta: texto,
        corte: null,
        efectos: [],
      };
    }
  }

  /**
   * Lo que el paciente YA tiene, y lo que tiene delante sin coger. Se leen antes
   * de decidir nada porque de los dos depende si hay algo que proponer.
   *
   * **Lo que ya tiene pueden ser varias citas**, de tratamientos distintos. Aquí
   * había una sola —`huecoActivo`, «como mucho hay uno»— y elegir cualquier hueco
   * soltaba «la» cita del paciente: pedir láser le quitó la limpieza a una
   * paciente. Con cerrojo, porque de aquí puede salir soltar una de ellas.
   */
  const vivas = await q.citasVivas(clientId, tx, conversacion.id, {
    bloquear: true,
    ...vigencia,
  });
  const propuestasVivas = await q.huecosPropuestos(clientId, tx, conversacion.id, vigencia);

  /**
   * A cuál de sus citas se refiere, si pide cambiar o cancelar. El número es
   * sobre la lista que se le enseñó; se pasa a `id` y de ahí a su posición en
   * la lectura con cerrojo. Si ya no está viva, la posición queda fuera de
   * rango y se le pregunta.
   */
  const idNombrado = clasificacion.cita === null ? null : mostradas[clasificacion.cita - 1]?.id;
  const aludida = citaAludida(
    vivas,
    clasificacion.cita === null ? null : vivas.findIndex((c) => c.id === idNombrado) + 1,
  );

  /**
   * Si le acabamos de preguntar «¿en lugar de la que tienes, o además?», su
   * respuesta. Sólo vale mientras el hueco que eligió siga propuesto: si se
   * le ha propuesto otra cosa desde entonces, la pregunta ya no está en pie.
   */
  const pendiente =
    conversacion.pendingHoldId === null
      ? undefined
      : propuestasVivas.find((h) => h.id === conversacion.pendingHoldId);
  const sustitucion: Sustitucion | null =
    pendiente === undefined ? null : clasificacion.sustitucion;

  /**
   * **Reagendar es mover UNA cita concreta.** Si tiene una, es ésa; si tiene
   * varias, la que diga. Si no dice cuál, se le pregunta y no se toca nada —
   * salvo que esté contestando a si sustituye, que ya dice a cuál.
   */
  const quiereCambiar = clasificacion.intencion === 'reagendar';
  const cambioPedido = quiereCambiar && aludida.tipo === 'identificada' ? aludida.cita : null;
  const preguntarCualCambiar =
    quiereCambiar && aludida.tipo === 'sin_identificar' && sustitucion === null;

  /**
   * El servicio de un reagendado es el de la cita que se mueve, diga lo que diga
   * la conversación: cambiar de tratamiento es cancelar y pedir otra cita, y
   * proponer otro servicio para «cambiar la de limpieza» sería decidirlo por él.
   */
  const servicio = cambioPedido?.serviceCode ?? servicioPedido;
  const nombreDelServicio =
    cliente.config.servicios.find((s) => s.codigo === servicio)?.nombre ?? null;

  const estado: EstadoParaRedactar = {
    faltaServicio: false,
    servicio: nombreDelServicio,
    preferencia: describirPreferencia(clasificacion.preferencia),
    preferenciaNoSatisfecha: false,
    servicioCambiado: false,
    reagendando: cambioPedido === null ? null : describirCita(cambioPedido, cliente),
    cancelada: false,
    faltaOpcion: false,
    alternativasAlejadas: false,
    consultada: false,
    citasVigentes: [],
    preguntarCual: null,
    preguntarSiSustituye: null,
    desmentidos: historial.desmentidos.map((d) => d.nota),
  };
  let estadoFinal = estado;

  /**
   * **Una consulta no es una elección, y nombrar una opción sí lo es.** Las dos
   * cosas se deciden aquí sin fiarse de la etiqueta del clasificador, porque lo
   * que sale mal es irreversible: una cita retenida que no pidió, o una que
   * pidió y no se retuvo mientras el modelo le decía «te la dejo apuntada».
   *
   * - Si pregunta por la disponibilidad («¿tenéis las 17:00?»), no se elige
   *   nada aunque la etiqueta diga `elegir_hueco`: se consulta y se propone.
   * - Si nombra sin preguntar una de las opciones vivas —por número o por la
   *   hora— se elige aunque la etiqueta diga `agendar` u `otro`. Medido contra
   *   el modelo real, «A las 10:20» tras una propuesta salía `agendar` 7 de cada
   *   10 veces antes de definir las intenciones.
   *
   * La hora y el número sí salen del clasificador: extraer «10:20» es mucho más
   * fiable que decidir qué quiere hacer el paciente con ella.
   */
  const consulta = esConsultaDeDisponibilidad(textoDelPaciente);
  const eligeSinEtiqueta =
    !consulta &&
    (clasificacion.intencion === 'agendar' || clasificacion.intencion === 'otro') &&
    resolverEleccion(propuestasVivas, clasificacion, cliente.config.zonaHoraria, textoDelPaciente) !== undefined;

  // Si está eligiendo una de las que tiene delante, no hay nada que proponer:
  // reproponer le caducaría justo la que está eligiendo.
  const motivo = eligeSinEtiqueta ? null : motivoParaProponer({
    intencion: clasificacion.intencion,
    servicio,
    preferencia: clasificacion.preferencia,
    propuestasVivas,
    // Sólo cuenta una cita DEL SERVICIO que pide. Con una limpieza viva,
    // «quiero cita de axilas» es una cita nueva y hay que proponerle.
    tieneHoraCogida: tieneHoraDe(vivas, servicio),
    zonaHoraria: cliente.config.zonaHoraria,
  });
  /** Se ha pedido una hora concreta y existe: hay que retenerla, no sólo ofrecerla. */
  let elegirTrasProponer = false;
  /**
   * `true` sólo si en este turno se ha mirado la agenda de verdad. Es lo que la
   * validación de salida exige para dejar pasar un «no hay nada por la tarde».
   */
  let consultoAgenda = false;

  /**
   * **El horario de apertura se compone desde el YAML, sin modelo.**
   *
   * Pasaba por el modelo, y la regla de horas tomaba «abrimos de lunes a
   * miércoles de 10:00 a 20:30» por huecos inventados: medido sobre conversación
   * corriente, preguntar el horario acababa escalado todas las veces, o el
   * modelo se quedaba sin poder contestarlo. Componerlo no necesita validación
   * porque no lo escribe nadie que pueda inventar.
   *
   * Sólo si no hay motivo para proponer: «¿por la tarde tienes algo?» a veces
   * sale etiquetado `horario`, y ésa es una pregunta de disponibilidad que se
   * contesta consultando la agenda, no con las horas de apertura.
   */
  if (clasificacion.intencion === 'horario' && motivo === null && !preguntarCualCambiar) {
    const texto = cliente.textos.horario();
    await q.guardarMensaje(clientId, tx, {
      conversationId: conversacion.id,
      direction: 'saliente',
      body: texto,
      isClinical: false,
      intent: clasificacion.intencion,
      createdAt: ahora,
    });
    await q.actualizarConversacion(clientId, tx, conversacion.id, { lastMessageAt: ahora });
    return {
      conversacionId: conversacion.id,
      estadoConversacion: 'abierta',
      respuesta: texto,
      corte: null,
      efectos,
    };
  }

  /**
   * **Los datos prácticos de la clínica, también sin modelo.** Dirección,
   * aparcamiento, pago, cancelación, primera visita y cómo prepararse salen del
   * YAML tal cual los escribió la clínica, o se remite a recepción si faltan. Sin
   * esto el modelo inventaba —«aparcamiento propio no tenemos», «la zona tiene
   * que venir rasurada»— y nada de eso lo puede comprobar ninguna regla.
   *
   * Nunca por encima de una acción: «cancela mi cita» es cancelar, aunque hable
   * de cancelación. Ni si está eligiendo o hay motivo para proponer.
   */
  const ACCIONES: readonly string[] = ['agendar', 'elegir_hueco', 'reagendar', 'cancelar'];
  if (
    clasificacion.tema !== null &&
    !ACCIONES.includes(clasificacion.intencion) &&
    motivo === null &&
    !eligeSinEtiqueta &&
    sustitucion === null &&
    !preguntarCualCambiar
  ) {
    // La preparación es la de SU tratamiento, el de la conversación. Si no se
    // sabe cuál, se pregunta: la de otro sería falsa, y roza lo clínico.
    const texto = cliente.textos.informacion(clasificacion.tema, servicio);
    await q.guardarMensaje(clientId, tx, {
      conversationId: conversacion.id,
      direction: 'saliente',
      body: texto,
      isClinical: false,
      intent: clasificacion.intencion,
      createdAt: ahora,
    });
    await q.actualizarConversacion(clientId, tx, conversacion.id, { lastMessageAt: ahora });
    return {
      conversacionId: conversacion.id,
      estadoConversacion: 'abierta',
      respuesta: texto,
      corte: null,
      efectos,
    };
  }

  if (clasificacion.intencion === 'cancelar') {
    if (aludida.tipo === 'ninguna_viva') {
      // No tiene ninguna cita viva. Se le dice, y no se escala por esto.
      estadoFinal = { ...estado, cancelada: false };
    } else if (aludida.tipo === 'sin_identificar') {
      // Tiene varias y no ha dicho cuál. Cancelar «la primera» sería elegir por
      // él cuál pierde; se le pregunta y no se toca ninguna.
      estadoFinal = { ...estado, preguntarCual: 'cancelar' };
    } else {
      const cita = aludida.cita;
      const resultado = transicionar({
        hueco: {
          state: cita.state,
          stateChangedAt: cita.stateChangedAt,
          slotStart: cita.slotStart,
          reminderSentAt: cita.reminderSentAt,
          escalatedAt: cita.escalatedAt,
          receptionNotifiedAt: cita.receptionNotifiedAt,
        },
        evento: { tipo: 'cita_cancelada' },
        ahora,
        politica: cliente.politica,
      });
      if (!resultado.ok) throw new TransicionRechazadaError(resultado.error.message);

      // Cancelar del todo: no hay nada que meter en su lugar.
      efectos.push(
        ...(await soltarCita(clientId, tx, cita, ahora, 'cita_cancelada', null)),
      );

      // El relleno de cancelaciones es un evento de negocio, no limpieza: un
      // hueco soltado con poco margen es material para la cola de espera.
      for (const efecto of resultado.transicion.efectos) {
        if (efecto.tipo === 'encolar_relleno_de_cancelacion') {
          efectos.push({
            tipo: 'encolar_relleno_de_cancelacion',
            horasDeAntelacion: efecto.horasDeAntelacion,
          });
        }
      }

      estadoFinal = { ...estado, cancelada: true };
    }
  }

  if (preguntarCualCambiar) {
    // Quiere cambiar una cita y tiene varias. Ni se propone ni se suelta nada:
    // los huecos dependen del tratamiento, y el tratamiento de cuál sea.
    estadoFinal = { ...estado, preguntarCual: 'cambiar' };
  } else if (
    (clasificacion.intencion === 'agendar' || clasificacion.intencion === 'reagendar') &&
    servicio === null
  ) {
    // **Nada se propone sobre una suposición.** No se crean huecos: se
    // pregunta. Ésta es la rama que evita que el paciente lea «¿qué zona
    // quieres?» mientras la base de datos ya tiene tres huecos de otra cosa.
    estadoFinal = { ...estado, faltaServicio: true };
  } else if (motivo !== null && servicio !== null) {
    // El segundo `!==` es para el compilador: sin servicio no hay motivo.
    {
      /**
       * **La agenda externa se lee ANTES de caducar nada.** Si no responde, el
       * paciente conserva las opciones que tenía —proponer de nuevo las habría
       * matado sin dar otras: el mensaje y el estado dejarían de coincidir— y se
       * le contesta con un texto fijo, no con el 503 de antes, que revertía la
       * transacción y perdía el mensaje entero: ni respuesta, ni escalado, ni
       * rastro. Es lo que pasó el 16-oct cuando caducó el token de Google.
       */
      const hastaExterna = new Date(ahora.getTime() + DIAS_DE_BUSQUEDA * 86_400_000);
      let ocupacionExterna: Awaited<ReturnType<typeof deps.agenda.ocupacion>>;
      try {
        ocupacionExterna = await deps.agenda.ocupacion({
          clientId,
          calendarioId: cliente.config.agenda.calendarioId,
          desde: ahora,
          hasta: hastaExterna,
        });
      } catch (error: unknown) {
        if (!(error instanceof AgendaNoDisponibleError)) throw error;
        return responderAgendaCaida(clientId, tx, {
          conversationId: conversacion.id,
          patientId: paciente.id,
          intencion: clasificacion.intencion,
          detalle: error.message,
          cliente,
          efectosPrevios: efectos,
          ahora,
        });
      }

      /**
       * Una propuesta nueva sustituye a la anterior. **Todos** los huecos
       * propuestos vivos mueren aquí, sean del servicio que sean.
       *
       * Si sólo se caducaran los de otro servicio, un paciente que pide «mejor
       * por la mañana» acabaría con seis huecos propuestos mientras el mensaje
       * le enseña tres: la base diría una cosa y él habría leído otra
       * (regla 4 bis), y los tres viejos serían basura que nadie limpia.
       */
      const previos = propuestasVivas;
      const deOtroServicio = previos.filter((h) => h.serviceCode !== servicio);
      if (previos.length > 0) {
        await q.caducarHuecos(
          clientId,
          tx,
          previos.map((h) => h.id),
          ahora,
        );
      }
      // Si se le había preguntado si un hueco sustituía a otra cita, ese hueco
      // acaba de caducar con los demás: la pregunta ya no está en pie.
      if (conversacion.pendingHoldId !== null) {
        await q.actualizarConversacion(clientId, tx, conversacion.id, { pendingHoldId: null });
      }
      if (deOtroServicio.length > 0) {
        await q.anotarAuditoria(clientId, tx, {
          entity: 'conversations',
          entityId: conversacion.id,
          action: `cambio_de_servicio:${servicio}`,
          actor: 'paciente',
        });
      }

      // La agenda devuelve ocupación en bruto; qué es proponible lo decide el
      // núcleo: horario, días de cierre, tramos partidos, antelación mínima y
      // que el servicio quepa entero antes del cierre.
      const definicion = cliente.config.servicios.find((s) => s.codigo === servicio);
      const hasta = new Date(ahora.getTime() + DIAS_DE_BUSQUEDA * 86_400_000);
      // La ocupación son DOS cosas: la de la agenda del cliente y la propia.
      // La agenda externa no sabe nada de un hueco que el núcleo acaba de
      // retener o confirmar —la clínica aún no lo ha metido en su programa, y el
      // núcleo no escribe ahí (regla 3)— así que sin la segunda mitad el sistema
      // vuelve a proponer un hueco que él mismo tiene dado.
      /**
       * **La propia se lee la ÚLTIMA, y el orden importa de verdad.**
       *
       * La ventana de carrera va desde la última lectura de ocupación hasta el
       * INSERT. Si se leyera la propia primero, esa ventana incluiría la llamada
       * HTTP a n8n entera —decenas o cientos de milisegundos— en vez de unos
       * microsegundos de cálculo puro. Lo que se cuela por esa ventana es una
       * doble reserva, así que se deja lo más estrecha posible y el camino de
       * recuperación se prueba con una costura que vive sólo en el test.
       */
      const ocupacion = [
        ...ocupacionExterna,
        ...(await q.ocupacionPropia(clientId, tx, { desde: ahora, hasta })),
      ];
      // Se ha mirado la agenda de verdad: a partir de aquí el mensaje sí puede
      // decir lo que hay y lo que no hay.
      consultoAgenda = true;
      const disponibles =
        definicion === undefined
          ? []
          : huecosProponibles({
              config: cliente.config,
              servicio: definicion,
              ahora,
              ocupacion,
            });

      const filtrados = elegirPropuestas(
        disponibles,
        clasificacion.preferencia,
        cliente.config.zonaHoraria,
        { cuantos: 3, reparto: cliente.config.agenda.repartoDeHuecos },
      );
      huecos = filtrados.huecos.map((h) => ({ inicio: h.inicio, fin: h.fin }));

      /**
       * Entre leer la ocupación y escribir las propuestas cabe que otra
       * conversación retenga uno de estos huecos. La base lo rechaza —para eso
       * está— pero eso no puede acabar en un 500 con el paciente esperando: la
       * regla 4 dice que ninguna ruta termina en silencio.
       *
       * Se reintenta una vez releyendo la ocupación propia, que es lo que ha
       * cambiado. Si vuelve a chocar, se sigue sin huecos y el paciente recibe
       * el mensaje de que no hay disponibilidad, que es cierto.
       */
      if (huecos.length > 0) {
        const expiresAt = new Date(ahora.getTime() + cliente.politica.propuestaMinutos * 60_000);
        try {
          await tx.transaction(async (sp) => {
            await q.proponerHuecos(clientId, sp, {
              patientId: paciente.id,
              conversationId: conversacion.id,
              serviceCode: servicio,
              huecos,
              expiresAt,
              ahora,
              replacesHoldId: cambioPedido?.id ?? null,
            });
          });
        } catch (error: unknown) {
          if (!esColisionDeHueco(error)) throw error;

          const tomados = await q.ocupacionPropia(clientId, tx, { desde: ahora, hasta });
          huecos = huecos.filter(
            (h) => !tomados.some((t) => h.inicio < t.fin && t.inicio < h.fin),
          );

          if (huecos.length > 0) {
            try {
              await tx.transaction(async (sp) => {
                await q.proponerHuecos(clientId, sp, {
                  patientId: paciente.id,
                  conversationId: conversacion.id,
                  serviceCode: servicio,
                  huecos,
                  expiresAt,
                  ahora,
                  replacesHoldId: cambioPedido?.id ?? null,
                });
              });
            } catch (segundo: unknown) {
              if (!esColisionDeHueco(segundo)) throw segundo;
              huecos = [];
            }
          }
        }
      }

      if (conversacion.serviceCode !== servicio) {
        await q.actualizarConversacion(clientId, tx, conversacion.id, { serviceCode: servicio });
      }

      estadoFinal = {
        ...estado,
        preferenciaNoSatisfecha: filtrados.preferenciaNoSatisfecha,
        alternativasAlejadas: filtrados.alternativasAlejadas,
        servicioCambiado: deOtroServicio.length > 0,
        reagendando: estado.reagendando,
        consultada: true,
      };

      /**
       * **Nombrar una hora concreta al reagendar es elegir, no explorar.**
       *
       * «No puedo a las 10, ¿puede ser a las 10:20?» es una petición, no una
       * encuesta. Si sólo se propusiera, el estado diría `propuesta` mientras el
       * mensaje da a entender que queda apuntado — la regla 4 bis otra vez— y el
       * hueco anterior seguiría vivo en manos de recepción.
       *
       * Sólo cuando esa hora existe de verdad: si no existe, `preferenciaNo-
       * Satisfecha` es cierto, se le ofrecen las cercanas y no se retiene nada,
       * porque retener una hora que no pidió sería peor que no retener.
       *
       * En un agendado normal no se retiene: «¿tenéis hueco a las 10?» es a
       * menudo una pregunta, y bloquear un hueco por preguntar sale caro. Ahí lo
       * que evita el desajuste es que el prompt no pueda dar a entender reserva.
       */
      // La decisión de retener no se toma aquí: se toma abajo, sobre lo que haya
      // en la mesa venga de este turno o del anterior.
      void filtrados;
    }
  } else if (
    propuestasVivas.length > 0 &&
    !tieneHoraDe(vivas, propuestasVivas[0]?.serviceCode ?? null)
  ) {
    /**
     * No había motivo para reproponer, pero sus opciones siguen ahí. Se le
     * enseñan las MISMAS, sin tocar la base: el modelo no tiene que reconstruir
     * de memoria lo que ofreció hace tres turnos, y la validación las acepta
     * porque son las que están escritas.
     *
     * No se enseñan cuando ya tiene hueco cogido DE ESE TRATAMIENTO: las dos
     * que dejó sin elegir siguen vivas como alternativa por si hay colisión,
     * pero volver a ofrecérselas a quien acaba de coger hora es ofrecerle
     * cambiarla. Una cita de otro tratamiento no cuenta: tener limpieza el
     * miércoles no hace que las opciones de láser dejen de ser suyas.
     */
    huecos = propuestasVivas.map((h) => ({ inicio: h.slotStart, fin: h.slotEnd }));
  }

  /**
   * **Nombrar una hora concreta al reagendar es elegir, no explorar** — y da
   * igual si esa hora sale de una propuesta de este turno o de una que el
   * paciente ya tenía delante.
   *
   * Antes esto se decidía dentro de la rama que proponía, así que en cuanto
   * dejó de reproponerse sin motivo, pedir una hora que YA estaba propuesta no
   * retenía nada: el paciente se quedaba con la cita vieja viva, la nueva sin
   * coger, y recepción con un aviso que ya no valía. Cinco tests de `dos-citas`
   * lo cazaron a la vez.
   *
   * Se resuelve con el MISMO resolutor que usa la elección explícita, no con una
   * comprobación paralela que pueda decir otra cosa.
   */
  /**
   * Ha dicho QUÉ cita quiere cambiar: todo lo que tenga propuesto de ese
   * tratamiento —de este turno o de antes— pasa a ser candidato a sustituirla.
   * Elija el que elija, se sabe a cuál sustituye sin volver a preguntárselo.
   */
  if (cambioPedido !== null) {
    await q.vincularPropuestas(clientId, tx, {
      conversationId: conversacion.id,
      serviceCode: cambioPedido.serviceCode,
      replacesHoldId: cambioPedido.id,
    });
  }

  if (
    quiereCambiar &&
    !preguntarCualCambiar &&
    !consulta &&
    clasificacion.preferencia?.horaExacta != null
  ) {
    const enLaMesa = await q.huecosPropuestos(clientId, tx, conversacion.id, vigencia);
    elegirTrasProponer =
      resolverEleccion(enLaMesa, clasificacion, cliente.config.zonaHoraria, textoDelPaciente) !== undefined;
  }

  /**
   * Contesta a «¿en lugar de la que tienes, o además?». Esa respuesta ES la
   * elección: el hueco ya lo eligió en el turno anterior y está guardado.
   */
  const contestaSustitucion = pendiente !== undefined && sustitucion !== null;

  const eligeConEtiqueta = clasificacion.intencion === 'elegir_hueco' && !consulta;

  if (eligeConEtiqueta || eligeSinEtiqueta || elegirTrasProponer || contestaSustitucion) {
    /**
     * Qué hueco ha elegido, **sin adivinar**.
     *
     * Antes era `clasificacion.opcion ?? 1`, y encima `retenerOpcion` caía al
     * primero si el rango no existía. Un paciente que dice «a las 10:20» con la
     * intención bien clasificada pero sin número acababa con las 10:00
     * retenidas y leyendo «te he guardado ese hueco»: el estado y el mensaje
     * decían cosas distintas, igual que en el reagendado, sólo que aquí se le
     * daba una cita a otra hora.
     *
     * Se resuelve por número, si no por la hora que nombró, y si no lo
     * identifica ninguna de las dos se PREGUNTA. Es la misma regla de siempre:
     * nada se decide sobre una suposición.
     */
    /**
     * Se relee: si en este mismo turno se ha repropuesto, las opciones de entre
     * las que elige son las nuevas, no las que había al entrar.
     */
    const entreLasQueElige = await q.huecosPropuestos(clientId, tx, conversacion.id, vigencia);
    const elegidoId =
      resolverEleccion(entreLasQueElige, clasificacion, cliente.config.zonaHoraria, textoDelPaciente) ??
      (contestaSustitucion && entreLasQueElige.some((h) => h.id === pendiente?.id)
        ? pendiente?.id
        : undefined);
    const fila = entreLasQueElige.find((h) => h.id === elegidoId);

    /**
     * Qué pasa con las citas que ya tiene. **Ésta es la decisión que estaba
     * mal**: antes, elegir con cualquier cita viva la soltaba. Ahora sólo se
     * suelta una cita si este hueco la sustituye de forma explícita — se propuso
     * para cambiarla, pidió cambiarla en este turno, o contestó «en lugar».
     */
    const destino =
      fila === undefined
        ? undefined
        : destinoDeLaEleccion({
            elegido: { serviceCode: fila.serviceCode, replacesHoldId: fila.replacesHoldId },
            vivas,
            cambioPedido,
            sustitucion,
          });

    if (fila === undefined || destino === undefined) {
      estadoFinal = { ...estadoFinal, faltaOpcion: entreLasQueElige.length > 0 };
    } else if (destino.tipo === 'preguntar_si_sustituye') {
      /**
       * Mismo tratamiento que una cita que ya tiene: puede ser un cambio o una
       * sesión más. **No se retiene ni se suelta nada** hasta que lo diga.
       * Retenerlo sin soltar le daría una cita de más si quería cambiarla; y
       * soltar la otra sería decidir el cambio por él.
       */
      await q.actualizarConversacion(clientId, tx, conversacion.id, { pendingHoldId: fila.id });
      estadoFinal = {
        ...estadoFinal,
        preguntarSiSustituye: {
          nueva: describirCita(fila, cliente),
          citas: destino.candidatas.map((c) => describirCita(c, cliente)),
        },
      };
    } else {
    const enFranja = dentroDeFranja(ahora, cliente);
    const automatica = cliente.config.agenda.confirmacion === 'automatica';
    const elegido = await retenerOpcion(tx, {
      clientId,
      conversationId: conversacion.id,
      preferidoId: fila.id,
      ahora,
      cliente,
      avisarARecepcion: enFranja,
      // El paso 6, en el mismo turno, sólo cuando vamos a escribir.
      //
      // **Si la agenda no responde aquí, se sigue**: esta relectura adelanta la
      // colisión al paciente, pero la que decide es la del ejecutor, justo antes
      // de escribir el evento. Si Google sigue caído entonces, degrada a
      // recepción y escala. Antes, un fallo aquí revertía el turno entero y el
      // paciente que acababa de elegir recibía «fuera de servicio».
      relee: automatica
        ? async (h) => {
            try {
              return await deps.agenda.sigueLibre({
                clientId,
                calendarioId: cliente.config.agenda.calendarioId,
                inicio: h.inicio,
                fin: h.fin,
              });
            } catch (error: unknown) {
              if (!(error instanceof AgendaNoDisponibleError)) throw error;
              await q.anotarAuditoria(clientId, tx, {
                entity: 'conversations',
                entityId: conversacion.id,
                action: 'relectura_en_turno:agenda_no_disponible',
                actor: 'sistema',
              });
              return true;
            }
          }
        : undefined,
    });
    holdId = elegido.holdId;

    /**
     * Reagendar: la cita anterior se suelta AQUÍ, cuando ya hay una nueva de
     * verdad, y no cuando el paciente dice que quiere cambiarla. Soltarla antes
     * lo dejaría sin nada si luego no hubiera hueco, y la ocupación propia hace
     * que los huecos propuestos nunca se solapen con la que todavía tiene.
     *
     * Y sólo la que este hueco sustituye: el vínculo se escribe en la fila del
     * hueco retenido —el de verdad, que tras una colisión puede no ser el que
     * eligió— para que recepción sepa después cuál es la buena.
     */
    if (destino.tipo === 'sustituye') {
      await q.actualizarHueco(clientId, tx, elegido.holdId, { replacesHoldId: destino.cita.id });
      efectos.push(
        ...(await soltarCita(clientId, tx, destino.cita, ahora, 'reagendada', elegido.holdId)),
      );
    }
    if (conversacion.pendingHoldId !== null) {
      await q.actualizarConversacion(clientId, tx, conversacion.id, { pendingHoldId: null });
    }

    /**
     * El hueco REALMENTE retenido, no el que pidió: si hubo colisión,
     * `retenerOpcion` habrá pasado a otro.
     */
    const retenido = entreLasQueElige.find((h) => h.id === elegido.holdId);

    if (!automatica && enFranja) {
      efectos.push({ tipo: 'avisar_a_recepcion', holdId: elegido.holdId });
    }
    if (elegido.huboColision) efectos.push({ tipo: 'proponer_alternativa' });

    /**
     * Modo `automatica`: **el paciente no recibe nada todavía**.
     *
     * No se le confirma hasta que el evento exista de verdad, y quien sabe eso es
     * n8n, que lo contará en `/evento-de-agenda`. Confirmarle antes y tener que
     * desdecirse después es el fallo de confianza que más caro sale.
     *
     * Que no haya silencio indefinido lo garantizan dos cosas, ninguna aquí: el
     * tiempo límite del nodo de n8n, que tiene que avisar de su propio fallo, y
     * el vencimiento de `retenida`, que degrada al camino de recepción si n8n no
     * vuelve nunca.
     */
    if (automatica) {
      const nombreServicio =
        cliente.config.servicios.find((s) => s.codigo === (retenido?.serviceCode ?? ''))?.nombre ??
        nombreDelServicio ??
        'Cita';
      /**
       * **La fila del paciente, no `vistaDelPaciente`.** El evento va a la agenda
       * de la clínica, que es la responsable del tratamiento y ya tiene su ficha;
       * la vista recortada existe para el modelo, que es un tercero. Dos
       * fronteras distintas, dos funciones distintas: ver `service/evento.ts`.
       */
      const evento = componerEvento({
        config: cliente.config,
        paciente,
        servicio: nombreServicio,
      });

      efectos.push({
        tipo: 'crear_evento_agenda',
        holdId: elegido.holdId,
        calendarioId: cliente.config.agenda.calendarioId,
        // Estable para el mismo hueco: si n8n reintenta, el proveedor reconoce
        // el mismo evento en vez de crear otro.
        idempotencyKey: `evento-${elegido.holdId}`,
        inicio: elegido.slotStart.toISOString(),
        fin: elegido.slotEnd.toISOString(),
        resumen: evento.resumen,
        descripcion: evento.descripcion,
      });

      await q.actualizarConversacion(clientId, tx, conversacion.id, { lastMessageAt: ahora });
      return {
        conversacionId: conversacion.id,
        estadoConversacion: 'abierta',
        respuesta: null,
        corte: null,
        efectos,
        holdId,
      };
    }

    // El hueco queda retenido AHORA aunque la clínica esté cerrada, y el
    // paciente recibe respuesta AHORA. Lo único que espera a mañana es el aviso
    // a recepción, que lo emitirá `/caducar-retenciones` al abrir la franja.
    /**
     * Reagendar y elegir son cosas distintas para quien las vive, así que no
     * comparten texto. Salían palabra por palabra iguales y quien acababa de
     * cambiar la hora leía «te he guardado ese hueco» sin saber cuál.
     *
     * Se busca el hueco REALMENTE retenido, no el que se pidió: si hubo
     * colisión, `retenerOpcion` habrá pasado a otro, y anunciar la hora que el
     * paciente pidió cuando se le ha dado otra es el desajuste de siempre.
     */
    const avisoDiferidoHasta = enFranja ? null : inicioDeFranja(ahora, cliente);
    const huecoRetenido = retenido;
    const texto =
      destino.tipo === 'sustituye' && huecoRetenido !== undefined
        ? cliente.textos.reagendado({
            nueva: huecoRetenido.slotStart,
            anterior: destino.cita.slotStart,
            servicio: huecoRetenido.serviceCode,
            avisoDiferidoHasta,
          })
        : cliente.textos.retenido({
            // El hueco REALMENTE retenido, no el que pidió: si hubo colisión,
            // `retenerOpcion` habrá pasado a otro, y anunciar la hora que pidió
            // cuando se le ha dado otra es el desajuste de siempre.
            hueco: huecoRetenido?.slotStart ?? elegido.slotStart,
            servicio: huecoRetenido?.serviceCode ?? fila.serviceCode,
            avisoDiferidoHasta,
          });
    await q.guardarMensaje(clientId, tx, {
      conversationId: conversacion.id,
      direction: 'saliente',
      body: texto,
      isClinical: false,
      intent: clasificacion.intencion,
      createdAt: ahora,
    });
    await q.actualizarConversacion(clientId, tx, conversacion.id, { lastMessageAt: ahora });

    return {
      conversacionId: conversacion.id,
      estadoConversacion: 'abierta',
      respuesta: texto,
      corte: null,
      efectos,
      holdId,
    };
    }
  }

  /**
   * Las citas que tiene AHORA, después de lo que haya pasado en este turno: si
   * acaba de cancelar una, decirle al modelo que la sigue teniendo es darle
   * pie a despedirse hasta el miércoles de una cita que ya no existe.
   */
  const vivasAhora = await q.citasVivas(clientId, tx, conversacion.id, {
    bloquear: false,
    ...vigencia,
  });
  estadoFinal = {
    ...estadoFinal,
    citasVigentes: vivasAhora.map((c) => ({
      descripcion: describirCita(c, cliente),
      confirmada: c.state === 'confirmada',
    })),
  };

  // Etapa 5: validación de salida. Se valida contra los huecos REALMENTE
  // propuestos en esta conversación, no contra los que el modelo crea recordar.
  const propuestosAhora = await q.huecosPropuestos(clientId, tx, conversacion.id, vigencia);
  const contextoDeValidacion: ContextoDeValidacion = {
    precios: preciosDelCatalogo(cliente.config),
    huecosPropuestos: propuestosAhora.map((h) => h.slotStart),
    // Su propia cita también se puede nombrar. Sin esto, el turno en que más
    // falta hace decir una hora —justo después de cogerla— era el único en que
    // estaba prohibida.
    //
    // Las que tenía al entrar también: «te he cancelado la del miércoles a las
    // 16:00» nombra una hora que ya no está viva, y es exactamente lo que hay
    // que decirle.
    citasVigentes: [...vivas, ...vivasAhora].map((h) => h.slotStart),
    consultaRealizada: consultoAgenda,
    // Las que ha escrito él en este mensaje: se le puede decir que no están.
    // Las reservas que se le afirmaron y nunca existieron: se pueden nombrar
    // para negarlas, que es como se deshace la mentira.
    reservasDesmentidas: historial.desmentidos.flatMap((d) => d.huecos),
    horasQueNombroElPaciente: extraerHoras(textoDelPaciente).map((h) => ({
      horas: h.horas,
      minutos: h.minutos,
    })),
    // Si en este turno se le proponen huecos DE CERO —no tenía opciones vivas
    // delante, o cambia de tratamiento— el mensaje dice de qué son. Es el caso
    // del servidor de pruebas. Al reproponer dentro del mismo intercambio
    // (otra franja, otro día) no se exige: el nombre ya iba antes, y medido en
    // el banco, exigirlo ahí regeneraba la mitad de los turnos de continuación.
    // Cada regeneración es latencia, y dos seguidas, un escalado.
    tratamientoDeLosHuecos:
      !consultoAgenda ||
      huecos.length === 0 ||
      (motivo !== 'sin_propuestas' && motivo !== 'cambio_de_servicio')
        ? null
        : (cliente.config.servicios.find((s) => s.codigo === propuestosAhora[0]?.serviceCode)
            ?.nombre ?? nombreDelServicio),
    // Despedirse dando por hecho que ocurre exige que TODAS estén confirmadas.
    // Con varias, «nos vemos» no dice cuál, y si una no lo está es la que falla.
    citaConfirmada: vivasAhora.length > 0 && vivasAhora.every((h) => h.state === 'confirmada'),
    zonaHoraria: cliente.config.zonaHoraria,
    ahora,
  };

  /**
   * Regla 4 en su forma más dura: si el proveedor del modelo no responde, tarda
   * de más o devuelve error, el paciente NO se queda en silencio. Se le manda un
   * texto fijo —que no depende del modelo— y responde una persona.
   */
  async function redactarOReserva(
    correccion?: { textoAnterior: string; explicacion: string },
  ): Promise<{ redaccion: Redaccion; caido: DomainError | null }> {
    try {
      const r = await redactor.redactar({
        intencion: clasificacion.intencion,
        texto: textoDelPaciente,
        paciente: vistaDelPaciente,
        huecos,
        estado: estadoFinal,
        ...(correccion === undefined ? {} : { correccion }),
      });
      return { redaccion: r, caido: null };
    } catch (error: unknown) {
      if (!isDomainError(error)) throw error;
      return {
        redaccion: {
          texto: error.patientMessage ?? cliente.textos.proveedorCaido(),
          modelo: `${error.code}:reserva`,
          tokensEntrada: 0,
          tokensSalida: 0,
        },
        caido: error,
      };
    }
  }

  const primera = await redactarOReserva();
  let redaccion = primera.redaccion;
  let caidaDelProveedor = primera.caido;
  let validacion = caidaDelProveedor === null
    ? validarSalida(redaccion.texto, contextoDeValidacion)
    : ({ valido: true } as const);
  let regeneraciones = 0;
  /**
   * Lo que escribió el modelo y no llegó a salir, con por qué. Sin esto, saber
   * qué había escrito en un saludo que acabó escalado obligaba a deducirlo del
   * motivo («lunes 10:20»). Se redacta con el mensaje: ver la migración 0011.
   */
  const borradores: Array<{ texto: string; motivos: MotivoDeBloqueo[] }> = [];

  // Fallo → regenerar UNA vez. La segunda no se reintenta: si el modelo vuelve
  // a inventarse un precio con la corrección delante, insistir sólo gasta
  // tiempo del paciente.
  if (!validacion.valido) {
    regeneraciones = 1;
    borradores.push({ texto: redaccion.texto, motivos: validacion.motivos });
    const anterior = redaccion.texto;
    const segunda = await redactarOReserva({
      textoAnterior: anterior,
      explicacion: explicar(validacion.motivos),
    });
    redaccion = segunda.redaccion;
    caidaDelProveedor = segunda.caido;
    validacion = caidaDelProveedor === null
      ? validarSalida(redaccion.texto, contextoDeValidacion)
      : ({ valido: true } as const);
    if (!validacion.valido) borradores.push({ texto: redaccion.texto, motivos: validacion.motivos });
  }

  let textoFinal = redaccion.texto;
  let escaladoId: string | undefined;

  if (caidaDelProveedor !== null) {
    // El texto ya es el de reserva; sólo falta que lo vea una persona.
    escaladoId = await q.crearEscalado(clientId, tx, {
      conversationId: conversacion.id,
      patientId: paciente.id,
      reason: 'validacion_fallida',
      severity: 2,
      notifiedAt: ahora,
      createdAt: ahora,
    });
    efectos.push({
      tipo: 'escalar_a_humano',
      escaladoId,
      severidad: 2,
      motivo: 'validacion_fallida',
    });
    await q.anotarAuditoria(clientId, tx, {
      entity: 'conversations',
      entityId: conversacion.id,
      action: `proveedor_caido:${caidaDelProveedor.code}`,
      actor: 'sistema',
    });
  } else if (!validacion.valido) {
    // Y si vuelve a fallar, escalar. Al paciente NUNCA le llega el texto que no
    // pasó la validación: se le manda uno fijo y responde una persona.
    /**
     * **Con su propio motivo si la causa es el historial.** Si lo bloqueado es
     * una hora o una reserva y hay en la ventana una reserva que se le afirmó y
     * nunca existió, «validación fallida» no le dice nada a recepción; «se le
     * dijo que tenía cita el lunes a las 10:20 y no existe» le dice qué aclarar.
     */
    const porElHistorial =
      historial.desmentidos.length > 0 &&
      validacion.motivos.some((m) =>
        ['franja_no_propuesta', 'dia_no_propuesto', 'reserva_afirmada'].includes(m.tipo),
      );
    if (porElHistorial) {
      efectos.push(
        ...(await escalarHistorialFalso(clientId, tx, {
          conversationId: conversacion.id,
          patientId: paciente.id,
          detalle: historial.desmentidos.map((d) => d.nota).join(' '),
          ahora,
          deduplicar: true,
        })),
      );
    } else {
      escaladoId = await q.crearEscalado(clientId, tx, {
        conversationId: conversacion.id,
        patientId: paciente.id,
        reason: 'validacion_fallida',
        severity: 2,
        notifiedAt: ahora,
        createdAt: ahora,
      });
      efectos.push({
        tipo: 'escalar_a_humano',
        escaladoId,
        severidad: 2,
        motivo: 'validacion_fallida',
      });
    }
    textoFinal = cliente.textos.escaladoPorValidacion();
    // Sólo aquí se sustituye el texto: en el caso del proveedor caído, el texto
    // de reserva ya está puesto y es el que debe salir.
    await q.anotarAuditoria(clientId, tx, {
      entity: 'conversations',
      entityId: conversacion.id,
      action: 'validacion_de_salida_fallida',
      actor: 'sistema',
    });
  }

  await q.guardarMensaje(clientId, tx, {
    conversationId: conversacion.id,
    direction: 'saliente',
    body: textoFinal,
    isClinical: false,
    intent: clasificacion.intencion,
    model: redaccion.modelo,
    promptTokens: clasificacion.tokensEntrada + redaccion.tokensEntrada,
    completionTokens: clasificacion.tokensSalida + redaccion.tokensSalida,
    // Queda registrado con qué versión de configuración se respondió: es lo que
    // permite reconstruir un precio si la clínica cambia el YAML luego.
    validationResult: {
      valido: validacion.valido,
      proveedorCaido: caidaDelProveedor?.code ?? null,
      regeneraciones,
      configVersion: cliente.configVersion,
      motivos: validacion.valido ? [] : validacion.motivos,
      borradores,
    },
    createdAt: ahora,
  });
  await q.actualizarConversacion(clientId, tx, conversacion.id, { lastMessageAt: ahora });

  return {
    conversacionId: conversacion.id,
    estadoConversacion: 'abierta',
    respuesta: textoFinal,
    corte: null,
    efectos,
    ...(holdId === undefined ? {} : { holdId }),
  };
}

/**
 * El paciente elige uno de los tres huecos propuestos.
 *
 * Si al retenerlo resulta que otra conversación se le adelantó, la que falla es
 * Postgres con `holds_slot_unico`, no un `if` nuestro: se marca colisionada y
 * se pasa a la siguiente opción. La comprobación previa no existe a propósito,
 * porque entre comprobar y escribir cabe una carrera.
 */
/**
 * Cuál de los huecos propuestos ha elegido, o `undefined` si no se sabe.
 *
 * `undefined` no es un fallo: es la respuesta correcta cuando el paciente dice
 * «vale» con tres opciones delante. Preguntar cuesta un turno; darle una cita a
 * una hora que no pidió cuesta que se presente cuando no toca.
 */
function resolverEleccion(
  propuestas: readonly q.HoldRow[],
  clasificacion: Extraccion,
  zonaHoraria: string,
  texto: string,
): string | undefined {
  if (propuestas.length === 0) return undefined;
  // Lo que el clasificador extraiga sólo vale si el mensaje lo sostiene: ver
  // `agent/eleccion.ts`. «Gracias» no señala ninguna opción, aunque el
  // clasificador diga `opcion: 1`.
  const ancla = anclaDeEleccion(texto);

  if (clasificacion.opcion !== null && ancla.senala) {
    // Un número que no corresponde a ningún hueco vivo no vale como elección.
    return propuestas.find((h) => h.rank === clasificacion.opcion)?.id;
  }

  const hora = clasificacion.preferencia?.horaExacta ?? null;
  if (hora !== null && ancla.nombraHora) {
    const dtf = new Intl.DateTimeFormat('es-ES', {
      timeZone: zonaHoraria,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    return propuestas.find((h) => dtf.format(h.slotStart) === hora)?.id;
  }

  /**
   * Con una sola opción viva no hay que preguntar cuál, **pero sí que la quiere**.
   * Antes valía cualquier mensaje etiquetado `agendar` u `otro`: con una sola
   * propuesta viva, «¿dónde estáis?» la retenía. Ahora hace falta que diga que
   * sí —«vale», «perfecto», «me va bien»— y que el clasificador lo lea como
   * elección. «Gracias» a secas no es un sí.
   */
  return propuestas.length === 1 && ancla.afirma && clasificacion.intencion === 'elegir_hueco'
    ? propuestas[0]?.id
    : undefined;
}

async function retenerOpcion(
  tx: Tx,
  args: {
    clientId: string;
    conversationId: string;
    /** El hueco que ha elegido, ya resuelto. Aquí no se adivina. */
    preferidoId: string;
    ahora: Date;
    cliente: ContextoDeCliente;
    /** `false` fuera de la franja: el hueco se retiene igual, el aviso espera. */
    avisarARecepcion: boolean;
    /**
     * El paso 6, adelantado. **Sólo en modo `automatica`.**
     *
     * Ahí escribimos en la agenda de la clínica, así que releer deja de ser algo
     * que ocurre horas después —cuando recepción pulsa— y pasa a ocurrir en el
     * mismo turno, segundos antes de la escritura. Es la reducción de riesgo que
     * justifica relajar la regla 3: la ventana entre releer y escribir baja de
     * «puede ser toda la noche» a un par de segundos.
     *
     * `undefined` en modo `recepcion`: allí el paso 6 sigue viviendo en
     * `/accion-recepcion`, que es donde toca.
     */
    relee?: ((hueco: { inicio: Date; fin: Date }) => Promise<boolean>) | undefined;
  },
): Promise<{ holdId: string; slotStart: Date; slotEnd: Date; huboColision: boolean }> {
  const propuestas = await q.huecosPropuestos(args.clientId, tx, args.conversationId, {
    ahora: args.ahora,
    politica: args.cliente.politica,
  });
  if (propuestas.length === 0) throw new HuecoInexistenteError('No hay huecos propuestos.');

  const preferido = propuestas.find((h) => h.id === args.preferidoId);
  if (preferido === undefined) throw new HuecoInexistenteError('Ese hueco ya no está propuesto.');

  // Si el elegido se ha ocupado, se prueba con los demás **del mismo
  // tratamiento**: eligió una limpieza, no «lo que haya».
  //
  // Hoy es inalcanzable, y conviene saber por qué: proponer un servicio caduca
  // TODAS las propuestas vivas, y unas propuestas de dos servicios disparan
  // `cambio_de_servicio` antes de elegir. Se intentó probar sembrando ese
  // estado a mano y el pipeline lo deshace antes de llegar aquí. Se queda como
  // defensa por si esa invariante cambia; las dos segundas opciones que SÍ son
  // alcanzables —recepción y modo automático— tienen su test.
  const orden = [
    preferido,
    ...propuestas.filter((h) => h.id !== preferido.id && h.serviceCode === preferido.serviceCode),
  ];
  let huboColision = false;

  for (const candidato of orden) {
    const resultado = transicionar({
      hueco: {
        state: 'propuesta',
        stateChangedAt: candidato.stateChangedAt,
        slotStart: candidato.slotStart,
        reminderSentAt: null,
        escalatedAt: null,
        receptionNotifiedAt: null,
      },
      evento: { tipo: 'paciente_elige' },
      ahora: args.ahora,
      politica: args.cliente.politica,
    });
    if (!resultado.ok) throw new TransicionRechazadaError(resultado.error.message);

    try {
      // Savepoint: si el índice único rechaza éste, la transacción principal
      // sigue viva y podemos probar con el siguiente.
      await tx.transaction(async (sp) => {
        await q.actualizarHueco(args.clientId, sp, candidato.id, {
          state: 'retenida',
          stateChangedAt: args.ahora,
          expiresAt: resultado.transicion.expiresAt,
        });
      });
    } catch (error: unknown) {
      if (!esColisionDeHueco(error)) throw error;
      huboColision = true;
      await q.actualizarHueco(args.clientId, tx, candidato.id, {
        state: 'colisionada',
        stateChangedAt: args.ahora,
        collisionDetectedAt: args.ahora,
      });
      continue;
    }

    /**
     * El hueco ya es nuestro. Antes de que nadie escriba nada en la agenda de la
     * clínica, se relee: si mientras tanto lo han ocupado por fuera, este
     * candidato no vale y se prueba con el siguiente.
     */
    if (args.relee !== undefined) {
      const libre = await args.relee({ inicio: candidato.slotStart, fin: candidato.slotEnd });
      if (!libre) {
        huboColision = true;
        await q.actualizarHueco(args.clientId, tx, candidato.id, {
          state: 'colisionada',
          stateChangedAt: args.ahora,
          collisionDetectedAt: args.ahora,
        });
        await q.anotarAuditoria(args.clientId, tx, {
          entity: 'holds',
          entityId: candidato.id,
          action: 'colision_al_releer',
          fromState: 'retenida',
          toState: 'colisionada',
          actor: 'sistema',
        });
        continue;
      }

      /**
       * En automática el hueco se queda AQUÍ, en `retenida`, esperando a que n8n
       * diga si creó el evento. No se pasa a `pendiente_recepcion`: no hay nada
       * que recepción tenga que hacer todavía.
       */
      await q.anotarAuditoria(args.clientId, tx, {
        entity: 'holds',
        entityId: candidato.id,
        action: 'paciente_elige',
        fromState: 'propuesta',
        toState: 'retenida',
        actor: 'paciente',
      });
      return {
        holdId: candidato.id,
        slotStart: candidato.slotStart,
        slotEnd: candidato.slotEnd,
        huboColision,
      };
    }

    // Se avisa a recepción y el hueco pasa a esperar su confirmación. El aviso
    // sale en los efectos de esta misma respuesta: devolverlo ES enviarlo.
    const avisado = transicionar({
      hueco: {
        state: 'retenida',
        stateChangedAt: args.ahora,
        slotStart: candidato.slotStart,
        reminderSentAt: null,
        escalatedAt: null,
        receptionNotifiedAt: null,
      },
      evento: { tipo: 'recepcion_avisada' },
      ahora: args.ahora,
      politica: args.cliente.politica,
    });
    if (!avisado.ok) throw new TransicionRechazadaError(avisado.error.message);

    await q.actualizarHueco(args.clientId, tx, candidato.id, {
      state: 'pendiente_recepcion',
      stateChangedAt: args.ahora,
      // Los plazos de recepción no arrancan hasta que se le avisa de verdad.
      expiresAt: args.avisarARecepcion ? avisado.transicion.expiresAt : null,
      receptionNotifiedAt: args.avisarARecepcion ? args.ahora : null,
    });
    await q.anotarAuditoria(args.clientId, tx, {
      entity: 'holds',
      entityId: candidato.id,
      action: 'paciente_elige',
      fromState: 'propuesta',
      toState: 'pendiente_recepcion',
      actor: 'paciente',
    });

    // La hora sale de aquí y no de una segunda búsqueda del que llama: es la
    // del hueco que se ha retenido de verdad, que con colisión de por medio no
    // tiene por qué ser el que el paciente nombró.
    return {
      holdId: candidato.id,
      slotStart: candidato.slotStart,
      slotEnd: candidato.slotEnd,
      huboColision,
    };
  }

  throw new HuecoNoDisponibleError('Todos los huecos propuestos se han ocupado.');
}

export type { EfectoDeHueco };
