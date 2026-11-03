import { afterEach, describe, expect, it, vi } from 'vitest';

import { crearAgendaN8n } from '../../src/service/agenda-n8n.js';

/**
 * El calendario viaja en cada petición: n8n no lo decide. Vivía en un mapa
 * `clientId → calendario` escrito a mano en dos nodos de n8n, y el modo
 * automático iba a necesitar un tercero. Una errata en uno de los tres leía un
 * calendario y escribía en otro.
 */
describe('las peticiones de agenda llevan el calendario del YAML', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('ocupación y hueco libre mandan calendarioId', async () => {
    const cuerpos: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: URL, init: { body: string }) => {
        cuerpos.push(JSON.parse(init.body));
        const ocupacion = cuerpos.length === 1;
        return new Response(JSON.stringify(ocupacion ? { ocupado: [] } : { libre: true }), { status: 200 });
      }),
    );
    const agenda = crearAgendaN8n({ baseUrl: 'http://n8n.local/webhook/agenda/', token: 't' });

    await agenda.ocupacion({ clientId: 'c', calendarioId: 'cal@group', desde: new Date(), hasta: new Date() });
    await agenda.sigueLibre({ clientId: 'c', calendarioId: 'cal@group', inicio: new Date(), fin: new Date() });

    expect(cuerpos).toEqual([
      expect.objectContaining({ calendarioId: 'cal@group' }),
      expect.objectContaining({ calendarioId: 'cal@group' }),
    ]);
  });
});
