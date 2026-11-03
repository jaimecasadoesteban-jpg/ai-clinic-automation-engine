import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * El acceso al panel: una página con datos de salud de pacientes, publicada en
 * internet. Un único operador, sin atajos.
 *
 * - **La contraseña no vive en ningún sitio**: en el entorno va su hash scrypt
 *   (`npx tsx src/panel-clave.ts` lo genera). Quien lea las variables de
 *   la plataforma de despliegue no puede entrar con ellas.
 * - **La sesión es una cookie firmada** (HMAC con `PANEL_SECRETO`), con
 *   caducidad dentro de la firma: no hay tabla de sesiones que robar ni que
 *   limpiar. `HttpOnly`, `Secure` y `SameSite=Strict`.
 * - **Intentos limitados** por IP: cinco fallos y quince minutos de espera.
 */

export const HORAS_DE_SESION = 12;
export const COOKIE = 'motor_panel';

/** `scrypt$<sal en hex>$<hash en hex>`, con los parámetros por defecto de Node. */
export function hashDeClave(clave: string): string {
  const sal = randomBytes(16);
  return `scrypt$${sal.toString('hex')}$${scryptSync(clave, sal, 64).toString('hex')}`;
}

export function claveCorrecta(clave: string, hash: string): boolean {
  const [tipo, sal, esperado] = hash.split('$');
  if (tipo !== 'scrypt' || sal === undefined || esperado === undefined) return false;
  const calculado = scryptSync(clave, Buffer.from(sal, 'hex'), 64);
  const b = Buffer.from(esperado, 'hex');
  return calculado.length === b.length && timingSafeEqual(calculado, b);
}

function firma(contenido: string, secreto: string): string {
  return createHmac('sha256', secreto).update(contenido).digest('base64url');
}

/** El valor de la cookie: usuario, caducidad y firma de los dos. */
export function crearSesion(usuario: string, secreto: string, ahora: Date): string {
  const contenido = `${Buffer.from(usuario).toString('base64url')}.${ahora.getTime() + HORAS_DE_SESION * 3_600_000}`;
  return `${contenido}.${firma(contenido, secreto)}`;
}

/** El usuario de una cookie válida y no caducada; `undefined` en cualquier otro caso. */
export function leerSesion(valor: string | undefined, secreto: string, ahora: Date): string | undefined {
  if (valor === undefined) return undefined;
  const partes = valor.split('.');
  if (partes.length !== 3) return undefined;
  const [usuario, caduca, recibida] = partes as [string, string, string];
  const esperada = firma(`${usuario}.${caduca}`, secreto);
  const a = Buffer.from(recibida);
  const b = Buffer.from(esperada);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  if (!/^\d+$/.test(caduca) || Number(caduca) <= ahora.getTime()) return undefined;
  return Buffer.from(usuario, 'base64url').toString('utf8');
}

/** Cinco fallos por IP y quince minutos de espera. En memoria: un solo proceso. */
export class LimiteDeIntentos {
  private readonly fallos = new Map<string, { n: number; desde: number }>();
  constructor(
    private readonly maximo = 5,
    private readonly ventanaMs = 15 * 60_000,
  ) {}

  bloqueado(ip: string, ahora: Date): boolean {
    const f = this.fallos.get(ip);
    if (f === undefined) return false;
    if (ahora.getTime() - f.desde > this.ventanaMs) {
      this.fallos.delete(ip);
      return false;
    }
    return f.n >= this.maximo;
  }

  fallo(ip: string, ahora: Date): void {
    const f = this.fallos.get(ip);
    if (f === undefined || ahora.getTime() - f.desde > this.ventanaMs) {
      this.fallos.set(ip, { n: 1, desde: ahora.getTime() });
    } else {
      f.n += 1;
    }
  }

  acierto(ip: string): void {
    this.fallos.delete(ip);
  }
}
