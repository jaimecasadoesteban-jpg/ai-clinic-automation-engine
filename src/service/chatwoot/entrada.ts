import { createHmac, timingSafeEqual } from 'node:crypto';

import type { MensajeDeLaBandeja } from '../../db/schema.js';

/**
 * Lo que llega por el webhook de Chatwoot, traducido a lo que entiende el
 * núcleo. Sin estado y sin base de datos: se prueba con payloads.
 *
 * **La forma del aviso no está bien documentada**: `message_type` aparece como
 * texto («incoming») en unos sitios y como número (0) en otros, y las etiquetas
 * no salen en todos los ejemplos. Se aceptan las dos formas y lo que no se
 * reconoce no se inventa: se ignora, y la ruta lo registra.
 */

/** Cuánto puede tener un aviso firmado antes de rechazarlo: contra la repetición. */
export const ANTIGUEDAD_MAXIMA_SEG = 300;

/**
 * ¿Lo firmó Chatwoot? `X-Chatwoot-Signature: sha256=<HMAC-SHA256 de
 * «{timestamp}.{cuerpo crudo}» con el secreto del webhook>`, y
 * `X-Chatwoot-Timestamp` en segundos. La hora entra en la firma, así que un
 * aviso viejo no se puede volver a mandar con otra: se rechaza pasados cinco
 * minutos.
 */
export function firmaDeChatwootValida(datos: {
  cuerpoCrudo: Buffer;
  firma: string | undefined;
  marcaDeTiempo: string | undefined;
  secreto: string;
  ahora: Date;
}): boolean {
  const { firma, marcaDeTiempo } = datos;
  if (firma === undefined || marcaDeTiempo === undefined || !firma.startsWith('sha256=')) return false;
  if (!/^\d{1,12}$/.test(marcaDeTiempo)) return false;
  const edad = Math.abs(datos.ahora.getTime() / 1000 - Number(marcaDeTiempo));
  if (edad > ANTIGUEDAD_MAXIMA_SEG) return false;

  const esperada = createHmac('sha256', datos.secreto)
    .update(Buffer.concat([Buffer.from(`${marcaDeTiempo}.`, 'utf8'), datos.cuerpoCrudo]))
    .digest('hex');
  const a = Buffer.from(firma.slice('sha256='.length), 'utf8');
  const b = Buffer.from(esperada, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Dónde vive una conversación en Chatwoot. `conversacionId` es el número que usa su API. */
export interface DireccionDeChatwoot {
  readonly cuentaId: number;
  readonly inboxId: number;
  readonly conversacionId: number;
}

export type AvisoDeChatwoot =
  | {
      readonly tipo: 'mensaje';
      readonly donde: DireccionDeChatwoot;
      /** Clave de idempotencia: Chatwoot reintenta. */
      readonly id: string;
      readonly mensaje: MensajeDeLaBandeja;
      /** Las etiquetas de la conversación, si el aviso las trae. */
      readonly etiquetas: readonly string[] | undefined;
    }
  | {
      /**
       * Chatwoot no pudo entregar uno de nuestros mensajes: lo aceptó, se lo
       * pasó a WhatsApp, y Meta lo rechazó después (fuera de la ventana de
       * 24 h, plantilla no encontrada…). Sin esto, ese fallo no lo ve nadie.
       */
      readonly tipo: 'fallo_de_entrega';
      readonly donde: DireccionDeChatwoot;
      readonly chatwootMensajeId: number;
      readonly error: string;
    }
  | {
      readonly tipo: 'conversacion';
      readonly donde: DireccionDeChatwoot;
      readonly telefono: string;
      readonly nombre: string;
      readonly etiquetas: readonly string[];
    };

/**
 * El aviso, si es algo que el núcleo tiene que atender. `undefined` para todo
 * lo demás: las notas privadas, la actividad y los eventos que no miramos.
 *
 * **Los salientes sí entran**, marcados como tales: lo que escribe una persona
 * desde el móvil (coexistencia) o desde Chatwoot tiene que estar en el
 * historial. Chatwoot avisa también de los nuestros (el agente, el panel); a
 * ésos los reconoce después la bandeja por su id.
 */
export function leerAvisoDeChatwoot(payload: unknown): AvisoDeChatwoot | undefined {
  if (!esObjeto(payload)) return undefined;
  const evento = payload['event'];

  if (evento === 'message_created') {
    // Las notas privadas son del equipo para el equipo: no son conversación.
    if (payload['private'] === true) return undefined;
    const tipoDeMensaje = payload['message_type'];
    const entrante = tipoDeMensaje === 'incoming' || tipoDeMensaje === 0;
    const saliente = tipoDeMensaje === 'outgoing' || tipoDeMensaje === 1;
    if (!entrante && !saliente) return undefined;

    const conversacion = objeto(payload['conversation']);
    const remitente = objeto(payload['sender']);
    const contacto = objeto(objeto(conversacion['meta'])['sender']);
    const donde = direccion(
      objeto(payload['account'])['id'],
      objeto(payload['inbox'])['id'] ?? conversacion['inbox_id'],
      conversacion['id'],
    );
    // En un saliente, `sender` es quien lo escribió (el equipo): el paciente
    // es el contacto de la conversación.
    const telefono = telefonoE164(entrante ? (remitente['phone_number'] ?? contacto['phone_number']) : contacto['phone_number']);
    const id = payload['id'];
    const idNumerico = typeof id === 'number' ? id : typeof id === 'string' && /^\d+$/.test(id) ? Number(id) : undefined;
    if (donde === undefined || telefono === undefined || idNumerico === undefined) return undefined;
    const contenidoDelMensaje = contenido(payload['content'], payload['attachments']);
    // Un saliente sin texto (un adjunto que mandó el equipo) no aporta nada al historial que lee el modelo.
    if (saliente && contenidoDelMensaje.tipo !== 'texto') return undefined;

    return {
      tipo: 'mensaje',
      donde,
      id: `chatwoot:${donde.cuentaId}:${idNumerico}`,
      mensaje: {
        telefono,
        nombre: nombreDe(entrante ? remitente['name'] : contacto['name']),
        ...contenidoDelMensaje,
        chatwoot: { cuentaId: donde.cuentaId, conversacionId: donde.conversacionId },
        ...(saliente ? { saliente: { chatwootMensajeId: idNumerico } } : {}),
      },
      etiquetas: etiquetas(conversacion['labels']),
    };
  }

  if (evento === 'message_updated') {
    const estado = payload['status'];
    const tipoDeMensaje = payload['message_type'];
    if (estado !== 'failed' || !(tipoDeMensaje === 'outgoing' || tipoDeMensaje === 1)) return undefined;
    const conversacion = objeto(payload['conversation']);
    const donde = direccion(objeto(payload['account'])['id'], objeto(payload['inbox'])['id'] ?? conversacion['inbox_id'], conversacion['id']);
    const id = entero(payload['id']);
    if (donde === undefined || id === undefined) return undefined;
    const error = objeto(payload['content_attributes'])['external_error'] ?? payload['external_error'];
    return {
      tipo: 'fallo_de_entrega',
      donde,
      chatwootMensajeId: id,
      error: typeof error === 'string' && error.trim() !== '' ? error.slice(0, 300) : 'sin detalle',
    };
  }

  if (evento === 'conversation_updated' || evento === 'conversation_created') {
    const remitente = objeto(objeto(payload['meta'])['sender']);
    const donde = direccion(payload['account_id'] ?? objeto(payload['account'])['id'], payload['inbox_id'], payload['id']);
    const telefono = telefonoE164(remitente['phone_number']);
    const lista = etiquetas(payload['labels']);
    if (donde === undefined || telefono === undefined || lista === undefined) return undefined;
    return { tipo: 'conversacion', donde, telefono, nombre: nombreDe(remitente['name']), etiquetas: lista };
  }

  return undefined;
}

function contenido(texto: unknown, adjuntos: unknown): Pick<MensajeDeLaBandeja, 'tipo' | 'texto'> {
  if (typeof texto === 'string' && texto.trim() !== '') return { tipo: 'texto', texto: texto.slice(0, 4096) };
  const primero = Array.isArray(adjuntos) ? objeto(adjuntos[0]) : {};
  switch (primero['file_type']) {
    case 'audio':
      return { tipo: 'audio' };
    case 'image':
      return { tipo: 'imagen' };
    case 'file':
      return { tipo: 'documento' };
    case 'location':
      return { tipo: 'ubicacion' };
    default:
      return { tipo: 'otro' };
  }
}

function direccion(cuenta: unknown, inbox: unknown, conversacion: unknown): DireccionDeChatwoot | undefined {
  const [c, i, v] = [entero(cuenta), entero(inbox), entero(conversacion)];
  return c === undefined || i === undefined || v === undefined ? undefined : { cuentaId: c, inboxId: i, conversacionId: v };
}

function entero(valor: unknown): number | undefined {
  const n = typeof valor === 'string' && /^\d+$/.test(valor) ? Number(valor) : valor;
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** E.164 con `+`. Lo que no lo parezca no es un teléfono al que contestar. */
function telefonoE164(valor: unknown): string | undefined {
  if (typeof valor !== 'string') return undefined;
  const digitos = valor.replace(/[\s\-().]/g, '').replace(/^\+/, '');
  return /^\d{8,15}$/.test(digitos) ? `+${digitos}` : undefined;
}

function nombreDe(valor: unknown): string {
  return (typeof valor === 'string' ? valor.trim().slice(0, 100) : '') || 'Paciente';
}

function etiquetas(valor: unknown): string[] | undefined {
  return Array.isArray(valor) ? valor.filter((e): e is string => typeof e === 'string') : undefined;
}

function esObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

function objeto(valor: unknown): Record<string, unknown> {
  return esObjeto(valor) ? valor : {};
}
