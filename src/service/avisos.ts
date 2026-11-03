import type { ClienteConfig } from '../config/cliente.js';
import type { PatientRow } from '../db/queries.js';

/**
 * A quién va cada aviso y qué dice, resuelto **dentro del núcleo**.
 *
 * ## Por qué no lo resuelve n8n
 *
 * Los contactos viven en el YAML de la clínica, y n8n no lee el YAML. Si el
 * efecto no llevara el destinatario, n8n tendría que mantener su propia tabla de
 * contactos: la misma configuración en dos sitios, uno de ellos sin tests y sin
 * diff legible. Es exactamente lo que se decidió no hacer con el horario, y por
 * el mismo motivo — el día que alguien cambie el número de recepción en un sitio
 * y no en el otro, los avisos se van a un móvil que ya no mira nadie y **no falla
 * nada**: simplemente dejan de llegar.
 *
 * Con esto, n8n hace una sola cosa: mandar `texto` a `destino`. Un workflow que
 * no decide nada es un workflow que no puede desincronizarse.
 *
 * Lo mismo con el texto, y por lo mismo que el evento de la agenda: compuesto
 * aquí, desde el YAML, versionado y con test.
 */

export interface Destinatario {
  readonly nombre: string;
  readonly canal: 'whatsapp' | 'email' | 'telefono';
  readonly destino: string;
}

/**
 * Cómo se le nombra a la clínica cada motivo. **No son los textos del paciente**:
 * esto lo lee quien trabaja, y tiene que entenderse de un vistazo en el móvil.
 */
const NOMBRE_DEL_MOTIVO: Readonly<Record<string, string>> = {
  urgencia_clinica: 'POSIBLE URGENCIA',
  contenido_clinico: 'Consulta clínica',
  menor_de_edad: 'Menor de edad',
  queja: 'Paciente molesto',
  pide_persona: 'Pide hablar con una persona',
  agente_atascado: 'El agente no consigue resolverlo',
  derechos_rgpd: 'Solicitud sobre sus datos (RGPD)',
  validacion_fallida: 'Respuesta bloqueada: contesta tú',
  sin_respuesta_recepcion: 'Cita sin confirmar, a punto de caducar',
  agenda_no_escrita: 'No se pudo dejar la cita en la agenda',
  agenda_no_disponible: 'La agenda no responde: un paciente pedía hueco y no se le pudo proponer',
  latido_perdido: 'Un proceso automático ha dejado de ejecutarse',
  historial_falso: 'Al paciente se le dijo algo que no es verdad',
  peticion_paciente: 'Petición del paciente',
};

/** Lo que va delante cuando hay que mirarlo AHORA, sea la hora que sea. */
const MARCA_URGENTE = '⚠️ ATENDER AHORA · ';

/**
 * Quién recibe un escalado.
 *
 * Dos reglas, y la segunda no es un detalle: **las solicitudes de derechos no van
 * a recepción**. La clínica designa a alguien para protección de datos y el
 * contrato de encargo compromete el traslado a esa persona; mandarlo «a los de
 * siempre» sería incumplirlo en silencio.
 */
/**
 * Los motivos que son de infraestructura, no de la clínica: van al operador por
 * correo y **no** a recepción. «Un cron ha dejado de llamar» o «la agenda no
 * responde» no son cosas que recepción pueda arreglar, y mandárselas es enseñarle
 * a ignorar avisos.
 */
export const MOTIVOS_DEL_OPERADOR: ReadonlySet<string> = new Set(['latido_perdido', 'agenda_no_disponible']);

export function nombreDelMotivo(motivo: string): string {
  return NOMBRE_DEL_MOTIVO[motivo] ?? motivo;
}

export function destinatariosDeEscalado(
  config: ClienteConfig,
  motivo: string,
  severidad: number,
): Destinatario[] {
  if (motivo === 'derechos_rgpd') return [...config.escalado.proteccionDeDatos];
  // Al operador por correo, desde la tabla de salida: aquí, a nadie de la clínica.
  if (MOTIVOS_DEL_OPERADOR.has(motivo)) return [];
  return config.escalado.contactos.filter((c) => c.severidadMinima <= severidad);
}

/** Quién recibe los avisos de cita. Nunca se cae a los contactos de escalado. */
export function destinatariosDeRecepcion(config: ClienteConfig): Destinatario[] {
  return [...config.escalado.recepcion];
}

/** «miércoles, 26 a las 16:00», en hora de la clínica. */
function cuando(fecha: Date, zonaHoraria: string): string {
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: zonaHoraria,
    weekday: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(fecha);
}

/**
 * Rellena una plantilla de aviso.
 *
 * El paciente entra como fila completa, no como la vista del prompt: esto va a
 * la clínica, que es la responsable del tratamiento y necesita saber a quién
 * llamar. Es la misma frontera que la del evento de agenda y **no** la del
 * modelo — ver `service/evento.ts`.
 */
export function componerAviso(entrada: {
  readonly plantilla: string;
  readonly config: ClienteConfig;
  readonly paciente?: PatientRow | undefined;
  readonly servicio?: string | undefined;
  readonly hueco?: Date | undefined;
  readonly motivo?: string | undefined;
  /**
   * Lo concreto, cuando el motivo solo no basta: va detrás del nombre del motivo
   * en `{motivo}`. Así las plantillas que ya tiene cada clínica lo llevan sin
   * tocarlas.
   */
  readonly detalle?: string | null | undefined;
  readonly severidad?: number | undefined;
}): string {
  const { paciente, config } = entrada;
  const apellidos = paciente?.familyName ?? '';
  const completo =
    paciente === undefined
      ? 'Sin paciente'
      : apellidos === ''
        ? paciente.givenName
        : `${paciente.givenName} ${apellidos}`;

  return entrada.plantilla
    .replaceAll('{paciente}', completo)
    .replaceAll('{telefono}', paciente?.phoneE164 ?? 'sin teléfono')
    .replaceAll('{servicio}', entrada.servicio ?? '')
    .replaceAll('{hueco}', entrada.hueco === undefined ? '' : cuando(entrada.hueco, config.zonaHoraria))
    .replaceAll(
      '{motivo}',
      entrada.motivo === undefined
        ? ''
        : `${NOMBRE_DEL_MOTIVO[entrada.motivo] ?? entrada.motivo}${
            entrada.detalle == null || entrada.detalle === '' ? '' : `: ${entrada.detalle}`
          }`,
    )
    .replaceAll('{marca}', entrada.severidad === 3 ? MARCA_URGENTE : '')
    .trim();
}
