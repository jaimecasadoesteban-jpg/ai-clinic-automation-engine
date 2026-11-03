import { z } from 'zod';

import { DomainError } from '../core/errors.js';
import type { Intervalo } from '../core/disponibilidad.js';
import type { Agenda } from './ports.js';

/**
 * La agenda de la clínica, leída a través de n8n.
 *
 * El núcleo no habla con Google Calendar ni con el programa de la clínica: le
 * pregunta a n8n, que ya tiene los conectores. **Sólo lectura y sólo
 * ocupado/libre** (regla 3) — aquí no hay ni habrá un método que escriba.
 */

export class AgendaNoDisponibleError extends DomainError {
  readonly code = 'agenda_no_disponible';
  readonly httpStatus = 503;
  override readonly patientMessage =
    'Ahora mismo no consigo ver la agenda. Escríbeme en un rato y te busco hueco.';
}

const ocupacionSchema = z.object({
  ocupado: z.array(z.object({ inicio: z.iso.datetime(), fin: z.iso.datetime() })),
});

const libreSchema = z.object({ libre: z.boolean() });

export interface OpcionesDeAgenda {
  /** URL base de los webhooks de n8n que exponen la agenda. */
  readonly baseUrl: string;
  readonly token: string;
  readonly tiempoLimiteMs?: number;
}

async function pedir(opciones: OpcionesDeAgenda, ruta: string, cuerpo: unknown): Promise<unknown> {
  const control = AbortSignal.timeout(opciones.tiempoLimiteMs ?? 10_000);
  let respuesta: Response;
  try {
    respuesta = await fetch(new URL(ruta, opciones.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${opciones.token}`,
      },
      body: JSON.stringify(cuerpo),
      signal: control,
    });
  } catch (error: unknown) {
    throw new AgendaNoDisponibleError(
      `No se ha podido consultar la agenda: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!respuesta.ok) {
    throw new AgendaNoDisponibleError(`La agenda ha respondido ${respuesta.status}.`);
  }
  return respuesta.json();
}

export function crearAgendaN8n(opciones: OpcionesDeAgenda): Agenda {
  return {
    async ocupacion(entrada): Promise<readonly Intervalo[]> {
      const crudo = await pedir(opciones, 'ocupacion', {
        clientId: entrada.clientId,
        calendarioId: entrada.calendarioId,
        desde: entrada.desde.toISOString(),
        hasta: entrada.hasta.toISOString(),
      });

      const datos = ocupacionSchema.safeParse(crudo);
      if (!datos.success) {
        throw new AgendaNoDisponibleError('La agenda ha devuelto algo que no cumple su esquema.');
      }
      return datos.data.ocupado.map((h) => ({ inicio: new Date(h.inicio), fin: new Date(h.fin) }));
    },

    async sigueLibre(entrada): Promise<boolean> {
      const crudo = await pedir(opciones, 'hueco-libre', {
        clientId: entrada.clientId,
        calendarioId: entrada.calendarioId,
        inicio: entrada.inicio.toISOString(),
        fin: entrada.fin.toISOString(),
      });

      const datos = libreSchema.safeParse(crudo);
      if (!datos.success) {
        // Ante la duda, el hueco NO está libre: confirmar sobre una respuesta
        // que no se entiende es exactamente lo que el paso 6 quiere evitar.
        throw new AgendaNoDisponibleError('La agenda ha devuelto algo que no cumple su esquema.');
      }
      return datos.data.libre;
    },
  };
}
