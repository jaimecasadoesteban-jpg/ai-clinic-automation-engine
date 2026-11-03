import { describe, expect, it } from 'vitest';

import { ConfigurationError, exigirEscritorDeAgenda, loadEnv } from '../../src/config/env.js';

const BASE = {
  DATABASE_URL: 'postgres://x',
  SUPPRESSION_PEPPER: 'p'.repeat(16),
  NUCLEO_API_TOKEN: 't'.repeat(24),
  ANTHROPIC_API_KEY: 'k',
  N8N_AGENDA_URL: 'http://n8n/agenda/',
  SMTP_HOST: 'smtp.gmail.com',
  SMTP_USER: 'u@x.test',
  SMTP_PASS: 'x',
  OPERADOR_CORREO: 'op@x.test',
};
const WA = { WHATSAPP_TOKEN: 'tok', WHATSAPP_APP_SECRET: 'sec', WHATSAPP_VERIFY_TOKEN: 'v'.repeat(16) };

describe('el entorno', () => {
  it('sin el correo del operador no arranca: sus avisos no llegarían a nadie', () => {
    const { OPERADOR_CORREO: _o, ...sin } = BASE;
    expect(() => loadEnv(sin)).toThrow(ConfigurationError);
  });

  it('WhatsApp: las tres variables o ninguna', () => {
    expect(() => loadEnv(BASE)).not.toThrow();
    expect(() => loadEnv({ ...BASE, ...WA })).not.toThrow();
    for (const falta of Object.keys(WA)) {
      const medias = Object.fromEntries(Object.entries(WA).filter(([k]) => k !== falta));
      expect(() => loadEnv({ ...BASE, ...medias })).toThrow(/las tres o ninguna/);
    }
  });

  it('Chatwoot: las dos variables o ninguna, y la URL por defecto es la de Chatwoot Cloud', () => {
    const CW = { CHATWOOT_API_TOKEN: 'tok', CHATWOOT_WEBHOOK_SECRET: 's'.repeat(16) };
    expect(loadEnv({ ...BASE, ...CW }).CHATWOOT_URL).toBe('https://app.chatwoot.com');
    expect(() => loadEnv({ ...BASE, CHATWOOT_API_TOKEN: 'tok' })).toThrow(/las dos o ninguna/);
    expect(() => loadEnv({ ...BASE, CHATWOOT_WEBHOOK_SECRET: 's'.repeat(16) })).toThrow(/las dos o ninguna/);
  });

  it('Google: las tres o ninguna; y la agenda se lee por n8n o por Google, pero por alguno', () => {
    const G = { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'sec', GOOGLE_REFRESH_TOKEN: 'tok' };
    const { N8N_AGENDA_URL: _n, ...sinN8n } = BASE;
    expect(() => loadEnv({ ...sinN8n, ...G })).not.toThrow();
    expect(() => loadEnv({ ...BASE, GOOGLE_CLIENT_ID: 'id' })).toThrow(/las tres o ninguna/);
    expect(() => loadEnv(sinN8n)).toThrow(/N8N_AGENDA_URL o las tres GOOGLE_/);
  });

  it('una clínica en automatica sin Google no arranca: el paciente no recibiría nunca la confirmación', () => {
    expect(() => exigirEscritorDeAgenda(['ejemplo'], false)).toThrow(/ejemplo: agenda.confirmacion es automatica/);
    expect(() => exigirEscritorDeAgenda(['ejemplo'], true)).not.toThrow();
    expect(() => exigirEscritorDeAgenda([], false)).not.toThrow();
  });

  it('panel: las tres o ninguna, y en el entorno va el hash, nunca la contraseña', () => {
    const P = { PANEL_USUARIO: 'operador', PANEL_CLAVE_HASH: `scrypt$${'a'.repeat(32)}$${'b'.repeat(128)}`, PANEL_SECRETO: 's'.repeat(32) };
    expect(() => loadEnv({ ...BASE, ...P })).not.toThrow();
    expect(() => loadEnv({ ...BASE, PANEL_USUARIO: 'operador' })).toThrow(/las tres o ninguna/);
    expect(() => loadEnv({ ...BASE, ...P, PANEL_CLAVE_HASH: 'mi-contraseña' })).toThrow(/hash/);
  });
});
