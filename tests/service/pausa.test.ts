import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Extraccion } from '../../src/agent/extraccion.js';
import { createCore, type Core } from '../../src/db/client.js';
import { procesarMensajeEntrante, type SalidaDeMensaje } from '../../src/service/pipeline.js';
import type { FabricaDeAgente } from '../../src/service/ports.js';
import {
  AgendaFalsa,
  AgenteFalso,
  ClasificadorFalso,
  dependenciasDePrueba,
  RedactorFalso,
} from '../support/fakes.js';
import { APP_URL, conexionAdmin, prepararBaseDeDatos } from '../support/db.js';

/**
 * Lo que pasa en pausa.
 *
 * Del banco: el paciente pide hablar con una persona, la conversación se pausa,
 * y en el turno siguiente cuenta un enrojecimiento post-tratamiento. **Cero
 * respuesta y cero escalado nuevo.** El escalado seguía siendo `pide_persona`
 * severidad 2 —sujeto a la franja de contacto y dirigido a contactos
 * comerciales— así que ese enrojecimiento contado a las 23:00 habría esperado a
 * las 09:00 sin llegar al responsable clínico.
 *
 * El cortafuegos sí se ejecutaba: es determinista y no cuesta nada. Lo que se
 * tiraba era su resultado. **No duplicar escalados es correcto; aplicarlo a la
 * evaluación y a la respuesta al paciente no.**
 *
 * Y el silencio es lo peor que puede pasar: quien cuenta un síntoma y no recibe
 * nada asume que no ha llegado.
 */

const CLINICA = '22223333-2222-4222-8222-222233330000';
const TELEFONO = '+34600202020';
const AHORA = new Date('2026-09-14T10:00:00.000Z');

const admin = conexionAdmin();
let core: Core;
let agenda: AgendaFalsa;
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

function agenteGuionado(extracciones: readonly Extraccion[]): FabricaDeAgente {
  return new AgenteFalso(new ClasificadorFalso(extracciones), new RedactorFalso());
}

async function enviar(texto: string, agente?: FabricaDeAgente): Promise<SalidaDeMensaje> {
  contador += 1;
  const deps = dependenciasDePrueba({ core, agenda, reloj: () => AHORA });
  const { cuerpo } = await procesarMensajeEntrante(
    agente === undefined ? deps : { ...deps, agente },
    {
      idempotencyKey: `pausa-${contador}`,
      clientId: CLINICA,
      telefono: TELEFONO,
      nombre: 'Rocío',
      texto,
    },
  );
  return cuerpo;
}

async function escalados(): Promise<Array<{ reason: string; severity: number }>> {
  const filas = await admin`
    select reason, severity from motor.escalations
     where client_id = ${CLINICA} order by created_at
  `;
  return filas.map((f) => ({ reason: String(f['reason']), severity: Number(f['severity']) }));
}

async function pausa(): Promise<{ status: string; pause_reason: string | null }> {
  const filas = await admin`
    select status, pause_reason from motor.conversations where client_id = ${CLINICA}
  `;
  return {
    status: String(filas[0]?.['status']),
    pause_reason: filas[0]?.['pause_reason'] === null ? null : String(filas[0]?.['pause_reason']),
  };
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
    values (${CLINICA}, 'clinica-de-pruebas', 'Clínica Pausa', '{}'::jsonb, 'test')
  `;
  agenda = new AgendaFalsa();
  contador = 0;
});

/** El primer turno del banco: pide hablar con una persona y se pausa. */
async function pausadaPorPeticion(): Promise<void> {
  const salida = await enviar(
    'no me gusta que me hables asi, quiero hablar con un humano',
    agenteGuionado([extraccion({ escalar: 'pide_persona' })]),
  );
  expect(salida.estadoConversacion).toBe('pausada');
  expect(await escalados()).toEqual([{ reason: 'pide_persona', severity: 2 }]);
}

describe('el escenario del banco, entero', () => {
  it('una urgencia dentro de una pausa por queja SÍ se evalúa y SÍ se escala', async () => {
    await pausadaPorPeticion();

    const salida = await enviar('por cierto, desde la ultima sesion tengo la zona un poco irritada');

    // 1. Se evalúa: el corte existe y es urgencia clínica.
    expect(salida.corte?.categoria).toBe('urgencia_clinica');

    // 2. Se escala DE NUEVO, con la severidad y el motivo que corresponden.
    //    Antes se quedaba en `pide_persona` severidad 2, con franja de contacto
    //    y contactos comerciales.
    expect(await escalados()).toEqual([
      { reason: 'pide_persona', severity: 2 },
      { reason: 'urgencia_clinica', severity: 3 },
    ]);
    expect(salida.efectos).toContainEqual(
      expect.objectContaining({ tipo: 'escalar_a_humano', severidad: 3 }),
    );

    // 3. El motivo de la pausa pasa a ser el nuevo: de ahí sale la severidad
    //    con la que se comparará el mensaje siguiente.
    expect((await pausa()).pause_reason).toBe('urgencia_clinica');
  });

  it('y el paciente recibe respuesta, aunque el aviso anterior fuera hace un segundo', async () => {
    await pausadaPorPeticion();

    const salida = await enviar('por cierto, desde la ultima sesion tengo la zona un poco irritada');

    // El silencio es lo peor que puede pasar: quien cuenta un síntoma y no
    // recibe nada asume que no ha llegado. El límite de 30 minutos es para los
    // mensajes de relleno, no para esto.
    expect(salida.respuesta).not.toBeNull();
    expect(salida.respuesta).toContain('112');
  });

  it('el mensaje queda marcado como clínico, con su regla', async () => {
    await pausadaPorPeticion();
    await enviar('por cierto, desde la ultima sesion tengo la zona un poco irritada');

    const filas = await admin`
      select is_clinical, firewall_category from motor.messages
       where client_id = ${CLINICA} and direction = 'entrante' order by created_at
    `;
    const ultimo = filas[filas.length - 1];
    expect(ultimo?.['is_clinical']).toBe(true);
    expect(ultimo?.['firewall_category']).toBe('urgencia_clinica');
  });
});

describe('no duplicar, pero decidido y no por casualidad', () => {
  it('una urgencia dentro de una pausa por urgencia NO abre un escalado nuevo', async () => {
    await enviar('me sale pus de la herida');
    expect(await escalados()).toEqual([{ reason: 'urgencia_clinica', severity: 3 }]);

    const salida = await enviar('y ademas no puedo respirar bien');

    // Misma severidad y mismo destinatario, y ya hay una persona mirándolo: el
    // segundo aviso no le diría nada que no vaya a ver.
    expect(await escalados()).toEqual([{ reason: 'urgencia_clinica', severity: 3 }]);

    // Pero al paciente se le responde igualmente, así que su mensaje queda en
    // el hilo que esa persona está leyendo.
    expect(salida.respuesta).not.toBeNull();
    expect(salida.corte?.categoria).toBe('urgencia_clinica');

    // Y queda rastro de que se decidió no duplicar: un escalado que no aparece
    // tiene que ser distinguible de un escalado que se perdió.
    const acciones = await admin`select action from motor.audit_log where client_id = ${CLINICA}`;
    expect(acciones.map((f) => String(f['action']))).toContain(
      'escalado_no_duplicado:urgencia_clinica',
    );
  });

  it('un contenido clínico en una pausa por queja SÍ escala: cambia el destinatario', async () => {
    await pausadaPorPeticion();

    await enviar('estoy tomando roacutan, afecta?');

    // Misma severidad que la pausa, pero ruta distinta: aparcarlo con el
    // contacto comercial es el mismo fallo por otra puerta.
    expect(await escalados()).toEqual([
      { reason: 'pide_persona', severity: 2 },
      { reason: 'contenido_clinico', severity: 2 },
    ]);
  });

  it('un contenido clínico en una pausa por urgencia NO duplica', async () => {
    await enviar('me sale pus de la herida');
    await enviar('estoy tomando roacutan, afecta?');

    expect(await escalados()).toEqual([{ reason: 'urgencia_clinica', severity: 3 }]);
  });
});

describe('la baja pedida en pausa también se honra', () => {
  it('en pausa, «no me mandeis mas mensajes» cierra y registra la baja', async () => {
    await pausadaPorPeticion();

    const salida = await enviar('no me mandeis mas mensajes');

    // Antes esto se lo comía la rama de pausa entera. No honrar una baja es de
    // las cosas que más caro salen.
    expect(salida.estadoConversacion).toBe('cerrada');
    expect(salida.efectos).toContainEqual(expect.objectContaining({ tipo: 'registrar_baja' }));

    const bajas = await admin`
      select count(*)::int as n from motor.suppression where client_id = ${CLINICA}
    `;
    expect(bajas[0]?.['n']).toBe(1);
  });
});

describe('lo que sí se sigue conteniendo en pausa', () => {
  it('un mensaje normal en pausa no escala ni pasa por el modelo', async () => {
    await pausadaPorPeticion();

    const salida = await enviar('vale, gracias');

    expect(await escalados()).toHaveLength(1);
    expect(salida.estadoConversacion).toBe('pausada');
  });

  it('los avisos de relleno siguen limitados: el segundo no repite', async () => {
    await pausadaPorPeticion();

    // El aviso de la pausa acaba de salir, así que este no repite.
    const primero = await enviar('holaaa?');
    expect(primero.respuesta).toBeNull();

    const segundo = await enviar('sigue ahi alguien?');
    expect(segundo.respuesta).toBeNull();
    expect(await escalados()).toHaveLength(1);
  });
});
