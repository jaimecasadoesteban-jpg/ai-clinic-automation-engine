import { DIAS, HORAS_DE_FRANJA, type Dia, type Preferencia } from './extraccion.js';

/**
 * Filtrado de huecos por la preferencia del paciente. Determinista: el modelo
 * extrae la preferencia, el código la aplica.
 */

export interface HuecoConHora {
  readonly inicio: Date;
  readonly fin: Date;
}

const ORDEN_DE_DIAS: readonly Dia[] = [
  'domingo',
  'lunes',
  'martes',
  'miercoles',
  'jueves',
  'viernes',
  'sabado',
];

const ABREVIATURAS_EN = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function partesLocales(
  fecha: Date,
  zonaHoraria: string,
): { dia: Dia; horas: number; minutos: number; fecha: string } {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: zonaHoraria,
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(fecha).map((x) => [x.type, x.value]));

  const abreviatura = String(p['weekday'] ?? '').toLowerCase().slice(0, 3);
  const indice = ABREVIATURAS_EN.indexOf(abreviatura);
  const horas = Number(p['hour']);

  return {
    dia: ORDEN_DE_DIAS[indice === -1 ? 0 : indice] ?? 'domingo',
    horas: horas === 24 ? 0 : horas,
    minutos: Number(p['minute']),
    fecha: `${String(p['year'])}-${String(p['month'])}-${String(p['day'])}`,
  };
}

export interface ResultadoDelFiltro {
  readonly huecos: HuecoConHora[];
  /**
   * `true` cuando había preferencia pero ningún hueco la cumplía. El mensaje al
   * paciente tiene que decirlo: proponerle otra hora sin avisar sería mentirle
   * sobre lo que se le ha buscado.
   */
  readonly preferenciaNoSatisfecha: boolean;
}

export function filtrarPorPreferencia(
  huecos: readonly HuecoConHora[],
  preferencia: Preferencia | null,
  zonaHoraria: string,
): ResultadoDelFiltro {
  if (preferencia === null) return { huecos: [...huecos], preferenciaNoSatisfecha: false };

  const filtrados = huecos.filter((hueco) => {
    const { dia, horas, fecha } = partesLocales(hueco.inicio, zonaHoraria);

    if (preferencia.diasExcluidos.includes(dia)) return false;
    if (preferencia.dias.length > 0 && !preferencia.dias.includes(dia)) return false;
    if (preferencia.desde !== null && fecha < preferencia.desde) return false;
    if (preferencia.franjas.length > 0) {
      const encaja = preferencia.franjas.some((franja) => {
        const [desde, hasta] = HORAS_DE_FRANJA[franja];
        return horas >= desde && horas < hasta;
      });
      if (!encaja) return false;
    }
    return true;
  });

  /**
   * Hora exacta: «¿podría ser a las 10:45?».
   *
   * No filtra a cero, ORDENA. Si esa hora existe sale la primera; si no existe,
   * salen las más cercanas — que es lo que responde una recepcionista, no un
   * «no puedo, te paso con una persona». Y se marca como no satisfecha para que
   * el mensaje reconozca que no es justo la hora que pidió.
   */
  if (preferencia.horaExacta !== null && filtrados.length > 0) {
    const [h, m] = preferencia.horaExacta.split(':').map(Number);
    const objetivo = (h ?? 0) * 60 + (m ?? 0);
    const distancia = (hueco: HuecoConHora): number => {
      const { horas, minutos } = partesLocales(hueco.inicio, zonaHoraria);
      return Math.abs(horas * 60 + minutos - objetivo);
    };

    const ordenados = [...filtrados].sort((a, b) => {
      const d = distancia(a) - distancia(b);
      return d !== 0 ? d : a.inicio.getTime() - b.inicio.getTime();
    });
    const exacto = distancia(ordenados[0]!) === 0;

    return { huecos: ordenados, preferenciaNoSatisfecha: !exacto };
  }

  // `cuantoAntes` no filtra: los huecos ya vienen ordenados por proximidad.
  if (filtrados.length > 0) return { huecos: filtrados, preferenciaNoSatisfecha: false };

  // Ni un hueco cumple lo que pidió. Se le proponen los primeros disponibles,
  // pero el mensaje tiene que reconocer que no son los que pedía.
  return { huecos: [...huecos], preferenciaNoSatisfecha: true };
}

/** Descripción de la preferencia, para que el redactor pueda referirse a ella. */
export function describirPreferencia(preferencia: Preferencia | null): string | null {
  if (preferencia === null) return null;

  const partes: string[] = [];
  if (preferencia.cuantoAntes) partes.push('lo antes posible');
  if (preferencia.dias.length > 0) partes.push(preferencia.dias.join(' o '));
  if (preferencia.diasExcluidos.length > 0) {
    partes.push(`no puede: ${preferencia.diasExcluidos.join(', ')}`);
  }
  if (preferencia.franjas.length > 0) partes.push(preferencia.franjas.join(' o '));
  if (preferencia.desde !== null) partes.push(`a partir del ${preferencia.desde}`);
  if (preferencia.horaExacta !== null) partes.push(`pidió las ${preferencia.horaExacta}`);

  return partes.length === 0 ? null : partes.join('; ');
}

export { DIAS };

/** Cómo se reparten las tres opciones. Sale del YAML de cada clínica. */
export type RepartoDeHuecos = 'cercania' | 'fidelidad';

export interface Propuestas {
  readonly huecos: HuecoConHora[];
  readonly preferenciaNoSatisfecha: boolean;
  /**
   * `true` si la 2ª o la 3ª se apartan de lo que pidió. **El mensaje tiene que
   * decirlo**: ofrecer un jueves a quien pidió martes sin avisar es hacerle
   * creer que le hemos buscado martes y no había.
   */
  readonly alternativasAlejadas: boolean;
}

/** Misma combinación de día de la semana y hora: «el martes a las 12», otra vez. */
function mismaRanura(a: HuecoConHora, b: HuecoConHora, zonaHoraria: string): boolean {
  const x = partesLocales(a.inicio, zonaHoraria);
  const y = partesLocales(b.inicio, zonaHoraria);
  return x.dia === y.dia && x.horas === y.horas && x.minutos === y.minutos;
}

/**
 * Las tres opciones que se le ofrecen.
 *
 * **El problema que lo trae:** ante «martes a las 12» se ofrecían martes 18,
 * martes 25 y martes 1 — la misma hora tres semanas seguidas. Es correcto
 * respecto a lo pedido y flojo como propuesta: son tres veces la misma opción, y
 * nadie quiere depilarse dentro de tres semanas. La clínica quiere llenar esta
 * semana.
 *
 * El reparto: **la primera respeta la preferencia lo más fielmente posible; la
 * segunda y la tercera priorizan cercanía en el tiempo**, aunque se alejen algo
 * de lo pedido, y nunca repiten la ranura de una ya elegida.
 *
 * Tres cosas que NO se relajan nunca:
 * - `diasExcluidos`. «Los lunes no puedo» es una imposibilidad, no un gusto, y
 *   ofrecerle un lunes es ruido que además le dice que no le escuchamos.
 * - La primera opción, que siempre es la más fiel disponible.
 * - Las reglas del núcleo. Esto ordena entre huecos ya proponibles; no inventa.
 */
export function elegirPropuestas(
  disponibles: readonly HuecoConHora[],
  preferencia: Preferencia | null,
  zonaHoraria: string,
  opciones: { readonly cuantos: number; readonly reparto: RepartoDeHuecos },
): Propuestas {
  // `diasExcluidos` se aplica siempre, también a las alternativas.
  const admisibles =
    preferencia === null || preferencia.diasExcluidos.length === 0
      ? [...disponibles]
      : disponibles.filter(
          (h) => !preferencia.diasExcluidos.includes(partesLocales(h.inicio, zonaHoraria).dia),
        );

  const filtrado = filtrarPorPreferencia(admisibles, preferencia, zonaHoraria);
  const fieles = filtrado.huecos;

  const elegidos: HuecoConHora[] = [];
  const primera = fieles[0] ?? admisibles[0];
  if (primera !== undefined) elegidos.push(primera);

  const candidatos =
    opciones.reparto === 'fidelidad'
      ? fieles
      : // Por proximidad: `admisibles` ya viene ordenado de más próximo a más
        // lejano desde el núcleo.
        admisibles;

  for (const candidato of candidatos) {
    if (elegidos.length >= opciones.cuantos) break;
    /**
     * La regla de no repetir ranura es de `cercania` y sólo de ahí. En
     * `fidelidad`, ofrecer la misma hora en semanas sucesivas **es lo que se
     * pide**: una clínica con agenda rígida prefiere eso a mandar al paciente a
     * un día que ya dijo que no quería.
     */
    const repetido =
      elegidos.some((e) => e.inicio.getTime() === candidato.inicio.getTime()) ||
      (opciones.reparto === 'cercania' &&
        elegidos.some((e) => mismaRanura(e, candidato, zonaHoraria)));
    if (!repetido) elegidos.push(candidato);
  }

  const idsFieles = new Set(fieles.map((h) => h.inicio.getTime()));
  const alternativasAlejadas = elegidos
    .slice(1)
    .some((h) => !idsFieles.has(h.inicio.getTime()));

  return {
    huecos: elegidos,
    preferenciaNoSatisfecha: filtrado.preferenciaNoSatisfecha,
    alternativasAlejadas: alternativasAlejadas && !filtrado.preferenciaNoSatisfecha,
  };
}
