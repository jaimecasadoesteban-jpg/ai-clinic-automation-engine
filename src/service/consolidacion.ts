import { sql } from 'drizzle-orm';

import { DomainError } from '../core/errors.js';
import { resolverCliente } from './contexto.js';
import type { Dependencias } from './pipeline.js';

/**
 * Consolidación de `period_metrics`.
 *
 * `period_metrics` es lo único que sobrevive al borrado del detalle a los 24
 * meses: cifras por periodo, **sin `patient_id`**. Y la purga sólo borra el
 * detalle de periodos ya consolidados, así que hasta que esto existió no se
 * consolidaba ninguno y la purga no borraba nada. El lado seguro —nunca se
 * destruyó la base de una factura emitida— pero el detalle se acumulaba
 * indefinidamente, que es responsabilidad sobre datos de salud que ya no
 * aportan valor.
 *
 * **Consolidar primero, borrar después.** El orden no es de comodidad: al revés
 * se destruye el detalle de un periodo cuya factura ya se emitió y no queda con
 * qué reconstruirla.
 *
 * Es idempotente: volver a consolidar un periodo recalcula sus cifras. Por eso
 * se puede reprocesar un mes sin miedo, y por eso el cron mensual puede
 * solaparse consigo mismo sin romper nada.
 *
 * La cuenta la hace `motor.consolidar_periodo` en SQL, no aquí: recorrer meses
 * de citas trayéndolos a Node para contarlos es traer datos de salud a memoria
 * para nada.
 */

export class PeriodoInvalidoError extends DomainError {
  readonly code = 'periodo_invalido';
  readonly httpStatus = 400;
}

/** El periodo es un mes natural, `YYYY-MM`. */
const PERIODO = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface EntradaDeConsolidacion {
  readonly clientId: string;
  /** Mes a consolidar, `YYYY-MM`. Si falta, el mes anterior al de hoy. */
  readonly periodo?: string;
}

export interface SalidaDeConsolidacion {
  readonly clientId: string;
  readonly periodo: string;
  readonly citasGeneradas: number;
  readonly huecosPropuestos: number;
  readonly conversaciones: number;
  readonly noShows: number;
}

/** El mes anterior al de `ahora`, en hora UTC. */
export function mesAnterior(ahora: Date): string {
  const anterior = new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth() - 1, 1));
  return `${anterior.getUTCFullYear()}-${String(anterior.getUTCMonth() + 1).padStart(2, '0')}`;
}

export async function consolidarPeriodo(
  deps: Dependencias,
  entrada: EntradaDeConsolidacion,
): Promise<SalidaDeConsolidacion> {
  const periodo = entrada.periodo ?? mesAnterior(deps.reloj());

  // El periodo entra en una consulta a la que la función SQL le da formato de
  // fecha. Se valida aquí además de en SQL: un mes mal escrito tiene que ser un
  // 400 con un mensaje legible, no un error de Postgres a mitad de un cron.
  if (!PERIODO.test(periodo)) {
    throw new PeriodoInvalidoError(`El periodo tiene que ser YYYY-MM, y ha llegado «${periodo}».`);
  }

  return deps.core.withClient(entrada.clientId, async (tx) => {
    await resolverCliente(entrada.clientId, tx, deps.configuracion);

    const filas = await tx.execute<{
      res_citas_generadas: number;
      res_huecos_propuestos: number;
      res_conversaciones: number;
      res_no_shows: number;
    }>(sql`select * from motor.consolidar_periodo(${entrada.clientId}::uuid, ${periodo})`);

    const fila = filas[0];
    if (fila === undefined) {
      // No debería ocurrir: la función inserta y devuelve. Si ocurre, es que
      // alguien la ha cambiado, y callar aquí dejaría la purga sin su condición.
      throw new PeriodoInvalidoError(`La consolidación de ${periodo} no ha devuelto cifras.`);
    }

    return {
      clientId: entrada.clientId,
      periodo,
      citasGeneradas: Number(fila.res_citas_generadas),
      huecosPropuestos: Number(fila.res_huecos_propuestos),
      conversaciones: Number(fila.res_conversaciones),
      noShows: Number(fila.res_no_shows),
    };
  });
}
