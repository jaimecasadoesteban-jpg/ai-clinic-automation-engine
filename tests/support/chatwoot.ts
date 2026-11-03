import { createHmac } from 'node:crypto';

/**
 * Avisos de Chatwoot como los de su documentación, para los tests. La forma
 * exacta del de verdad está por comprobar contra uno real antes de activar:
 * por eso los tests prueban las dos formas de `message_type`.
 */

export const CUENTA = 7;
export const INBOX = 42;

export function avisoDeMensaje(opciones: {
  id: number;
  conversacion?: number;
  texto?: string | null;
  telefono?: string;
  tipo?: 'incoming' | 'outgoing' | 0 | 1;
  privado?: boolean;
  adjuntos?: Array<{ file_type: string }>;
  etiquetas?: string[];
  inbox?: number;
}): Record<string, unknown> {
  const conversacion = opciones.conversacion ?? 1001;
  return {
    event: 'message_created',
    id: opciones.id,
    content: opciones.texto === undefined ? 'hola' : opciones.texto,
    message_type: opciones.tipo ?? 'incoming',
    private: opciones.privado ?? false,
    content_type: 'text',
    attachments: opciones.adjuntos ?? [],
    // En un saliente, `sender` es quien lo escribió: una persona del equipo, sin teléfono.
    sender:
      opciones.tipo === 'outgoing' || opciones.tipo === 1
        ? { id: 1, name: 'Marta', type: 'user' }
        : { id: 55, name: 'Lola', phone_number: opciones.telefono ?? '+34600123456', type: 'contact' },
    inbox: { id: opciones.inbox ?? INBOX, name: 'WhatsApp' },
    account: { id: CUENTA, name: 'Cuenta' },
    conversation: {
      id: conversacion,
      inbox_id: opciones.inbox ?? INBOX,
      ...(opciones.etiquetas === undefined ? {} : { labels: opciones.etiquetas }),
      meta: { sender: { name: 'Lola', phone_number: opciones.telefono ?? '+34600123456' } },
    },
  };
}

export function avisoDeConversacion(opciones: {
  etiquetas: string[];
  conversacion?: number;
  telefono?: string;
}): Record<string, unknown> {
  return {
    event: 'conversation_updated',
    id: opciones.conversacion ?? 1001,
    account_id: CUENTA,
    inbox_id: INBOX,
    labels: opciones.etiquetas,
    meta: { sender: { name: 'Lola', phone_number: opciones.telefono ?? '+34600123456' } },
    changed_attributes: [{ label_list: {} }],
  };
}

/** `sha256=` + HMAC-SHA256 de «{timestamp}.{cuerpo}». */
export function firmarChatwoot(cuerpo: string, secreto: string, marcaDeTiempo: number): string {
  return `sha256=${createHmac('sha256', secreto).update(`${marcaDeTiempo}.${cuerpo}`).digest('hex')}`;
}
