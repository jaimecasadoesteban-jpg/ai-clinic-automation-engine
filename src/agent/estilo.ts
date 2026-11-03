import type { ClienteConfig } from '../config/cliente.js';

/**
 * Deriva a formulario: cuándo el agente ha dejado de escribir como una persona.
 *
 * Esto **no bloquea**, y es deliberado. La validación de salida regenera una vez
 * y, si vuelve a fallar, escala a un humano: hacer eso por un emoji de más
 * sería llenar a recepción de avisos por cuestiones de estilo, que es la misma
 * fatiga de alertas que evitamos en todo lo demás. Un precio inventado justifica
 * un escalado; una lista con guiones, no.
 *
 * Lo que sí hace es servir de red en `npm run eval`: si alguien toca el prompt o
 * cambia de modelo y la prosa vuelve a sonar a folleto, la puerta lo dice antes
 * de que lo lea un paciente.
 *
 * Los umbrales salen del YAML de cada clínica (regla 7).
 */

export type MotivoDeEstilo =
  | { readonly tipo: 'demasiadas_frases'; readonly frases: number; readonly maximo: number }
  | { readonly tipo: 'demasiados_emojis'; readonly emojis: number; readonly maximo: number }
  | { readonly tipo: 'lista'; readonly muestra: string }
  | { readonly tipo: 'negrita' }
  | { readonly tipo: 'muletilla'; readonly muletilla: string };

/**
 * Líneas que son una lista: guion, asterisco, viñeta, «1.» o «1️⃣».
 *
 * Se mira línea a línea porque un guion a mitad de frase —«depilación láser -
 * axilas»— no es una lista, y bloquear eso sería un falso positivo tonto.
 */
const LINEA_DE_LISTA = /^\s*(?:[-*•·]|\d{1,2}[.)]|[0-9]️?⃣)\s+\S/u;

const NEGRITA = /\*\*[^*]+\*\*|(?<!\*)\*[^*\n]{2,}\*(?!\*)/u;

/** Emojis de verdad, incluidos los de teclas numéricas. */
const EMOJI = /\p{Extended_Pictographic}|[0-9#*]️?⃣/gu;

/**
 * Los huecos propuestos se enumeran, y eso no es sonar a formulario.
 *
 * Una línea corta que lleva una hora es un hueco —«sábado 15 a las 10:20»— y no
 * cuenta ni como frase ni como lista. Si no se descontaran, la respuesta
 * correcta con tres huecos saldría marcada y el detector no serviría de nada.
 */
function esLineaDeHueco(linea: string): boolean {
  const limpia = linea.replace(LINEA_DE_LISTA, '').trim();
  if (!/\d{1,2}[:.]\d{2}/.test(limpia)) return false;
  return limpia.split(/\s+/).length <= 8;
}

function sinEnumeracionDeHuecos(texto: string): string {
  return texto
    .split('\n')
    .filter((linea) => !esLineaDeHueco(linea))
    .join('\n');
}

/** Cuenta frases de verdad: los puntos de «10:20» o «35 €» no separan nada. */
export function contarFrases(texto: string): number {
  const normalizado = texto
    .replace(/\d+[.,]\d+/g, '0')
    .replace(/\b(sr|sra|dr|dra|etc|aprox)\./gi, '$1');

  return normalizado
    .split(/[.!?\n]+/)
    .map((f) => f.trim())
    .filter((f) => f.length > 0).length;
}

export function contarEmojis(texto: string): number {
  return (texto.match(EMOJI) ?? []).length;
}

export function evaluarEstilo(texto: string, config: ClienteConfig): MotivoDeEstilo[] {
  const t = config.tono;
  const motivos: MotivoDeEstilo[] = [];

  // Enumerar tres huecos es legítimo; contar esas líneas como frases haría que
  // la respuesta correcta saliera marcada.
  const sinHuecos = sinEnumeracionDeHuecos(texto);

  const frases = contarFrases(sinHuecos);
  if (frases > t.frasesMaximas) {
    motivos.push({ tipo: 'demasiadas_frases', frases, maximo: t.frasesMaximas });
  }

  const emojis = contarEmojis(texto);
  if (emojis > t.emojisMaximos) {
    motivos.push({ tipo: 'demasiados_emojis', emojis, maximo: t.emojisMaximos });
  }

  if (!t.permiteListas) {
    const linea = sinHuecos.split('\n').find((l) => LINEA_DE_LISTA.test(l));
    if (linea !== undefined) motivos.push({ tipo: 'lista', muestra: linea.trim().slice(0, 40) });
  }

  if (NEGRITA.test(texto)) motivos.push({ tipo: 'negrita' });

  const normalizado = texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  for (const muletilla of t.muletillasProhibidas) {
    const limpia = muletilla
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '');
    // Sólo al principio de una frase: «perfecto» dentro de una frase normal es
    // castellano corriente, y «¡Perfecto! …» es la muletilla de folleto.
    if (new RegExp(`(^|[.!?¡¿]\\s*)${limpia}\\b`, 'u').test(normalizado)) {
      motivos.push({ tipo: 'muletilla', muletilla });
    }
  }

  return motivos;
}

/** Resumen legible, para el informe de la evaluación. */
export function explicarEstilo(motivos: readonly MotivoDeEstilo[]): string {
  return motivos
    .map((m) => {
      switch (m.tipo) {
        case 'demasiadas_frases':
          return `${m.frases} frases (máximo ${m.maximo})`;
        case 'demasiados_emojis':
          return `${m.emojis} emojis (máximo ${m.maximo})`;
        case 'lista':
          return `lista: «${m.muestra}»`;
        case 'negrita':
          return 'negritas';
        case 'muletilla':
          return `muletilla «${m.muletilla}»`;
      }
    })
    .join(', ');
}
