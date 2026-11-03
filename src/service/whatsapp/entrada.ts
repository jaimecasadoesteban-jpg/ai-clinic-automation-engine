import { createHmac, timingSafeEqual } from 'node:crypto';

import type { MensajeDeLaBandeja } from '../../db/schema.js';

/**
 * Lo que llega por el webhook de Meta, traducido a lo que entiende el turno.
 * Sin estado y sin base de datos: se prueba con payloads reales.
 */

/**
 * ¿Lo firmó Meta? `X-Hub-Signature-256: sha256=<HMAC del cuerpo crudo con el App
 * Secret>`. Es lo que protege `/whatsapp`, que no puede llevar nuestro token: sin
 * el App Secret no se puede falsificar una petición. Sobre el cuerpo **crudo**:
 * re-serializar el JSON cambiaría los bytes y la firma no coincidiría nunca.
 */
export function firmaValida(cuerpoCrudo: Buffer, cabecera: string | undefined, appSecret: string): boolean {
  if (cabecera === undefined || !cabecera.startsWith('sha256=')) return false;
  const esperada = createHmac('sha256', appSecret).update(cuerpoCrudo).digest('hex');
  const recibida = cabecera.slice('sha256='.length);
  const a = Buffer.from(recibida, 'utf8');
  const b = Buffer.from(esperada, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface MensajeEntrante {
  /** La línea de la clínica: resuelve a qué clínica va (`canal.remitenteId`). */
  readonly remitenteId: string;
  /** El wamid de Meta: es la clave de idempotencia. */
  readonly id: string;
  readonly mensaje: MensajeDeLaBandeja;
}

interface Valor {
  metadata?: { phone_number_id?: string };
  contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
  messages?: Array<Record<string, unknown> & { id?: string; from?: string; type?: string }>;
}

/**
 * Todos los mensajes de un payload. Los acuses (entregado, leído) no son
 * mensajes y no salen de aquí.
 *
 * **Lo que no es texto también sale**, con su tipo: una nota de voz tiene que
 * recibir respuesta («sólo puedo leer mensajes escritos»). n8n la descartaba en
 * silencio y el paciente creía que había llegado.
 */
export function extraerMensajes(payload: unknown): MensajeEntrante[] {
  const salida: MensajeEntrante[] = [];
  const entradas = (payload as { entry?: Array<{ changes?: Array<{ value?: Valor }> }> })?.entry ?? [];
  for (const entrada of entradas) {
    for (const cambio of entrada.changes ?? []) {
      const valor = cambio.value ?? {};
      const remitenteId = valor.metadata?.phone_number_id;
      if (remitenteId === undefined) continue;
      for (const m of valor.messages ?? []) {
        if (typeof m.id !== 'string' || typeof m.from !== 'string') continue;
        const contacto = (valor.contacts ?? []).find((c) => c.wa_id === m.from);
        const nombre = (contacto?.profile?.name ?? '').trim().slice(0, 100) || 'Paciente';
        salida.push({ remitenteId, id: m.id, mensaje: { telefono: `+${m.from}`, nombre, ...contenido(m) } });
      }
    }
  }
  return salida;
}

function contenido(m: Record<string, unknown>): Pick<MensajeDeLaBandeja, 'tipo' | 'texto'> {
  const tipo = m['type'];
  const texto = (t: unknown): Pick<MensajeDeLaBandeja, 'tipo' | 'texto'> =>
    typeof t === 'string' && t.trim() !== '' ? { tipo: 'texto', texto: t.slice(0, 4096) } : { tipo: 'otro' };
  switch (tipo) {
    case 'text':
      return texto((m['text'] as { body?: unknown } | undefined)?.body);
    // Un botón o una respuesta de lista es lo que el paciente quiso decir: su texto.
    case 'button':
      return texto((m['button'] as { text?: unknown } | undefined)?.text);
    case 'interactive': {
      const i = m['interactive'] as { button_reply?: { title?: unknown }; list_reply?: { title?: unknown } } | undefined;
      return texto(i?.button_reply?.title ?? i?.list_reply?.title);
    }
    case 'audio':
      return { tipo: 'audio' };
    case 'image':
    case 'sticker':
      return { tipo: 'imagen' };
    case 'document':
      return { tipo: 'documento' };
    case 'location':
      return { tipo: 'ubicacion' };
    default:
      return { tipo: 'otro' };
  }
}
