import { describe, expect, it } from 'vitest';

import type { CargaDeEvento } from '../../src/db/schema.js';
import { AgendaNoDisponibleError } from '../../src/service/agenda-n8n.js';
import { crearAgendaGoogle, crearEscritorGoogle, idDeEvento } from '../../src/service/google/calendar.js';

/**
 * Google Calendar desde el núcleo, contra un Google falso. Lo que importa: que
 * un calendario que Google no puede leer no se tome por «todo libre», y que
 * crear un evento distinga los tres resultados sin confundirlos.
 */

const CAL = 'clinica@group.calendar.google.com';
const OPCIONES = { clientId: 'id', clientSecret: 'secreto', refreshToken: 'permiso' };

type Respuesta = { status: number; body?: unknown } | Error;

/** Un `fetch` que contesta por ruta y apunta lo que se le pide. */
function googleFalso(rutas: Record<string, Respuesta | Respuesta[]>) {
  const llamadas: Array<{ url: string; metodo: string; cuerpo: unknown }> = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    llamadas.push({ url: u, metodo: init?.method ?? 'GET', cuerpo: typeof init?.body === 'string' && u.includes('googleapis.com/calendar') ? JSON.parse(init.body) : init?.body });
    const clave = Object.keys(rutas).find((r) => u.includes(r) && (r !== '/events' || init?.method === 'POST'));
    if (clave === undefined) throw new Error(`ruta no esperada: ${u}`);
    const entrada = rutas[clave];
    const r = Array.isArray(entrada) ? (entrada.shift() ?? { status: 500 }) : entrada;
    if (r === undefined) throw new Error('sin respuesta');
    if (r instanceof Error) throw r;
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  return { f, llamadas };
}

const TOKEN = { 'oauth2.googleapis.com/token': { status: 200, body: { access_token: 'acceso', expires_in: 3600 } } };
const libre = { status: 200, body: { calendars: { [CAL]: { busy: [] } } } };
const ocupadoDe = (start: string, end: string) => ({ status: 200, body: { calendars: { [CAL]: { busy: [{ start, end }] } } } });

const EVENTO = {
  holdId: 'h1',
  calendarioId: CAL,
  idempotencyKey: 'evento-h1',
  inicio: '2026-10-20T08:00:00.000Z',
  fin: '2026-10-20T08:20:00.000Z',
  resumen: 'Láser axilas — Lola',
  descripcion: 'Tel. +34600123456',
  canal: { por: 'chatwoot', cuentaId: 1, conversacionId: 2 },
  clinica: 'Clínica',
} satisfies CargaDeEvento;

describe('leer la agenda', () => {
  it('lo ocupado sale tal cual, y el token se pide una vez y se reutiliza', async () => {
    const { f, llamadas } = googleFalso({ ...TOKEN, '/freeBusy': ocupadoDe('2026-10-20T08:00:00Z', '2026-10-20T09:00:00Z') });
    const agenda = crearAgendaGoogle({ ...OPCIONES, fetch: f });
    const rango = { clientId: 'c', calendarioId: CAL, desde: new Date('2026-10-20T00:00:00Z'), hasta: new Date('2026-10-21T00:00:00Z') };

    const ocupado = await agenda.ocupacion(rango);
    await agenda.ocupacion(rango);

    expect(ocupado).toEqual([{ inicio: new Date('2026-10-20T08:00:00Z'), fin: new Date('2026-10-20T09:00:00Z') }]);
    expect(llamadas.filter((l) => l.url.includes('/token'))).toHaveLength(1);
  });

  it('un calendario que Google no puede leer NO es «todo libre»: es una agenda caída', async () => {
    const { f } = googleFalso({ ...TOKEN, '/freeBusy': { status: 200, body: { calendars: { [CAL]: { errors: [{ reason: 'notFound' }], busy: [] } } } } });
    const agenda = crearAgendaGoogle({ ...OPCIONES, fetch: f });

    await expect(
      agenda.ocupacion({ clientId: 'c', calendarioId: CAL, desde: new Date(), hasta: new Date() }),
    ).rejects.toBeInstanceOf(AgendaNoDisponibleError);
  });

  it('un permiso revocado tampoco: agenda caída, y el turno ya sabe contestar a eso', async () => {
    const { f } = googleFalso({ 'oauth2.googleapis.com/token': { status: 400, body: { error: 'invalid_grant' } } });
    const agenda = crearAgendaGoogle({ ...OPCIONES, fetch: f });

    await expect(
      agenda.sigueLibre({ clientId: 'c', calendarioId: CAL, inicio: new Date(), fin: new Date() }),
    ).rejects.toBeInstanceOf(AgendaNoDisponibleError);
  });

  it('dos citas que se tocan no chocan: solape estricto, como en el núcleo', async () => {
    const { f } = googleFalso({ ...TOKEN, '/freeBusy': ocupadoDe('2026-10-20T07:40:00Z', '2026-10-20T08:00:00Z') });
    const agenda = crearAgendaGoogle({ ...OPCIONES, fetch: f });

    expect(
      await agenda.sigueLibre({ clientId: 'c', calendarioId: CAL, inicio: new Date(EVENTO.inicio), fin: new Date(EVENTO.fin) }),
    ).toBe(true);
  });
});

describe('crear el evento', () => {
  it('relee antes de escribir, y lo crea con un id fijo que Google acepta', async () => {
    const { f, llamadas } = googleFalso({ ...TOKEN, '/freeBusy': libre, '/events': { status: 200, body: {} } });

    const r = await crearEscritorGoogle({ ...OPCIONES, fetch: f }).crear(EVENTO);

    expect(r).toEqual({ creado: true, eventoId: idDeEvento('evento-h1') });
    expect(llamadas.map((l) => l.url.split('?')[0]?.split('/').slice(-1)[0])).toEqual(['token', 'freeBusy', 'events']);
    expect(idDeEvento('evento-h1')).toMatch(/^[a-v0-9]{5,1024}$/);
    expect(llamadas.at(-1)?.cuerpo).toMatchObject({ id: idDeEvento('evento-h1'), summary: EVENTO.resumen });
  });

  it('si el hueco está ocupado, es una colisión y no se escribe nada', async () => {
    const { f, llamadas } = googleFalso({
      ...TOKEN,
      '/freeBusy': ocupadoDe('2026-10-20T08:10:00Z', '2026-10-20T08:40:00Z'),
      [`/events/${idDeEvento('evento-h1')}`]: { status: 404 },
    });

    const r = await crearEscritorGoogle({ ...OPCIONES, fetch: f }).crear(EVENTO);

    expect(r).toMatchObject({ creado: false, motivo: 'ocupado' });
    expect(llamadas.some((l) => l.metodo === 'POST' && l.url.endsWith('/events'))).toBe(false);
  });

  it('si lo ocupa nuestro propio evento de un intento anterior, está creado: no es una colisión', async () => {
    const { f } = googleFalso({
      ...TOKEN,
      '/freeBusy': ocupadoDe(EVENTO.inicio, EVENTO.fin),
      [`/events/${idDeEvento('evento-h1')}`]: { status: 200, body: { status: 'confirmed' } },
    });

    expect(await crearEscritorGoogle({ ...OPCIONES, fetch: f }).crear(EVENTO)).toEqual({ creado: true, eventoId: idDeEvento('evento-h1') });
  });

  it('409 (ya existe con ese id) es creado: un reintento no crea dos', async () => {
    const { f } = googleFalso({ ...TOKEN, '/freeBusy': libre, '/events': { status: 409 } });

    expect((await crearEscritorGoogle({ ...OPCIONES, fetch: f }).crear(EVENTO)).creado).toBe(true);
  });

  it.each([
    ['un 403 (sin permiso de escritura)', { status: 403 }, 'rechazado'],
    ['un 500', { status: 500 }, 'error'],
    ['un corte de red: pudo crearse o no', new Error('socket hang up'), 'error'],
  ] as const)('%s no es «ocupado»: no sabemos si existe', async (_n, respuesta, motivo) => {
    const { f } = googleFalso({ ...TOKEN, '/freeBusy': libre, '/events': respuesta });

    expect(await crearEscritorGoogle({ ...OPCIONES, fetch: f }).crear(EVENTO)).toMatchObject({ creado: false, motivo });
  });

  it('si no se puede releer, no se escribe: sin relectura no hay escritura', async () => {
    const { f, llamadas } = googleFalso({ ...TOKEN, '/freeBusy': { status: 503 } });

    expect(await crearEscritorGoogle({ ...OPCIONES, fetch: f }).crear(EVENTO)).toMatchObject({ creado: false, motivo: 'error' });
    expect(llamadas.some((l) => l.metodo === 'POST' && l.url.endsWith('/events'))).toBe(false);
  });
});
