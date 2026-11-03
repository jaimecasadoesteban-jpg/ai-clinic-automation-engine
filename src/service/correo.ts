import nodemailer from 'nodemailer';

/**
 * El correo saliente, como puerto: el ejecutor no sabe de SMTP, y los tests no
 * mandan correos de verdad.
 */
export interface CorreoSaliente {
  enviar(mensaje: { para: string; asunto: string; cuerpo: string }): Promise<void>;
  /** ¿Se puede hablar con el servidor? Para el arranque: avisa, no impide. */
  comprobar(): Promise<boolean>;
  cerrar(): void;
}

export function crearCorreoSmtp(opciones: {
  host: string;
  port: number;
  user: string;
  pass: string;
}): CorreoSaliente {
  const transporte = nodemailer.createTransport({
    host: opciones.host,
    port: opciones.port,
    // 465 es TLS directo; 587 negocia TLS después (STARTTLS).
    secure: opciones.port === 465,
    auth: { user: opciones.user, pass: opciones.pass },
    connectionTimeout: 10_000,
    socketTimeout: 20_000,
  });

  return {
    async enviar({ para, asunto, cuerpo }) {
      await transporte.sendMail({ from: `Motor de Citas <${opciones.user}>`, to: para, subject: asunto, text: cuerpo });
    },
    async comprobar() {
      try {
        await transporte.verify();
        return true;
      } catch {
        return false;
      }
    },
    cerrar() {
      transporte.close();
    },
  };
}
