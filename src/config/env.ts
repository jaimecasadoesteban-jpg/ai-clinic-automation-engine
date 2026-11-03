import { z } from 'zod';

/**
 * Configuración de proceso. Se valida una sola vez al arrancar (`src/index.ts`).
 * Nada de `process.env` disperso por el código: todo pasa por aquí.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  DATABASE_URL: z.string().min(1),
  /** Pimienta del HMAC de la lista de bajas. Crítica y no rotable; ver docs/DESIGN_RULES.md. */
  SUPPRESSION_PEPPER: z.string().min(16, 'debe tener al menos 16 caracteres'),
  /** Token compartido con n8n. Todos los endpoints salvo /salud lo exigen. */
  NUCLEO_API_TOKEN: z.string().min(24, 'debe tener al menos 24 caracteres'),
  /** Proveedor del LLM: única salida al exterior permitida desde el núcleo. */
  ANTHROPIC_API_KEY: z.string().min(1),
  /**
   * Webhooks de n8n que exponen la agenda de la clínica, sólo lectura.
   * El núcleo no habla con Google Calendar: le pregunta a n8n.
   */
  N8N_AGENDA_URL: z.url().optional(),
  /**
   * Google Calendar sin n8n, con el mismo cliente OAuth que usaba n8n. **Las
   * tres o ninguna.** Con ellas, el núcleo lee la agenda directamente y, en
   * modo `automatica`, escribe la cita. Sin ellas, la lectura sigue por
   * `N8N_AGENDA_URL` y ninguna clínica puede estar en `automatica`.
   */
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  GOOGLE_REFRESH_TOKEN: z.string().min(1).optional(),
  /**
   * Correo saliente para los avisos al operador (quien mantiene el sistema, no
   * la clínica): la agenda que no responde, un cron que no llama. **Obligatorio**:
   * sin él, esos avisos no le llegarían a nadie, y eso es lo que no puede pasar.
   * Es preferible que el despliegue no arranque. Con Gmail, `SMTP_PASS` es una
   * contraseña de aplicación, nunca la de la cuenta.
   */
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(465),
  SMTP_USER: z.string().min(1),
  SMTP_PASS: z.string().min(1),
  OPERADOR_CORREO: z.email(),
  /**
   * WhatsApp sin n8n. **Las tres o ninguna**: mientras falten, `/whatsapp` no se
   * monta y el webhook sigue en n8n. Con algunas sí y otras no, no arranca: es
   * una configuración a medias, que es justo la que falla sin avisar.
   * - `WHATSAPP_TOKEN`: token de acceso de Meta, sin «Bearer».
   * - `WHATSAPP_APP_SECRET`: el secreto de la app; verifica la firma del webhook.
   * - `WHATSAPP_VERIFY_TOKEN`: la frase que se pone en Meta al configurar el webhook.
   */
  WHATSAPP_TOKEN: z.string().min(1).optional(),
  WHATSAPP_APP_SECRET: z.string().min(1).optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().min(16, 'debe tener al menos 16 caracteres').optional(),
  WHATSAPP_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/).default('v21.0'),
  /**
   * WhatsApp a través de Chatwoot (coexistencia). **Las dos o ninguna**, por lo
   * mismo que las de Meta: sin ellas `/chatwoot` no se monta.
   * - `CHATWOOT_API_TOKEN`: el token de acceso (Perfil → Token de acceso).
   * - `CHATWOOT_WEBHOOK_SECRET`: el secreto del webhook, que verifica la firma.
   * Qué cuenta e inbox son de cada clínica va en su YAML (`canal.chatwoot`).
   */
  CHATWOOT_URL: z.url().default('https://app.chatwoot.com'),
  CHATWOOT_API_TOKEN: z.string().min(1).optional(),
  CHATWOOT_WEBHOOK_SECRET: z.string().min(16, 'debe tener al menos 16 caracteres').optional(),
  /**
   * El panel del operador (`/panel`). **Las tres o ninguna**: sin ellas no se
   * monta. `PANEL_CLAVE_HASH` es el hash, nunca la contraseña
   * (`npx tsx src/panel-clave.ts`); `PANEL_SECRETO` firma las sesiones.
   */
  PANEL_USUARIO: z.string().min(1).optional(),
  PANEL_CLAVE_HASH: z.string().regex(/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/, 'tiene que ser el hash de src/panel-clave.ts, no la contraseña').optional(),
  PANEL_SECRETO: z.string().min(32, 'debe tener al menos 32 caracteres').optional(),
}).superRefine((env, ctx) => {
  const panel = [env.PANEL_USUARIO, env.PANEL_CLAVE_HASH, env.PANEL_SECRETO].filter((v) => v !== undefined);
  if (panel.length !== 0 && panel.length !== 3) {
    ctx.addIssue({ code: 'custom', path: ['PANEL_USUARIO'], message: 'PANEL_USUARIO, PANEL_CLAVE_HASH y PANEL_SECRETO van las tres o ninguna' });
  }
  const google = [env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_REFRESH_TOKEN].filter((v) => v !== undefined);
  if (google.length !== 0 && google.length !== 3) {
    ctx.addIssue({
      code: 'custom',
      path: ['GOOGLE_CLIENT_ID'],
      message: 'GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET y GOOGLE_REFRESH_TOKEN van las tres o ninguna',
    });
  }
  // La agenda se lee por un sitio o por otro, pero por alguno: sin agenda no
  // se propone nada y todo el que pide cita acaba en un escalado.
  if (google.length === 0 && env.N8N_AGENDA_URL === undefined) {
    ctx.addIssue({ code: 'custom', path: ['N8N_AGENDA_URL'], message: 'hace falta N8N_AGENDA_URL o las tres GOOGLE_*' });
  }
  if ((env.CHATWOOT_API_TOKEN === undefined) !== (env.CHATWOOT_WEBHOOK_SECRET === undefined)) {
    ctx.addIssue({
      code: 'custom',
      path: ['CHATWOOT_API_TOKEN'],
      message: 'CHATWOOT_API_TOKEN y CHATWOOT_WEBHOOK_SECRET van las dos o ninguna',
    });
  }
  const puestas = [env.WHATSAPP_TOKEN, env.WHATSAPP_APP_SECRET, env.WHATSAPP_VERIFY_TOKEN].filter((v) => v !== undefined);
  if (puestas.length !== 0 && puestas.length !== 3) {
    ctx.addIssue({
      code: 'custom',
      path: ['WHATSAPP_TOKEN'],
      message: 'WHATSAPP_TOKEN, WHATSAPP_APP_SECRET y WHATSAPP_VERIFY_TOKEN van las tres o ninguna',
    });
  }
});

export type Env = z.infer<typeof envSchema>;

/** El proceso no puede arrancar: la configuración de entorno es inválida. */
export class ConfigurationError extends Error {
  override readonly name = 'ConfigurationError';
  constructor(readonly problems: readonly string[]) {
    super(`Configuración de entorno inválida:\n- ${problems.join('\n- ')}`);
  }
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `${issue.path.join('.') || '(raíz)'}: ${issue.message}`,
    );
    throw new ConfigurationError(problems);
  }
  return result.data;
}

/**
 * Ninguna clínica en `automatica` sin escritor de agenda: el paciente elegiría
 * y la confirmación no llegaría nunca, porque sale cuando el evento existe. Al
 * arrancar, no a mitad de una conversación.
 */
export function exigirEscritorDeAgenda(automaticas: readonly string[], hayGoogle: boolean): void {
  if (hayGoogle || automaticas.length === 0) return;
  throw new ConfigurationError([
    `${automaticas.join(', ')}: agenda.confirmacion es automatica y faltan GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET y GOOGLE_REFRESH_TOKEN. ` +
      'Sin ellas el núcleo no puede escribir la cita y el paciente no recibiría nunca la confirmación.',
  ]);
}
