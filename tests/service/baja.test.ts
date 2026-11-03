import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createCore, type Core } from '../../src/db/client.js';
import {
  marcarEscaladoAtendido,
  reactivarComunicaciones,
} from '../../src/service/appointments.js';
import { procesarMensajeEntrante, type SalidaDeMensaje } from '../../src/service/pipeline.js';
import { AgendaFalsa, dependenciasDePrueba } from '../support/fakes.js';
import { APP_URL, conexionAdmin, prepararBaseDeDatos } from '../support/db.js';

/**
 * La baja no es un callejón sin salida.
 *
 * Del banco: el paciente pide la baja, se le confirma con «escríbenos cuando
 * quieras», escribe treinta segundos después pidiendo cita, y recibe silencio
 * absoluto. Cinco mensajes, cinco escalados idénticos, ninguna salida.
 *
 * **Confundíamos dos cosas.** Honrar el opt-out es no escribirle por iniciativa
 * nuestra: nada de oleadas ni recordatorios comerciales. Contestar a quien nos
 * escribe pidiendo algo no es una comunicación comercial, es atender su
 * petición. Y pedir cita **no** revoca la baja: querer cita y no querer
 * publicidad son cosas compatibles.
 */

const CLINICA = '33334444-3333-4333-8333-333344440000';
const TELEFONO = '+34600303030';
const AHORA = new Date('2026-09-14T10:00:00.000Z');

const admin = conexionAdmin();
let core: Core;
let agenda: AgendaFalsa;
let contador = 0;

async function enviar(texto: string): Promise<SalidaDeMensaje> {
  contador += 1;
  const deps = dependenciasDePrueba({ core, agenda, reloj: () => AHORA });
  const { cuerpo } = await procesarMensajeEntrante(deps, {
    idempotencyKey: `baja-${contador}`,
    clientId: CLINICA,
    telefono: TELEFONO,
    nombre: 'Alicia',
    texto,
  });
  return cuerpo;
}

async function escalados(): Promise<Array<{ reason: string; state: string }>> {
  const filas = await admin`
    select reason, state from motor.escalations
     where client_id = ${CLINICA} order by created_at
  `;
  return filas.map((f) => ({ reason: String(f['reason']), state: String(f['state']) }));
}

async function bajas(): Promise<Array<{ revocada: boolean; nota: string | null }>> {
  const filas = await admin`
    select revoked_at, revoked_note from motor.suppression where client_id = ${CLINICA}
  `;
  return filas.map((f) => ({
    revocada: f['revoked_at'] !== null,
    nota: f['revoked_note'] === null ? null : String(f['revoked_note']),
  }));
}

async function conversacion(): Promise<{ id: string; status: string }> {
  const filas = await admin`
    select id, status from motor.conversations where client_id = ${CLINICA}
  `;
  return { id: String(filas[0]?.['id']), status: String(filas[0]?.['status']) };
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
    values (${CLINICA}, 'clinica-de-pruebas', 'Clínica Baja', '{}'::jsonb, 'test')
  `;
  agenda = new AgendaFalsa();
  contador = 0;
});

describe('el escenario del banco, entero', () => {
  it('quien se da de baja y luego pide cita SÍ recibe respuesta', async () => {
    const baja = await enviar('no quiero recibir mas mensajes');
    expect(baja.estadoConversacion).toBe('cerrada');
    expect(baja.respuesta).not.toBeNull();

    const vuelve = await enviar('pues ahora si quiero cita perdona');

    // Antes: silencio. El propio texto de la baja le dice «escríbenos cuando
    // quieras» y la clínica perdía al paciente treinta segundos después.
    expect(vuelve.respuesta).not.toBeNull();
    expect(vuelve.estadoConversacion).toBe('abierta');
  });

  it('la baja NO se levanta por pedir cita', async () => {
    await enviar('no quiero recibir mas mensajes');
    await enviar('pues ahora si quiero cita perdona');

    // Querer cita y no querer publicidad son compatibles. Deducir un
    // consentimiento de una acción que no lo expresa es lo que no se puede
    // hacer: sigue fuera de las oleadas hasta que lo diga.
    expect(await bajas()).toEqual([{ revocada: false, nota: null }]);
  });

  it('cinco mensajes NO son cinco escalados', async () => {
    await enviar('no quiero recibir mas mensajes');
    await enviar('pues ahora si quiero cita perdona');
    await enviar('hola?');
    await enviar('sigue ahi alguien?');
    await enviar('hola');

    // Es la fatiga de alertas: recepción ve cinco avisos idénticos y deja de
    // mirarlos. Sólo queda el de la propia baja.
    expect(await escalados()).toEqual([{ reason: 'peticion_paciente', state: 'abierta' }]);

    const acciones = await admin`select action from motor.audit_log where client_id = ${CLINICA}`;
    const lista = acciones.map((f) => String(f['action']));
    // Con rastro: un escalado que no aparece tiene que ser distinguible de uno
    // que se perdió.
    expect(lista).toContain('escalado_no_duplicado:peticion_paciente');
    expect(lista).toContain('reabierta_por_paciente_con_baja_vigente');
  });
});

describe('qué puede hacer una persona de la clínica', () => {
  it('marcar el escalado como atendido reabre también un cierre, no sólo una pausa', async () => {
    await enviar('no quiero recibir mas mensajes');
    const { id } = await conversacion();
    const abiertos = await admin`
      select id from motor.escalations where client_id = ${CLINICA} and state = 'abierta'
    `;

    const deps = dependenciasDePrueba({ core, agenda, reloj: () => AHORA });
    const salida = await marcarEscaladoAtendido(deps, {
      idempotencyKey: 'atender-baja-1',
      clientId: CLINICA,
      escaladoId: String(abiertos[0]?.['id']),
      atendidoPor: 'Recepción',
    });

    // Antes devolvía «sin cambio» y un cierre por baja no se podía deshacer ni
    // aunque lo pidiera el propio paciente.
    expect(salida.conversacionId).toBe(id);
    expect(salida.estadoConversacion).toBe('abierta');
    expect((await conversacion()).status).toBe('abierta');
  });

  it('pero reabrir la conversación NO levanta la baja', async () => {
    await enviar('no quiero recibir mas mensajes');
    const abiertos = await admin`
      select id from motor.escalations where client_id = ${CLINICA} and state = 'abierta'
    `;

    const deps = dependenciasDePrueba({ core, agenda, reloj: () => AHORA });
    await marcarEscaladoAtendido(deps, {
      idempotencyKey: 'atender-baja-2',
      clientId: CLINICA,
      escaladoId: String(abiertos[0]?.['id']),
      atendidoPor: 'Recepción',
    });

    // Son dos cosas distintas: una deja que el agente conteste, la otra
    // devuelve a las oleadas. Recepción no puede hacer la segunda por su cuenta.
    expect(await bajas()).toEqual([{ revocada: false, nota: null }]);
  });

  it('reactivar comunicaciones marca la baja como revocada, y NO la borra', async () => {
    await enviar('no quiero recibir mas mensajes');
    const pacientes = await admin`select id from motor.patients where client_id = ${CLINICA}`;

    const deps = dependenciasDePrueba({ core, agenda, reloj: () => AHORA });
    const salida = await reactivarComunicaciones(deps, {
      clientId: CLINICA,
      patientId: String(pacientes[0]?.['id']),
      loPidioElPaciente: true,
      constancia: 'lo pidió por WhatsApp el 14/09',
    });

    expect(salida.reactivado).toBe(true);
    // La fila sigue ahí: es la prueba de que respetamos el opt-out mientras
    // estuvo vigente, y el registro de bajas no se borra nunca.
    const filas = await bajas();
    expect(filas).toHaveLength(1);
    expect(filas[0]?.revocada).toBe(true);
    expect(filas[0]?.nota).toContain('WhatsApp');

    const acciones = await admin`select action from motor.audit_log where client_id = ${CLINICA}`;
    expect(acciones.map((f) => String(f['action']))).toContain(
      'baja_levantada:lo pidió por WhatsApp el 14/09',
    );
  });

  it('tras revocar, el paciente puede volver a darse de baja', async () => {
    await enviar('no quiero recibir mas mensajes');
    const pacientes = await admin`select id from motor.patients where client_id = ${CLINICA}`;
    const deps = dependenciasDePrueba({ core, agenda, reloj: () => AHORA });
    await reactivarComunicaciones(deps, {
      clientId: CLINICA,
      patientId: String(pacientes[0]?.['id']),
      loPidioElPaciente: true,
      constancia: 'lo pidió en consulta',
    });

    // El índice único sólo cubre las vigentes: si cubriera todas, la fila
    // revocada ocuparía el sitio y no se podría volver a dar de baja nunca.
    const otra = await enviar('no me mandeis mas mensajes');
    expect(otra.estadoConversacion).toBe('cerrada');

    const filas = await bajas();
    expect(filas).toHaveLength(2);
    expect(filas.filter((f) => !f.revocada)).toHaveLength(1);
  });
});
