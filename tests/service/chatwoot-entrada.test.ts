import { describe, expect, it } from 'vitest';

import { firmaDeChatwootValida, leerAvisoDeChatwoot } from '../../src/service/chatwoot/entrada.js';
import { CUENTA, INBOX, avisoDeConversacion, avisoDeMensaje, firmarChatwoot } from '../support/chatwoot.js';

const SECRETO = 'secreto-del-webhook-de-chatwoot';
const AHORA = new Date('2026-10-17T10:00:00.000Z');
const SEGUNDOS = Math.floor(AHORA.getTime() / 1000);

describe('la firma de Chatwoot', () => {
  const cuerpo = JSON.stringify({ event: 'message_created' });
  const comprobar = (firma: string | undefined, marca: string | undefined, crudo = cuerpo) =>
    firmaDeChatwootValida({ cuerpoCrudo: Buffer.from(crudo), firma, marcaDeTiempo: marca, secreto: SECRETO, ahora: AHORA });

  it('la buena pasa', () => {
    expect(comprobar(firmarChatwoot(cuerpo, SECRETO, SEGUNDOS), String(SEGUNDOS))).toBe(true);
  });

  it.each([
    ['sin firma', undefined, String(SEGUNDOS)],
    ['sin hora', firmarChatwoot(cuerpo, SECRETO, SEGUNDOS), undefined],
    ['con otro secreto', firmarChatwoot(cuerpo, 'otro-secreto-cualquiera', SEGUNDOS), String(SEGUNDOS)],
    // La hora va dentro de la firma: cambiarla para «rejuvenecer» un aviso la rompe.
    ['con la hora cambiada', firmarChatwoot(cuerpo, SECRETO, SEGUNDOS - 600), String(SEGUNDOS)],
    ['sin el prefijo sha256=', firmarChatwoot(cuerpo, SECRETO, SEGUNDOS).slice(7), String(SEGUNDOS)],
  ])('%s, no', (_n, firma, marca) => {
    expect(comprobar(firma, marca)).toBe(false);
  });

  it('de otro cuerpo, no', () => {
    expect(comprobar(firmarChatwoot(cuerpo, SECRETO, SEGUNDOS), String(SEGUNDOS), `${cuerpo} `)).toBe(false);
  });

  it('un aviso bien firmado pero de hace más de cinco minutos, no: no se puede repetir', () => {
    const vieja = SEGUNDOS - 301;
    expect(comprobar(firmarChatwoot(cuerpo, SECRETO, vieja), String(vieja))).toBe(false);
    const reciente = SEGUNDOS - 299;
    expect(comprobar(firmarChatwoot(cuerpo, SECRETO, reciente), String(reciente))).toBe(true);
  });
});

describe('lo que trae un aviso', () => {
  it('un mensaje del paciente: teléfono, nombre, texto y la conversación donde contestar', () => {
    expect(leerAvisoDeChatwoot(avisoDeMensaje({ id: 9, texto: 'Quiero cita' }))).toEqual({
      tipo: 'mensaje',
      donde: { cuentaId: CUENTA, inboxId: INBOX, conversacionId: 1001 },
      id: `chatwoot:${CUENTA}:9`,
      mensaje: {
        telefono: '+34600123456',
        nombre: 'Lola',
        tipo: 'texto',
        texto: 'Quiero cita',
        chatwoot: { cuentaId: CUENTA, conversacionId: 1001 },
      },
      etiquetas: undefined,
    });
  });

  it('message_type como número (0) también es entrante: la documentación dice las dos cosas', () => {
    expect(leerAvisoDeChatwoot(avisoDeMensaje({ id: 9, tipo: 0 }))?.tipo).toBe('mensaje');
  });

  it('lo que escribe el equipo (saliente) entra marcado como tal, con el teléfono del paciente y no el de quien escribe', () => {
    for (const tipo of ['outgoing', 1] as const) {
      const aviso = leerAvisoDeChatwoot(avisoDeMensaje({ id: 9, tipo, texto: 'Te llamo ahora' }));
      expect(aviso?.tipo === 'mensaje' ? aviso.mensaje : undefined).toMatchObject({
        telefono: '+34600123456',
        nombre: 'Lola',
        texto: 'Te llamo ahora',
        saliente: { chatwootMensajeId: 9 },
      });
    }
  });

  it('los avisos de actividad (asignaciones, cambios de estado) y las plantillas no son mensajes de nadie', () => {
    for (const tipo of [2, 3, 'activity', 'template']) {
      expect(leerAvisoDeChatwoot({ ...avisoDeMensaje({ id: 9 }), message_type: tipo })).toBeUndefined();
    }
  });

  it('en un saliente, el teléfono es el del paciente aunque quien escribe tenga uno', () => {
    const aviso = leerAvisoDeChatwoot({
      ...avisoDeMensaje({ id: 9, tipo: 'outgoing', texto: 'Te llamo ahora' }),
      sender: { id: 1, name: 'Marta', type: 'user', phone_number: '+34699000111' },
    });
    expect(aviso?.tipo === 'mensaje' ? aviso.mensaje.telefono : undefined).toBe('+34600123456');
  });

  it('un mensaje nuestro que WhatsApp no entregó llega como fallo, con su motivo', () => {
    const aviso = leerAvisoDeChatwoot({
      ...avisoDeMensaje({ id: 5001, tipo: 'outgoing', texto: 'x' }),
      event: 'message_updated',
      status: 'failed',
      content_attributes: { external_error: '(#131047) Re-engagement message' },
    });
    expect(aviso).toEqual({
      tipo: 'fallo_de_entrega',
      donde: { cuentaId: CUENTA, inboxId: INBOX, conversacionId: 1001 },
      chatwootMensajeId: 5001,
      error: '(#131047) Re-engagement message',
    });
  });

  it('un mensaje actualizado que no ha fallado, o que es del paciente, no es un fallo', () => {
    expect(leerAvisoDeChatwoot({ ...avisoDeMensaje({ id: 1, tipo: 'outgoing' }), event: 'message_updated', status: 'delivered' })).toBeUndefined();
    expect(leerAvisoDeChatwoot({ ...avisoDeMensaje({ id: 1 }), event: 'message_updated', status: 'failed' })).toBeUndefined();
  });

  it('un mensaje del paciente no va marcado como saliente', () => {
    const aviso = leerAvisoDeChatwoot(avisoDeMensaje({ id: 9 }));
    expect(aviso?.tipo === 'mensaje' ? aviso.mensaje.saliente : 'otro').toBeUndefined();
  });

  it.each([
    ['un saliente sin texto (un adjunto del equipo)', avisoDeMensaje({ id: 9, tipo: 'outgoing', texto: null, adjuntos: [{ file_type: 'image' }] })],
    ['una nota privada', avisoDeMensaje({ id: 9, privado: true })],
    ['una nota privada del equipo', avisoDeMensaje({ id: 9, tipo: 'outgoing', privado: true })],
    ['un teléfono que no lo es', avisoDeMensaje({ id: 9, telefono: 'abc' })],
    ['otro evento', { event: 'contact_created', id: 3 }],
    ['algo que no es un objeto', 'hola'],
  ])('%s, no entra', (_n, payload) => {
    expect(leerAvisoDeChatwoot(payload)).toBeUndefined();
  });

  it('una nota de voz sale como audio, para poder pedirle que lo escriba', () => {
    const aviso = leerAvisoDeChatwoot(avisoDeMensaje({ id: 9, texto: null, adjuntos: [{ file_type: 'audio' }] }));
    expect(aviso?.tipo === 'mensaje' ? aviso.mensaje.tipo : undefined).toBe('audio');
  });

  it('si el aviso trae las etiquetas, salen', () => {
    const aviso = leerAvisoDeChatwoot(avisoDeMensaje({ id: 9, etiquetas: ['agente-parado', 'vip'] }));
    expect(aviso?.tipo === 'mensaje' ? aviso.etiquetas : undefined).toEqual(['agente-parado', 'vip']);
  });

  it('un cambio en la conversación trae sus etiquetas y de quién es', () => {
    expect(leerAvisoDeChatwoot(avisoDeConversacion({ etiquetas: ['agente-parado'] }))).toEqual({
      tipo: 'conversacion',
      donde: { cuentaId: CUENTA, inboxId: INBOX, conversacionId: 1001 },
      telefono: '+34600123456',
      nombre: 'Lola',
      etiquetas: ['agente-parado'],
    });
  });
});
