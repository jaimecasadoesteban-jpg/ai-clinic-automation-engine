/**
 * Lo que usamos de nodemailer, y nada más. La versión 10 no trae tipos y los de
 * DefinitelyTyped son de versiones anteriores: mejor declarar la superficie
 * mínima que fiarse de unos tipos que pueden no corresponder.
 */
declare module 'nodemailer' {
  export interface Transporte {
    sendMail(mensaje: { from: string; to: string; subject: string; text: string }): Promise<{ messageId: string }>;
    verify(): Promise<true>;
    close(): void;
  }
  export function createTransport(opciones: {
    host: string;
    port: number;
    secure: boolean;
    auth: { user: string; pass: string };
    connectionTimeout?: number;
    socketTimeout?: number;
  }): Transporte;
  const nodemailer: { createTransport: typeof createTransport };
  export default nodemailer;
}
