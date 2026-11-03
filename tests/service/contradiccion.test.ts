import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Extraccion } from '../../src/agent/extraccion.js';
import { createCore, type Core } from '../../src/db/client.js';
import { procesarMensajeEntrante, type SalidaDeMensaje } from '../../src/service/pipeline.js';
import { accionRecepcion } from '../../src/service/reception.js';
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
 * El agente contradiciéndose sobre una cita real.
 *
 * En el banco: recepción confirma, el sistema dice «Confirmada tu cita», el
 * paciente pregunta «¿está confirmada entonces?» y el agente contesta «queda
 * anotado, pero confirmada no está». El agente no mintió — **leyó un estado
 * incoherente**: el mismo hueco de las 10:20 tenía dos filas, una `propuesta` y
 * otra `confirmada`.
 *
 * La causa: la ocupación venía sólo de la agenda externa, y la agenda externa no
 * sabe nada de un hueco que el núcleo acaba de confirmar — la clínica todavía no
 * lo ha metido en su calendario, que es justamente el diseño (regla 3, nunca se
 * escribe en la agenda del cliente). Así que al turno siguiente el núcleo volvía
 * a proponer un hueco que él mismo tenía confirmado.
 *
 * Y `holds_slot_unico` no lo impedía porque `propuesta` no está en su `WHERE`:
 * la restricción cubría la doble reserva, no la doble fila.
 *
 * Verificado por sabotaje: quitando los huecos propios de la ocupación, este
 * test vuelve a producir las dos filas.
 */

/**
 * La costura para probar la carrera, **y vive sólo aquí**.
 *
 * La ventana real va desde la última lectura de ocupación —`ocupacionPropia`—
 * hasta el INSERT, y en medio no hay ninguna entrada/salida donde engancharse.
 * La primera versión de este test invertía el orden de las dos lecturas en
 * producción para abrir un hueco donde meterse, y eso metía la llamada HTTP a
 * n8n entera dentro de la ventana: lo que se cuela por ahí es una doble reserva,
 * así que el remedio era peor.
 *
 * En vez de eso se envuelve el módulo de consultas y se dispara el competidor
 * justo después de que el pipeline lea la ocupación propia. Producción queda
 * exactamente igual; con el enganche a `null` esto es la función original.
 */
const enganche = vi.hoisted(() => ({
  trasLeerOcupacionPropia: null as null | (() => Promise<void>),
  /**
   * Cuántas veces se ha intentado escribir las propuestas.
   *
   * Es lo que distingue «no hizo falta recuperarse» de «se recuperó»: con el
   * orden bueno se escribe una vez, y si alguien invierte las lecturas la
   * primera choca y hay que reintentar. Sin esto, el test del orden pasaba
   * igual con el orden mal, porque la recuperación tapaba el síntoma.
   */
  intentosDeProponer: 0,
}));

vi.mock('../../src/db/queries.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/db/queries.js')>();
  return {
    ...original,
    async ocupacionPropia(...args: Parameters<typeof original.ocupacionPropia>) {
      const salida = await original.ocupacionPropia(...args);
      const hook = enganche.trasLeerOcupacionPropia;
      if (hook !== null) {
        // Se dispara una sola vez: el reintento vuelve a leer, y si el ladrón
        // robara otra vez el test no estaría probando una carrera sino un bucle.
        enganche.trasLeerOcupacionPropia = null;
        await hook();
      }
      return salida;
    },
    async proponerHuecos(...args: Parameters<typeof original.proponerHuecos>) {
      enganche.intentosDeProponer += 1;
      return original.proponerHuecos(...args);
    },
  };
});

const CLINICA = 'eeee1111-eeee-4eee-8eee-eeee11110000';
const TELEFONO = '+34600111222';
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

async function enviar(texto: string, agente: FabricaDeAgente): Promise<SalidaDeMensaje> {
  contador += 1;
  const deps = dependenciasDePrueba({ core, agenda, reloj: () => AHORA });
  const { cuerpo } = await procesarMensajeEntrante(
    { ...deps, agente },
    {
      idempotencyKey: `contradiccion-${contador}`,
      clientId: CLINICA,
      telefono: TELEFONO,
      nombre: 'Lucía',
      texto,
    },
  );
  return cuerpo;
}

/** Todas las filas de un mismo hueco, por instante de inicio. */
async function filasPorSlot(): Promise<Map<string, string[]>> {
  const filas = await admin`
    select slot_start, state from motor.holds where client_id = ${CLINICA}
     order by slot_start, state
  `;
  const mapa = new Map<string, string[]>();
  for (const fila of filas) {
    const clave = new Date(String(fila['slot_start'])).toISOString();
    mapa.set(clave, [...(mapa.get(clave) ?? []), String(fila['state'])]);
  }
  return mapa;
}

/** Estados que ocupan el hueco de verdad. `propuesta` y `caducada` no cuentan. */
const VIVOS = new Set(['retenida', 'pendiente_recepcion', 'confirmada']);

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
    values (${CLINICA}, 'clinica-de-pruebas', 'Clínica Contradicción', '{}'::jsonb, 'test')
  `;
  agenda = new AgendaFalsa();
  contador = 0;
  enganche.trasLeerOcupacionPropia = null;
  enganche.intentosDeProponer = 0;
});

/** La conversación del banco, hasta la confirmación de recepción. */
async function hastaConfirmar(): Promise<{ holdId: string; slot: string }> {
  await enviar(
    'quiero depilacion laser de axilas',
    agenteGuionado([extraccion({ intencion: 'agendar', servicio: 'laser-axilas' })]),
  );
  const eleccion = await enviar(
    'a las 10:20 me viene bien',
    agenteGuionado([extraccion({ intencion: 'elegir_hueco', opcion: 2 })]),
  );
  const holdId = eleccion.holdId;
  if (holdId === undefined) throw new Error('no se retuvo ningún hueco');

  const deps = dependenciasDePrueba({ core, agenda, reloj: () => AHORA });
  await accionRecepcion(deps, {
    idempotencyKey: 'recepcion-1',
    clientId: CLINICA,
    holdId,
  });

  const filas = await admin`select slot_start from motor.holds where id = ${holdId}`;
  return { holdId, slot: new Date(String(filas[0]?.['slot_start'])).toISOString() };
}

describe('un hueco no puede tener dos filas en estados distintos', () => {
  it('tras confirmar, el turno siguiente NO vuelve a proponer el hueco confirmado', async () => {
    const { slot } = await hastaConfirmar();

    // «¿Está confirmada entonces? Gracias!» — el servicio sigue vigente en la
    // conversación, así que el pipeline recalcula disponibilidad.
    await enviar(
      'esta confirmada entonces? gracias!',
      agenteGuionado([extraccion({ intencion: 'agendar', servicio: 'laser-axilas' })]),
    );

    const porSlot = await filasPorSlot();
    const estados = porSlot.get(slot) ?? [];

    // Ésta es la fila fantasma: 10:20 propuesta Y 10:20 confirmada.
    expect(estados).toEqual(['confirmada']);
  });

  it('ningún hueco tiene a la vez una fila viva y otra propuesta', async () => {
    await hastaConfirmar();
    await enviar(
      'esta confirmada entonces?',
      agenteGuionado([extraccion({ intencion: 'agendar', servicio: 'laser-axilas' })]),
    );

    for (const [slot, estados] of await filasPorSlot()) {
      const vivas = estados.filter((e) => VIVOS.has(e));
      if (vivas.length > 0) {
        expect({ slot, estados }).toEqual({ slot, estados: vivas });
      }
    }
  });

  it('la ocupación propia también tapa un hueco meramente retenido', async () => {
    await enviar(
      'quiero depilacion laser de axilas',
      agenteGuionado([extraccion({ intencion: 'agendar', servicio: 'laser-axilas' })]),
    );
    const eleccion = await enviar(
      'la segunda',
      agenteGuionado([extraccion({ intencion: 'elegir_hueco', opcion: 2 })]),
    );
    const retenido = await admin`select slot_start from motor.holds where id = ${eleccion.holdId!}`;
    const slot = new Date(String(retenido[0]?.['slot_start'])).toISOString();

    // Otro paciente distinto pide cita: el hueco retenido no puede ofrecerse.
    contador += 1;
    const deps = dependenciasDePrueba({ core, agenda, reloj: () => AHORA });
    await procesarMensajeEntrante(
      {
        ...deps,
        agente: agenteGuionado([extraccion({ intencion: 'agendar', servicio: 'laser-axilas' })]),
      },
      {
        idempotencyKey: `otro-paciente-${contador}`,
        clientId: CLINICA,
        telefono: '+34600333444',
        nombre: 'Marta',
        texto: 'quiero cita de axilas',
      },
    );

    const propuestasEnEseSlot = await admin`
      select count(*)::int as n from motor.holds
       where client_id = ${CLINICA} and state = 'propuesta' and slot_start = ${slot}
    `;
    expect(propuestasEnEseSlot[0]?.['n']).toBe(0);
  });

  it('un competidor que entra DESPUÉS de la última lectura: el paciente no se queda sin respuesta', async () => {
    // La carrera de verdad, con la ventana estrecha: el núcleo ya ha leído toda
    // la ocupación y otra conversación retiene uno de esos huecos antes de que
    // escriba. La base lo rechaza —para eso está— pero la regla 4 dice que eso
    // no puede acabar en un 500 con el paciente esperando.
    await enviar(
      'quiero cita de axilas',
      agenteGuionado([extraccion({ intencion: 'agendar', servicio: 'laser-axilas' })]),
    );
    const primeros = await admin`
      select slot_start, slot_end from motor.holds
       where client_id = ${CLINICA} and state = 'propuesta' order by rank
    `;
    const robado = primeros[0];
    if (robado === undefined) throw new Error('no se propuso nada');

    await admin`delete from motor.holds where client_id = ${CLINICA}`;

    // El ladrón necesita paciente y conversación PROPIOS: si comparte los de la
    // conversación viva, su INSERT pide un lock de clave ajena sobre las mismas
    // filas que la transacción en curso está actualizando, y se bloquean.
    const ladrones = await admin`
      insert into motor.patients (client_id, given_name, phone_e164)
      values (${CLINICA}, 'Ladrón', '+34600777666') returning id
    `;
    const ladronPaciente = String(ladrones[0]?.['id']);
    const ladronConv = await admin`
      insert into motor.conversations (client_id, patient_id)
      values (${CLINICA}, ${ladronPaciente}) returning id
    `;
    const ladronConversacion = String(ladronConv[0]?.['id']);

    enganche.trasLeerOcupacionPropia = async () => {
      await admin`
        insert into motor.holds
          (client_id, conversation_id, patient_id, service_code, slot_start, slot_end, rank, state)
        values (${CLINICA}, ${ladronConversacion}, ${ladronPaciente},
                'laser-axilas', ${String(robado['slot_start'])}, ${String(robado['slot_end'])},
                1, 'retenida')
      `;
    };

    enganche.intentosDeProponer = 0;
    const salida = await enviar(
      'quiero cita de axilas',
      agenteGuionado([extraccion({ intencion: 'agendar', servicio: 'laser-axilas' })]),
    );

    // Hay respuesta, y ninguna propuesta pisa el hueco que se llevó el otro.
    expect(salida.respuesta).not.toBeNull();
    // Y se ha recuperado de verdad: la primera escritura chocó y hubo reintento.
    expect(enganche.intentosDeProponer).toBe(2);
    const pisando = await admin`
      select count(*)::int as n from motor.holds
       where client_id = ${CLINICA} and state = 'propuesta'
         and slot_start = ${String(robado['slot_start'])}
    `;
    expect(pisando[0]?.['n']).toBe(0);

    // Y se le siguen dando huecos: no se queda con una respuesta vacía.
    const propuestos = await admin`
      select count(*)::int as n from motor.holds
       where client_id = ${CLINICA} and state = 'propuesta'
    `;
    expect(Number(propuestos[0]?.['n'])).toBeGreaterThan(0);
  });

  it('el orden de las lecturas deja fuera al que entra durante la llamada a la agenda', async () => {
    // La ocupación propia se lee la ÚLTIMA justo para esto: quien retiene
    // mientras el núcleo habla con n8n todavía se ve, y no hace falta recuperar
    // nada. Si alguien invierte ese orden, la ventana pasa a incluir una llamada
    // HTTP entera.
    await enviar(
      'quiero cita de axilas',
      agenteGuionado([extraccion({ intencion: 'agendar', servicio: 'laser-axilas' })]),
    );
    const primeros = await admin`
      select slot_start, slot_end from motor.holds
       where client_id = ${CLINICA} and state = 'propuesta' order by rank
    `;
    const robado = primeros[0];
    if (robado === undefined) throw new Error('no se propuso nada');
    await admin`delete from motor.holds where client_id = ${CLINICA}`;

    const ladrones = await admin`
      insert into motor.patients (client_id, given_name, phone_e164)
      values (${CLINICA}, 'Ladrón2', '+34600777555') returning id
    `;
    const ladronPaciente = String(ladrones[0]?.['id']);
    const ladronConv = await admin`
      insert into motor.conversations (client_id, patient_id)
      values (${CLINICA}, ${ladronPaciente}) returning id
    `;

    const original = agenda.ocupacion.bind(agenda);
    agenda.ocupacion = async () => {
      const previa = await original();
      await admin`
        insert into motor.holds
          (client_id, conversation_id, patient_id, service_code, slot_start, slot_end, rank, state)
        values (${CLINICA}, ${String(ladronConv[0]?.['id'])}, ${ladronPaciente},
                'laser-axilas', ${String(robado['slot_start'])}, ${String(robado['slot_end'])},
                1, 'retenida')
        on conflict do nothing
      `;
      return previa;
    };

    enganche.intentosDeProponer = 0;
    const salida = await enviar(
      'quiero cita de axilas',
      agenteGuionado([extraccion({ intencion: 'agendar', servicio: 'laser-axilas' })]),
    );

    expect(salida.respuesta).not.toBeNull();
    const pisando = await admin`
      select count(*)::int as n from motor.holds
       where client_id = ${CLINICA} and state = 'propuesta'
         and slot_start = ${String(robado['slot_start'])}
    `;
    expect(pisando[0]?.['n']).toBe(0);

    // Y lo que prueba el orden: NO hizo falta recuperarse. Con las lecturas
    // invertidas la primera escritura choca y esto sería 2.
    expect(enganche.intentosDeProponer).toBe(1);
  });

  it('si dos pacientes eligen el mismo hueco, el segundo pasa al siguiente y no revienta', async () => {
    // Este camino existía desde la fase 6 y no lo cubría ningún test: el de la
    // doble reserva probaba el índice —la base— pero no la recuperación de la
    // aplicación. Estaba roto: drizzle envuelve el error de Postgres y el
    // reconocedor de colisiones miraba sólo la capa de fuera, así que en vez de
    // marcar `colisionada` y pasar al siguiente hueco, salía la excepción.
    await enviar(
      'quiero cita de axilas',
      agenteGuionado([extraccion({ intencion: 'agendar', servicio: 'laser-axilas' })]),
    );
    const propuestos = await admin`
      select id, slot_start, slot_end from motor.holds
       where client_id = ${CLINICA} and state = 'propuesta' order by rank
    `;
    const primera = propuestos[0];
    if (primera === undefined) throw new Error('no se propuso nada');

    const otros = await admin`
      insert into motor.patients (client_id, given_name, phone_e164)
      values (${CLINICA}, 'Rival', '+34600555111') returning id
    `;
    const rival = String(otros[0]?.['id']);
    const conv = await admin`
      insert into motor.conversations (client_id, patient_id)
      values (${CLINICA}, ${rival}) returning id
    `;
    await admin`
      insert into motor.holds
        (client_id, conversation_id, patient_id, service_code, slot_start, slot_end, rank, state)
      values (${CLINICA}, ${String(conv[0]?.['id'])}, ${rival}, 'laser-axilas',
              ${String(primera['slot_start'])}, ${String(primera['slot_end'])}, 1, 'retenida')
    `;

    const salida = await enviar(
      'la primera',
      agenteGuionado([extraccion({ intencion: 'elegir_hueco', opcion: 1 })]),
    );

    // Se le da otro hueco y se le contesta. No se queda sin respuesta.
    expect(salida.respuesta).not.toBeNull();
    expect(salida.holdId).toBeDefined();
    expect(salida.holdId).not.toBe(String(primera['id']));

    const estados = await admin`
      select state from motor.holds where id = ${String(primera['id'])}
    `;
    expect(estados[0]?.['state']).toBe('colisionada');
  });

  it('la base de datos lo impide aunque el código se equivoque', async () => {
    const { holdId, slot } = await hastaConfirmar();
    const fila = await admin`
      select conversation_id, patient_id, service_code, slot_end from motor.holds where id = ${holdId}
    `;

    // Insertar a mano una propuesta sobre un hueco ya confirmado tiene que
    // fallar en Postgres. Si sólo lo impide el código, vuelve el día que alguien
    // añada otro camino que proponga huecos.
    await expect(
      admin`
        insert into motor.holds
          (client_id, conversation_id, patient_id, service_code, slot_start, slot_end, rank, state)
        values (${CLINICA}, ${String(fila[0]?.['conversation_id'])}, ${String(fila[0]?.['patient_id'])},
                ${String(fila[0]?.['service_code'])}, ${slot}, ${String(fila[0]?.['slot_end'])}, 1, 'propuesta')
      `,
    ).rejects.toThrow();
  });
});
