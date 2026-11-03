import { createHash } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';

import type { Tx } from '../db/client.js';
import { idempotencyKeys } from '../db/schema.js';
import { DomainError } from '../core/errors.js';

/**
 * Idempotencia real: se guarda la respuesta, no sólo la marca de «ya visto».
 *
 * Meta reintenta los webhooks. Sin guardar la respuesta, el reintento recibiría
 * un error donde la primera vez hubo un éxito — y, peor, si sólo se comprobara
 * la existencia de la clave sin haber escrito nada todavía, dos entregas
 * simultáneas crearían dos citas.
 *
 * La protección de fondo es la restricción `idempotency_keys_unico`: la segunda
 * ejecución concurrente falla en Postgres, no en un `if`.
 */

export class ClaveReutilizadaError extends DomainError {
  readonly code = 'idempotency_key_reutilizada';
  readonly httpStatus = 409;

  constructor(readonly clave: string) {
    super(
      `La clave de idempotencia «${clave}» ya se usó con un cuerpo distinto. ` +
        'Reutilizarla con otro contenido es un error de quien llama.',
    );
  }
}

export function hashDePeticion(cuerpo: unknown): string {
  return createHash('sha256').update(JSON.stringify(cuerpo)).digest('hex');
}

export interface RespuestaGuardada {
  readonly statusCode: number;
  readonly cuerpo: unknown;
}

/** La respuesta anterior si esta clave ya se procesó. */
export async function respuestaPrevia(
  clientId: string,
  tx: Tx,
  clave: string,
  hash: string,
): Promise<RespuestaGuardada | undefined> {
  const filas = await tx
    .select()
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.clientId, clientId), eq(idempotencyKeys.key, clave)))
    .limit(1);

  const fila = filas[0];
  if (fila === undefined) return undefined;

  if (fila.requestHash !== hash) throw new ClaveReutilizadaError(clave);

  return { statusCode: fila.statusCode, cuerpo: fila.response };
}

export async function guardarRespuesta(
  clientId: string,
  tx: Tx,
  datos: {
    clave: string;
    endpoint: string;
    hash: string;
    statusCode: number;
    cuerpo: unknown;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into motor.idempotency_keys
      (client_id, key, endpoint, request_hash, status_code, response, purge_at)
    values (
      ${clientId}, ${datos.clave}, ${datos.endpoint}, ${datos.hash},
      ${datos.statusCode}, ${JSON.stringify(datos.cuerpo)}::jsonb, now()
    )
  `);
}
