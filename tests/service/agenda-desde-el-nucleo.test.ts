import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Extraccion } from '../../src/agent/extraccion.js';
import { createCore, type Core } from '../../src/db/client.js';
import type { CargaDeEvento } from '../../src/db/schema.js';
import type { CorreoSaliente } from '../../src/service/correo.js';
import { ejecutarSalida } from '../../src/service/ejecutor.js';
import type { EscritorDeAgenda, ResultadoDeEscritura } from '../../src/service/google/escritor.js';
import { procesarMensajeEntrante } from '../../src/service/pipeline.js';
import {
  AgendaFalsa,
  AgenteFalso,
  ClasificadorFalso,
  RedactorFalso,
  configDePrueba,
  dependenciasDePrueba,
  registroDePrueba,
} from '../support/fakes.js';
import { APP_URL, conexionAdmin, prepararBaseDeDatos } from '../support/db.js';

/**
 * Modo `automatica` sin n8n: el turno en que el paciente elige encola el evento
 * (y no le dice nada todavía); el ejecutor lo crea y lo que pase sale por el
 * canal del paciente. **No se confirma hasta que el evento existe**, y si no
 * sabemos si existe, no se le toca la cita.
 */

const CLINICA = 'ad0c0000-0000-4000-8000-0000000ad0c0';
const AHORA = new Date('2026-09-14T10:00:00.000Z');
const CANAL = { por: 'chatwoot', cuentaId: 7, conversacionId: 1001 } as const;

const admin = conexionAdmin();
let core: Core;
let agenda: AgendaFalsa;
let contador = 0;

const CONFIG = registroDePrueba([
  {
    slug: 'clinica-de-pruebas',
    config: configDePrueba({
      agenda: { nivel: 'A', calendarioId: 'pruebas@group.calendar.google.com', confirmacion: 'automatica' },
      vencimientos: { agendaMinutos: 3 },
      canal: { tipo: 'whatsapp', remitenteId: '000', chatwoot: { cuentaId: 7, inboxId: 42 } },
    }),
  },
]);

function extraccion(extra: Partial<Extraccion> = {}): Extraccion {
  return {
    intencion: 'agendar', servicio: 'laser-axilas', opcion: null, preferencia: null,
    escalar: null, cita: null, sustitucion: null, tema: null, ...extra,
  };
}

function deps() {
  return dependenciasDePrueba({ core, agenda, reloj: () => AHORA, configuracion: CONFIG });
}

async function escribe(texto: string, e: Extraccion) {
  contador += 1;
  return procesarMensajeEntrante(
    { ...deps(), agente: new AgenteFalso(new ClasificadorFalso([e]), new RedactorFalso()) },
    { idempotencyKey: `auto-nucleo-${contador}`, clientId: CLINICA, telefono: '+34600555444', nombre: 'Lola', texto },
    CANAL,
  );
}

/** Pide cita y elige la primera: el turno deja el evento encolado. */
async function eligeLaPrimera() {
  await escribe('Quiero cita para axilas', extraccion());
  return escribe('la primera', extraccion({ intencion: 'elegir_hueco', opcion: 1 }));
}

class EscritorFalso implements EscritorDeAgenda {
  readonly pedidos: CargaDeEvento[] = [];
  constructor(private readonly resultados: ResultadoDeEscritura[]) {}
  crear(evento: CargaDeEvento): Promise<ResultadoDeEscritura> {
    this.pedidos.push(evento);
    return Promise.resolve(this.resultados.shift() ?? { creado: true, eventoId: 'ev' });
  }
}

class CorreoFalso implements CorreoSaliente {
  enviar(): Promise<void> {
    return Promise.resolve();
  }
  comprobar(): Promise<boolean> {
    return Promise.resolve(true);
  }
  cerrar(): void {}
}

function ejecutar(escritor?: EscritorDeAgenda) {
  return ejecutarSalida(core, CLINICA, {
    correo: new CorreoFalso(),
    operador: 'op@x.test',
    ...(escritor === undefined ? {} : { agenda: { escritor, deps: deps() } }),
    ahora: AHORA,
  });
}

async function salida(kind: string): Promise<Array<Record<string, unknown>>> {
  return (await admin`select payload, state from motor.outbox where client_id = ${CLINICA} and kind = ${kind} order by created_at`).map(
    (f) => ({ ...(f['payload'] as Record<string, unknown>), estado: f['state'] }),
  );
}

async function huecosPorEstado() {
  const filas = await admin`select state, count(*)::int as n from motor.holds where client_id = ${CLINICA} group by state`;
  return Object.fromEntries(filas.map((f) => [String(f['state']), Number(f['n'])]));
}

beforeAll(async () => {
  await prepararBaseDeDatos(admin);
  core = createCore(APP_URL);
}, 60_000);

afterAll(async () => {
  await core.close();
  await admin.end();
});

beforeEach(async () => {
  await admin`update motor.conversations set pending_hold_id = null where client_id = ${CLINICA}`;
  for (const tabla of ['inbox', 'outbox', 'audit_log', 'idempotency_keys', 'job_runs', 'appointments', 'escalations', 'messages', 'holds', 'conversations', 'patients']) {
    await admin.unsafe(`delete from motor.${tabla} where client_id = $1`, [CLINICA]);
  }
  await admin`delete from motor.clients where id = ${CLINICA}`;
  await admin`
    insert into motor.clients (id, slug, name, config, config_version)
    values (${CLINICA}, 'clinica-de-pruebas', 'Clínica', '{}'::jsonb, 'test')
  `;
  agenda = new AgendaFalsa();
});

describe('el turno en que elige', () => {
  it('el arranque sabe qué clínicas necesitan escritor de agenda', () => {
    expect(CONFIG.enModoAutomatico()).toEqual(['clinica-de-pruebas']);
  });

  it('encola el evento con el canal del paciente, y no le confirma nada todavía', async () => {
    const { cuerpo } = await eligeLaPrimera();

    expect(cuerpo.respuesta).toBeNull();
    const [evento] = await salida('evento_agenda');
    expect(evento).toMatchObject({ canal: CANAL, calendarioId: 'pruebas@group.calendar.google.com', estado: 'pendiente' });
    // En el turno de la elección no sale nada al paciente por Chatwoot.
    expect((await salida('chatwoot')).filter((s) => s['privado'] === false)).toHaveLength(1); // sólo las propuestas
    expect(await huecosPorEstado()).toMatchObject({ retenida: 1 });
  });
});

describe('el ejecutor crea el evento', () => {
  it('creado: la cita queda confirmada y la confirmación sale por Chatwoot, con su hora y su tratamiento', async () => {
    await eligeLaPrimera();
    const escritor = new EscritorFalso([{ creado: true, eventoId: 'ev-1' }]);

    await ejecutar(escritor);

    expect(escritor.pedidos).toHaveLength(1);
    expect(await huecosPorEstado()).toMatchObject({ confirmada: 1 });
    expect(await admin`select 1 from motor.appointments where client_id = ${CLINICA}`).toHaveLength(1);
    const publicos = (await salida('chatwoot')).filter((s) => s['privado'] === false);
    expect(publicos).toHaveLength(2);
    expect(publicos[1]).toMatchObject({ cuentaId: 7, conversacionId: 1001 });
    expect(String(publicos[1]?.['texto'])).toMatch(/láser axilas/i);
    expect((await salida('evento_agenda'))[0]?.['estado']).toBe('enviado');
  });

  it('un reintento no confirma dos veces ni crea una segunda cita', async () => {
    await eligeLaPrimera();
    await ejecutar(new EscritorFalso([{ creado: true, eventoId: 'ev-1' }]));
    // La fila vuelve a pendiente, como si la marca no hubiera llegado a guardarse.
    await admin`update motor.outbox set state = 'pendiente' where client_id = ${CLINICA} and kind = 'evento_agenda'`;

    await ejecutar(new EscritorFalso([{ creado: true, eventoId: 'ev-1' }]));

    expect(await admin`select 1 from motor.appointments where client_id = ${CLINICA}`).toHaveLength(1);
    expect((await salida('chatwoot')).filter((s) => s['privado'] === false)).toHaveLength(2);
  });

  it('ocupado: se pasa a la segunda opción y se encola su evento, sin decirle nada al paciente', async () => {
    await eligeLaPrimera();

    await ejecutar(new EscritorFalso([{ creado: false, motivo: 'ocupado', detalle: 'x' }]));

    expect(await huecosPorEstado()).toMatchObject({ colisionada: 1, retenida: 1 });
    const eventos = await salida('evento_agenda');
    expect(eventos).toHaveLength(2);
    // Las dos filas llevan la misma hora: se busca la nueva por su estado.
    expect(eventos.filter((e) => e['estado'] === 'pendiente')).toEqual([expect.objectContaining({ canal: CANAL })]);
    expect((await salida('chatwoot')).filter((s) => s['privado'] === false)).toHaveLength(1);

    // Y la segunda sí entra.
    await ejecutar(new EscritorFalso([{ creado: true, eventoId: 'ev-2' }]));
    expect(await huecosPorEstado()).toMatchObject({ colisionada: 1, confirmada: 1 });
  });

  it.each(['rechazado', 'error'] as const)(
    '%s: no sabemos si existe. No se le toca la cita: pasa a recepción, con nota al equipo y correo al operador',
    async (motivo) => {
      await eligeLaPrimera();

      await ejecutar(new EscritorFalso([{ creado: false, motivo, detalle: 'Google ha respondido 403' }]));

      expect(await huecosPorEstado()).toMatchObject({ pendiente_recepcion: 1 });
      const chatwoot = await salida('chatwoot');
      // El paciente recibe el texto de «retenido, pendiente de confirmar», que dice la verdad.
      expect(chatwoot.filter((s) => s['privado'] === false)).toHaveLength(2);
      expect(chatwoot.filter((s) => s['privado'] === true).length).toBeGreaterThan(0);
      const correos = await salida('correo_operador');
      expect(correos.map((c) => c['asunto'])).toContainEqual(expect.stringMatching(/No se ha podido escribir en la agenda/));
      expect(JSON.stringify(correos)).not.toContain('34600555444');
    },
  );

  it('sin escritor de agenda, el evento espera: ni se pierde ni se da por fallido', async () => {
    await eligeLaPrimera();

    await ejecutar();

    expect((await salida('evento_agenda'))[0]?.['estado']).toBe('pendiente');
    expect(await huecosPorEstado()).toMatchObject({ retenida: 1 });
  });
});
