import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Extraccion } from '../../src/agent/extraccion.js';
import { createCore, type Core } from '../../src/db/client.js';
import { procesarMensajeEntrante, type SalidaDeMensaje } from '../../src/service/pipeline.js';
import { accionRecepcion } from '../../src/service/reception.js';
import {
  AgendaFalsa,
  AgenteFalso,
  ClasificadorFalso,
  dependenciasDePrueba,
  RedactorFalso,
} from '../support/fakes.js';
import { APP_URL, conexionAdmin, prepararBaseDeDatos } from '../support/db.js';

/**
 * Un paciente puede tener varias citas vivas a la vez.
 *
 * De una sesión real por WhatsApp: con una limpieza facial pendiente de
 * recepción el miércoles, la paciente pidió láser de axilas para el viernes. Al
 * elegir el viernes recibió «te lo cambio al viernes y suelto el de miércoles»,
 * y la base lo confirmaba: la limpieza estaba `liberada`. Cualquier elección con
 * una cita viva se trataba como reagendado, sin mirar el servicio.
 *
 * Aquí los dos tratamientos son láser de axilas y láser de piernas: lo que
 * importa es que sean servicios distintos del catálogo.
 */

const CLINICA = '33334444-3333-4333-8333-333344440000';
const TELEFONO = '+34600777888';
// Lunes a mediodía en Madrid: dentro de la franja, así que los avisos salen ya.
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

async function enviar(
  texto: string,
  guion: Extraccion,
  redactor: RedactorFalso = new RedactorFalso(),
): Promise<SalidaDeMensaje> {
  contador += 1;
  const deps = dependenciasDePrueba({ core, agenda, reloj: () => AHORA });
  const { cuerpo } = await procesarMensajeEntrante(
    { ...deps, agente: new AgenteFalso(new ClasificadorFalso([guion]), redactor) },
    {
      idempotencyKey: `varias-${contador}`,
      clientId: CLINICA,
      telefono: TELEFONO,
      nombre: 'Lucía',
      texto,
    },
  );
  return cuerpo;
}

interface Fila {
  id: string;
  servicio: string;
  state: string;
  replaces: string | null;
  inicio: Date;
}

async function huecos(): Promise<Fila[]> {
  const filas = await admin`
    select id, service_code, state, replaces_hold_id, slot_start from motor.holds
     where client_id = ${CLINICA} order by slot_start, id
  `;
  return filas.map((f) => ({
    id: String(f['id']),
    servicio: String(f['service_code']),
    state: String(f['state']),
    replaces: f['replaces_hold_id'] === null ? null : String(f['replaces_hold_id']),
    inicio: new Date(String(f['slot_start'])),
  }));
}

const VIVOS = ['retenida', 'pendiente_recepcion', 'confirmada'];

/** Las citas vivas en el orden en que se le enseñan al clasificador. */
async function vivas(): Promise<Fila[]> {
  return (await huecos()).filter((h) => VIVOS.includes(h.state));
}

function hora(fecha: Date): string {
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(fecha);
}

/** Pide un tratamiento y elige la primera opción. Devuelve la cita retenida. */
async function conCita(servicio: string): Promise<string> {
  await enviar(`quiero cita de ${servicio}`, extraccion({ intencion: 'agendar', servicio }));
  const eleccion = await enviar('la primera', extraccion({ intencion: 'elegir_hueco', opcion: 1 }));
  if (eleccion.holdId === undefined) throw new Error(`no se retuvo ${servicio}`);
  return eleccion.holdId;
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
    values (${CLINICA}, 'clinica-de-pruebas', 'Clínica Varias Citas', '{}'::jsonb, 'test')
  `;
  agenda = new AgendaFalsa();
  contador = 0;
});

describe('el caso de la sesión real', () => {
  it('pedir un tratamiento distinto NO suelta la cita que ya tenía', async () => {
    const axilas = await conCita('laser-axilas');

    await enviar(
      'quiero tambien cita de piernas',
      extraccion({ intencion: 'agendar', servicio: 'laser-piernas' }),
    );
    const eleccion = await enviar(
      'la primera',
      extraccion({ intencion: 'elegir_hueco', opcion: 1 }),
    );

    // Las dos siguen vivas: ésta es la línea que antes fallaba.
    const tiene = await vivas();
    expect(tiene.map((h) => h.servicio).sort()).toEqual(['laser-axilas', 'laser-piernas']);
    expect(tiene.find((h) => h.id === axilas)?.state).toBe('pendiente_recepcion');

    // Nada que anular en recepción: no se ha cancelado nada.
    expect(eleccion.efectos.some((e) => e.tipo === 'avisar_a_recepcion_de_anulacion')).toBe(false);
    // Y el mensaje no dice que suelta nada. El de antes era fiel al estado; lo
    // falso era la decisión.
    expect(eleccion.respuesta ?? '').not.toMatch(/suelto/);
    // La nueva no sustituye a nadie.
    expect(tiene.find((h) => h.id === eleccion.holdId)?.replaces).toBeNull();
  });

  it('«quiero cita de piernas», sin día, se propone aunque tenga axilas', async () => {
    // Antes tener CUALQUIER cita contaba como «ya tiene hora» y no se proponía
    // nada: la cita de otro tratamiento bloqueaba pedir una nueva.
    await conCita('laser-axilas');
    // Vuelve otro día: las opciones de axilas que no eligió ya han caducado. Sin
    // esto el motivo sale `cambio_de_servicio` por ellas y el test no mira lo
    // que dice mirar — pasaba igual con la regla saboteada.
    await admin`
      update motor.holds set state = 'caducada'
       where client_id = ${CLINICA} and state = 'propuesta'
    `;

    await enviar('y otra de piernas', extraccion({ intencion: 'agendar', servicio: 'laser-piernas' }));

    const propuestas = (await huecos()).filter((h) => h.state === 'propuesta');
    expect(propuestas).toHaveLength(3);
    expect(propuestas.every((h) => h.servicio === 'laser-piernas')).toBe(true);
  });

  it('el redactor ve TODAS sus citas, no sólo la primera', async () => {
    await conCita('laser-axilas');
    await conCita('laser-piernas');

    const redactor = new RedactorFalso();
    await enviar('gracias', extraccion({ intencion: 'otro' }), redactor);

    expect(redactor.estados[0]?.citasVigentes).toHaveLength(2);
  });
});

describe('reagendar es mover UNA cita concreta', () => {
  it('con varias y sin decir cuál: se pregunta, sin proponer ni soltar nada', async () => {
    await conCita('laser-axilas');
    await conCita('laser-piernas');
    const antes = await huecos();

    const redactor = new RedactorFalso();
    await enviar('quiero cambiar la cita', extraccion({ intencion: 'reagendar' }), redactor);

    // Ni una fila tocada: ni soltada, ni propuesta, ni caducada.
    expect(await huecos()).toEqual(antes);
    expect(redactor.estados[0]?.preguntarCual).toBe('cambiar');
  });

  it('diciendo cuál, se mueve ésa y la otra no se toca', async () => {
    const axilas = await conCita('laser-axilas');
    const piernas = await conCita('laser-piernas');
    const orden = (await vivas()).map((h) => h.id);
    const numeroDePiernas = orden.indexOf(piernas) + 1;

    const cambio = await enviar(
      'la de piernas, ¿puede ser por la tarde?',
      extraccion({
        intencion: 'reagendar',
        cita: numeroDePiernas,
        preferencia: {
          dias: [],
          diasExcluidos: [],
          franjas: ['tarde'],
          desde: null,
          horaExacta: null,
          cuantoAntes: false,
        },
      }),
    );
    expect(cambio.efectos.some((e) => e.tipo === 'avisar_a_recepcion_de_anulacion')).toBe(false);

    // Lo propuesto es de piernas —el servicio de la cita que se mueve— y
    // sustituye a ESA cita.
    const propuestas = (await huecos()).filter((h) => h.state === 'propuesta');
    expect(propuestas.length).toBeGreaterThan(0);
    expect(propuestas.every((h) => h.servicio === 'laser-piernas')).toBe(true);
    expect(propuestas.every((h) => h.replaces === piernas)).toBe(true);

    const eleccion = await enviar('la primera', extraccion({ intencion: 'elegir_hueco', opcion: 1 }));

    const despues = await huecos();
    expect(despues.find((h) => h.id === piernas)?.state).toBe('liberada');
    expect(despues.find((h) => h.id === axilas)?.state).toBe('pendiente_recepcion');
    expect(despues.find((h) => h.id === eleccion.holdId)?.replaces).toBe(piernas);

    // La anulación es de la de piernas, no de «la cita del paciente».
    const anulacion = eleccion.efectos.find((e) => e.tipo === 'avisar_a_recepcion_de_anulacion');
    expect(anulacion).toMatchObject({ holdId: piernas });
  });

  it('un número que no corresponde a ninguna cita no suelta la única que hay', async () => {
    const axilas = await conCita('laser-axilas');

    const redactor = new RedactorFalso();
    await enviar('cancela la segunda', extraccion({ intencion: 'cancelar', cita: 2 }), redactor);

    expect((await huecos()).find((h) => h.id === axilas)?.state).toBe('pendiente_recepcion');
    expect(redactor.estados[0]?.preguntarCual).toBe('cancelar');
  });
});

describe('el mismo tratamiento puede ser un cambio o una sesión más', () => {
  /** Axilas retenidas, y elige OTRA de las opciones de axilas que tenía delante. */
  async function eligeOtraDeLasMismas(): Promise<{
    original: string;
    salida: SalidaDeMensaje;
    redactor: RedactorFalso;
  }> {
    const original = await conCita('laser-axilas');
    const redactor = new RedactorFalso();
    const salida = await enviar(
      'y la segunda tambien',
      extraccion({ intencion: 'elegir_hueco', opcion: 2 }),
      redactor,
    );
    return { original, salida, redactor };
  }

  it('se pregunta ANTES de retener nada, y la que tenía sigue en pie', async () => {
    const { original, salida, redactor } = await eligeOtraDeLasMismas();

    expect(salida.holdId).toBeUndefined();
    expect(await vivas()).toEqual([expect.objectContaining({ id: original })]);
    expect(redactor.estados[0]?.preguntarSiSustituye).not.toBeNull();
    expect(salida.efectos.filter((e) => e.tipo.startsWith('avisar_a_recepcion'))).toEqual([]);
  });

  it('«en lugar»: se retiene la que eligió y se suelta la otra', async () => {
    const { original } = await eligeOtraDeLasMismas();
    const elegida = (await huecos()).find((h) => h.state === 'propuesta' && h.id !== original);
    expect(elegida).toBeDefined();

    // La respuesta no repite la hora: «en lugar de la otra» basta.
    const salida = await enviar(
      'en lugar de la otra',
      extraccion({ intencion: 'otro', sustitucion: 'en_lugar' }),
    );

    const ahora = await vivas();
    expect(ahora).toHaveLength(1);
    expect(ahora[0]?.replaces).toBe(original);
    expect((await huecos()).find((h) => h.id === original)?.state).toBe('liberada');
    expect(salida.respuesta ?? '').toContain('suelto el de');
  });

  it('«además»: se retiene y las dos siguen vivas', async () => {
    const { original } = await eligeOtraDeLasMismas();

    const salida = await enviar('las dos', extraccion({ intencion: 'agendar', sustitucion: 'ademas' }));

    const ahora = await vivas();
    expect(ahora).toHaveLength(2);
    expect(ahora.find((h) => h.id === original)?.state).toBe('pendiente_recepcion');
    expect(salida.efectos.some((e) => e.tipo === 'avisar_a_recepcion_de_anulacion')).toBe(false);
  });

  it('una respuesta que no contesta («vale») no decide nada', async () => {
    const { original } = await eligeOtraDeLasMismas();

    const salida = await enviar('vale', extraccion({ intencion: 'otro', sustitucion: null }));

    expect(salida.holdId).toBeUndefined();
    expect(await vivas()).toEqual([expect.objectContaining({ id: original })]);
  });
});

describe('cancelar con varias citas', () => {
  it('sin decir cuál, no se cancela ninguna', async () => {
    await conCita('laser-axilas');
    await conCita('laser-piernas');

    const redactor = new RedactorFalso();
    await enviar('cancela la cita', extraccion({ intencion: 'cancelar' }), redactor);

    expect(await vivas()).toHaveLength(2);
    expect(redactor.estados[0]?.preguntarCual).toBe('cancelar');
  });

  it('diciendo cuál, sólo ésa', async () => {
    const axilas = await conCita('laser-axilas');
    const piernas = await conCita('laser-piernas');
    const numeroDeAxilas = (await vivas()).findIndex((h) => h.id === axilas) + 1;

    await enviar('cancela la de axilas', extraccion({ intencion: 'cancelar', cita: numeroDeAxilas }));

    const ahora = await vivas();
    expect(ahora.map((h) => h.id)).toEqual([piernas]);
  });
});

describe('recepción con varias citas en marcha', () => {
  it('el aviso viejo de un reagendado señala a la que la sustituye, no a otra', async () => {
    const axilas = await conCita('laser-axilas');
    const piernas = await conCita('laser-piernas');
    const numeroDeAxilas = (await vivas()).findIndex((h) => h.id === axilas) + 1;

    await enviar(
      'quiero cambiar la de axilas',
      extraccion({
        intencion: 'reagendar',
        cita: numeroDeAxilas,
        preferencia: {
          dias: [],
          diasExcluidos: [],
          franjas: ['tarde'],
          desde: null,
          horaExacta: null,
          cuantoAntes: false,
        },
      }),
    );
    const cambio = await enviar('la primera', extraccion({ intencion: 'elegir_hueco', opcion: 1 }));
    const nueva = (await huecos()).find((h) => h.id === cambio.holdId);
    const dePiernas = (await huecos()).find((h) => h.id === piernas);
    if (nueva === undefined || dePiernas === undefined) throw new Error('faltan citas');

    const deps = dependenciasDePrueba({ core, agenda, reloj: () => AHORA });
    const pulsado = await accionRecepcion(deps, {
      idempotencyKey: 'pulsa-el-viejo',
      clientId: CLINICA,
      holdId: axilas,
    });

    expect(pulsado.cuerpo.estado).toBe('anulada');
    const instruccion = pulsado.cuerpo.mensajeParaRecepcion ?? '';
    expect(instruccion).toContain(hora(nueva.inicio));
    expect(instruccion).not.toContain(hora(dePiernas.inicio));
  });

  it('la 2ª opción ante una colisión es del MISMO tratamiento, nunca de otro', async () => {
    const axilas = await conCita('laser-axilas');
    // Pide piernas: las opciones de axilas que quedaban caducan y quedan vivas
    // tres de piernas.
    await enviar('y de piernas', extraccion({ intencion: 'agendar', servicio: 'laser-piernas' }));

    const fila = (await huecos()).find((h) => h.id === axilas);
    if (fila === undefined) throw new Error('sin axilas');
    agenda.ocupar(fila.inicio);

    const deps = dependenciasDePrueba({ core, agenda, reloj: () => AHORA });
    const salida = await accionRecepcion(deps, {
      idempotencyKey: 'colision-axilas',
      clientId: CLINICA,
      holdId: axilas,
    });

    expect(salida.cuerpo.estado).toBe('colisionada');
    // Sin alternativa de axilas: no se le pasa a una de piernas que no pidió
    // para esto.
    expect(salida.cuerpo.alternativaHoldId).toBeUndefined();
    const piernas = (await huecos()).filter((h) => h.servicio === 'laser-piernas');
    expect(piernas.every((h) => h.state === 'propuesta')).toBe(true);
  });
});

describe('la despedida con varias citas', () => {
  it('«nos vemos» se bloquea si alguna de sus citas no está confirmada', async () => {
    const axilas = await conCita('laser-axilas');
    await conCita('laser-piernas');
    const deps = dependenciasDePrueba({ core, agenda, reloj: () => AHORA });
    await accionRecepcion(deps, { idempotencyKey: 'confirma-axilas', clientId: CLINICA, holdId: axilas });

    const redactor = new RedactorFalso([
      'Gracias a ti, nos vemos.',
      'Gracias a ti, cualquier cosa me dices.',
    ]);
    const salida = await enviar('gracias!', extraccion({ intencion: 'otro' }), redactor);

    // Una confirmada no basta: «nos vemos» no dice cuál, y la de piernas
    // todavía la tiene que pasar recepción.
    expect(redactor.correcciones).toHaveLength(1);
    expect(salida.respuesta).toBe('Gracias a ti, cualquier cosa me dices.');
  });
});

describe('la base no deja sustituir la cita de otro', () => {
  it('replaces_hold_id hacia la cita de otro paciente se rechaza', async () => {
    const suya = await conCita('laser-axilas');
    const conversacion = await admin`
      select conversation_id, patient_id from motor.holds where id = ${suya}
    `;
    const [otro] = await admin`
      insert into motor.patients (client_id, given_name, phone_e164)
      values (${CLINICA}, 'Otro', '+34600999999')
      returning id
    `;

    await expect(admin`
      insert into motor.holds (client_id, patient_id, conversation_id, slot_start, slot_end,
                               service_code, state, replaces_hold_id)
      values (${CLINICA}, ${String(otro?.['id'])}, ${String(conversacion[0]?.['conversation_id'])},
              '2026-10-20T08:00:00Z', '2026-10-20T08:20:00Z', 'laser-axilas', 'propuesta', ${suya})
    `).rejects.toThrow(/holds_sustituye_al_mismo|no puede sustituir/);
  });

  it('pending_hold_id hacia un hueco de otra conversación se rechaza', async () => {
    const suya = await conCita('laser-axilas');
    const [otro] = await admin`
      insert into motor.patients (client_id, given_name, phone_e164)
      values (${CLINICA}, 'Otra', '+34600999998')
      returning id
    `;
    const [conv] = await admin`
      insert into motor.conversations (client_id, patient_id, purge_at)
      values (${CLINICA}, ${String(otro?.['id'])}, now())
      returning id
    `;

    await expect(admin`
      update motor.conversations set pending_hold_id = ${suya} where id = ${String(conv?.['id'])}
    `).rejects.toThrow(/conversations_pendiente_propio|no es de la conversación/);
  });
});
