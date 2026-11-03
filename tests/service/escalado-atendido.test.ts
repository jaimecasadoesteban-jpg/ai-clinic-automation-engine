import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createCore, type Core } from '../../src/db/client.js';
import { EscaladoInexistenteError, marcarEscaladoAtendido } from '../../src/service/appointments.js';
import { AgendaFalsa, dependenciasDePrueba } from '../support/fakes.js';
import { APP_URL, conexionAdmin, prepararBaseDeDatos } from '../support/db.js';

/**
 * Marcar un escalado como atendido: la única salida de una conversación parada.
 *
 * La función existía y nada la exponía. Antes de ponerle un botón delante había
 * que arreglarle tres cosas, porque un botón lo pulsa cualquiera y lo pulsa dos
 * veces: reabría aunque otro escalado siguiera parando la conversación, no
 * dejaba constancia de quién lo atendió, y no era idempotente.
 */

const CLINICA = 'abab0000-abab-4bab-8bab-abab00000000';
const OTRA = 'abab9999-abab-4bab-8bab-abab99999999';
const PACIENTE = 'abab1111-abab-4bab-8bab-abab11111111';
const CONVERSACION = 'abab2222-abab-4bab-8bab-abab22222222';
const AHORA = new Date('2026-09-15T10:00:00.000Z');

const admin = conexionAdmin();
let core: Core;
let clave = 0;

function atender(escaladoId: string, extra: { atendidoPor?: string; idempotencyKey?: string; clientId?: string } = {}) {
  clave += 1;
  return marcarEscaladoAtendido(dependenciasDePrueba({ core, agenda: new AgendaFalsa(), reloj: () => AHORA }), {
    idempotencyKey: extra.idempotencyKey ?? `atender-${clave}`,
    clientId: extra.clientId ?? CLINICA,
    escaladoId,
    atendidoPor: extra.atendidoPor ?? 'Recepción',
  });
}

async function escalado(reason: string, severity = 2): Promise<string> {
  const [fila] = await admin`
    insert into motor.escalations (client_id, conversation_id, patient_id, reason, severity, created_at)
    values (${CLINICA}, ${CONVERSACION}, ${PACIENTE}, ${reason}::motor.escalation_reason, ${severity}, ${AHORA.toISOString()})
    returning id
  `;
  return String(fila?.['id']);
}

async function estadoDeLaConversacion(): Promise<string> {
  const [fila] = await admin`select status from motor.conversations where id = ${CONVERSACION}`;
  return String(fila?.['status']);
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
  for (const id of [CLINICA, OTRA]) {
    for (const tabla of ['audit_log', 'idempotency_keys', 'escalations', 'messages', 'holds', 'conversations', 'patients']) {
      await admin.unsafe(`delete from motor.${tabla} where client_id = $1`, [id]);
    }
    await admin`delete from motor.clients where id = ${id}`;
  }
  await admin`
    insert into motor.clients (id, slug, name, config, config_version)
    values (${CLINICA}, 'clinica-de-pruebas', 'Clínica', '{}'::jsonb, 'test'),
           (${OTRA}, 'otra-clinica', 'Otra', '{}'::jsonb, 'test')
  `;
  await admin`
    insert into motor.patients (id, client_id, given_name, phone_e164)
    values (${PACIENTE}, ${CLINICA}, 'Marta', '+34600444555')
  `;
  await admin`
    insert into motor.conversations (id, client_id, patient_id, status, paused_at, pause_reason)
    values (${CONVERSACION}, ${CLINICA}, ${PACIENTE}, 'pausada', ${AHORA.toISOString()}, 'urgencia_clinica')
  `;
});

describe('reanuda lo que paró, y sólo eso', () => {
  it('atendida la urgencia que la pausó, el agente vuelve a contestar', async () => {
    const urgencia = await escalado('urgencia_clinica', 3);

    const salida = await atender(urgencia);

    expect(salida).toMatchObject({ estado: 'atendida', estadoConversacion: 'abierta', sigueParadaPor: [] });
    expect(await estadoDeLaConversacion()).toBe('abierta');
  });

  it('con una urgencia abierta, atender la queja NO reabre: el agente no charla encima de una urgencia', async () => {
    const urgencia = await escalado('urgencia_clinica', 3);
    const queja = await escalado('queja');

    const salida = await atender(queja);

    expect(salida.estadoConversacion).toBe('pausada');
    expect(salida.sigueParadaPor).toEqual(['urgencia_clinica']);
    expect(await estadoDeLaConversacion()).toBe('pausada');

    // Y cuando se atiende la urgencia, ya sí.
    expect((await atender(urgencia)).estadoConversacion).toBe('abierta');
  });

  it('atender algo que no la paraba —un latido perdido— no la reabre', async () => {
    // Sin ningún otro escalado abierto: lo único que decide es que un latido
    // perdido no es lo que paró la conversación.
    const latido = await escalado('latido_perdido');

    const salida = await atender(latido);

    expect(salida.estado).toBe('atendida');
    expect(await estadoDeLaConversacion()).toBe('pausada');
  });
});

describe('quién lo atendió', () => {
  it('queda en el escalado y en auditoría', async () => {
    const urgencia = await escalado('urgencia_clinica', 3);

    await atender(urgencia, { atendidoPor: 'Dra. López' });

    const [fila] = await admin`select assignee, state from motor.escalations where id = ${urgencia}`;
    expect(fila).toMatchObject({ assignee: 'Dra. López', state: 'atendida' });
    const [auditoria] = await admin`
      select actor, payload from motor.audit_log where entity_id = ${urgencia} and action like 'escalado_atendido:%'
    `;
    expect(auditoria?.['actor']).toBe('recepcion');
    expect(auditoria?.['payload']).toEqual({ atendidoPor: 'Dra. López' });
  });
});

describe('un botón se pulsa dos veces', () => {
  it('la segunda dice que ya estaba atendida, y no reescribe ni quién ni cuándo', async () => {
    const urgencia = await escalado('urgencia_clinica', 3);
    await atender(urgencia, { atendidoPor: 'Dra. López' });

    const segunda = await atender(urgencia, { atendidoPor: 'Otra persona' });

    expect(segunda.estado).toBe('ya_estaba_atendida');
    const [fila] = await admin`select assignee from motor.escalations where id = ${urgencia}`;
    expect(fila?.['assignee']).toBe('Dra. López');
  });

  it('con la misma clave, la misma respuesta', async () => {
    const urgencia = await escalado('urgencia_clinica', 3);

    const una = await atender(urgencia, { idempotencyKey: 'boton-1' });
    const otra = await atender(urgencia, { idempotencyKey: 'boton-1' });

    expect(otra).toEqual(una);
  });

  it('pulsado después de que el paciente volviera a escribir y cortara otra vez, no reabre por el viejo', async () => {
    const vieja = await escalado('urgencia_clinica', 3);
    await atender(vieja);
    // Vuelve a cortar: otra urgencia, otra pausa.
    await admin`update motor.conversations set status = 'pausada' where id = ${CONVERSACION}`;
    await escalado('urgencia_clinica', 3);

    const repetido = await atender(vieja);

    expect(repetido.estado).toBe('ya_estaba_atendida');
    expect(await estadoDeLaConversacion()).toBe('pausada');
  });
});

describe('regla 1', () => {
  it('un escalado de otra clínica no existe para ésta', async () => {
    const urgencia = await escalado('urgencia_clinica', 3);

    await expect(atender(urgencia, { clientId: OTRA })).rejects.toBeInstanceOf(EscaladoInexistenteError);
    const [fila] = await admin`select state from motor.escalations where id = ${urgencia}`;
    expect(fila?.['state']).toBe('abierta');
  });
});
