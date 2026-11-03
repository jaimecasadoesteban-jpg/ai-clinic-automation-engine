import type { ClienteConfig } from '../config/cliente.js';
import type { PatientRow } from '../db/queries.js';

/**
 * Qué se escribe en el evento de la agenda de la clínica, en modo `automatica`.
 *
 * ## Por qué esto NO es `toPromptPatient`
 *
 * Son dos fronteras distintas con dos criterios distintos, y se parecen lo justo
 * para confundirlas — de hecho se confundieron en la primera versión de esto, y
 * el resultado era que recepción abría la agenda el lunes y leía «Limpieza
 * facial — pac_8371»: un evento sin valor operativo, sin saber a quién llamar
 * para mover la cita ni a quién esperar.
 *
 * - **La frontera del prompt** existe porque el modelo es **un tercero**. Ahí la
 *   minimización es obligatoria y el criterio es dar lo mínimo que permita
 *   conversar: nombre de pila y una referencia interna. Eso no se toca.
 * - **El evento va a la agenda de la clínica**, que es la **responsable del
 *   tratamiento** y ya tiene a ese paciente en su ficha con nombre completo y
 *   teléfono. Escribirle un identificador interno no protege a nadie: le quita
 *   utilidad a su propia agenda.
 *
 * **Van en funciones separadas a propósito.** Compartirlas haría que ajustar una
 * moviera la otra sin querer, y la del prompt es la que no puede moverse.
 *
 * Qué se escribe lo decide la clínica con los marcadores de su YAML (regla 7):
 * una recepción con la pantalla a la vista del público puede querer sólo `{ref}`,
 * y ésa es su decisión, no nuestra.
 */

/** Los marcadores que admiten `tituloDelEvento` y `descripcionDelEvento`. */
export const MARCADORES_DEL_EVENTO = [
  '{servicio}',
  '{nombre}',
  '{apellidos}',
  '{nombreCompleto}',
  '{telefono}',
  '{ref}',
] as const;

export interface EventoDeAgenda {
  readonly resumen: string;
  readonly descripcion: string;
}

/**
 * Compone el título y la descripción del evento.
 *
 * Recibe la fila completa del paciente **a propósito**: aquí sí puede entrar el
 * teléfono, y que el tipo lo transporte es la diferencia con la frontera del
 * prompt, donde el tipo no lo transporta y por eso no puede colarse.
 */
export function componerEvento(entrada: {
  readonly config: ClienteConfig;
  readonly paciente: PatientRow;
  /** Nombre del servicio tal como lo lee una persona, no el código. */
  readonly servicio: string;
}): EventoDeAgenda {
  const { config, paciente, servicio } = entrada;
  const apellidos = paciente.familyName ?? '';
  const completo = apellidos === '' ? paciente.givenName : `${paciente.givenName} ${apellidos}`;

  const rellenar = (plantilla: string): string =>
    plantilla
      .replaceAll('{servicio}', servicio)
      .replaceAll('{nombreCompleto}', completo)
      .replaceAll('{nombre}', paciente.givenName)
      .replaceAll('{apellidos}', apellidos)
      .replaceAll('{telefono}', paciente.phoneE164)
      // `publicRef` es columna generada; en la práctica nunca falta.
      .replaceAll('{ref}', paciente.publicRef ?? '')
      .trim();

  return {
    resumen: rellenar(config.agenda.tituloDelEvento),
    descripcion: rellenar(config.agenda.descripcionDelEvento),
  };
}
