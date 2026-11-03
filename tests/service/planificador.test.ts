import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createCore, type Core } from '../../src/db/client.js';
import type { CorreoSaliente } from '../../src/service/correo.js';
import { ejecutarSalida } from '../../src/service/ejecutor.js';
import { ejecutarTrabajo, pasarPlanificador, tocaEjecutar } from '../../src/service/planificador.js';
import { caducarRetenciones } from '../../src/service/vencimientos.js';
import { AgendaFalsa, configDePrueba, dependenciasDePrueba, registroDePrueba } from '../support/fakes.js';
import { APP_URL, conexionAdmin, prepararBaseDeDatos } from '../support/db.js';

/**
 * El planificador: los crons dentro del núcleo. Qué toca y cuándo (puro), y
 * que lo que emiten salga por el canal de cada conversación —sin n8n que lo
 * envíe—, en la misma transacción que el cambio de estado.
 */

const MADRID = 'Europe/Madrid';

describe('qué toca y cuándo', () => {
  const a = (iso: string) => new Date(iso);

  it('caducar, cada minuto; verificar, cada media hora; y la primera vez, siempre', () => {
    expect(tocaEjecutar('caducar-retenciones', undefined, a('2026-10-19T10:00:00Z'), MADRID)).toBe(true);
    expect(tocaEjecutar('caducar-retenciones', a('2026-10-19T09:59:30Z'), a('2026-10-19T10:00:00Z'), MADRID)).toBe(false);
    expect(tocaEjecutar('caducar-retenciones', a('2026-10-19T09:59:00.5Z'), a('2026-10-19T10:00:00Z'), MADRID)).toBe(true);
    expect(tocaEjecutar('verificar-citas', a('2026-10-19T09:40:00Z'), a('2026-10-19T10:00:00Z'), MADRID)).toBe(false);
    expect(tocaEjecutar('verificar-citas', a('2026-10-19T09:30:00Z'), a('2026-10-19T10:00:00Z'), MADRID)).toBe(true);
  });

  it('derechos: a las 09:05 en hora de la clínica, no en UTC', () => {
    // 09:04 en Madrid (07:04 UTC, verano): todavía no.
    expect(tocaEjecutar('vigilar-derechos', undefined, a('2026-10-19T07:04:00Z'), MADRID)).toBe(false);
    expect(tocaEjecutar('vigilar-derechos', undefined, a('2026-10-19T07:05:00Z'), MADRID)).toBe(true);
    // En Canarias es una hora menos que en Madrid: a esa misma hora UTC aún no toca.
    expect(tocaEjecutar('vigilar-derechos', undefined, a('2026-10-19T07:05:00Z'), 'Atlantic/Canary')).toBe(false);
    // Tras el cambio de hora (invierno, UTC+1), las 09:05 son las 08:05 UTC.
    expect(tocaEjecutar('vigilar-derechos', undefined, a('2026-10-26T07:05:00Z'), MADRID)).toBe(false);
    expect(tocaEjecutar('vigilar-derechos', undefined, a('2026-10-26T08:05:00Z'), MADRID)).toBe(true);
  });

  it('derechos: una vez al día, y un reinicio no lo repite; una caída por la mañana lo hace al volver', () => {
    const hechoHoy = a('2026-10-19T07:06:00Z');
    expect(tocaEjecutar('vigilar-derechos', hechoHoy, a('2026-10-19T12:00:00Z'), MADRID)).toBe(false);
    expect(tocaEjecutar('vigilar-derechos', a('2026-10-18T07:06:00Z'), a('2026-10-19T09:30:00Z'), MADRID)).toBe(true);
    // Corrió hoy, pero de madrugada (antes de las 09:05): no cuenta como el de hoy.
    expect(tocaEjecutar('vigilar-derechos', a('2026-10-19T02:00:00Z'), a('2026-10-19T08:00:00Z'), MADRID)).toBe(true);
  });

  it('consolidar: el día 1 desde las 02:00 UTC, una vez al mes; y si el día 1 estaba caído, al volver', () => {
    expect(tocaEjecutar('consolidar-periodo', a('2026-10-01T02:00:00Z'), a('2026-10-01T01:59:00Z'), MADRID)).toBe(false);
    expect(tocaEjecutar('consolidar-periodo', a('2026-09-01T02:00:00Z'), a('2026-10-01T02:00:00Z'), MADRID)).toBe(true);
    expect(tocaEjecutar('consolidar-periodo', a('2026-10-01T02:00:30Z'), a('2026-10-01T05:00:00Z'), MADRID)).toBe(false);
    expect(tocaEjecutar('consolidar-periodo', a('2026-09-01T02:00:00Z'), a('2026-10-03T09:00:00Z'), MADRID)).toBe(true);
  });
});

const CLINICA = 'b1a0c000-0000-4000-8000-0000000b1a0c';
const PACIENTE = 'b1a0c111-0000-4000-8000-0000000b1a0c';
const CONVERSACION = 'b1a0c222-0000-4000-8000-0000000b1a0c';
/** Martes 15 de septiembre de 2026, 12:00 en Madrid: dentro de la franja. */
const AHORA = new Date('2026-09-15T10:00:00.000Z');
const CHATWOOT = { por: 'chatwoot', cuentaId: 7, conversacionId: 1001 };

const admin = conexionAdmin();
let core: Core;

const CONFIG = registroDePrueba([
  {
    slug: 'clinica-de-pruebas',
    config: configDePrueba({ canal: { tipo: 'whatsapp', remitenteId: '000', chatwoot: { cuentaId: 7, inboxId: 42 } } }),
  },
]);

function deps(ahora = AHORA) {
  return dependenciasDePrueba({ core, agenda: new AgendaFalsa(), reloj: () => ahora, configuracion: CONFIG });
}

async function salida(kind: string): Promise<Array<Record<string, unknown>>> {
  return (await admin`select payload from motor.outbox where client_id = ${CLINICA} and kind = ${kind} order by created_at`).map(
    (f) => f['payload'] as Record<string, unknown>,
  );
}

async function hueco(estado: string, desdeHaceMin: number, slot: string, avisado = false): Promise<void> {
  const cambiado = new Date(AHORA.getTime() - desdeHaceMin * 60_000).toISOString();
  await admin`
    insert into motor.holds (client_id, patient_id, conversation_id, slot_start, slot_end, service_code, state,
                             state_changed_at, reception_notified_at)
    values (${CLINICA}, ${PACIENTE}, ${CONVERSACION}, ${slot}, ${new Date(new Date(slot).getTime() + 20 * 60_000).toISOString()},
            'laser-axilas', ${estado}::motor.hold_state, ${cambiado}, ${avisado ? cambiado : null})
  `;
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
  for (const tabla of ['outbox', 'audit_log', 'idempotency_keys', 'job_runs', 'rights_requests', 'appointments', 'escalations', 'messages', 'holds', 'conversations', 'patients', 'period_metrics']) {
    await admin.unsafe(`delete from motor.${tabla} where client_id = $1`, [CLINICA]);
  }
  await admin`delete from motor.clients where id = ${CLINICA}`;
  await admin`insert into motor.clients (id, slug, name, config, config_version) values (${CLINICA}, 'clinica-de-pruebas', 'Clínica', '{}'::jsonb, 'test')`;
  await admin`insert into motor.patients (id, client_id, given_name, phone_e164) values (${PACIENTE}, ${CLINICA}, 'Marta', '+34600333222')`;
  await admin`
    insert into motor.conversations (id, client_id, patient_id, reply_channel)
    values (${CONVERSACION}, ${CLINICA}, ${PACIENTE}, ${JSON.stringify(CHATWOOT)}::jsonb)
  `;
});

describe('lo que emite un cron sale por el canal de la conversación', () => {
  /** El paciente escribió hace `horas` horas: de eso depende la ventana de 24 h de WhatsApp. */
  async function escribioHace(horas: number): Promise<void> {
    await admin`
      insert into motor.messages (client_id, conversation_id, direction, body, is_clinical, purge_at, created_at)
      values (${CLINICA}, ${CONVERSACION}, 'entrante', 'hola', false, now() + interval '1 year',
              ${new Date(AHORA.getTime() - horas * 3_600_000).toISOString()})
    `;
  }

  it('una propuesta que caduca, dentro de las 24 h: el aviso va al paciente por Chatwoot, como mensaje y no como nota', async () => {
    await escribioHace(7);
    await hueco('propuesta', 7 * 60, '2026-09-20T09:00:00.000Z');

    await ejecutarTrabajo(deps(), CLINICA, 'caducar-retenciones');

    const [mensaje] = await salida('chatwoot');
    expect(mensaje).toMatchObject({ cuentaId: 7, conversacionId: 1001, privado: false });
    expect(mensaje?.['plantilla']).toBeUndefined();
    expect(String(mensaje?.['texto'])).toMatch(/láser axilas/);
  });

  it('fuera de las 24 h y con plantilla en el YAML: sale la plantilla, con sus valores en el orden configurado', async () => {
    await escribioHace(30);
    await hueco('propuesta', 7 * 60, '2026-09-20T09:00:00.000Z');
    const conPlantilla = registroDePrueba([
      {
        slug: 'clinica-de-pruebas',
        config: configDePrueba({
          canal: { tipo: 'whatsapp', remitenteId: '000', chatwoot: { cuentaId: 7, inboxId: 42 } },
          plantillas: { propuesta_caducada: { nombre: 'propuesta_caducada', idioma: 'es', variables: ['nombre', 'servicio', 'clinica'] } },
        }),
      },
    ]);

    await ejecutarTrabajo(
      dependenciasDePrueba({ core, agenda: new AgendaFalsa(), reloj: () => AHORA, configuracion: conPlantilla }),
      CLINICA,
      'caducar-retenciones',
    );

    const [mensaje] = await salida('chatwoot');
    expect(mensaje?.['plantilla']).toEqual({ nombre: 'propuesta_caducada', idioma: 'es', parametros: ['Marta', 'Láser axilas', 'Clínica de Pruebas'] });
  });

  it('fuera de las 24 h y sin plantilla: no se manda un texto que Meta va a tirar; lo sabe el operador', async () => {
    await escribioHace(30);
    await hueco('propuesta', 7 * 60, '2026-09-20T09:00:00.000Z');

    await ejecutarTrabajo(deps(), CLINICA, 'caducar-retenciones');

    expect(await salida('chatwoot')).toEqual([]);
    const [correo] = await salida('correo_operador');
    expect(String(correo?.['cuerpo'])).toMatch(/falta la plantilla «propuesta_caducada»/);
    expect(JSON.stringify(correo)).not.toMatch(/Marta|34600333222/);
  });

  it('un recordatorio a recepción: nota privada en esa conversación', async () => {
    await hueco('pendiente_recepcion', 2 * 60 + 5, '2026-09-20T09:00:00.000Z', true);

    await ejecutarTrabajo(deps(), CLINICA, 'caducar-retenciones');

    const notas = (await salida('chatwoot')).filter((m) => m['privado'] === true);
    expect(notas.length).toBeGreaterThan(0);
    expect(await salida('whatsapp')).toEqual([]);
  });

  it('una conversación que nunca entró por el núcleo no tiene por dónde salir: lo sabe el operador', async () => {
    await admin`update motor.conversations set reply_channel = null where id = ${CONVERSACION}`;
    await hueco('propuesta', 7 * 60, '2026-09-20T09:00:00.000Z');

    await ejecutarTrabajo(deps(), CLINICA, 'caducar-retenciones');

    expect(await salida('chatwoot')).toEqual([]);
    const [correo] = await salida('correo_operador');
    expect(String(correo?.['asunto'])).toMatch(/no tiene por dónde salir/);
    expect(JSON.stringify(correo)).not.toContain('34600333222');
  });

  it('se encola en la misma transacción: si lo que encola falla, el cambio de estado tampoco queda', async () => {
    await hueco('propuesta', 7 * 60, '2026-09-20T09:00:00.000Z');

    await expect(
      caducarRetenciones(deps(), { clientId: CLINICA }, () => Promise.reject(new Error('la salida no se pudo encolar'))),
    ).rejects.toThrow('la salida no se pudo encolar');

    // El hueco sigue como estaba: no hay una caducidad sin su aviso.
    expect((await admin`select state from motor.holds where client_id = ${CLINICA}`)[0]?.['state']).toBe('propuesta');
  });
});

describe('derechos: el aviso del plazo llega a protección de datos por su canal', () => {
  it('a los 20 días, correo a quien la clínica designó (no a recepción) y nota en la conversación', async () => {
    const recibida = new Date(AHORA.getTime() - 21 * 86_400_000);
    await admin`
      insert into motor.rights_requests (client_id, patient_id, conversation_id, kind, received_at, transfer_due_at, answer_due_at)
      values (${CLINICA}, ${PACIENTE}, ${CONVERSACION}, 'supresion', ${recibida.toISOString()},
              ${new Date(recibida.getTime() + 2 * 86_400_000).toISOString()}, ${new Date(recibida.getTime() + 30 * 86_400_000).toISOString()})
    `;

    await ejecutarTrabajo(deps(), CLINICA, 'vigilar-derechos');

    const correos = await salida('correo');
    expect(correos.map((c) => c['correoA'])).toEqual(['datos@clinica.example']); // proteccionDeDatos de configDePrueba
    expect((await salida('chatwoot')).filter((m) => m['privado'] === true)).toHaveLength(1);
  });

  it('y el ejecutor manda ese correo a su destinatario, no al operador', async () => {
    const recibida = new Date(AHORA.getTime() - 21 * 86_400_000);
    await admin`
      insert into motor.rights_requests (client_id, patient_id, conversation_id, kind, received_at, transfer_due_at, answer_due_at)
      values (${CLINICA}, ${PACIENTE}, ${CONVERSACION}, 'supresion', ${recibida.toISOString()},
              ${new Date(recibida.getTime() + 2 * 86_400_000).toISOString()}, ${new Date(recibida.getTime() + 30 * 86_400_000).toISOString()})
    `;
    await ejecutarTrabajo(deps(), CLINICA, 'vigilar-derechos');
    const enviados: string[] = [];
    const correo: CorreoSaliente = {
      enviar: (m) => {
        enviados.push(m.para);
        return Promise.resolve();
      },
      comprobar: () => Promise.resolve(true),
      cerrar: () => undefined,
    };

    await ejecutarSalida(core, CLINICA, { correo, operador: 'op@x.test', ahora: AHORA });

    expect(enviados).toContain('datos@clinica.example');
    expect(enviados).not.toContain('op@x.test');
  });
});

describe('una pasada', () => {
  it('la primera ejecuta todo lo que toca y deja su latido; la siguiente, en el mismo minuto, nada', async () => {
    const dia1 = new Date('2026-10-01T08:00:00.000Z'); // día 1, 10:00 en Madrid

    const primera = await pasarPlanificador(deps(dia1), CLINICA, MADRID);
    const segunda = await pasarPlanificador(deps(new Date(dia1.getTime() + 10_000)), CLINICA, MADRID);

    expect(primera.fallos).toEqual([]);
    expect(primera.hechos.map((h) => h.trabajo).sort()).toEqual(
      ['caducar-retenciones', 'consolidar-periodo', 'presumir-asistencia', 'recordatorios', 'relacion-de-asistencia', 'verificar-citas', 'vigilar-derechos'].sort(),
    );
    expect(segunda.hechos).toEqual([]);
    const latidos = await admin`select job from motor.job_runs where client_id = ${CLINICA} order by job`;
    expect(latidos.map((f) => f['job'])).toEqual([
      'caducar-retenciones',
      'consolidar-periodo',
      'presumir-asistencia',
      'recordatorios',
      'relacion-de-asistencia',
      'verificar-citas',
      'vigilar-derechos',
    ]);
  });
});
