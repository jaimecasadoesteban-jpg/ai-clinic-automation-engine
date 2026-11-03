import type { ClienteConfig, Servicio } from '../config/cliente.js';

/**
 * Qué huecos son proponibles. **Regla de negocio, y por tanto del núcleo.**
 *
 * n8n devuelve ocupación en bruto —cuándo está pillada la agenda— y aquí se
 * decide qué se puede ofrecer. El horario de la clínica, los días de cierre, la
 * antelación mínima y la duración de cada servicio están en el YAML, dentro del
 * núcleo, y son obligatorios desde la fase 6 precisamente por esto: una regla de
 * negocio en un lienzo visual sin tests es lo que el principio 2 dice que no
 * hacemos.
 *
 * Lo que se comprueba, en este orden:
 * - **Días de cierre.** Si el día no tiene tramos en el horario, no hay huecos.
 * - **Tramos partidos.** Un día puede tener varios `{abre, cierra}`; se generan
 *   candidatos dentro de cada uno por separado. Nada cae en la hora de comer.
 * - **Antelación mínima.** En nivel A se excluyen las próximas 24 h, para que
 *   recepción tenga margen de reaccionar.
 * - **Duración del servicio.** El hueco tiene que caber ENTERO antes del cierre:
 *   proponer una limpieza facial de 60 minutos a las 19:50 cuando se cierra a
 *   las 20:30 es proponer algo que no se puede hacer.
 * - **Ocupación.** Se descarta todo lo que solape con lo que la agenda dice que
 *   está pillado, aunque solape sólo un minuto.
 */

export interface Intervalo {
  readonly inicio: Date;
  readonly fin: Date;
}

/** Horas de antelación mínima según el nivel de agenda de la clínica. */
export const ANTELACION_POR_NIVEL = { A: 24, B: 0 } as const;

/** Cuántos días hacia delante se buscan huecos. */
export const DIAS_DE_BUSQUEDA = 21;

const DIAS_EN_ORDEN = [
  'domingo',
  'lunes',
  'martes',
  'miercoles',
  'jueves',
  'viernes',
  'sabado',
] as const;

const ABREVIATURAS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function partesLocales(fecha: Date, zonaHoraria: string): { dia: string; anio: number; mes: number; diaMes: number } {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: zonaHoraria,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(fecha).map((x) => [x.type, x.value]));
  const indice = ABREVIATURAS.indexOf(String(p['weekday'] ?? '').toLowerCase().slice(0, 3));

  return {
    dia: DIAS_EN_ORDEN[indice === -1 ? 0 : indice] ?? 'domingo',
    anio: Number(p['year']),
    mes: Number(p['month']),
    diaMes: Number(p['day']),
  };
}

/** Milisegundos que la zona va por delante de UTC en ese instante. */
function desfase(fecha: Date, zonaHoraria: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: zonaHoraria,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(fecha).map((x) => [x.type, x.value]));
  const horas = Number(p['hour']);
  const comoUtc = Date.UTC(
    Number(p['year']),
    Number(p['month']) - 1,
    Number(p['day']),
    horas === 24 ? 0 : horas,
    Number(p['minute']),
    Number(p['second']),
  );
  return comoUtc - fecha.getTime();
}

/** El instante en que son las HH:MM locales de ese día. */
export function instanteDe(
  anio: number,
  mes: number,
  diaMes: number,
  horas: number,
  minutos: number,
  zonaHoraria: string,
): Date {
  const tentativa = Date.UTC(anio, mes - 1, diaMes, horas, minutos);
  const primero = desfase(new Date(tentativa), zonaHoraria);
  const candidato = tentativa - primero;
  // El desfase se mide en un instante que todavía no es el bueno. Si entre uno
  // y otro cae un cambio de hora, hay que volver a medirlo en el instante
  // resultante: sin esto, las 01:00 del día en que se atrasa el reloj salían una
  // hora tarde. En la hora que se repite (02:00-03:00) se queda con la segunda.
  const segundo = desfase(new Date(candidato), zonaHoraria);
  return new Date(segundo === primero ? candidato : tentativa - segundo);
}

function solapa(a: Intervalo, b: Intervalo): boolean {
  return a.inicio < b.fin && b.inicio < a.fin;
}

export interface EntradaDeDisponibilidad {
  readonly config: ClienteConfig;
  readonly servicio: Servicio;
  readonly ahora: Date;
  /** Lo que la agenda dice que está pillado. Ocupación en bruto, sin interpretar. */
  readonly ocupacion: readonly Intervalo[];
  readonly dias?: number;
}

/**
 * Genera los huecos proponibles, en orden de proximidad.
 *
 * El paso entre candidatos es la propia duración del servicio, así que salen
 * consecutivos y sin solaparse entre ellos.
 */
export function huecosProponibles(entrada: EntradaDeDisponibilidad): Intervalo[] {
  const { config, servicio, ahora, ocupacion } = entrada;
  const zona = config.zonaHoraria;
  const duracionMs = servicio.duracionMinutos * 60_000;

  const antelacionHoras = ANTELACION_POR_NIVEL[config.agenda.nivel];
  const desde = new Date(ahora.getTime() + antelacionHoras * 3_600_000);

  // Un día puede tener varios tramos: mañana y tarde, con la comida en medio.
  const tramosPorDia = new Map<string, Array<{ abre: string; cierra: string }>>();
  for (const tramo of config.horario) {
    const lista = tramosPorDia.get(tramo.dia) ?? [];
    lista.push({ abre: tramo.abre, cierra: tramo.cierra });
    tramosPorDia.set(tramo.dia, lista);
  }

  const salida: Intervalo[] = [];
  const dias = entrada.dias ?? DIAS_DE_BUSQUEDA;

  for (let salto = 0; salto <= dias; salto += 1) {
    // Se avanza por días de calendario locales, no de 24 h en 24 h: el día en que
    // cambia la hora dura 23 o 25 horas, y sumando 24 h desde las 00:30 un día se
    // repetía (todos sus huecos duplicados) y el último se perdía.
    const hoyLocal = partesLocales(ahora, zona);
    const referencia = new Date(Date.UTC(hoyLocal.anio, hoyLocal.mes - 1, hoyLocal.diaMes + salto, 12));
    const dia = DIAS_EN_ORDEN[referencia.getUTCDay()] ?? 'domingo';
    const anio = referencia.getUTCFullYear();
    const mes = referencia.getUTCMonth() + 1;
    const diaMes = referencia.getUTCDate();

    // Día de cierre: ningún tramo, ningún hueco. Sin esto se proponen domingos.
    const tramos = tramosPorDia.get(dia);
    if (tramos === undefined) continue;

    for (const tramo of tramos) {
      const [abreH, abreM] = tramo.abre.split(':').map(Number);
      const [cierraH, cierraM] = tramo.cierra.split(':').map(Number);
      const abre = instanteDe(anio, mes, diaMes, abreH ?? 0, abreM ?? 0, zona);
      const cierra = instanteDe(anio, mes, diaMes, cierraH ?? 0, cierraM ?? 0, zona);

      for (let inicio = abre.getTime(); inicio + duracionMs <= cierra.getTime(); inicio += duracionMs) {
        const candidato: Intervalo = {
          inicio: new Date(inicio),
          fin: new Date(inicio + duracionMs),
        };

        // Antelación mínima: en nivel A, nada dentro de las próximas 24 h.
        if (candidato.inicio < desde) continue;
        // Ocupado, aunque solape un solo minuto.
        if (ocupacion.some((pillado) => solapa(candidato, pillado))) continue;

        salida.push(candidato);
      }
    }
  }

  return salida.sort((a, b) => a.inicio.getTime() - b.inicio.getTime());
}

/**
 * ¿Sigue siendo proponible este hueco concreto? Se usa en el paso 6, antes de
 * confirmar: no basta con que la agenda lo dé por libre, tiene que seguir
 * cumpliendo las reglas de la clínica.
 */
export function sigueSiendoProponible(
  entrada: EntradaDeDisponibilidad & { hueco: Intervalo },
): boolean {
  return huecosProponibles({ ...entrada, dias: DIAS_DE_BUSQUEDA }).some(
    (h) => h.inicio.getTime() === entrada.hueco.inicio.getTime(),
  );
}
