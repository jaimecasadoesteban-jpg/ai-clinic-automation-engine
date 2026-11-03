import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { Intervalo } from '../../core/disponibilidad.js';
import { AgendaNoDisponibleError } from '../agenda-n8n.js';
import type { Agenda } from '../ports.js';
import type { EscritorDeAgenda, ResultadoDeEscritura } from './escritor.js';

/**
 * Google Calendar desde el núcleo, con el mismo cliente OAuth que usaba n8n.
 *
 * - **Leer** es la misma llamada que hacía el workflow de agenda: `freeBusy`,
 *   ocupación en bruto, sin interpretar (lo interpreta `core/disponibilidad`).
 * - **Escribir** sólo lo hace el ejecutor de la tabla de salida, después del
 *   commit, y por un puerto aparte: `Agenda` sigue siendo de sólo lectura
 *   (regla 3, y un test de convenciones).
 *
 * El permiso es un *refresh token* de la cuenta de Google de la clínica. Con la
 * app publicada no caduca, pero se puede revocar: entonces todo lo que lea
 * falla con `agenda_no_disponible` —el turno contesta, guarda y escala— y lo
 * que escriba degrada a recepción.
 */

export interface OpcionesDeGoogle {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  readonly tiempoLimiteMs?: number;
  /** Para los tests. */
  readonly fetch?: typeof fetch;
}

const API = 'https://www.googleapis.com/calendar/v3';

const tokenSchema = z.object({ access_token: z.string().min(1), expires_in: z.number().positive() });

const freeBusySchema = z.object({
  calendars: z.record(
    z.string(),
    z.object({
      busy: z.array(z.object({ start: z.string(), end: z.string() })).optional(),
      errors: z.array(z.unknown()).optional(),
    }),
  ),
});

/** Un fallo de Google que no es «no está libre»: no sabemos la respuesta. */
export class GoogleError extends Error {
  override readonly name = 'GoogleError';
  constructor(
    message: string,
    /** 4xx que no es 429: reintentar no lo arregla (permiso, calendario inexistente). */
    readonly permanente: boolean,
  ) {
    super(message);
  }
}

/**
 * El id del evento en Google, sacado de la clave de idempotencia: un reintento
 * que intenta crearlo otra vez recibe 409 en vez de crear un segundo. Google
 * exige base32hex (a–v, 0–9); el hexadecimal de un sha256 lo es.
 */
export function idDeEvento(idempotencyKey: string): string {
  return createHash('sha256').update(idempotencyKey).digest('hex');
}

function crearCliente(opciones: OpcionesDeGoogle) {
  const pedirHttp = opciones.fetch ?? fetch;
  const limite = opciones.tiempoLimiteMs ?? 8_000;
  let token: { valor: string; caduca: number } | undefined;

  async function accessToken(): Promise<string> {
    if (token !== undefined && token.caduca > Date.now()) return token.valor;
    let respuesta: Response;
    try {
      respuesta = await pedirHttp('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: opciones.clientId,
          client_secret: opciones.clientSecret,
          refresh_token: opciones.refreshToken,
        }).toString(),
        signal: AbortSignal.timeout(limite),
      });
    } catch (error: unknown) {
      throw new GoogleError(`Google no responde al renovar el token: ${mensaje(error)}`, false);
    }
    if (!respuesta.ok) {
      // 400 invalid_grant: el permiso se revocó. No se arregla reintentando.
      const detalle = (await respuesta.text().catch(() => '')).slice(0, 200);
      throw new GoogleError(`Google no renueva el token (${respuesta.status}): ${detalle}`, respuesta.status < 500);
    }
    const datos = tokenSchema.parse(await respuesta.json());
    // Un minuto de margen: un token que caduca en vuelo es un 401 tonto.
    token = { valor: datos.access_token, caduca: Date.now() + (datos.expires_in - 60) * 1000 };
    return token.valor;
  }

  async function llamar(metodo: 'GET' | 'POST', ruta: string, cuerpo?: unknown): Promise<Response> {
    const autorizacion = `Bearer ${await accessToken()}`;
    try {
      return await pedirHttp(`${API}${ruta}`, {
        method: metodo,
        headers: { authorization: autorizacion, 'content-type': 'application/json' },
        ...(cuerpo === undefined ? {} : { body: JSON.stringify(cuerpo) }),
        signal: AbortSignal.timeout(limite),
      });
    } catch (error: unknown) {
      throw new GoogleError(`Google Calendar no responde: ${mensaje(error)}`, false);
    }
  }

  /**
   * Lo ocupado de un calendario en un rango. **Si el calendario no existe o no
   * está compartido, Google no falla**: devuelve `errors` y nada ocupado. Leerlo
   * como «todo libre» propondría citas encima de una agenda llena; es el fallo
   * silencioso más caro de esta integración, y ya lo vigilaba el workflow.
   */
  async function ocupado(calendarioId: string, desde: Date, hasta: Date): Promise<Intervalo[]> {
    const respuesta = await llamar('POST', '/freeBusy', {
      timeMin: desde.toISOString(),
      timeMax: hasta.toISOString(),
      items: [{ id: calendarioId }],
    });
    if (!respuesta.ok) {
      throw new GoogleError(`freeBusy ha respondido ${respuesta.status}`, respuesta.status < 500 && respuesta.status !== 429);
    }
    const datos = freeBusySchema.safeParse(await respuesta.json());
    if (!datos.success) throw new GoogleError('freeBusy ha devuelto algo que no cumple su esquema', false);
    const calendario = datos.data.calendars[calendarioId];
    if (calendario === undefined) throw new GoogleError(`Google no ha devuelto el calendario ${calendarioId}`, true);
    if (calendario.errors !== undefined && calendario.errors.length > 0) {
      throw new GoogleError(`Google devuelve errores para el calendario: ${JSON.stringify(calendario.errors)}`, true);
    }
    return (calendario.busy ?? []).map((b) => ({ inicio: new Date(b.start), fin: new Date(b.end) }));
  }

  return { llamar, ocupado };
}

/** El puerto de lectura. Un fallo de Google aquí es una agenda no disponible. */
export function crearAgendaGoogle(opciones: OpcionesDeGoogle): Agenda {
  const google = crearCliente(opciones);
  const comoAgendaCaida = async <T>(f: () => Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (error: unknown) {
      throw new AgendaNoDisponibleError(`No se ha podido consultar la agenda: ${mensaje(error)}`);
    }
  };
  return {
    ocupacion: (entrada) => comoAgendaCaida(() => google.ocupado(entrada.calendarioId, entrada.desde, entrada.hasta)),
    sigueLibre: (entrada) =>
      comoAgendaCaida(async () => {
        const ocupado = await google.ocupado(entrada.calendarioId, entrada.inicio, entrada.fin);
        // Solape estricto, la misma semántica que el núcleo: dos citas que se
        // tocan (10:00–10:20 y 10:20–10:40) no chocan.
        return !ocupado.some((b) => b.inicio < entrada.fin && entrada.inicio < b.fin);
      }),
  };
}

/** El puerto de escritura. Sólo lo usa el ejecutor de la tabla de salida. */
export function crearEscritorGoogle(opciones: OpcionesDeGoogle): EscritorDeAgenda {
  const google = crearCliente(opciones);
  return {
    async crear(evento): Promise<ResultadoDeEscritura> {
      const id = idDeEvento(evento.idempotencyKey);
      const inicio = new Date(evento.inicio);
      const fin = new Date(evento.fin);

      let ocupado: Intervalo[];
      try {
        ocupado = await google.ocupado(evento.calendarioId, inicio, fin);
      } catch (error: unknown) {
        return { creado: false, motivo: error instanceof GoogleError && error.permanente ? 'rechazado' : 'error', detalle: mensaje(error) };
      }

      if (ocupado.some((b) => b.inicio < fin && inicio < b.fin)) {
        // ¿Lo ocupa nuestro propio evento, de un intento anterior que sí llegó
        // a crearse? Entonces está creado, no es una colisión.
        const existente = await google.llamar('GET', `/calendars/${encodeURIComponent(evento.calendarioId)}/events/${id}`).catch(() => undefined);
        if (existente?.ok === true) {
          const datos = (await existente.json().catch(() => ({}))) as { status?: string };
          if (datos.status !== 'cancelled') return { creado: true, eventoId: id };
        }
        return { creado: false, motivo: 'ocupado', detalle: 'el hueco ya está ocupado en la agenda' };
      }

      let respuesta: Response;
      try {
        respuesta = await google.llamar('POST', `/calendars/${encodeURIComponent(evento.calendarioId)}/events`, {
          id,
          summary: evento.resumen,
          description: evento.descripcion,
          start: { dateTime: inicio.toISOString() },
          end: { dateTime: fin.toISOString() },
        });
      } catch (error: unknown) {
        // Pudo crearse o no: no lo sabemos, y eso lo decide una persona.
        return { creado: false, motivo: 'error', detalle: mensaje(error) };
      }
      // 409: ya existe con ese id. Lo creó un intento anterior: está creado.
      if (respuesta.ok || respuesta.status === 409) return { creado: true, eventoId: id };

      const detalle = `Google ha respondido ${respuesta.status}: ${(await respuesta.text().catch(() => '')).slice(0, 200)}`;
      return {
        creado: false,
        motivo: respuesta.status < 500 && respuesta.status !== 429 ? 'rechazado' : 'error',
        detalle,
      };
    },
  };
}

function mensaje(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
