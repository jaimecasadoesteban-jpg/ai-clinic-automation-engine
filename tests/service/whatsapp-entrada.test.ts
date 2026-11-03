import { describe, expect, it } from 'vitest';

import { extraerMensajes, firmaValida } from '../../src/service/whatsapp/entrada.js';
import { firmar, webhookDeMeta } from '../support/meta.js';

const SECRETO = 'secreto-de-la-app';

describe('la firma de Meta', () => {
  const cuerpo = JSON.stringify({ hola: 'mundo' });

  it('la buena pasa', () => {
    expect(firmaValida(Buffer.from(cuerpo), firmar(cuerpo, SECRETO), SECRETO)).toBe(true);
  });

  it.each([
    ['sin cabecera', undefined],
    ['sin el prefijo sha256=', firmar(cuerpo, SECRETO).slice('sha256='.length)],
    ['con otro secreto', firmar(cuerpo, 'otro')],
    ['de otro cuerpo', firmar(cuerpo + ' ', SECRETO)],
  ])('%s, no', (_n, cabecera) => {
    expect(firmaValida(Buffer.from(cuerpo), cabecera, SECRETO)).toBe(false);
  });
});

describe('lo que trae un webhook', () => {
  const de = (m: Record<string, unknown> & { type: string }) =>
    extraerMensajes(webhookDeMeta({ remitenteId: '000', mensajes: [{ id: 'wamid.1', from: '34600111222', ...m }] }))[0];

  it('un texto: teléfono E.164, nombre del perfil, el texto y su línea', () => {
    expect(de({ type: 'text', text: { body: 'Quiero cita' } })).toEqual({
      remitenteId: '000',
      id: 'wamid.1',
      mensaje: { telefono: '+34600111222', nombre: 'Lola', tipo: 'texto', texto: 'Quiero cita' },
    });
  });

  it.each([
    ['audio', { type: 'audio', audio: {} }, 'audio'],
    ['foto', { type: 'image', image: {} }, 'imagen'],
    ['documento', { type: 'document', document: {} }, 'documento'],
    ['ubicación', { type: 'location', location: {} }, 'ubicacion'],
    ['vídeo', { type: 'video', video: {} }, 'otro'],
  ])('una nota de %s también sale, con su tipo: tiene que recibir respuesta', (_n, m, tipo) => {
    expect(de(m)?.mensaje.tipo).toBe(tipo);
  });

  it('un botón y una respuesta de lista son lo que dijo: su texto', () => {
    expect(de({ type: 'button', button: { text: 'Sí' } })?.mensaje).toMatchObject({ tipo: 'texto', texto: 'Sí' });
    expect(de({ type: 'interactive', interactive: { button_reply: { title: 'La primera' } } })?.mensaje).toMatchObject({
      tipo: 'texto',
      texto: 'La primera',
    });
  });

  it('los acuses de entrega y lectura no son mensajes', () => {
    const acuse = {
      entry: [{ changes: [{ value: { metadata: { phone_number_id: '000' }, statuses: [{ id: 'wamid.1', status: 'read' }] } }] }],
    };
    expect(extraerMensajes(acuse)).toEqual([]);
  });

  it('basura no revienta', () => {
    expect(extraerMensajes(null)).toEqual([]);
    expect(extraerMensajes({ entry: 'no' })).toEqual([]);
  });
});
