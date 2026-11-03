import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Extraccion } from '../../src/agent/extraccion.js';
import { createCore, type Core } from '../../src/db/client.js';
import { procesarMensajeEntrante, type SalidaDeMensaje } from '../../src/service/pipeline.js';
import { accionRecepcion } from '../../src/service/reception.js';
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
 * Cuando la agenda no responde, el turno no se pierde.
 *
 * El 16-oct caducó el token de Google. El núcleo recibió un 500 de la agenda,
 * lanzó una excepción dentro de la transacción del turno y la transacción se
 * revirtió: el paciente no recibió nada (n8n no enviaba si no había
 * `respuesta`), el mensaje que escribió no quedó guardado, no hubo escalado, ni
 * siquiera clave de idempotencia. Y el texto que el error llevaba prometía
 * «te escribe una persona del equipo», que nadie iba a hacer.
 */

const CLINICA = 'a9e0c0de-a9e0-4de0-8de0-a9e0c0de0000';
const AHORA = new Date('2026-09-14T10:00:00.000Z');
const admin = conexionAdmin();
let core: Core;
let agenda: AgendaFalsa;
let contador = 0;

function extraccion(extra: Partial<Extraccion> = {}): Extraccion {
  return {
    intencion: 'agendar', servicio: 'laser-axilas', opcion: null, preferencia: null,
    escalar: null, cita: null, sustitucion: null, tema: null, ...extra,
  };
}

async function enviar(texto: string, guion: Extraccion = extraccion()): Promise<SalidaDeMensaje> {
  contador += 1;
  const deps = dependenciasDePrueba({ core, agenda, reloj: () => AHORA });
  const { cuerpo } = await procesarMensajeEntrante(
    { ...deps, agente: new AgenteFalso(new ClasificadorFalso([guion]), new RedactorFalso()) },
    { idempotencyKey: `caida-${contador}`, clientId: CLINICA, telefono: '+34600808080', nombre: 'Ana', texto },
  );
  return cuerpo;
}

const cuenta = async (sql: string): Promise<number> => {
  const [f] = await admin.unsafe(sql, [CLINICA]);
  return Number(f?.['n']);
};

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
  for (const tabla of ['outbox', 'audit_log', 'idempotency_keys', 'job_runs', 'escalations', 'messages', 'holds', 'conversations', 'patients']) {
    await admin.unsafe(`delete from motor.${tabla} where client_id = $1`, [CLINICA]);
  }
  await admin`delete from motor.clients where id = ${CLINICA}`;
  await admin`
    insert into motor.clients (id, slug, name, config, config_version)
    values (${CLINICA}, 'clinica-de-pruebas', 'Clínica', '{}'::jsonb, 'test')
  `;
  agenda = new AgendaFalsa();
  contador = 0;
});

describe('la agenda no responde y el paciente pide cita', () => {
  it('recibe un texto (respuesta, no un error), y no promete a nadie', async () => {
    agenda.fallar();

    const salida = await enviar('Quiero cita para axilas');

    expect(salida.respuesta).toMatch(/no consigo ver la agenda/i);
    expect(salida.respuesta).not.toMatch(/persona|equipo|te escribe|te escribo|enseguida/i);
  });

  it('el turno no se pierde: queda el mensaje, la respuesta y la clave de idempotencia', async () => {
    agenda.fallar();

    await enviar('Quiero cita para axilas');

    expect(await cuenta(`select count(*)::int n from motor.messages where client_id = $1 and direction = 'entrante'`)).toBe(1);
    expect(await cuenta(`select count(*)::int n from motor.messages where client_id = $1 and direction = 'saliente'`)).toBe(1);
    expect(await cuenta(`select count(*)::int n from motor.idempotency_keys where client_id = $1`)).toBe(1);
  });

  it('queda un escalado con su motivo, y sale como efecto', async () => {
    agenda.fallar();

    const salida = await enviar('Quiero cita para axilas');

    expect(await cuenta(`select count(*)::int n from motor.escalations where client_id = $1 and reason = 'agenda_no_disponible'`)).toBe(1);
    const efecto = salida.efectos.find((e) => e.tipo === 'escalar_a_humano');
    expect(efecto).toMatchObject({ motivo: 'agenda_no_disponible', severidad: 2 });
    expect(efecto?.texto).toMatch(/agenda no responde/i);
    // Es infraestructura: no va a recepción, va al operador por correo.
    expect(efecto?.destinatarios).toEqual([]);
    expect(await cuenta(`select count(*)::int n from motor.outbox where client_id = $1 and kind = 'correo_operador'`)).toBe(1);
  });

  it('no se crea ningún hueco: nada se propone sobre una agenda que no se ha podido leer', async () => {
    agenda.fallar();

    await enviar('Quiero cita para axilas');

    expect(await cuenta(`select count(*)::int n from motor.holds where client_id = $1`)).toBe(0);
  });

  it('si insiste, se le contesta cada vez pero no se avisa cada vez', async () => {
    agenda.fallar();

    await enviar('Quiero cita para axilas');
    const segundo = await enviar('Quiero cita para axilas');
    const tercero = await enviar('Quiero cita para axilas');

    expect(segundo.respuesta).toMatch(/no consigo ver la agenda/i);
    expect(tercero.respuesta).toMatch(/no consigo ver la agenda/i);
    expect(segundo.efectos.filter((e) => e.tipo === 'escalar_a_humano')).toEqual([]);
    expect(tercero.efectos.filter((e) => e.tipo === 'escalar_a_humano')).toEqual([]);
    expect(await cuenta(`select count(*)::int n from motor.escalations where client_id = $1 and reason = 'agenda_no_disponible'`)).toBe(1);
    expect(await cuenta(`select count(*)::int n from motor.audit_log where client_id = $1 and action = 'escalado_no_duplicado:agenda_no_disponible'`)).toBe(2);
  });

  it('conserva las opciones que ya tenía: no se caducan sin dar otras', async () => {
    await enviar('Quiero cita para axilas');
    const antes = await cuenta(`select count(*)::int n from motor.holds where client_id = $1 and state = 'propuesta'`);
    expect(antes).toBe(3);

    agenda.fallar();
    // Una preferencia nueva obligaría a volver a proponer, y por tanto a leer la agenda.
    await enviar('mejor por la tarde', extraccion({
      preferencia: { dias: [], diasExcluidos: [], franjas: ['tarde'], desde: null, horaExacta: null, cuantoAntes: false },
    }));

    expect(await cuenta(`select count(*)::int n from motor.holds where client_id = $1 and state = 'propuesta'`)).toBe(3);
  });

  it('cuando la agenda vuelve, el paciente recibe huecos', async () => {
    agenda.fallar();
    await enviar('Quiero cita para axilas');
    agenda.recuperar();

    const salida = await enviar('Quiero cita para axilas');

    expect(salida.respuesta).toContain('opcion 1');
    expect(await cuenta(`select count(*)::int n from motor.holds where client_id = $1 and state = 'propuesta'`)).toBe(3);
  });

  it('un error que NO es de la agenda sigue siendo un error: no se disfraza', async () => {
    agenda.fallar(new Error('fallo de programación'));

    await expect(enviar('Quiero cita para axilas')).rejects.toThrow('fallo de programación');
  });
});

describe('la agenda no responde en el paso 6', () => {
  const AUTOMATICA = registroDePrueba([
    {
      slug: 'clinica-de-pruebas',
      config: configDePrueba({
        agenda: { nivel: 'A', calendarioId: 'pruebas@group.calendar.google.com', confirmacion: 'automatica' },
        canal: { tipo: 'whatsapp', remitenteId: '000', chatwoot: { cuentaId: 7, inboxId: 42 } },
      }),
    },
  ]);

  async function enviarA(texto: string, guion: Extraccion, configuracion?: ReturnType<typeof registroDePrueba>) {
    contador += 1;
    const deps = dependenciasDePrueba({ core, agenda, reloj: () => AHORA, ...(configuracion === undefined ? {} : { configuracion }) });
    return procesarMensajeEntrante(
      { ...deps, agente: new AgenteFalso(new ClasificadorFalso([guion]), new RedactorFalso()) },
      { idempotencyKey: `caida-${contador}`, clientId: CLINICA, telefono: '+34600808080', nombre: 'Ana', texto },
      { por: 'chatwoot', cuentaId: 7, conversacionId: 1001 },
    );
  }

  it('en automática, al elegir: el turno sigue y la cita se encola; la relectura que decide es la del ejecutor', async () => {
    await enviarA('quiero cita de axilas', extraccion(), AUTOMATICA);
    agenda.fallarAlReleer();

    const { statusCode, cuerpo } = await enviarA('la primera', extraccion({ intencion: 'elegir_hueco', opcion: 1 }), AUTOMATICA);

    expect(statusCode).toBe(200);
    expect(cuerpo.respuesta).toBeNull();
    expect(await cuenta(`select count(*) as n from motor.holds where client_id = $1 and state = 'retenida'`)).toBe(1);
    expect(await cuenta(`select count(*) as n from motor.outbox where client_id = $1 and kind = 'evento_agenda'`)).toBe(1);
    expect(await cuenta(`select count(*) as n from motor.audit_log where client_id = $1 and action = 'relectura_en_turno:agenda_no_disponible'`)).toBe(1);
  });

  it('al confirmar recepción: no se confirma ni se toca nada, recepción sabe que tiene que volver a pulsar, y el reintento funciona', async () => {
    await enviar('quiero cita de axilas');
    const eleccion = await enviar('la primera', extraccion({ intencion: 'elegir_hueco', opcion: 1 }));
    const holdId = String(eleccion.holdId);
    agenda.fallarAlReleer();
    const deps = dependenciasDePrueba({ core, agenda, reloj: () => AHORA });

    const primera = await accionRecepcion(deps, { idempotencyKey: 'pulsar-1', clientId: CLINICA, holdId });

    expect(primera.statusCode).toBe(200);
    expect(primera.cuerpo.estado).toBe('agenda_no_disponible');
    expect(primera.cuerpo.respuesta).toBeNull();
    expect(primera.cuerpo.mensajeParaRecepcion).toMatch(/vuelve a pulsar/);
    expect(await cuenta(`select count(*) as n from motor.holds where client_id = $1 and state = 'pendiente_recepcion'`)).toBe(1);
    expect(await cuenta(`select count(*) as n from motor.escalations where client_id = $1 and reason = 'agenda_no_disponible'`)).toBe(1);
    // El operador lo sabe: agenda_no_disponible va a su correo.
    expect(await cuenta(`select count(*) as n from motor.outbox where client_id = $1 and kind = 'correo_operador'`)).toBe(1);

    agenda.recuperar();
    const segunda = await accionRecepcion(deps, { idempotencyKey: 'pulsar-1', clientId: CLINICA, holdId });

    expect(segunda.cuerpo.estado).toBe('confirmada');
  });
});
