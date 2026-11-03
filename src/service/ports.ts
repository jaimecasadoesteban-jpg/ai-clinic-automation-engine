import type { Categoria } from '../agent/firewall.js';
import type { PromptPatient } from '../agent/prompt-boundary.js';
import type { Extraccion, TemaDeInformacion } from '../agent/extraccion.js';
import type { Intervalo } from '../core/disponibilidad.js';
import type { TurnoDeConversacion } from '../agent/prompt.js';
import type { ClienteConfig } from '../config/cliente.js';

/**
 * Las piezas no deterministas del pipeline, detrás de un puerto.
 *
 * La orquestación se prueba entera sin ellas: en los tests se enchufan
 * implementaciones falsas y deterministas, y así el flujo de agendado —incluida
 * la colisión del paso 6— se verifica sin que la aleatoriedad de un modelo
 * enturbie el resultado. El modelo real entra por aquí en la fase siguiente,
 * sin tocar nada de lo demás.
 *
 * El cortafuegos NO es un puerto: es determinista y va siempre el de verdad.
 */

export type { Intencion } from '../agent/extraccion.js';

/**
 * Lo que el modelo pequeño extrae, con salida cerrada. Esto es lo que sustituye
 * a las herramientas del agente: datos, no decisiones.
 */
export interface Clasificacion extends Extraccion {
  readonly modelo: string;
  readonly tokensEntrada: number;
  readonly tokensSalida: number;
}

export interface ClasificadorDeIntencion {
  clasificar(entrada: {
    readonly texto: string;
    readonly paciente: PromptPatient;
  }): Promise<Clasificacion>;
}

export interface Redaccion {
  readonly texto: string;
  readonly modelo: string;
  readonly tokensEntrada: number;
  readonly tokensSalida: number;
}

/** Lo que se le dice al modelo cuando su salida anterior no pasó la validación. */
export interface Correccion {
  readonly textoAnterior: string;
  readonly explicacion: string;
}

/** Lo que el redactor necesita saber del estado real del sistema. */
export interface EstadoParaRedactar {
  /** `true` si NO se ha determinado el servicio y hay que preguntarlo. */
  readonly faltaServicio: boolean;
  /** Nombre del servicio, cuando sí se determinó. */
  readonly servicio: string | null;
  /** Preferencia del paciente, en texto, o `null`. */
  readonly preferencia: string | null;
  /** `true` si había preferencia y ningún hueco la cumplía. */
  readonly preferenciaNoSatisfecha: boolean;
  /** `true` si se han descartado huecos anteriores por cambio de servicio. */
  readonly servicioCambiado: boolean;
  /**
   * La cita que está cambiando, descrita —«Limpieza facial, miércoles 26 a las
   * 16:00»—, o `null`. Con nombre y no un booleano: **puede tener varias**, y
   * «tu cita» sin decir cuál es justo la ambigüedad que hay que evitar. La
   * anterior sigue en pie hasta que elija una nueva.
   */
  readonly reagendando: string | null;
  /** `true` si se acaba de soltar su cita. */
  readonly cancelada: boolean;
  /**
   * `true` cuando hay huecos propuestos y NO se sabe cuál ha elegido. Hay que
   * preguntárselo, no retener el primero por si acaso.
   */
  readonly faltaOpcion: boolean;
  /** `true` si la 2ª o la 3ª opción se apartan de lo que pidió. */
  readonly alternativasAlejadas: boolean;
  /**
   * `true` si en este turno se ha mirado la agenda. Con `false`, el mensaje no
   * puede afirmar que hay o que no hay hueco: no habría nada detrás.
   */
  readonly consultada: boolean;
  /**
   * Las citas que el paciente YA tiene, cada una con tratamiento, día y hora, y
   * si está confirmada.
   *
   * **Una lista, no una cita.** Un paciente puede tener limpieza el miércoles y
   * láser el viernes, y el agente tiene que poder nombrar las dos sin
   * inventarse nada — y saber que a éste no hay que proponerle horas para lo
   * que ya tiene.
   */
  readonly citasVigentes: readonly CitaParaRedactar[];
  /**
   * Tiene varias citas y ha pedido cambiar o cancelar sin decir cuál. **No se
   * ha propuesto ni soltado nada**: hay que preguntárselo nombrándolas.
   */
  readonly preguntarCual: 'cambiar' | 'cancelar' | null;
  /**
   * Ha elegido un hueco del MISMO tratamiento que una cita que ya tiene. Puede
   * ser un cambio o una sesión más, así que **no se ha retenido nada**: hay que
   * preguntarle si es en lugar de esa cita o además.
   */
  /**
   * Lo que se le dijo en esta conversación y no era verdad, ya corregido: «No
   * existe ninguna cita el lunes 12 a las 10:20: nunca llegó a reservarse».
   * El modelo tiene que poder aclarárselo si sale el tema, en vez de construir
   * encima de la mentira.
   */
  readonly desmentidos: readonly string[];
  readonly preguntarSiSustituye: {
    /** El hueco que ha elegido, descrito. */
    readonly nueva: string;
    /** Las citas del mismo tratamiento que podría estar sustituyendo. */
    readonly citas: readonly string[];
  } | null;
}

export interface CitaParaRedactar {
  /** «Láser axilas, viernes 28 a las 17:00». Sin datos del paciente. */
  readonly descripcion: string;
  /** Tenerla no es lo mismo que tenerla confirmada, y la despedida cambia. */
  readonly confirmada: boolean;
}

export interface Redactor {
  redactar(entrada: {
    readonly intencion: import('../agent/extraccion.js').Intencion;
    readonly texto: string;
    readonly paciente: PromptPatient;
    readonly huecos?: readonly HuecoDisponible[];
    readonly correccion?: Correccion | undefined;
    /**
     * Regla 4 bis: el mensaje y el estado del sistema tienen que coincidir.
     * Si aquí llega `faltaServicio: true`, no hay huecos creados y el mensaje
     * no puede dar a entender que sí.
     */
    readonly estado?: EstadoParaRedactar | undefined;
  }): Promise<Redaccion>;
}

export interface HuecoDisponible {
  readonly inicio: Date;
  readonly fin: Date;
}

/**
 * La agenda de la clínica, **sólo lectura y sólo ocupado/libre** (regla 3). No
 * existe ni existirá un método que escriba: escribe siempre una persona.
 *
 * **Devuelve ocupación en bruto, no huecos proponibles.** Qué se puede ofrecer
 * —horario, días de cierre, tramos partidos, antelación mínima, que el servicio
 * quepa entero antes del cierre— lo decide el núcleo en
 * `core/disponibilidad.ts`, porque son reglas de negocio y tienen que estar
 * donde se puedan probar.
 *
 * El núcleo no habla con Google Calendar; los datos vienen de n8n.
 */
export interface Agenda {
  /** Cuándo está pillada la agenda en ese rango. Sin interpretar. */
  ocupacion(entrada: {
    readonly clientId: string;
    /** Qué calendario: sale del YAML (`agenda.calendarioId`), no de n8n. */
    readonly calendarioId: string;
    readonly desde: Date;
    readonly hasta: Date;
  }): Promise<readonly Intervalo[]>;

  /**
   * Paso 6: releer antes de confirmar. Nunca se confirma sobre información
   * vieja. Se pregunta por el intervalo completo, no sólo por el instante de
   * inicio: media hora ocupada dentro de una cita de una hora también cuenta.
   */
  sigueLibre(entrada: {
    readonly clientId: string;
    readonly calendarioId: string;
    readonly inicio: Date;
    readonly fin: Date;
  }): Promise<boolean>;
}

/** Textos de cara al paciente. Salen del YAML de la clínica; hay respaldo en código. */
export interface Textos {
  corte(categoria: Categoria): string;
  enPausa(): string;
  /**
   * «He retenido tu hueco, queda pendiente de confirmar».
   *
   * Texto fijo y no generado: es una notificación de estado con peso legal —
   * no puede decir «confirmada» bajo ninguna circunstancia— y el paciente que
   * escribe de madrugada tiene que recibirlo **en el momento**, no diez horas
   * después. Dejarlo en manos del modelo sería arriesgar las dos cosas.
   */
  retenido(datos: {
    /** La hora que se le acaba de reservar. El mensaje la dice: es lo primero que preguntaría. */
    hueco: Date;
    /**
     * Código del catálogo del hueco. **Obligatorio**: el mensaje dice de qué es
     * la cita, no sólo cuándo. Si se hubiera retenido el de las 10:20 que salió
     * en el servidor de pruebas, el paciente habría ido a depilarse creyendo
     * que iba a una limpieza facial.
     */
    servicio: string;
    avisoDiferidoHasta: Date | null;
  }): string;
  /**
   * «Te lo cambio a las 10:00 y suelto el de las 11:00».
   *
   * **Reagendar NO puede compartir texto con elegir por primera vez.** Salían
   * palabra por palabra iguales: «Te he guardado ese hueco. Queda pendiente de
   * que recepción lo confirme». Quien acaba de cambiar la hora de su cita lee
   * eso y no sabe a qué hora la tiene ni si la anterior sigue en pie — y es
   * justo el momento en que más necesita saberlo.
   *
   * Lleva las dos horas a propósito: la nueva, porque es la que hay que
   * recordar, y la anterior, porque confirmar que se ha soltado es la mitad de
   * lo que el paciente está preguntando.
   */
  /**
   * «Tu solicitud sobre tus datos está en curso; no te agendo nada mientras».
   *
   * Texto fijo, no generado: es una afirmación con consecuencia legal y el
   * modelo no puede matizarla ni prometer plazos que no dependen de nosotros.
   */
  derechosEnCurso(): string;
  /**
   * El horario de apertura, compuesto desde el YAML. **Sin modelo.**
   *
   * Pasaba por el modelo y la regla de horas lo tomaba por huecos inventados:
   * medido sobre conversación corriente, «¿qué horario tenéis?» y «¿abrís los
   * sábados?» acababan escaladas todas las veces. docs/DESIGN_RULES.md prometía que los
   * datos de catálogo se componían desde configuración; ese paso nunca existió.
   * No se arregla dejando las horas de apertura como mencionables: así se
   * colaría «tengo hueco el lunes a las 10:00» si las 10:00 es la hora de abrir.
   */
  horario(): string;
  /**
   * Un dato práctico de la clínica —dirección, aparcamiento, pago, cancelación,
   * primera visita, preparación—, **tal cual lo escribió la clínica**. Sin
   * modelo, por lo mismo que el horario: el modelo se los inventaba y ninguna
   * regla puede comprobarlos. Si el dato no está, remite a recepción.
   */
  informacion(tema: TemaDeInformacion, servicio: string | null): string;
  /**
   * «Por aquí sólo puedo leer mensajes escritos».
   *
   * Texto fijo y no generado, por lo mismo que los demás: es una limitación del
   * sistema, no una conversación, y el modelo no debe adornar ni prometer que lo
   * escuchará luego. Recibe el tipo por si una clínica quiere decir algo
   * distinto ante una foto que ante una nota de voz.
   */
  soloTexto(tipo: string): string;
  reagendado(datos: {
    nueva: Date;
    anterior: Date;
    /** El de la cita que se mueve: reagendar no cambia de tratamiento. */
    servicio: string;
    avisoDiferidoHasta: Date | null;
  }): string;
  /**
   * «Confirmada tu cita del lunes 24 a las 11:00».
   *
   * Con la hora dentro, por lo mismo que la retención: es el mensaje que el
   * paciente busca en el hilo tres días después para saber cuándo tiene que ir.
   */
  confirmada(datos: { hueco: Date; servicio: string }): string;
  /**
   * El hueco se ocupó entre medias y se pasa a la segunda opción. **Dice cuál
   * es**: enterarte de que tu cita ha cambiado sin que te digan a qué hora es
   * peor que no enterarte.
   */
  colisionConAlternativa(datos: { alternativa: Date; servicio: string }): string;
  colisionSinAlternativa(): string;
  /**
   * Lo que lee el paciente cuando la validación de salida bloquea dos veces.
   *
   * Estaba escrito a mano en `pipeline.ts`, que es una regla 7 rota: un texto
   * de cara al paciente que una clínica no podía cambiar sin tocar un `.ts`.
   */
  escaladoPorValidacion(): string;
  /** Y cuando el proveedor del modelo no responde. Tampoco puede haber silencio. */
  proveedorCaido(): string;
  /**
   * La agenda no responde y el paciente pedía hueco. **No promete a una persona**
   * ni «te escribo luego»: nadie lo va a hacer, y es la regla 4 quater. Dice lo
   * que es verdad —ahora no se puede mirar— y le deja una salida que depende de
   * él.
   */
  agendaNoDisponible(): string;
  /**
   * El mensaje no se ha podido atender ni reintentando: algo del núcleo falla.
   * Lo recibe el paciente para no quedarse en silencio, sin prometer a nadie.
   */
  fueraDeServicio(): string;
  /**
   * Los tres mensajes que el sistema le manda al paciente **sin que haya escrito
   * nada**: salen de `/caducar-retenciones`, dentro de la franja de contacto.
   *
   * Existían como plantillas con nombre en la máquina de estados y no como
   * texto en ningún sitio, así que n8n recibía `{ plantilla: 'propuesta_caducada' }`
   * sin teléfono ni texto y no podía mandar nada. La regla 4 escrita y no
   * construida, y nadie lo vio porque los crons no estaban montados.
   *
   * Tono más cuidado que en ningún otro texto: el paciente no ha preguntado. Ni
   * reproches («no contestaste») ni inseguridad, y siempre con una salida.
   */
  propuestaCaducada(datos: { servicio: string }): string;
  retencionCaducada(datos: { hueco: Date; servicio: string }): string;
  sinRespuestaDeRecepcion(datos: { hueco: Date; servicio: string }): string;
  /** Antes de la cita. `nombre` es el de pila: lo único identificativo que lleva. */
  recordatorio(datos: { nombre: string; hueco: Date; servicio: string }): string;
}

/**
 * El clasificador y el redactor se construyen POR CONVERSACIÓN, no una vez al
 * arrancar: necesitan el catálogo de la clínica, la ventana de 8 turnos, el
 * resumen y el presupuesto que ya se ha gastado en esa conversación.
 *
 * En los tests, la fábrica devuelve las piezas falsas; en producción, las que
 * hablan con el proveedor. Es el único punto de intercambio.
 */
export interface ContextoDeAgente {
  readonly config: ClienteConfig;
  readonly turnos: readonly TurnoDeConversacion[];
  readonly resumen: string | null;
  /** Llamadas al modelo ya gastadas en esta conversación, para el tope. */
  readonly llamadasPrevias: number;
  /**
   * El servicio que ya se estaba tratando. El clasificador lo necesita para no
   * volver a preguntar lo que ya se sabe, y para detectar un cambio.
   */
  readonly servicioVigente: string | null;
  /**
   * Las citas que el paciente ya tiene, descritas y en orden: el clasificador
   * devuelve en `cita` un número sobre ESTA lista. Sin datos del paciente.
   */
  readonly citasVivas: readonly string[];
  /**
   * Los huecos que tiene delante, descritos y numerados como `opcion`. Así «la
   * segunda» se entiende aunque la oferta haya salido de la ventana de turnos,
   * y «el sábado a las 10» no depende de que el texto lo dejara claro.
   */
  readonly huecosOfrecidos: readonly string[];
}

/**
 * Una llamada al proveedor, tal cual: lo que se le mandó, lo que devolvió, lo
 * que costó y lo que tardó. Regla 6: sin esto, ante una reclamación no se puede
 * saber qué vio el modelo cuando escribió lo que escribió.
 */
export interface LlamadaAlModelo {
  readonly tipo: 'clasificar' | 'redactar' | 'resumir';
  readonly modelo: string;
  readonly sistema: string;
  readonly mensajes: ReadonlyArray<{ readonly role: string; readonly content: string }>;
  /** El texto devuelto, o `null` si falló. */
  readonly respuesta: string | null;
  readonly tokensEntrada: number;
  readonly tokensSalida: number;
  readonly latenciaMs: number;
  /** Por qué falló, si falló. La llamada cuenta igual: se gastó. */
  readonly error: string | null;
}

/**
 * El resumen de lo que ha salido de la ventana de turnos. Devuelve `null` si
 * no se pudo: un resumen que falta no puede tumbar el turno del paciente.
 */
export interface Resumidor {
  resumir(entrada: {
    readonly resumenAnterior: string | null;
    readonly turnos: readonly TurnoDeConversacion[];
  }): Promise<string | null>;
}

export interface Agente {
  readonly clasificador: ClasificadorDeIntencion;
  readonly redactor: Redactor;
  readonly resumidor: Resumidor;
  /** Lo que se ha llamado al modelo en este turno, en orden. */
  llamadas(): readonly LlamadaAlModelo[];
}

export interface FabricaDeAgente {
  para(contexto: ContextoDeAgente): Agente;
}
