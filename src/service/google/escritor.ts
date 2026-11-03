import type { CargaDeEvento } from '../../db/schema.js';

/**
 * El puerto que **sí** escribe en la agenda de la clínica, y por eso no es
 * `Agenda`: ése es de sólo lectura y un test de convenciones lo vigila. Éste lo
 * usa sólo el ejecutor de la tabla de salida, después del commit del turno
 * (regla 3).
 *
 * **Nunca lanza.** Devuelve uno de los tres resultados que distingue la máquina
 * de estados, porque la distinción manda: `ocupado` es una colisión de verdad y
 * se pasa a la segunda opción; `rechazado` y `error` significan que no sabemos
 * si el evento existe, y lo comprueba una persona.
 */
export type ResultadoDeEscritura =
  | { readonly creado: true; readonly eventoId: string }
  | { readonly creado: false; readonly motivo: 'ocupado' | 'rechazado' | 'error'; readonly detalle: string };

export interface EscritorDeAgenda {
  crear(evento: CargaDeEvento): Promise<ResultadoDeEscritura>;
}
