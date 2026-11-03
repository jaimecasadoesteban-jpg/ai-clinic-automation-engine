import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Extraccion } from '../../src/agent/extraccion.js';
import { createCore, type Core } from '../../src/db/client.js';
import { procesarMensajeEntrante, type SalidaDeMensaje } from '../../src/service/pipeline.js';
import {
  AgendaFalsa,
  AgenteFalso,
  ClasificadorFalso,
  dependenciasDePrueba,
  RedactorFalso,
} from '../support/fakes.js';
import { APP_URL, conexionAdmin, prepararBaseDeDatos } from '../support/db.js';

/**
 * **Un mensaje falso del historial no se oculta: se desmiente.**
 *
 * Del servidor de pruebas: «Te la dejo apuntada el lunes a las 10:20» sin
 * ningún hueco retenido. Al día siguiente, a un «Hola», el modelo quiso
 * recordarle su cita del lunes; la validación lo bloqueó dos veces y se escaló
 * como «validación fallida», que no le dice nada a recepción.
 *
 * El mensaje falso se siembra a mano porque la validación de hoy ya no lo deja
 * salir: es el residuo de una versión anterior, que es justo como llega.
 */

const CLINICA = 'ccccdddd-cccc-4ccc-8ccc-ccccdddd0000';
const AHORA = new Date('2026-09-14T10:00:00.000Z');
const AL_DIA_SIGUIENTE = new Date('2026-09-15T10:00:00.000Z');

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

async function enviar(
  texto: string,
  ahora: Date,
  agente: AgenteFalso = new AgenteFalso(new ClasificadorFalso([extraccion()]), new RedactorFalso()),
): Promise<SalidaDeMensaje> {
  contador += 1;
  const deps = dependenciasDePrueba({ core, agenda: new AgendaFalsa(), reloj: () => ahora });
  const { cuerpo } = await procesarMensajeEntrante(
    { ...deps, agente },
    { idempotencyKey: `historial-${contador}`, clientId: CLINICA, telefono: '+34600444555', nombre: 'Marta', texto },
  );
  return cuerpo;
}

const formato = (fecha: Date, opciones: Intl.DateTimeFormatOptions): string =>
  new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', ...opciones }).format(fecha);

/** Propone axilas y siembra el mensaje falso sobre la segunda opción. */
async function conMentiraEnElHistorial(): Promise<{ inicio: Date; dia: string; hora: string }> {
  await enviar(
    'quiero axilas',
    AHORA,
    new AgenteFalso(
      new ClasificadorFalso([extraccion({ intencion: 'agendar', servicio: 'laser-axilas' })]),
      new RedactorFalso(),
    ),
  );
  const [segunda] = await admin`
    select slot_start, conversation_id from motor.holds
     where client_id = ${CLINICA} and state = 'propuesta' order by rank offset 1 limit 1
  `;
  const inicio = new Date(String(segunda?.['slot_start']));
  const dia = formato(inicio, { weekday: 'long' });
  const hora = formato(inicio, { hour: '2-digit', minute: '2-digit', hour12: false });
  await admin`
    insert into motor.messages (client_id, conversation_id, direction, body, is_clinical, model, purge_at, created_at)
    values (${CLINICA}, ${String(segunda?.['conversation_id'])}, 'saliente',
            ${`Te la dejo apuntada el ${dia} a las ${hora}, pendiente de que recepción la confirme.`},
            false, 'claude-opus-5', now() + interval '1 year', ${new Date(AHORA.getTime() + 60_000).toISOString()})
  `;
  return { inicio, dia, hora };
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
  for (const tabla of ['audit_log', 'idempotency_keys', 'job_runs', 'appointments', 'escalations', 'messages', 'holds', 'conversations', 'patients']) {
    await admin.unsafe(`delete from motor.${tabla} where client_id = $1`, [CLINICA]);
  }
  await admin`delete from motor.clients where id = ${CLINICA}`;
  await admin`
    insert into motor.clients (id, slug, name, config, config_version)
    values (${CLINICA}, 'clinica-de-pruebas', 'Clínica Historial', '{}'::jsonb, 'test')
  `;
  // Un sistema sano: los crons están llamando. Sin esto, al día siguiente hay
  // propuestas vivas de ayer y ningún cron ha pasado nunca, y el vigilante
  // escala —con razón— un latido perdido que no es lo que se prueba aquí.
  for (const job of ['caducar-retenciones', 'verificar-citas']) {
    await admin`
      insert into motor.job_runs (client_id, job, last_run_at, updated_at)
      values (${CLINICA}, ${job}, ${AL_DIA_SIGUIENTE.toISOString()}, ${AL_DIA_SIGUIENTE.toISOString()})
    `;
  }
  contador = 0;
});

describe('(b) el barrido encuentra la reserva que nunca existió', () => {
  it('el «Hola» siguiente: se marca, se escala con su motivo y dice qué aclarar', async () => {
    const { dia, hora } = await conMentiraEnElHistorial();
    const correccion = `Hola Marta. Lo del ${dia} a las ${hora} no llegó a reservarse, perdona el lío.`;
    const redactor = new RedactorFalso([correccion]);
    const agente = new AgenteFalso(new ClasificadorFalso([extraccion()]), redactor);

    const salida = await enviar('Hola', AL_DIA_SIGUIENTE, agente);

    // Recepción sabe QUÉ tiene que aclarar.
    const escalado = salida.efectos.find((e) => e.tipo === 'escalar_a_humano');
    expect(escalado).toMatchObject({ motivo: 'historial_falso' });
    expect(escalado?.texto).toContain(hora);
    expect(salida.efectos.some((e) => 'motivo' in e && e.motivo === 'validacion_fallida')).toBe(false);

    // El modelo ve la verdad delante, no la mentira suelta.
    const turnos = agente.contextos[0]?.turnos.map((t) => t.texto).join('\n') ?? '';
    expect(turnos).toMatch(/CORRECCIÓN: este mensaje de la clínica NO era cierto/);
    expect(redactor.estados[0]?.desmentidos).toHaveLength(1);

    // Y puede decírselo nombrando la hora para negarla.
    expect(salida.respuesta).toBe(correccion);

    const [fila] = await admin`
      select disproved_at, disproved_note from motor.messages
       where client_id = ${CLINICA} and body like 'Te la dejo apuntada%'
    `;
    expect(fila?.['disproved_at']).not.toBeNull();
    expect(String(fila?.['disproved_note'])).toContain(hora);
  });

  it('el siguiente turno no vuelve a escalar lo mismo, y queda rastro', async () => {
    await conMentiraEnElHistorial();
    await enviar('Hola', AL_DIA_SIGUIENTE);

    const segunda = await enviar('Hola otra vez', AL_DIA_SIGUIENTE);

    expect(segunda.efectos.filter((e) => e.tipo === 'escalar_a_humano')).toEqual([]);
    const [abiertos] = await admin`
      select count(*)::int as n from motor.escalations
       where client_id = ${CLINICA} and reason = 'historial_falso'
    `;
    expect(abiertos?.['n']).toBe(1);
  });

  it('una reserva que SÍ existió no se desmiente', async () => {
    await enviar(
      'quiero axilas',
      AHORA,
      new AgenteFalso(
        new ClasificadorFalso([extraccion({ intencion: 'agendar', servicio: 'laser-axilas' })]),
        new RedactorFalso(),
      ),
    );
    const eleccion = await enviar(
      'la primera',
      AHORA,
      new AgenteFalso(new ClasificadorFalso([extraccion({ intencion: 'elegir_hueco', opcion: 1 })]), new RedactorFalso()),
    );
    const [suya] = await admin`select slot_start, conversation_id from motor.holds where id = ${String(eleccion.holdId)}`;
    const inicio = new Date(String(suya?.['slot_start']));
    await admin`
      insert into motor.messages (client_id, conversation_id, direction, body, is_clinical, model, purge_at, created_at)
      values (${CLINICA}, ${String(suya?.['conversation_id'])}, 'saliente',
              ${`A ti, queda anotado el ${formato(inicio, { weekday: 'long' })} a las ${formato(inicio, { hour: '2-digit', minute: '2-digit', hour12: false })}.`},
              false, 'claude-opus-5', now() + interval '1 year', ${new Date(AHORA.getTime() + 60_000).toISOString()})
    `;

    const salida = await enviar('Hola', new Date(AHORA.getTime() + 3_600_000));

    expect(salida.efectos.some((e) => 'motivo' in e && e.motivo === 'historial_falso')).toBe(false);
    const [fila] = await admin`select disproved_at from motor.messages where client_id = ${CLINICA} and body like 'A ti, queda anotado%'`;
    expect(fila?.['disproved_at']).toBeNull();
  });
});

describe('(a) si la validación falla por el historial, el escalado lo dice', () => {
  it('con el aviso del barrido ya atendido, el fallo sale como historial_falso, no como validación', async () => {
    const { dia, hora } = await conMentiraEnElHistorial();
    await enviar('Hola', AL_DIA_SIGUIENTE);
    // Recepción lo atendió, pero el modelo vuelve a construir encima de la mentira.
    await admin`update motor.escalations set state = 'atendida' where client_id = ${CLINICA}`;
    const mentira = `Hola Marta, te recuerdo tu cita del ${dia} a las ${hora}.`;
    const agente = new AgenteFalso(new ClasificadorFalso([extraccion()]), new RedactorFalso([mentira, mentira]));

    const salida = await enviar('¿a qué hora era?', AL_DIA_SIGUIENTE, agente);

    expect(salida.respuesta).not.toBe(mentira);
    const escalado = salida.efectos.find((e) => e.tipo === 'escalar_a_humano');
    expect(escalado).toMatchObject({ motivo: 'historial_falso' });
    expect(escalado?.texto).toContain(hora);
  });
});

describe('cuántas veces se avisa', () => {
  it('(a) con el aviso del barrido abierto, el fallo de validación no lo repite y deja rastro', async () => {
    const { dia, hora } = await conMentiraEnElHistorial();
    await enviar('Hola', AL_DIA_SIGUIENTE);
    const mentira = `Hola Marta, te recuerdo tu cita del ${dia} a las ${hora}.`;
    const agente = new AgenteFalso(new ClasificadorFalso([extraccion()]), new RedactorFalso([mentira, mentira]));

    const salida = await enviar('¿a qué hora era?', AL_DIA_SIGUIENTE, agente);

    expect(salida.respuesta).not.toBe(mentira);
    expect(salida.efectos.filter((e) => e.tipo === 'escalar_a_humano')).toEqual([]);
    const [rastro] = await admin`
      select count(*)::int as n from motor.audit_log
       where client_id = ${CLINICA} and action = 'escalado_no_duplicado:historial_falso'
    `;
    expect(rastro?.['n']).toBe(1);
  });

  it('(b) una segunda mentira distinta SÍ se avisa: recepción tiene que saber las dos', async () => {
    const { inicio } = await conMentiraEnElHistorial();
    await enviar('Hola', AL_DIA_SIGUIENTE);
    const [conv] = await admin`select id from motor.conversations where client_id = ${CLINICA}`;
    // Otra hora de las propuestas, afirmada como reservada en un turno posterior.
    const [tercera] = await admin`
      select slot_start from motor.holds
       where client_id = ${CLINICA} and slot_start <> ${inicio.toISOString()} order by slot_start desc limit 1
    `;
    const otra = new Date(String(tercera?.['slot_start']));
    await admin`
      insert into motor.messages (client_id, conversation_id, direction, body, is_clinical, model, purge_at, created_at)
      values (${CLINICA}, ${String(conv?.['id'])}, 'saliente',
              ${`Te la reservo el ${formato(otra, { weekday: 'long' })} a las ${formato(otra, { hour: '2-digit', minute: '2-digit', hour12: false })}.`},
              false, 'claude-opus-5', now() + interval '1 year', ${new Date(AL_DIA_SIGUIENTE.getTime() + 60_000).toISOString()})
    `;

    const salida = await enviar('Hola', new Date(AL_DIA_SIGUIENTE.getTime() + 120_000));

    const escalado = salida.efectos.find((e) => e.tipo === 'escalar_a_humano');
    expect(escalado).toMatchObject({ motivo: 'historial_falso' });
    expect(escalado?.texto).toContain(formato(otra, { hour: '2-digit', minute: '2-digit', hour12: false }));
  });
});
