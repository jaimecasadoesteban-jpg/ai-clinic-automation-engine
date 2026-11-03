/**
 * Los modelos, con la versión fijada explícitamente.
 *
 * docs/DESIGN_RULES.md exige versión fijada y nunca un alias móvil: si el proveedor mueve
 * un alias, cambian a la vez el coste, la latencia y el comportamiento de todas
 * las clínicas, y el conjunto de evaluación que se pasó ayer deja de decir nada.
 *
 * `claude-haiku-4-5-20251001` lleva la fecha porque existe esa variante.
 * `claude-opus-5` **no tiene variante fechada**: la cadena de abajo es el
 * identificador completo, y añadirle un sufijo de fecha da un 404. Está fijado
 * igual: cambiarlo exige tocar este fichero y volver a pasar `npm run eval`.
 */

/** Etapa 3: clasificar y extraer. Modelo pequeño, salida cerrada. */
export const MODELO_CLASIFICADOR = 'claude-haiku-4-5-20251001' as const;

/** Etapa 4: redactar de cara al paciente. Modelo grande. */
export const MODELO_REDACTOR = 'claude-opus-5' as const;

/**
 * Enrutado en dos niveles. El grande sólo redacta; nunca clasifica ni extrae.
 */
export const MODELOS = {
  clasificador: MODELO_CLASIFICADOR,
  redactor: MODELO_REDACTOR,
  /** El resumen de lo que sale de la ventana: tarea de extracción, no de tono. */
  resumidor: MODELO_CLASIFICADOR,
} as const;

/** Ventana de conversación que se le pasa al modelo: 8 turnos más resumen. */
export const TURNOS_EN_VENTANA = 8;

/**
 * Límites de gasto. Un bucle de herramientas que se llame a sí mismo puede
 * quemar tokens sin parar, así que hay tope por mensaje y tope por conversación:
 * al alcanzarlos se escala en vez de seguir.
 */
export const PRESUPUESTO = {
  /** Llamadas al proveedor permitidas al atender un solo mensaje entrante. */
  llamadasPorMensaje: 4,
  /**
   * Llamadas en una conversación **en las últimas `ventanaHoras`**.
   *
   * Era «en toda la vida de la conversación», y una paciente de meses lo habría
   * agotado: desde ese momento, todo lo que escribiera se escalaba. Lo que el
   * tope tiene que parar es un bucle —un reintento que no acaba, n8n mandando
   * el mismo mensaje con claves nuevas—, y eso quema llamadas en minutos, no en
   * meses. Sesenta en un día son unos treinta turnos: una conversación real
   * cabe de sobra, y un bucle se corta en cuanto empieza.
   *
   * Cuentan todas las llamadas: clasificar, redactar, regenerar y resumir. Antes
   * contaba sólo los mensajes redactados.
   */
  llamadasPorConversacionEnVentana: 60,
  ventanaHoras: 24,
} as const;

/**
 * Tiempos límite y reintentos.
 *
 * El paciente no puede quedarse en silencio porque una API de terceros esté
 * caída, así que los plazos son cortos y los reintentos acotados. El SDK
 * reintenta 408/409/429/5xx y errores de conexión, y **los tiempos límite
 * también se reintentan**: el reloj de pared llega a `tiempoLimite × (reintentos + 1)`.
 * Por eso el presupuesto total está calculado sobre ese producto, no sobre el
 * tiempo límite suelto.
 */
export const TIEMPOS = {
  /** Milisegundos. El SDK de TypeScript usa milisegundos, no segundos. */
  clasificadorMs: 8_000,
  redactorMs: 20_000,
  resumidorMs: 10_000,
  reintentos: 2,
} as const;

/**
 * Precios por millón de tokens, en dólares. **Aproximados y volátiles**: sirven
 * para que el banco de pruebas dé un orden de magnitud del gasto de una sesión,
 * no para facturar. Si el proveedor los cambia, esto queda desfasado en silencio.
 */
export const PRECIOS: Readonly<Record<string, { entrada: number; salida: number }>> = {
  'claude-opus-5': { entrada: 5, salida: 25 },
  'claude-haiku-4-5-20251001': { entrada: 1, salida: 5 },
};

/** Coste aproximado en dólares de una llamada. Devuelve 0 si el modelo no está tarifado. */
export function costeAproximado(modelo: string, entrada: number, salida: number): number {
  const tarifa = PRECIOS[modelo];
  if (tarifa === undefined) return 0;
  return (entrada / 1_000_000) * tarifa.entrada + (salida / 1_000_000) * tarifa.salida;
}
