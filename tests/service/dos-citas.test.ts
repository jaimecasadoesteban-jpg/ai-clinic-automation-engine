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
 * Dos citas vivas para el mismo paciente.
 *
 * Del banco: el paciente elige las 10:00, se avisa a recepción, y al turno
 * siguiente pide las 10:20. Las 10:00 se quedaban en `pendiente_recepcion`.
 * **Recepción ya tenía el aviso delante y lo iba a meter en su agenda**, así que
 * la consecuencia real no era una fila de más: era un hueco ocupado que nadie
 * iba a usar y un paciente presentándose a otra hora.
 *
 * El razonamiento anterior —«la cita anterior sigue en pie hasta que elija la
 * nueva»— vale desde `confirmada`, donde el paciente tiene algo que perder. No
 * vale desde `pendiente_recepcion`: ahí el aviso ya salió y no se retira solo.
 *
 * Y el mensaje decía «te lo dejo apuntado» sobre un hueco que sólo estaba
 * `propuesta`. Nombrar una hora concreta al reagendar es elegir, no explorar.
 */

/** Costura de test: dispara algo mientras el pipeline tiene el cerrojo cogido. */
const enganche = vi.hoisted(() => ({
  trasBloquearHuecoActivo: null as null | (() => Promise<void>),
}));

vi.mock('../../src/db/queries.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/db/queries.js')>();
  return {
    ...original,
    async citasVivas(...args: Parameters<typeof original.citasVivas>) {
      const salida = await original.citasVivas(...args);
      const hook = enganche.trasBloquearHuecoActivo;
      // Sólo en la lectura que BLOQUEA: es la que abre la carrera. La de sólo
      // lectura del final del turno no coge cerrojo y no prueba nada.
      if (hook !== null && args[3].bloquear) {
        enganche.trasBloquearHuecoActivo = null;
        await hook();
      }
      return salida;
    },
  };
});

const CLINICA = '11112222-1111-4111-8111-111122220000';
const TELEFONO = '+34600123123';
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

function preferencia(extra: Partial<NonNullable<Extraccion['preferencia']>> = {}) {
  return {
    dias: [],
    diasExcluidos: [],
    franjas: [],
    desde: null,
    horaExacta: null,
    cuantoAntes: false,
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
      idempotencyKey: `dos-citas-${contador}`,
      clientId: CLINICA,
      telefono: TELEFONO,
      nombre: 'Carmen',
      texto,
    },
  );
  return cuerpo;
}

/** Estados de los huecos que ocupan de verdad, con su hora local. */
const VIVOS = ['retenida', 'pendiente_recepcion', 'confirmada'];

async function huecosVivos(): Promise<Array<{ id: string; hora: string; state: string }>> {
  const filas = await admin`
    select id, slot_start, state from motor.holds
     where client_id = ${CLINICA} and state in ('retenida', 'pendiente_recepcion', 'confirmada')
     order by slot_start
  `;
  const dtf = new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return filas.map((f) => ({
    id: String(f['id']),
    hora: dtf.format(new Date(String(f['slot_start']))),
    state: String(f['state']),
  }));
}

/** Las horas locales de los huecos propuestos, en orden de rango. */
async function horasPropuestas(): Promise<string[]> {
  const filas = await admin`
    select slot_start from motor.holds
     where client_id = ${CLINICA} and state = 'propuesta' order by rank
  `;
  const dtf = new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return filas.map((f) => dtf.format(new Date(String(f['slot_start']))));
}

/** La hora local de un hueco cualquiera. */
async function horaDe(holdId: string): Promise<string> {
  const filas = await admin`select slot_start from motor.holds where id = ${holdId}`;
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(String(filas[0]?.['slot_start'])));
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
    values (${CLINICA}, 'clinica-de-pruebas', 'Clínica Dos Citas', '{}'::jsonb, 'test')
  `;
  agenda = new AgendaFalsa();
  contador = 0;
  enganche.trasBloquearHuecoActivo = null;
});

/** Los dos primeros turnos del banco: propone y elige el primero. */
async function conAvisoEnRecepcion(): Promise<{ holdId: string; hora: string }> {
  await enviar(
    'quiero depilacion laser de axilas',
    agenteGuionado([extraccion({ intencion: 'agendar', servicio: 'laser-axilas' })]),
  );
  const eleccion = await enviar(
    'a las 10',
    agenteGuionado([extraccion({ intencion: 'elegir_hueco', opcion: 1 })]),
  );
  const holdId = eleccion.holdId;
  if (holdId === undefined) throw new Error('no se retuvo nada');

  // El aviso a recepción ha salido: ése es el detalle que lo cambia todo.
  expect(eleccion.efectos.some((e) => e.tipo === 'avisar_a_recepcion')).toBe(true);
  const estado = (await huecosVivos()).find((h) => h.id === holdId);
  expect(estado?.state).toBe('pendiente_recepcion');

  return { holdId, hora: await horaDe(holdId) };
}

describe('el escenario del banco, entero', () => {
  it('pedir otra hora desde pendiente_recepcion deja UNA sola cita viva', async () => {
    const { holdId: primera, hora: horaVieja } = await conAvisoEnRecepcion();
    const segundaHora = (await horasPropuestas()).find((h) => h !== horaVieja);
    if (segundaHora === undefined) throw new Error('no hay otra hora que pedir');

    const salida = await enviar(
      `me acabo de dar cuenta que no puedo a las ${horaVieja}, puede ser a las ${segundaHora}?`,
      agenteGuionado([
        extraccion({
          intencion: 'reagendar',
          preferencia: preferencia({ horaExacta: segundaHora }),
        }),
      ]),
    );

    // Éste es el fallo: había 10:00 pendiente_recepcion Y 10:20 propuesta.
    const vivos = await huecosVivos();
    expect(vivos).toHaveLength(1);
    expect(vivos[0]?.hora).toBe(segundaHora);
    expect(vivos[0]?.id).not.toBe(primera);

    // La anterior queda liberada, no colgando.
    const anterior = await admin`select state from motor.holds where id = ${primera}`;
    expect(anterior[0]?.['state']).toBe('liberada');

    // Y nombrar la hora ha RETENIDO de verdad: el mensaje puede decir que queda
    // apuntado porque el estado lo respalda (regla 4 bis).
    expect(salida.holdId).toBeDefined();
    expect(VIVOS).toContain(vivos[0]?.state);
  });

  it('se avisa a recepción de que el aviso anterior quedó sin efecto', async () => {
    const { holdId: primera, hora } = await conAvisoEnRecepcion();
    const otra = (await horasPropuestas()).find((h) => h !== hora);
    if (otra === undefined) throw new Error('no hay otra hora que pedir');

    const salida = await enviar(
      `puede ser a las ${otra}?`,
      agenteGuionado([
        extraccion({ intencion: 'reagendar', preferencia: preferencia({ horaExacta: otra }) }),
      ]),
    );

    // El aviso a recepción es un mensaje que ya está en su WhatsApp. NO se
    // puede retirar —el canal no lo permite— así que lo único que se puede
    // hacer es mandar otro diciendo que el anterior no vale.
    const retirada = salida.efectos.find((e) => e.tipo === 'avisar_a_recepcion_de_anulacion');
    expect(retirada).toBeDefined();
    expect(retirada).toMatchObject({ holdId: primera });
  });

  it('si recepción pulsa igualmente sobre el viejo, NO se crea la cita y se le dice', async () => {
    const { holdId: primera, hora } = await conAvisoEnRecepcion();
    const otra = (await horasPropuestas()).find((h) => h !== hora);
    if (otra === undefined) throw new Error('no hay otra hora que pedir');

    await enviar(
      `puede ser a las ${otra}?`,
      agenteGuionado([
        extraccion({ intencion: 'reagendar', preferencia: preferencia({ horaExacta: otra }) }),
      ]),
    );

    // Recepción tenía la tarjeta vieja delante y pulsa «Ya la he metido».
    const deps = dependenciasDePrueba({ core, agenda, reloj: () => AHORA });
    const respuesta = await accionRecepcion(deps, {
      idempotencyKey: 'recepcion-tardia',
      clientId: CLINICA,
      holdId: primera,
    });

    expect(respuesta.cuerpo.estado).toBe('anulada');
    expect(respuesta.cuerpo.citaId).toBeNull();
    // Se le dice a recepción; un 409 genérico le enseñaría a ignorar errores.
    expect(respuesta.cuerpo.efectos.some((e) => e.tipo === 'avisar_a_recepcion_de_anulacion')).toBe(true);

    // Y le dice QUÉ HACER, no sólo qué ha pasado: con la hora nueva delante no
    // tiene que investigar nada, y lo que se investiga con prisa se ignora.
    const instruccion = respuesta.cuerpo.mensajeParaRecepcion ?? '';
    expect(instruccion).toContain(otra);
    expect(instruccion).toMatch(/hay que meter/i);

    const citas = await admin`
      select count(*)::int as n from motor.appointments where client_id = ${CLINICA}
    `;
    expect(citas[0]?.['n']).toBe(0);

    // Y sigue habiendo una sola cita viva: la que el paciente quiere.
    expect(await huecosVivos()).toHaveLength(1);
  });
});

describe('el aviso viejo se va a pulsar, y hay que aguantarlo', () => {
  /**
   * El caso peor: recepción pulsa el aviso NUEVO —mete la cita buena— y después
   * pulsa el VIEJO, que sigue en el hilo porque en WhatsApp no se puede retirar
   * un mensaje con botones ya entregado.
   *
   * No puede acabar con dos citas ni deshacer la correcta.
   */
  it('pulsar el viejo DESPUÉS del nuevo no crea otra cita ni deshace la buena', async () => {
    const { holdId: vieja, hora } = await conAvisoEnRecepcion();
    const otra = (await horasPropuestas()).find((h) => h !== hora);
    if (otra === undefined) throw new Error('no hay otra hora que pedir');

    const cambio = await enviar(
      `puede ser a las ${otra}?`,
      agenteGuionado([
        extraccion({ intencion: 'reagendar', preferencia: preferencia({ horaExacta: otra }) }),
      ]),
    );
    const nueva = String(cambio.holdId);

    const deps = dependenciasDePrueba({ core, agenda, reloj: () => AHORA });

    // 1. Recepción pulsa el aviso bueno y mete la cita.
    const buena = await accionRecepcion(deps, {
      idempotencyKey: 'pulsa-nueva',
      clientId: CLINICA,
      holdId: nueva,
    });
    expect(buena.cuerpo.estado).toBe('confirmada');
    expect(buena.cuerpo.citaId).not.toBeNull();

    // 2. Y después pulsa el viejo, que sigue ahí con su botón.
    const tardia = await accionRecepcion(deps, {
      idempotencyKey: 'pulsa-vieja-despues',
      clientId: CLINICA,
      holdId: vieja,
    });

    expect(tardia.cuerpo.estado).toBe('anulada');
    expect(tardia.cuerpo.citaId).toBeNull();
    // Le dice que ya está hecha: si no, la mete otra vez.
    expect(tardia.cuerpo.mensajeParaRecepcion ?? '').toMatch(/no hay que hacer nada/i);

    // Una sola cita, y la correcta, intacta.
    const citas = await admin`
      select hold_id, outcome from motor.appointments where client_id = ${CLINICA}
    `;
    expect(citas).toHaveLength(1);
    expect(String(citas[0]?.['hold_id'])).toBe(nueva);
    expect(citas[0]?.['outcome']).toBe('pendiente');

    const vivos = await huecosVivos();
    expect(vivos).toHaveLength(1);
    expect(vivos[0]?.id).toBe(nueva);
    expect(vivos[0]?.state).toBe('confirmada');
  });

  it('en una colisión, recepción también recibe QUÉ hacer con la segunda opción', async () => {
    // Mismo patrón que el aviso anulado: decir qué ha pasado sin decir qué
    // hacer deja a recepción investigando, y eso se acaba ignorando.
    await enviar(
      'quiero cita de axilas',
      agenteGuionado([extraccion({ intencion: 'agendar', servicio: 'laser-axilas' })]),
    );
    const eleccion = await enviar(
      'la primera',
      agenteGuionado([extraccion({ intencion: 'elegir_hueco', opcion: 1 })]),
    );

    // La clínica metió otra cosa ahí por su cuenta entre medias.
    const filas = await admin`select slot_start, slot_end from motor.holds where id = ${eleccion.holdId!}`;
    agenda.ocupar(
      new Date(String(filas[0]?.['slot_start'])),
      new Date(String(filas[0]?.['slot_end'])),
    );

    const deps = dependenciasDePrueba({ core, agenda, reloj: () => AHORA });
    const respuesta = await accionRecepcion(deps, {
      idempotencyKey: 'colision-1',
      clientId: CLINICA,
      holdId: String(eleccion.holdId),
    });

    expect(respuesta.cuerpo.estado).toBe('colisionada');
    const instruccion = respuesta.cuerpo.mensajeParaRecepcion ?? '';
    expect(instruccion).toMatch(/hay que meter|no metas nada/i);
  });

  it('tras cancelar del todo, pulsar el aviso viejo dice que no hay nada que meter', async () => {
    const { holdId: vieja } = await conAvisoEnRecepcion();

    await enviar('al final no puedo, cancelala', agenteGuionado([extraccion({ intencion: 'cancelar' })]));

    const deps = dependenciasDePrueba({ core, agenda, reloj: () => AHORA });
    const tardia = await accionRecepcion(deps, {
      idempotencyKey: 'pulsa-tras-cancelar',
      clientId: CLINICA,
      holdId: vieja,
    });

    expect(tardia.cuerpo.estado).toBe('anulada');
    expect(tardia.cuerpo.mensajeParaRecepcion ?? '').toMatch(/no hay que meter nada/i);

    const citas = await admin`
      select count(*)::int as n from motor.appointments
       where client_id = ${CLINICA} and outcome = 'pendiente'
    `;
    expect(citas[0]?.['n']).toBe(0);
  });
});

describe('la carrera: recepción confirma mientras el paciente cambia', () => {
  it('si gana el paciente, recepción se entera y no crea la cita', async () => {
    const { holdId: primera, hora } = await conAvisoEnRecepcion();
    const otra = (await horasPropuestas()).find((h) => h !== hora);
    if (otra === undefined) throw new Error('no hay otra hora que pedir');

    // Con el cerrojo cogido por el pipeline, recepción intenta confirmar. Se
    // queda esperando y, al entrar, lee el estado que le ha dejado el paciente.
    let recepcion: Promise<Awaited<ReturnType<typeof accionRecepcion>>> | null = null;
    enganche.trasBloquearHuecoActivo = async () => {
      const deps = dependenciasDePrueba({ core, agenda, reloj: () => AHORA });
      recepcion = accionRecepcion(deps, {
        idempotencyKey: 'carrera-recepcion',
        clientId: CLINICA,
        holdId: primera,
      });
      // Un respiro para que llegue al SELECT ... FOR UPDATE y se bloquee ahí.
      await new Promise((r) => setTimeout(r, 50));
    };

    await enviar(
      `puede ser a las ${otra}?`,
      agenteGuionado([
        extraccion({ intencion: 'reagendar', preferencia: preferencia({ horaExacta: otra }) }),
      ]),
    );

    const resultado = await recepcion!;
    expect(resultado.cuerpo.estado).toBe('anulada');

    const citas = await admin`
      select count(*)::int as n from motor.appointments where client_id = ${CLINICA}
    `;
    expect(citas[0]?.['n']).toBe(0);
    expect(await huecosVivos()).toHaveLength(1);
  });
});

describe('el mismo desajuste en el flujo normal de elección', () => {
  it('«a las 10:20» sin número retiene ESE hueco, no el primero', async () => {
    await enviar(
      'quiero cita de axilas',
      agenteGuionado([extraccion({ intencion: 'agendar', servicio: 'laser-axilas' })]),
    );

    const horas = await horasPropuestas();
    const segunda = horas[1];
    if (segunda === undefined) throw new Error('hacen falta al menos dos huecos');

    const eleccion = await enviar(
      `a las ${segunda} me viene bien`,
      agenteGuionado([
        extraccion({
          intencion: 'elegir_hueco',
          opcion: null,
          preferencia: preferencia({ horaExacta: segunda }),
        }),
      ]),
    );

    // Antes era `opcion ?? 1`: se retenía el primero y se le decía «te he
    // guardado ese hueco». El estado y el mensaje decían horas distintas.
    expect(eleccion.holdId).toBeDefined();
    expect(await horaDe(String(eleccion.holdId))).toBe(segunda);
  });

  it('«vale» con tres opciones NO reserva nada: se pregunta', async () => {
    await enviar(
      'quiero cita de axilas',
      agenteGuionado([extraccion({ intencion: 'agendar', servicio: 'laser-axilas' })]),
    );

    const salida = await enviar(
      'vale',
      agenteGuionado([extraccion({ intencion: 'elegir_hueco', opcion: null })]),
    );

    // Nada se decide sobre una suposición, tampoco al elegir.
    expect(salida.holdId).toBeUndefined();
    expect(await huecosVivos()).toEqual([]);
    expect(salida.respuesta).not.toBeNull();
  });

  it('un número que no corresponde a ningún hueco vivo tampoco vale', async () => {
    await enviar(
      'quiero cita de axilas',
      agenteGuionado([extraccion({ intencion: 'agendar', servicio: 'laser-axilas' })]),
    );
    await admin`
      delete from motor.holds where client_id = ${CLINICA} and rank in (2, 3)
    `;

    const salida = await enviar(
      'la tercera',
      agenteGuionado([extraccion({ intencion: 'elegir_hueco', opcion: 3 })]),
    );

    expect(salida.holdId).toBeUndefined();
    expect(await huecosVivos()).toEqual([]);
  });
});
