import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Extraccion } from '../../src/agent/extraccion.js';
import { PRESUPUESTO } from '../../src/agent/models.js';
import { createCore, type Core } from '../../src/db/client.js';
import { procesarMensajeEntrante } from '../../src/service/pipeline.js';
import type { LlamadaAlModelo } from '../../src/service/ports.js';
import {
  AgendaFalsa,
  AgenteFalso,
  ClasificadorFalso,
  RedactorFalso,
  dependenciasDePrueba,
} from '../support/fakes.js';
import { APP_URL, conexionAdmin, prepararBaseDeDatos } from '../support/db.js';

/**
 * Regla 6 y la ventana «de 8 turnos más resumen», en el pipeline.
 *
 * En producción, `messages.prompt` y `latency_ms` estaban a NULL: para explicar
 * por qué el agente se desdijo del aparcamiento hubo que reconstruir el prompt
 * desde el código. Y el resumen no lo escribía nada: a partir del noveno turno,
 * el modelo no sabía lo que se había hablado antes.
 */

const CLINICA = 'cdcd0000-cdcd-4dcd-8dcd-cdcd00000000';
const AHORA = new Date('2026-09-15T10:00:00.000Z');
const TELEFONO = '+34600777888';

const admin = conexionAdmin();
let core: Core;
let contador = 0;

function extraccion(extra: Partial<Extraccion> = {}): Extraccion {
  return {
    intencion: 'otro',
    servicio: null,
    opcion: null,
    preferencia: null,
    escalar: null,
    cita: null,
    sustitucion: null,
    tema: null,
    ...extra,
  };
}

function llamada(extra: Partial<LlamadaAlModelo> = {}): LlamadaAlModelo {
  return {
    tipo: 'redactar',
    modelo: 'claude-opus-5',
    sistema: 'SISTEMA',
    mensajes: [{ role: 'user', content: 'hola' }],
    respuesta: 'Hola, ¿en qué te ayudo?',
    tokensEntrada: 100,
    tokensSalida: 20,
    latenciaMs: 800,
    error: null,
    ...extra,
  };
}

function agente(llamadas: readonly LlamadaAlModelo[] = []): AgenteFalso {
  return new AgenteFalso(new ClasificadorFalso([extraccion()]), new RedactorFalso(), llamadas);
}

async function enviar(texto: string, a: AgenteFalso = agente(), ahora = AHORA): Promise<void> {
  contador += 1;
  const deps = dependenciasDePrueba({ core, agenda: new AgendaFalsa(), reloj: () => ahora });
  await procesarMensajeEntrante(
    { ...deps, agente: a },
    { idempotencyKey: `registro-${contador}`, clientId: CLINICA, telefono: TELEFONO, nombre: 'Rosa', texto },
  );
}

async function conversacion(): Promise<{ id: string; patientId: string }> {
  const [fila] = await admin`select id, patient_id from motor.conversations where client_id = ${CLINICA}`;
  return { id: String(fila?.['id']), patientId: String(fila?.['patient_id']) };
}

/** Mete mensajes de antes, cada uno un minuto después del anterior. */
async function historial(
  mensajes: ReadonlyArray<{ texto: string; entrante: boolean; clinico?: boolean; desmentido?: boolean }>,
  desde: Date,
): Promise<Date[]> {
  const { id } = await conversacion();
  const fechas: Date[] = [];
  for (const [i, m] of mensajes.entries()) {
    const cuando = new Date(desde.getTime() + i * 60_000);
    fechas.push(cuando);
    await admin`
      insert into motor.messages (client_id, conversation_id, direction, body, is_clinical, purge_at, created_at, disproved_at)
      values (${CLINICA}, ${id}, ${m.entrante ? 'entrante' : 'saliente'}, ${m.texto}, ${m.clinico ?? false},
              ${new Date(cuando.getTime() + 365 * 86_400_000).toISOString()}, ${cuando.toISOString()},
              ${m.desmentido === true ? cuando.toISOString() : null})
    `;
  }
  return fechas;
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
  for (const tabla of ['audit_log', 'idempotency_keys', 'job_runs', 'escalations', 'messages', 'holds', 'conversations', 'patients']) {
    await admin.unsafe(`delete from motor.${tabla} where client_id = $1`, [CLINICA]);
  }
  await admin`delete from motor.clients where id = ${CLINICA}`;
  await admin`
    insert into motor.clients (id, slug, name, config, config_version)
    values (${CLINICA}, 'clinica-de-pruebas', 'Clínica', '{}'::jsonb, 'test')
  `;
  contador = 0;
});

describe('regla 6: cada turno deja lo que se le preguntó al modelo', () => {
  it('en el mensaje entrante: las llamadas, la latencia y los tokens sumados', async () => {
    await enviar('hola', agente([llamada({ tipo: 'clasificar', latenciaMs: 300, tokensEntrada: 50, tokensSalida: 10 }), llamada()]));

    const [fila] = await admin`
      select prompt, latency_ms, prompt_tokens, completion_tokens from motor.messages
       where client_id = ${CLINICA} and direction = 'entrante'
    `;
    const prompt = fila?.['prompt'] as { llamadas: Array<{ tipo: string; sistema: string }> };
    expect(prompt.llamadas.map((l) => l.tipo)).toEqual(['clasificar', 'redactar']);
    expect(prompt.llamadas[1]?.sistema).toBe('SISTEMA');
    expect(fila).toMatchObject({ latency_ms: 1100, prompt_tokens: 150, completion_tokens: 30 });
  });

  it('también en un turno que no redactó: la clasificación se hizo y cuenta', async () => {
    // El horario sale compuesto del YAML, sin redactor, pero antes se clasificó.
    const a = new AgenteFalso(new ClasificadorFalso([extraccion({ intencion: 'horario' })]), new RedactorFalso(), [
      llamada({ tipo: 'clasificar' }),
    ]);

    await enviar('¿qué horario tenéis?', a);

    const [fila] = await admin`select prompt from motor.messages where client_id = ${CLINICA} and direction = 'entrante'`;
    expect((fila?.['prompt'] as { llamadas: unknown[] }).llamadas).toHaveLength(1);
  });

  it('a los 90 días se borra el prompt, aunque la fila viva doce meses: puede llevar un mensaje clínico de la ventana', async () => {
    await enviar('hola', agente([llamada()]));
    await admin`
      update motor.messages set created_at = now() - interval '91 days'
       where client_id = ${CLINICA} and direction = 'entrante'
    `;

    await admin`select * from motor.purge_expired()`;

    const [fila] = await admin`
      select prompt, body, latency_ms from motor.messages where client_id = ${CLINICA} and direction = 'entrante'
    `;
    expect(fila?.['prompt']).toBeNull();
    // La telemetría de la regla 6 sobrevive; el texto de la fila sigue su plazo.
    expect(fila?.['latency_ms']).toBe(800);
    expect(fila?.['body']).toBe('hola');
  });
});

describe('el tope cuenta en una ventana de tiempo, no en toda la vida', () => {
  async function gastadas(cuando: Date, cuantas: number): Promise<void> {
    await enviar('hola', agente(), new Date(cuando.getTime() - 60_000));
    const { id } = await conversacion();
    await admin`
      insert into motor.messages (client_id, conversation_id, direction, body, is_clinical, purge_at, created_at, prompt)
      values (${CLINICA}, ${id}, 'entrante', 'x', false, now() + interval '1 year', ${cuando.toISOString()},
              ${JSON.stringify({ llamadas: Array.from({ length: cuantas }, () => llamada()) })}::jsonb)
    `;
  }

  it('las de la última hora cuentan, todas: clasificar, redactar, regenerar y resumir', async () => {
    await gastadas(new Date(AHORA.getTime() - 3_600_000), PRESUPUESTO.llamadasPorConversacionEnVentana);
    const a = agente();

    await enviar('hola otra vez', a);

    expect(a.contextos.at(-1)?.llamadasPrevias).toBe(PRESUPUESTO.llamadasPorConversacionEnVentana);
  });

  it('las de hace 25 horas ya no: una paciente de meses no agota el cupo por haber hablado mucho', async () => {
    await gastadas(new Date(AHORA.getTime() - 25 * 3_600_000), PRESUPUESTO.llamadasPorConversacionEnVentana);
    const a = agente();

    await enviar('hola otra vez', a);

    expect(a.contextos.at(-1)?.llamadasPrevias).toBe(0);
  });
});

describe('ventana de 8 turnos más resumen', () => {
  const ANTES = new Date(AHORA.getTime() - 2 * 3_600_000);

  it('lo que sale de la ventana se resume, y el siguiente turno lo lleva en el prompt', async () => {
    await enviar('hola', agente(), new Date(ANTES.getTime() - 60_000));
    // 20 mensajes de antes + los dos del primer turno: salen de la ventana los
    // seis más antiguos.
    await historial(
      Array.from({ length: 20 }, (_, i) => ({ texto: `mensaje ${i}`, entrante: i % 2 === 0 })),
      ANTES,
    );
    const a = agente();

    await enviar('¿y entonces?', a);

    expect(a.resumenesPedidos).toHaveLength(1);
    const [fila] = await admin`select summary, summary_until from motor.conversations where client_id = ${CLINICA}`;
    expect(fila?.['summary']).toMatch(/^Resumen de \d+ turnos\.$/);

    const siguiente = agente();
    await enviar('vale', siguiente, new Date(AHORA.getTime() + 60_000));
    expect(siguiente.contextos.at(-1)?.resumen).toBe(fila?.['summary']);
  });

  it('lo clínico y lo desmentido no entran en el resumen', async () => {
    await enviar('hola', agente(), new Date(ANTES.getTime() - 60_000));
    await historial(
      [
        { texto: 'tengo la zona un poco roja', entrante: true, clinico: true },
        { texto: 'Te la dejo apuntada el lunes a las 10:20', entrante: false, desmentido: true },
        { texto: '¿cuánto cuesta la limpieza?', entrante: true },
        { texto: 'Son 55 €.', entrante: false },
        ...Array.from({ length: 16 }, (_, i) => ({ texto: `relleno ${i}`, entrante: i % 2 === 0 })),
      ],
      ANTES,
    );
    const a = agente();

    await enviar('ok', a);

    const textos = a.resumenesPedidos.flatMap((r) => r.turnos.map((t) => t.texto));
    expect(textos).toContain('¿cuánto cuesta la limpieza?');
    expect(textos).not.toContain('tengo la zona un poco roja');
    expect(textos).not.toContain('Te la dejo apuntada el lunes a las 10:20');
  });

  it('no se resume en cada turno: hasta que no salen cuatro, no se llama', async () => {
    await enviar('hola', agente(), new Date(ANTES.getTime() - 60_000));
    await historial(
      Array.from({ length: 14 }, (_, i) => ({ texto: `mensaje ${i}`, entrante: i % 2 === 0 })),
      ANTES,
    );
    const a = agente();

    // 16 de antes + 2 de este turno = 18: salen dos.
    await enviar('¿y?', a);

    expect(a.resumenesPedidos).toEqual([]);
  });

  it('el resumen avanza también sobre lo que no resume: lo clínico no queda pendiente para siempre', async () => {
    await enviar('hola', agente(), new Date(ANTES.getTime() - 60_000));
    const fechas = await historial(
      Array.from({ length: 20 }, (_, i) => ({ texto: `clínico ${i}`, entrante: true, clinico: i < 6 })),
      ANTES,
    );

    await enviar('ok', agente());

    const [fila] = await admin`select summary_until from motor.conversations where client_id = ${CLINICA}`;
    // 2 del primer turno + 20 de historial + 2 de este turno = 24; la ventana
    // es de 16, así que salen los dos del primer turno y los seis primeros del
    // historial —todos clínicos—. No se resume nada y el resumen cubre igual
    // hasta el sexto.
    expect(new Date(String(fila?.['summary_until'])).getTime()).toBe(fechas[5]?.getTime());
  });
});
