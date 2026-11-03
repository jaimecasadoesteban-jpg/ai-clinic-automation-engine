import { createHmac } from 'node:crypto';

/** Un webhook de Meta como los de verdad, para los tests. */
export function webhookDeMeta(opciones: {
  remitenteId: string;
  mensajes: Array<Record<string, unknown> & { id: string; from: string; type: string }>;
  nombre?: string;
}): unknown {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '34600000000', phone_number_id: opciones.remitenteId },
              contacts: opciones.mensajes.map((m) => ({ wa_id: m.from, profile: { name: opciones.nombre ?? 'Lola' } })),
              messages: opciones.mensajes,
            },
          },
        ],
      },
    ],
  };
}

export function firmar(cuerpo: string, secreto: string): string {
  return `sha256=${createHmac('sha256', secreto).update(Buffer.from(cuerpo)).digest('hex')}`;
}
