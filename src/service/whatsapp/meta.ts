/**
 * Envío de WhatsApp por la Cloud API de Meta. Sólo texto: es lo único que manda
 * el núcleo hoy. Las plantillas (para escribir fuera de la ventana de 24 h)
 * llegarán cuando haga falta; mientras, ese caso es un fallo permanente que
 * avisa al operador.
 */

export interface WhatsAppSaliente {
  enviarTexto(mensaje: { remitenteId: string; para: string; texto: string }): Promise<void>;
}

/**
 * Un envío que Meta rechazó. `permanente` decide si se reintenta: reintentar un
 * número inválido o un mensaje fuera de la ventana de 24 h no lo arregla, y
 * tirar de reintentos ocho veces sólo retrasa el aviso al operador.
 */
export class EnvioRechazadoError extends Error {
  override readonly name = 'EnvioRechazadoError';
  constructor(
    message: string,
    readonly permanente: boolean,
    readonly codigo: number | null,
  ) {
    super(message);
  }
}

/** 131047: fuera de la ventana de 24 h. 131026: no se puede entregar. 131030/131021: número no válido. */
const CODIGOS_PERMANENTES = new Set([131047, 131026, 131030, 131021, 131051, 131008, 100]);

export function crearWhatsAppMeta(opciones: {
  token: string;
  versionGraph: string;
  tiempoLimiteMs?: number;
}): WhatsAppSaliente {
  return {
    async enviarTexto({ remitenteId, para, texto }) {
      let respuesta: Response;
      try {
        respuesta = await fetch(`https://graph.facebook.com/${opciones.versionGraph}/${remitenteId}/messages`, {
          method: 'POST',
          headers: { authorization: `Bearer ${opciones.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: para.replace(/^\+/, ''),
            type: 'text',
            text: { preview_url: false, body: texto },
          }),
          signal: AbortSignal.timeout(opciones.tiempoLimiteMs ?? 15_000),
        });
      } catch (error: unknown) {
        // Red o tiempo agotado: puede que haya salido o no. Se reintenta.
        throw new EnvioRechazadoError(
          `Meta no responde: ${error instanceof Error ? error.message : String(error)}`,
          false,
          null,
        );
      }
      if (respuesta.ok) return;

      const cuerpo = (await respuesta.json().catch(() => ({}))) as {
        error?: { code?: number; message?: string; error_data?: { details?: string } };
      };
      const codigo = cuerpo.error?.code ?? null;
      const detalle = cuerpo.error?.error_data?.details ?? cuerpo.error?.message ?? '';
      const permanente =
        (codigo !== null && CODIGOS_PERMANENTES.has(codigo)) ||
        (respuesta.status >= 400 && respuesta.status < 500 && respuesta.status !== 429);
      throw new EnvioRechazadoError(`Meta ha respondido ${respuesta.status} (${codigo ?? '?'}): ${detalle}`, permanente, codigo);
    },
  };
}
