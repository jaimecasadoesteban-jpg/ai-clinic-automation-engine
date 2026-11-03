import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createCore, type Core } from '../../src/db/client.js';
import { generarInforme } from '../../src/service/informe.js';
import { ejecutarOleada } from '../../src/service/oleadas.js';
import { procesarMensajeEntrante } from '../../src/service/pipeline.js';
import { caducarRetenciones } from '../../src/service/vencimientos.js';
import { verificarCitas } from '../../src/service/verificacion.js';
import { AgendaFalsa, dependenciasDePrueba, huecosDesde } from '../support/fakes.js';
import { APP_URL, conexionAdmin, prepararBaseDeDatos } from '../support/db.js';

/** Los cuatro endpoints de mantenimiento. El primero es el que devuelve la vida a la máquina. */

const CLINICA = 'dddd0000-dddd-4ddd-8ddd-dddd00000000';
const PACIENTE = 'dddd1111-dddd-4ddd-8ddd-dddd11111111';
const CONVERSACION = 'dddd2222-dddd-4ddd-8ddd-dddd22222222';
const OLEADA = 'dddd3333-dddd-4ddd-8ddd-dddd33333333';

/** Martes 15 de septiembre de 2026, 12:00 en Madrid (dentro de la franja). */
const MEDIODIA = new Date('2026-09-15T10:00:00.000Z');
/** Las 03:00 de Madrid del día siguiente: fuera de la franja, y con todo ya vencido. */
const MADRUGADA = new Date('2026-09-16T01:00:00.000Z');

const admin = conexionAdmin();
let core: Core;
let agenda: AgendaFalsa;

function deps(reloj: () => Date = () => MEDIODIA) {
  return dependenciasDePrueba({ core, agenda, reloj });
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
  for (const tabla of [
    'audit_log',
    'idempotency_keys',
    'job_runs',
    'rights_requests',
    'appointments',
    'escalations',
    'wave_recipients',
    'waves',
    'messages',
    'holds',
    'conversations',
    'suppression',
    'patients',
  ]) {
    await admin.unsafe(`delete from motor.${tabla} where client_id = $1`, [CLINICA]);
  }
  await admin`delete from motor.clients where id = ${CLINICA}`;
  await admin`
    insert into motor.clients (id, slug, name, config, config_version)
    values (${CLINICA}, 'clinica-de-pruebas', 'Clínica', '{}'::jsonb, 'test')
  `;
  await admin`
    insert into motor.patients (id, client_id, given_name, phone_e164)
    values (${PACIENTE}, ${CLINICA}, 'Marta', '+34600222111')
  `;
  await admin`
    insert into motor.conversations (id, client_id, patient_id)
    values (${CONVERSACION}, ${CLINICA}, ${PACIENTE})
  `;
  agenda = new AgendaFalsa(huecosDesde(new Date('2026-09-20T09:00:00.000Z'), 3));
});

async function crearHueco(
  estado: string,
  desdeHace: number,
  slot = '2026-09-20T09:00:00.000Z',
): Promise<string> {
  const cambiado = new Date(MEDIODIA.getTime() - desdeHace * 60_000);
  // Un `pendiente_recepcion` normal ya tiene a recepción avisada; el caso del
  // aviso diferido se construye aparte, poniendo reception_notified_at a null.
  const avisado = estado === 'pendiente_recepcion' ? cambiado.toISOString() : null;
  const filas = await admin`
    insert into motor.holds
      (client_id, patient_id, conversation_id, slot_start, slot_end, service_code, state,
       state_changed_at, reception_notified_at)
    values (${CLINICA}, ${PACIENTE}, ${CONVERSACION}, ${slot},
            ${new Date(new Date(slot).getTime() + 30 * 60_000).toISOString()}, 'laser-axilas',
            ${estado}::motor.hold_state, ${cambiado.toISOString()}, ${avisado})
    returning id
  `;
  return String(filas[0]?.['id']);
}

describe('/caducar-retenciones: la máquina de estados deja de estar inerte', () => {
  it('una propuesta de hace 7 h caduca y avisa al paciente', async () => {
    const id = await crearHueco('propuesta', 7 * 60);

    const salida = await caducarRetenciones(deps(), { clientId: CLINICA });

    expect(salida.aplicados).toHaveLength(1);
    expect(salida.aplicados[0]).toMatchObject({ holdId: id, desde: 'propuesta', hasta: 'caducada' });
    expect(salida.aplicados[0]?.efectos.map((e) => e.tipo)).toContain('mensaje_al_paciente');

    const estado = await admin`select state from motor.holds where id = ${id}`;
    expect(estado[0]?.['state']).toBe('caducada');
  });

  it('una retención de hace 10 min no caduca todavía', async () => {
    await crearHueco('retenida', 10);

    const salida = await caducarRetenciones(deps(), { clientId: CLINICA });

    expect(salida.aplicados).toEqual([]);
  });

  it('pendiente_recepcion a las 2 h recuerda, y a las 4 h escala', async () => {
    const id = await crearHueco('pendiente_recepcion', 150);

    const primera = await caducarRetenciones(deps(), { clientId: CLINICA });
    expect(primera.aplicados[0]?.efectos.map((e) => e.tipo)).toEqual(['recordar_a_recepcion']);

    // Cuatro horas después del cambio de estado.
    const masTarde = new Date(MEDIODIA.getTime() + 120 * 60_000);
    const segunda = await caducarRetenciones(deps(() => masTarde), { clientId: CLINICA });
    expect(segunda.aplicados[0]?.efectos.map((e) => e.tipo)).toEqual(['escalar_a_humano']);

    const escalados = await admin`
      select reason from motor.escalations where client_id = ${CLINICA} and hold_id = ${id}
    `;
    expect(escalados.map((f) => f['reason'])).toEqual(['sin_respuesta_recepcion']);
  });

  it('no repite el recordatorio ni el escalado', async () => {
    await crearHueco('pendiente_recepcion', 150);

    await caducarRetenciones(deps(), { clientId: CLINICA });
    const segunda = await caducarRetenciones(deps(), { clientId: CLINICA });

    expect(segunda.aplicados).toEqual([]);
  });
});

describe('cien vencimientos acumulados no son cien mensajes de golpe', () => {
  it('a las tres de la mañana no se procesa nada, y se informa de cuántos esperan', async () => {
    for (let i = 0; i < 3; i += 1) {
      await crearHueco('propuesta', 7 * 60, `2026-09-2${i}T09:00:00.000Z`);
    }

    const salida = await caducarRetenciones(deps(() => MADRUGADA), { clientId: CLINICA });

    // Nadie recibe «tu propuesta ha caducado» de madrugada.
    expect(salida.diferidoPorHorario).toBe(true);
    expect(salida.aplicados).toEqual([]);
    expect(salida.restantes).toBe(3);

    const estados = await admin`
      select distinct state from motor.holds where client_id = ${CLINICA}
    `;
    expect(estados.map((f) => f['state'])).toEqual(['propuesta']);
  });

  it('el lote está acotado y se drena en varias llamadas', async () => {
    for (let i = 0; i < 5; i += 1) {
      await crearHueco('propuesta', 7 * 60 + i, `2026-09-2${i}T09:00:00.000Z`);
    }

    const primera = await caducarRetenciones(deps(), { clientId: CLINICA, limite: 2 });
    expect(primera.aplicados).toHaveLength(2);
    expect(primera.restantes).toBe(3);

    const segunda = await caducarRetenciones(deps(), { clientId: CLINICA, limite: 2 });
    expect(segunda.aplicados).toHaveLength(2);
    expect(segunda.restantes).toBe(1);
  });

  it('procesa los más antiguos primero: nadie se queda atrás por el atasco', async () => {
    const viejo = await crearHueco('propuesta', 20 * 60, '2026-09-20T09:00:00.000Z');
    await crearHueco('propuesta', 7 * 60, '2026-09-21T09:00:00.000Z');

    const salida = await caducarRetenciones(deps(), { clientId: CLINICA, limite: 1 });

    expect(salida.aplicados[0]?.holdId).toBe(viejo);
  });
});

describe('dos llamadas solapadas se reparten el trabajo', () => {
  it('cada hueco lo procesa una sola de las dos ejecuciones', async () => {
    // La protección es `FOR UPDATE SKIP LOCKED`, que vive en Postgres. Si se
    // pudiera probar en secuencia, no estaría probando la restricción.
    for (let i = 0; i < 4; i += 1) {
      await crearHueco('propuesta', 7 * 60 + i, `2026-09-2${i}T09:00:00.000Z`);
    }
    const otroCore = createCore(APP_URL);

    try {
      const [a, b] = await Promise.all([
        caducarRetenciones(deps(), { clientId: CLINICA }),
        caducarRetenciones(dependenciasDePrueba({ core: otroCore, agenda, reloj: () => MEDIODIA }), {
          clientId: CLINICA,
        }),
      ]);

      const ids = [...a.aplicados, ...b.aplicados].map((x) => x.holdId);
      // Ninguno procesado dos veces, y entre las dos se han hecho los cuatro.
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toHaveLength(4);
    } finally {
      await otroCore.close();
    }
  });
});

describe('/verificar-citas: red de seguridad del paso 8', () => {
  it('si el hueco confirmado aparece libre en la agenda, se detecta y se escala', async () => {
    const id = await crearHueco('confirmada', 30);

    // La agenda dice que está libre: la cita no llegó a existir en el programa
    // de la clínica, o alguien la borró.
    const salida = await verificarCitas(deps(), { clientId: CLINICA });

    expect(salida.colisiones).toBe(1);
    expect(salida.verificados[0]).toMatchObject({ holdId: id, estado: 'colisionada' });

    const escalados = await admin`
      select severity from motor.escalations where client_id = ${CLINICA} and hold_id = ${id}
    `;
    // 2 y no 3: es operativo, no clínico. La 3 despierta al contacto clínico.
    expect(escalados[0]?.['severity']).toBe(2);
  });

  it('y el escalado SALE: con a quién va, qué cita es y el motivo de verdad', async () => {
    // Se creaba la fila en `escalations` y la respuesta sólo decía
    // `colisiones: 1`: nadie se enteraba hasta el día de la cita.
    await crearHueco('confirmada', 30);

    const salida = await verificarCitas(deps(), { clientId: CLINICA });

    const [efecto] = salida.efectos;
    expect(efecto).toMatchObject({ tipo: 'escalar_a_humano', motivo: 'agenda_no_escrita', severidad: 2 });
    expect(efecto?.destinatarios.length).toBeGreaterThan(0);
    // Dice qué cita, no «cita sin confirmar, a punto de caducar» sobre una
    // cita que estaba confirmada.
    expect(efecto?.texto).toMatch(/domingo 20/);
    expect(efecto?.texto).toMatch(/no aparece en la agenda/);
    expect(efecto?.texto).not.toMatch(/sin confirmar/i);
  });

  it('una vez por cita, no una cada 30 minutos', async () => {
    const id = await crearHueco('confirmada', 30);

    await verificarCitas(deps(), { clientId: CLINICA });
    const segunda = await verificarCitas(deps(), { clientId: CLINICA });

    expect(segunda.colisiones).toBe(1);
    expect(segunda.efectos).toEqual([]);
    const escalados = await admin`select id from motor.escalations where hold_id = ${id}`;
    expect(escalados).toHaveLength(1);
  });

  it('si recepción la mete y luego vuelve a desaparecer, se vuelve a avisar', async () => {
    const id = await crearHueco('confirmada', 30);
    await verificarCitas(deps(), { clientId: CLINICA });

    agenda.ocupar(new Date('2026-09-20T09:00:00.000Z'), new Date('2026-09-20T09:30:00.000Z'));
    expect((await verificarCitas(deps(), { clientId: CLINICA })).colisiones).toBe(0);

    agenda = new AgendaFalsa();
    const otraVez = await verificarCitas(deps(), { clientId: CLINICA });

    expect(otraVez.efectos).toHaveLength(1);
    const escalados = await admin`select id from motor.escalations where hold_id = ${id}`;
    expect(escalados).toHaveLength(2);
  });

  it('si el hueco sigue ocupado en la agenda, todo correcto', async () => {
    const id = await crearHueco('confirmada', 30);
    agenda.ocupar(
      new Date('2026-09-20T09:00:00.000Z'),
      new Date('2026-09-20T09:30:00.000Z'),
    );

    const salida = await verificarCitas(deps(), { clientId: CLINICA });

    expect(salida.colisiones).toBe(0);
    expect(salida.verificados[0]).toMatchObject({ holdId: id, estado: 'ok' });
  });
});

describe('/oleada/ejecutar', () => {
  async function crearOleada(aprobada: boolean): Promise<void> {
    await admin`
      insert into motor.waves (id, client_id, name, segment, template_ref, state, approved_at, approved_by)
      values (${OLEADA}, ${CLINICA}, 'Reactivación', '{"mesesSinVisita": 6}'::jsonb,
              'Hola, hace tiempo que no nos vemos.', 'ejecutando',
              ${aprobada ? MEDIODIA.toISOString() : null}, ${aprobada ? 'Dirección de la clínica' : null})
    `;
    await admin`
      insert into motor.wave_recipients (client_id, wave_id, patient_id)
      values (${CLINICA}, ${OLEADA}, ${PACIENTE})
    `;
  }

  it('sin aprobación registrada, la oleada NO se ejecuta', async () => {
    await crearOleada(false);

    await expect(
      ejecutarOleada(deps(), { idempotencyKey: 'o1', clientId: CLINICA, waveId: OLEADA }),
    ).rejects.toMatchObject({ code: 'oleada_sin_aprobacion' });

    const enviados = await admin`
      select count(*)::int as n from motor.wave_recipients
      where client_id = ${CLINICA} and state <> 'pendiente'
    `;
    expect(enviados[0]?.['n']).toBe(0);
  });

  it('con aprobación, devuelve los destinatarios', async () => {
    await crearOleada(true);

    const salida = await ejecutarOleada(deps(), {
      idempotencyKey: 'o2',
      clientId: CLINICA,
      waveId: OLEADA,
    });

    expect(salida.destinatarios).toHaveLength(1);
    expect(salida.destinatarios[0]?.telefono).toBe('+34600222111');
    expect(salida.suprimidos).toBe(0);
  });

  it('quien se dio de baja DESPUÉS de construir el segmento no recibe nada', async () => {
    await crearOleada(true);

    // La baja llega entre la construcción del segmento y el envío. Es el hueco
    // real: entre una cosa y otra pueden pasar días.
    const { hashTelefono } = await import('../../src/core/phone.js');
    const hash = hashTelefono('+34600222111', 'pimienta-de-pruebas-no-es-un-secreto');
    await admin`
      insert into motor.suppression (client_id, patient_id, phone_hash, reason)
      values (${CLINICA}, ${PACIENTE}, ${hash}, 'baja_solicitada')
    `;

    const salida = await ejecutarOleada(deps(), {
      idempotencyKey: 'o3',
      clientId: CLINICA,
      waveId: OLEADA,
    });

    // Ni un destinatario. Escribirle sería un problema legal, no comercial.
    expect(salida.destinatarios).toEqual([]);
    expect(salida.suprimidos).toBe(1);

    const estado = await admin`
      select state from motor.wave_recipients where client_id = ${CLINICA}
    `;
    expect(estado[0]?.['state']).toBe('suprimido');
  });

  it('de madrugada tampoco se manda publicidad', async () => {
    await crearOleada(true);

    const salida = await ejecutarOleada(deps(() => MADRUGADA), {
      idempotencyKey: 'o4',
      clientId: CLINICA,
      waveId: OLEADA,
    });

    expect(salida.diferidoPorHorario).toBe(true);
    expect(salida.destinatarios).toEqual([]);
  });
});

describe('/informe/:clientId', () => {
  it('devuelve las cifras del periodo y la carga diaria de escalados', async () => {
    await procesarMensajeEntrante(deps(), {
      idempotencyKey: 'i1',
      clientId: CLINICA,
      telefono: '+34600222999',
      nombre: 'Lucía',
      texto: 'me sale pus de la herida',
    });
    await procesarMensajeEntrante(deps(), {
      idempotencyKey: 'i2',
      clientId: CLINICA,
      telefono: '+34600222998',
      nombre: 'Ana',
      texto: 'cuanto cuesta el laser?',
    });

    const informe = await generarInforme(deps(), {
      clientId: CLINICA,
      desde: '2026-09-15',
      hasta: '2026-09-15',
    });

    expect(informe.mensajesEntrantes).toBe(2);
    expect(informe.cortesPorCategoria).toEqual([
      { categoria: 'urgencia_clinica', total: 1, porDia: 1 },
    ]);
    // La cifra que dice si recepción va a dejar de mirar los avisos.
    expect(informe.escalados.map((e) => e.motivo)).toContain('urgencia_clinica');
    expect(informe.dias).toBe(1);
  });
});
