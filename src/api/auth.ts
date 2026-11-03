import { timingSafeEqual } from 'node:crypto';

import type { App } from './server.js';

/**
 * Autenticación de las llamadas de n8n.
 *
 * El núcleo no se expone a internet, pero eso es una propiedad del despliegue y
 * no del código: una regla de red la puede cambiar alguien sin darse cuenta, y
 * entonces la única barrera desaparece sin que nada falle. Esto no depende del
 * despliegue.
 *
 * Todos los endpoints salvo `/salud` y `/listo`, que tienen que poder responder
 * a un supervisor sin credenciales.
 *
 * Exigirles token los haría inútiles justo para lo que existen: el
 * `HEALTHCHECK` de un contenedor, un balanceador y un monitor externo no deben
 * llevar la llave del sistema, y meterla en un Dockerfile para que el
 * healthcheck pase es peor que no tener healthcheck. Ninguno de los dos revela
 * nada: nombre, versión, hora y si la base contesta.
 */

// `/whatsapp` y `/chatwoot` no pueden llevar nuestro token: Meta y Chatwoot no
// lo tienen. Los protege su firma, que se comprueba en la propia ruta.
const SIN_AUTENTICAR = new Set(['/salud', '/listo', '/whatsapp', '/chatwoot']);

/** Comparación en tiempo constante: comparar con `===` filtra el token carácter a carácter. */
function coincide(recibido: string, esperado: string): boolean {
  const a = Buffer.from(recibido);
  const b = Buffer.from(esperado);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function registrarAutenticacion(app: App, token: string): void {
  app.addHook('onRequest', async (request, reply) => {
    const ruta = request.url.split('?')[0] ?? request.url;
    if (SIN_AUTENTICAR.has(ruta)) return;
    // El panel lo usa un navegador, que no tiene el token: lo protege su propia
    // sesión (ver `routes/panel.ts`).
    if (ruta === '/panel' || ruta.startsWith('/panel/')) return;

    const cabecera = request.headers.authorization;
    const recibido =
      typeof cabecera === 'string' && cabecera.startsWith('Bearer ')
        ? cabecera.slice('Bearer '.length)
        : null;

    if (recibido === null || !coincide(recibido, token)) {
      request.log.warn({ url: request.url }, 'llamada sin autenticar');
      // Sin pistas sobre por qué: falta, está mal, o tiene otra longitud.
      await reply.status(401).send({
        error: 'no_autenticado',
        mensaje: 'Falta la cabecera Authorization o el token no es válido.',
        requestId: request.id,
      });
    }
  });
}
