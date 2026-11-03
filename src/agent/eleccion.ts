import { extraerDias, extraerHoras } from './output-validation.js';

/**
 * **Lo que eligió lo dice su mensaje, no el número que ponga el clasificador.**
 *
 * El clasificador extrae bien el número y la hora cuando están: «la segunda»,
 * «a las 10:20». Cuando no están, a veces se los inventa. Ante «Gracias», con
 * tres horas propuestas en un mensaje que no acababa en pregunta, devolvió
 * `elegir_hueco` con `opcion: 1`, y el sistema retuvo el martes 20 a las 10:00
 * y le contestó «te reservo el hueco». Es la regla «nada se elige sobre una
 * suposición», rota por dentro: la suposición la hacía el modelo pequeño.
 *
 * Así que el número o la hora del clasificador sólo valen si el mensaje tiene
 * algo que los ancle: una cifra, un ordinal, un día o una hora. Si no lo tiene,
 * no se sabe cuál quiere, y se pregunta. Preguntar cuesta un turno.
 */

function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

/** «la primera», «el segundo», «la última», «opción 3», «la 2». */
const ORDINAL_O_NUMERO =
  /\b(primer[oa]?|segund[oa]|tercer[oa]?|ultim[oa]|opcion\s*\d|la\s+\d\b|el\s+\d\b|^\s*\d\s*$|\d\s*(a|o|ª|º)\b)/;

/** Aceptar lo único que hay: «vale», «sí», «perfecto», «esa», «me va bien». */
const AFIRMA =
  /^(?:\s*(si|vale|ok|okay|perfect[oa]|genial|estupendo|de acuerdo|claro|adelante|venga|dale|esa|ese|me va bien|me viene bien|me sirve|me cuadra|me quedo|me la quedo|reservamela|cogela|apuntamela)\b)/;

export interface AnclaDeEleccion {
  /** Hay en el mensaje algo que puede señalar una opción concreta. */
  readonly senala: boolean;
  /** Nombra una hora: sólo así vale la hora que extrajo el clasificador. */
  readonly nombraHora: boolean;
  /** Empieza aceptando: con una sola opción delante, eso la elige. */
  readonly afirma: boolean;
}

export function anclaDeEleccion(texto: string): AnclaDeEleccion {
  const t = normalizar(texto);
  const nombraHora = extraerHoras(texto).length > 0;
  return {
    senala: nombraHora || extraerDias(texto).length > 0 || ORDINAL_O_NUMERO.test(t),
    nombraHora,
    afirma: AFIRMA.test(t),
  };
}
