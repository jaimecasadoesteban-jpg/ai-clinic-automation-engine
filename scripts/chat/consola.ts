/**
 * Presentación del banco de pruebas. Colores ANSI y nada más — sin dependencias.
 */

const ESC = '[';
const on = process.stdout.isTTY === true;

function pintar(codigo: string, texto: string): string {
  return on ? `${ESC}${codigo}m${texto}${ESC}0m` : texto;
}

export const c = {
  gris: (t: string) => pintar('90', t),
  rojo: (t: string) => pintar('31', t),
  verde: (t: string) => pintar('32', t),
  ambar: (t: string) => pintar('33', t),
  azul: (t: string) => pintar('36', t),
  fuerte: (t: string) => pintar('1', t),
};

/** El bloque de depuración va con sangría y en gris: se distingue del mensaje. */
export function bajoLaLinea(lineas: readonly (string | null)[]): void {
  const utiles = lineas.filter((l): l is string => l !== null && l.length > 0);
  if (utiles.length === 0) return;
  for (const linea of utiles) console.log(c.gris(`   │ ${linea}`));
}

export function titulo(texto: string): void {
  console.log(`\n${c.fuerte(texto)}`);
}

export function euros(valor: number): string {
  return `${valor.toFixed(2)} €`;
}

export function dolares(valor: number): string {
  return valor < 0.01 ? `<0,01 $` : `${valor.toFixed(3)} $`;
}

export function hora(fecha: Date, zonaHoraria: string): string {
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: zonaHoraria,
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(fecha);
}
