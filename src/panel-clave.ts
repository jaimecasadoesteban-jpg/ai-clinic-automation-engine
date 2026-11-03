import { hashDeClave } from './panel/sesion.js';

/**
 * Genera el hash de la contraseña del panel para `PANEL_CLAVE_HASH`. La
 * contraseña se lee de la entrada, no de los argumentos, para que no quede en
 * el historial de la terminal:
 *
 *   read -s CLAVE && echo "$CLAVE" | npx tsx src/panel-clave.ts; unset CLAVE
 */
let entrada = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (trozo: string) => {
  entrada += trozo;
});
process.stdin.on('end', () => {
  const clave = entrada.replace(/\r?\n$/, '');
  if (clave.length < 12) {
    console.error('La contraseña tiene que tener al menos 12 caracteres.');
    process.exit(1);
  }
  console.log(hashDeClave(clave));
});
