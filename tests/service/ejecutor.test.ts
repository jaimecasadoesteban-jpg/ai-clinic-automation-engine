import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Extraccion } from '../../src/agent/extraccion.js';
import { createCore, type Core } from '../../src/db/client.js';
import * as q from '../../src/db/queries.js';
import type { CorreoSaliente } from '../../src/service/correo.js';
import { ejecutarSalida, MAX_INTENTOS } from '../../src/service/ejecutor.js';
import { procesarMensajeEntrante } from '../../src/service/pipeline.js';
import { AgendaFalsa, AgenteFalso, ClasificadorFalso, RedactorFalso, dependenciasDePrueba } from '../support/fakes.js';
import { APP_URL, conexionAdmin, prepararBaseDeDatos } from '../support/db.js';

/**
 * La tabla de salida y su ejecutor: lo que va fuera se guarda dentro de la
 * transacción del turno y se envía después del commit (regla 3). Primer uso:
 * los avisos de infraestructura al operador, por correo y no a recepción.
 */

const CLINICA = 'ec0c0000-ec0c-4c0c-8c0c-ec0c00000000';
const OTRA = 'ec0c9999-ec0c-4c0c-8c0c-ec0c99999999';
const AHORA = new Date('2026-09-14T10:00:00.000Z');
const OPERADOR = 'operador@ejemplo.test';
const TELEFONO = '+34600909090';
const admin = conexionAdmin();
let core: Core;
let agenda: AgendaFalsa;
let contador = 0;

class CorreoFalso implements CorreoSaliente {
  readonly enviados: Array<{ para: string; asunto: string; cuerpo: string }> = [];
  constructor(
    private fallos = 0,
    /** Lo que tarda cada envío: para que dos pasadas se solapen de verdad. */
    private readonly esperaMs = 0,
  ) {}
  async enviar(m: { para: string; asunto: string; cuerpo: string }): Promise<void> {
    if (this.esperaMs > 0) await new Promise((r) => setTimeout(r, this.esperaMs));
    if (this.fallos > 0) {
      this.fallos -= 1;
      throw new Error('SMTP caído');
    }
    this.enviados.push(m);
  }
  comprobar(): Promise<boolean> {
    return Promise.resolve(true);
  }
  cerrar(): void {}
}

function extraccion(extra: Partial<Extraccion> = {}): Extraccion {
  return {
    intencion: 'agendar', servicio: 'laser-axilas', opcion: null, preferencia: null,
    escalar: null, cita: null, sustitucion: null, tema: null, ...extra,
  };
}

async function enviar(texto: string, guion: Extraccion = extraccion()) {
  contador += 1;
  const deps = dependenciasDePrueba({ core, agenda, reloj: () => AHORA });
  const { cuerpo } = await procesarMensajeEntrante(
    { ...deps, agente: new AgenteFalso(new ClasificadorFalso([guion]), new RedactorFalso()) },
    { idempotencyKey: `ejec-${contador}`, clientId: CLINICA, telefono: TELEFONO, nombre: 'Marisa', texto },
  );
  return cuerpo;
}

const filas = async () =>
  admin`select state, attempts, next_attempt_at, payload, last_error from motor.outbox where client_id = ${CLINICA} order by created_at`;

beforeAll(async () => {
  await prepararBaseDeDatos(admin);
  core = createCore(APP_URL);
}, 60_000);

afterAll(async () => {
  await core.close();
  await admin.end();
});

beforeEach(async () => {
  for (const id of [CLINICA, OTRA]) {
    await admin`update motor.conversations set pending_hold_id = null where client_id = ${id}`;
    for (const tabla of ['outbox', 'audit_log', 'idempotency_keys', 'job_runs', 'escalations', 'messages', 'holds', 'conversations', 'patients']) {
      await admin.unsafe(`delete from motor.${tabla} where client_id = $1`, [id]);
    }
    await admin`delete from motor.clients where id = ${id}`;
  }
  await admin`
    insert into motor.clients (id, slug, name, config, config_version)
    values (${CLINICA}, 'clinica-de-pruebas', 'Clínica', '{}'::jsonb, 'test'),
           (${OTRA}, 'otra', 'Otra', '{}'::jsonb, 'test')
  `;
  agenda = new AgendaFalsa();
  contador = 0;
});

describe('los avisos de infraestructura van al operador, no a recepción', () => {
  it('la agenda caída encola un correo, y el efecto no va a nadie de la clínica', async () => {
    agenda.fallar();

    const salida = await enviar('Quiero cita para axilas');

    expect(salida.efectos.find((e) => e.tipo === 'escalar_a_humano')?.destinatarios).toEqual([]);
    const [fila] = await filas();
    expect(fila?.['state']).toBe('pendiente');
    expect(String((fila?.['payload'] as { asunto: string }).asunto)).toMatch(/La agenda no responde/);
  });

  it('el correo no lleva datos del paciente: ni teléfono ni nombre', async () => {
    agenda.fallar();
    await enviar('Quiero cita para axilas');

    const [fila] = await filas();
    const texto = JSON.stringify(fila?.['payload']);
    expect(texto).not.toContain(TELEFONO);
    expect(texto).not.toContain('Marisa');
  });

  it('lo que es de la clínica (una queja) no se encola: sigue yendo a sus contactos', async () => {
    const salida = await enviar('esto es una vergüenza', extraccion({ intencion: 'otro', servicio: null, escalar: 'queja' }));

    expect(salida.efectos.find((e) => e.tipo === 'escalar_a_humano')?.destinatarios.length).toBeGreaterThan(0);
    expect(await filas()).toEqual([]);
  });
});

describe('regla 3: lo que se encola en un turno que revierte no existe', () => {
  it('si la transacción falla, no queda nada que enviar', async () => {
    await expect(
      core.withClient(CLINICA, async (tx) => {
        await q.encolarSalida(CLINICA, tx, {
          kind: 'correo_operador',
          dedupeKey: 'x',
          payload: { asunto: 'a', cuerpo: 'b' },
          ahora: AHORA,
        });
        throw new Error('el turno revierte');
      }),
    ).rejects.toThrow('el turno revierte');

    expect(await filas()).toEqual([]);
  });

  it('el mismo escalado no encola dos correos', async () => {
    for (let i = 0; i < 2; i += 1) {
      await core.withClient(CLINICA, (tx) =>
        q.encolarSalida(CLINICA, tx, { kind: 'correo_operador', dedupeKey: 'escalado:1', payload: { asunto: 'a', cuerpo: 'b' }, ahora: AHORA }),
      );
    }
    expect(await filas()).toHaveLength(1);
  });
});

describe('el ejecutor', () => {
  async function encolar(clave = 'escalado:1', clinica = CLINICA): Promise<void> {
    await core.withClient(clinica, (tx) =>
      q.encolarSalida(clinica, tx, { kind: 'correo_operador', dedupeKey: clave, payload: { asunto: 'Asunto', cuerpo: 'Cuerpo' }, ahora: AHORA }),
    );
  }

  it('lo envía al operador y lo marca: la segunda pasada no reenvía', async () => {
    await encolar();
    const correo = new CorreoFalso();

    const r1 = await ejecutarSalida(core, CLINICA, { correo, operador: OPERADOR, ahora: AHORA });
    const r2 = await ejecutarSalida(core, CLINICA, { correo, operador: OPERADOR, ahora: AHORA });

    expect(r1.enviados).toBe(1);
    expect(r2.enviados).toBe(0);
    expect(correo.enviados).toEqual([{ para: OPERADOR, asunto: 'Asunto', cuerpo: 'Cuerpo' }]);
    expect((await filas())[0]?.['state']).toBe('enviado');
  });

  it('si el SMTP falla, reintenta más tarde con espera creciente', async () => {
    await encolar();
    const correo = new CorreoFalso(2);

    const primero = await ejecutarSalida(core, CLINICA, { correo, operador: OPERADOR, ahora: AHORA });
    const [tras1] = await filas();
    // Antes de que venza la espera, no se reintenta.
    const antes = await ejecutarSalida(core, CLINICA, { correo, operador: OPERADOR, ahora: new Date(AHORA.getTime() + 30_000) });
    const segundo = await ejecutarSalida(core, CLINICA, { correo, operador: OPERADOR, ahora: new Date(AHORA.getTime() + 60_000) });
    const [tras2] = await filas();

    expect(primero.reintentos).toBe(1);
    expect(antes).toEqual({ enviados: 0, reintentos: 0, fallidos: [] });
    expect(segundo.reintentos).toBe(1);
    expect(new Date(String(tras1?.['next_attempt_at'])).getTime() - AHORA.getTime()).toBe(60_000);
    expect(new Date(String(tras2?.['next_attempt_at'])).getTime() - (AHORA.getTime() + 60_000)).toBe(120_000);
    expect(tras2?.['last_error']).toBe('SMTP caído');
  });

  it('pasado el tope de intentos queda fallido y se devuelve para registrarlo', async () => {
    await encolar();
    const correo = new CorreoFalso(100);
    let ahora = AHORA;
    let ultimo = await ejecutarSalida(core, CLINICA, { correo, operador: OPERADOR, ahora });
    for (let i = 1; i < MAX_INTENTOS; i += 1) {
      ahora = new Date(ahora.getTime() + 61 * 60_000);
      ultimo = await ejecutarSalida(core, CLINICA, { correo, operador: OPERADOR, ahora });
    }

    expect(ultimo.fallidos).toHaveLength(1);
    expect((await filas())[0]).toMatchObject({ state: 'fallido', attempts: MAX_INTENTOS });
  });

  it('regla 1: la pasada de una clínica no envía lo de otra', async () => {
    await encolar('escalado:otra', OTRA);
    const correo = new CorreoFalso();

    await ejecutarSalida(core, CLINICA, { correo, operador: OPERADOR, ahora: AHORA });

    expect(correo.enviados).toEqual([]);
  });

  it('dos ejecutores a la vez se reparten el trabajo: nada sale dos veces', async () => {
    for (let i = 0; i < 6; i += 1) await encolar(`escalado:${i}`);
    const otroCore = createCore(APP_URL);
    // Cada envío tarda: la primera pasada sigue dentro de su transacción cuando
    // empieza la segunda. Sin eso, una acaba antes de que la otra lea y el test
    // no prueba nada (lo destapó el sabotaje de quitar el bloqueo).
    const correo = new CorreoFalso(0, 40);
    try {
      // Concurrente de verdad: la protección es SKIP LOCKED, que vive en Postgres.
      await Promise.all([
        ejecutarSalida(core, CLINICA, { correo, operador: OPERADOR, ahora: AHORA }),
        ejecutarSalida(otroCore, CLINICA, { correo, operador: OPERADOR, ahora: AHORA }),
      ]);
    } finally {
      await otroCore.close();
    }

    expect(correo.enviados).toHaveLength(6);
  });
});
