import { EnvioRechazadoError } from '../whatsapp/meta.js';

/**
 * Envío por la API de Chatwoot: un mensaje en una conversación que ya existe.
 * Chatwoot lo manda por WhatsApp, y queda en el mismo hilo que ve el equipo y
 * el móvil de la clínica (coexistencia). Las notas privadas no salen del
 * Chatwoot: son para el equipo.
 *
 * **Lo que esto no ve:** que Chatwoot acepte el mensaje no quiere decir que
 * WhatsApp lo entregue. Fuera de la ventana de 24 h, Meta lo rechaza después,
 * y eso llega como un cambio de estado del mensaje que todavía no miramos.
 */

export interface ChatwootSaliente {
  /** Devuelve el id que le da Chatwoot: así se reconoce su eco cuando Chatwoot avisa de él. */
  enviar(mensaje: {
    cuentaId: number;
    conversacionId: number;
    texto: string;
    privado: boolean;
    plantilla?: { nombre: string; idioma: string; parametros: string[] } | undefined;
  }): Promise<{ id: number | null }>;
  /**
   * Pone o quita una etiqueta sin tocar las demás. La API sólo sabe sustituir
   * la lista entera, así que se lee primero: quitar `agente-parado` no puede
   * llevarse por delante las etiquetas que puso el equipo.
   */
  cambiarEtiqueta(cambio: { cuentaId: number; conversacionId: number; etiqueta: string; poner: boolean }): Promise<void>;
}

export function crearChatwoot(opciones: { url: string; token: string; tiempoLimiteMs?: number }): ChatwootSaliente {
  const base = opciones.url.replace(/\/+$/, '');
  async function llamar(metodo: 'GET' | 'POST', ruta: string, cuerpo?: unknown): Promise<Response> {
    let respuesta: Response;
    try {
      respuesta = await fetch(`${base}/api/v1${ruta}`, {
        method: metodo,
        headers: { api_access_token: opciones.token, 'content-type': 'application/json' },
        ...(cuerpo === undefined ? {} : { body: JSON.stringify(cuerpo) }),
        signal: AbortSignal.timeout(opciones.tiempoLimiteMs ?? 15_000),
      });
    } catch (error: unknown) {
      // Red o tiempo agotado: puede que haya salido o no. Se reintenta.
      throw new EnvioRechazadoError(
        `Chatwoot no responde: ${error instanceof Error ? error.message : String(error)}`,
        false,
        null,
      );
    }
    if (respuesta.ok) return respuesta;

    const detalle = (await respuesta.text().catch(() => '')).slice(0, 300);
    // Un 4xx (conversación que no existe, token sin permiso) no lo arregla
    // reintentar; un 429 o un 5xx, sí.
    const permanente = respuesta.status >= 400 && respuesta.status < 500 && respuesta.status !== 429;
    throw new EnvioRechazadoError(`Chatwoot ha respondido ${respuesta.status}: ${detalle}`, permanente, respuesta.status);
  }

  return {
    async enviar({ cuentaId, conversacionId, texto, privado, plantilla }) {
      const respuesta = await llamar('POST', `/accounts/${cuentaId}/conversations/${conversacionId}/messages`, {
        content: texto,
        message_type: 'outgoing',
        private: privado,
        // Una plantilla de WhatsApp: Chatwoot la busca entre las aprobadas y
        // sincronizadas por nombre e idioma, y pone los valores en {{1}}, {{2}}…
        ...(plantilla === undefined
          ? {}
          : {
              template_params: {
                name: plantilla.nombre,
                language: plantilla.idioma,
                processed_params: { body: Object.fromEntries(plantilla.parametros.map((p, i) => [String(i + 1), p])) },
              },
            }),
      });
      const cuerpo = (await respuesta.json().catch(() => ({}))) as { id?: unknown };
      return { id: typeof cuerpo.id === 'number' ? cuerpo.id : null };
    },

    async cambiarEtiqueta({ cuentaId, conversacionId, etiqueta, poner }) {
      const ruta = `/accounts/${cuentaId}/conversations/${conversacionId}/labels`;
      const actuales = (await (await llamar('GET', ruta)).json().catch(() => ({}))) as { payload?: unknown };
      const lista = Array.isArray(actuales.payload) ? actuales.payload.filter((e): e is string => typeof e === 'string') : [];
      const nuevas = poner ? [...new Set([...lista, etiqueta])] : lista.filter((e) => e !== etiqueta);
      if (nuevas.length === lista.length && nuevas.every((e) => lista.includes(e))) return;
      await llamar('POST', ruta, { labels: nuevas });
    },
  };
}
