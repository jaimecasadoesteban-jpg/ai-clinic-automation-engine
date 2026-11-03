import { afterEach, describe, expect, it, vi } from 'vitest';

import { crearChatwoot } from '../../src/service/chatwoot/api.js';

/**
 * Lo que se le manda a la API de Chatwoot. La forma de `template_params` sale
 * de su código (`Whatsapp::TemplateProcessorService`): `name`, `language` y
 * `processed_params.body` con los valores por posición, «1», «2»…
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

function capturar(respuesta: unknown = { id: 777 }) {
  const peticiones: Array<{ url: string; cuerpo: Record<string, unknown> }> = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    peticiones.push({ url, cuerpo: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    return new Response(JSON.stringify(respuesta), { status: 200 });
  });
  return peticiones;
}

describe('enviar por la API de Chatwoot', () => {
  it('un texto: mensaje saliente, y devuelve el id que le da Chatwoot (para reconocer su eco)', async () => {
    const peticiones = capturar();

    const r = await crearChatwoot({ url: 'https://app.chatwoot.com/', token: 't' }).enviar({ cuentaId: 7, conversacionId: 9, texto: 'hola', privado: false });

    expect(r).toEqual({ id: 777 });
    expect(peticiones[0]?.url).toBe('https://app.chatwoot.com/api/v1/accounts/7/conversations/9/messages');
    expect(peticiones[0]?.cuerpo).toEqual({ content: 'hola', message_type: 'outgoing', private: false });
  });

  it('una plantilla: template_params con nombre, idioma y los valores por posición', async () => {
    const peticiones = capturar();

    await crearChatwoot({ url: 'https://app.chatwoot.com', token: 't' }).enviar({
      cuentaId: 7,
      conversacionId: 9,
      texto: 'Hola Lola, te recordamos…',
      privado: false,
      plantilla: { nombre: 'recordatorio_cita', idioma: 'es', parametros: ['Lola', 'Láser axilas', 'martes 20 a las 10:00'] },
    });

    expect(peticiones[0]?.cuerpo['template_params']).toEqual({
      name: 'recordatorio_cita',
      language: 'es',
      processed_params: { body: { '1': 'Lola', '2': 'Láser axilas', '3': 'martes 20 a las 10:00' } },
    });
  });
});
