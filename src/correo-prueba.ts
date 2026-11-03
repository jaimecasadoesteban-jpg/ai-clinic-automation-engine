/**
 * Manda un correo de prueba al operador con la configuración del entorno.
 * En el contenedor: `node dist/correo-prueba.js`. Sirve para comprobar el SMTP
 * sin esperar a que algo falle.
 */
import { loadEnv } from './config/env.js';
import { crearCorreoSmtp } from './service/correo.js';

const env = loadEnv();
const correo = crearCorreoSmtp({ host: env.SMTP_HOST, port: env.SMTP_PORT, user: env.SMTP_USER, pass: env.SMTP_PASS });
try {
  await correo.enviar({
    para: env.OPERADOR_CORREO,
    asunto: '[Motor de Citas] Correo de prueba al operador',
    cuerpo: `Si lees esto, los avisos al operador llegan.\nEnviado: ${new Date().toISOString()}`,
  });
  console.log(`Enviado a ${env.OPERADOR_CORREO}.`);
} catch (error: unknown) {
  console.error('No se ha podido enviar:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  correo.cerrar();
}
