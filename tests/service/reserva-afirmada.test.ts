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
 * El turno del servidor de pruebas, entero.
 *
 * Se le propusieron tres huecos, contestó «A las 10:20», el clasificador lo
 * etiquetó `agendar` y no se retuvo nada. El modelo escribió «Te la dejo
 * apuntada el lunes a las 10:20, pendiente de que recepción la confirme.
 * Cualquier cosa me dices.», y salió así: sin `holdId`, sin efectos, sin aviso a
 * recepción. El paciente se habría presentado a una cita que no existía.
 *
 * El día y la hora del texto son los de una propuesta viva, a propósito: ninguna
 * otra regla de la validación puede bloquearlo. Si la de la reserva desaparece,
 * este test es el que lo dice.
 */

const CLINICA = '77778888-7777-4777-8777-777788880000';
// Jueves 8 de octubre a las 17:30 en Madrid, como en la prueba real.
const AHORA = new Date('2026-10-08T15:30:00.000Z');

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

async function enviar(texto: string, guion: Extraccion, redactor: RedactorFalso): Promise<SalidaDeMensaje> {
  contador += 1;
  const deps = dependenciasDePrueba({ core, agenda: new AgendaFalsa(), reloj: () => AHORA });
  const { cuerpo } = await procesarMensajeEntrante(
    { ...deps, agente: new AgenteFalso(new ClasificadorFalso([guion]), redactor) },
    {
      idempotencyKey: `reserva-${contador}`,
      clientId: CLINICA,
      telefono: '+34600888777',
      nombre: 'Marta',
      texto,
    },
  );
  return cuerpo;
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
  for (const tabla of ['audit_log', 'idempotency_keys', 'escalations', 'messages', 'holds', 'conversations', 'patients']) {
    await admin.unsafe(`delete from motor.${tabla} where client_id = $1`, [CLINICA]);
  }
  await admin`delete from motor.clients where id = ${CLINICA}`;
  await admin`
    insert into motor.clients (id, slug, name, config, config_version)
    values (${CLINICA}, 'clinica-de-pruebas', 'Clínica Reserva', '{}'::jsonb, 'test')
  `;
  contador = 0;
});

describe('«te la dejo apuntada» sin que exista ningún hueco retenido', () => {
  it('no le llega al paciente', async () => {
    await enviar(
      'quiero una nueva cita',
      extraccion({ intencion: 'agendar', servicio: 'laser-axilas' }),
      new RedactorFalso(),
    );
    const [segunda] = await admin`
      select slot_start from motor.holds
       where client_id = ${CLINICA} and state = 'propuesta' order by rank offset 1 limit 1
    `;
    const inicio = new Date(String(segunda?.['slot_start']));
    const formato = (opciones: Intl.DateTimeFormatOptions): string =>
      new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', ...opciones }).format(inicio);
    const dia = formato({ weekday: 'long' });
    const hora = formato({ hour: '2-digit', minute: '2-digit', hour12: false });

    const LA_FRASE = `Te la dejo apuntada el ${dia} a las ${hora}, pendiente de que recepción la confirme. Cualquier cosa me dices.`;
    // El modelo insiste: dos veces la misma frase, como haría con el mismo
    // contexto delante.
    const redactor = new RedactorFalso([LA_FRASE, LA_FRASE]);

    // El clasificador lo etiquetó `agendar` y no sacó la hora: nadie retiene.
    const salida = await enviar(`A las ${hora}`, extraccion({ intencion: 'agendar' }), redactor);

    // Lo que hay en la base: ni un hueco retenido.
    const vivos = await admin`
      select count(*)::int as n from motor.holds
       where client_id = ${CLINICA} and state in ('retenida', 'pendiente_recepcion', 'confirmada')
    `;
    expect(vivos[0]?.['n']).toBe(0);
    expect(salida.holdId).toBeUndefined();

    // Y lo que lee el paciente no puede decir otra cosa.
    expect(salida.respuesta).not.toBe(LA_FRASE);
    expect(salida.respuesta ?? '').not.toMatch(/apuntad|reservad/i);
    // Se intentó corregir diciendo por qué, y como insistió, lo ve una persona.
    expect(redactor.correcciones[0]?.explicacion).toMatch(/no se ha reservado nada/);
    expect(salida.efectos).toContainEqual(
      expect.objectContaining({ tipo: 'escalar_a_humano', motivo: 'validacion_fallida' }),
    );
  });
});

describe('lo que se bloqueó queda escrito, y se va con el mensaje', () => {
  it('los dos borradores se guardan con su motivo, y la redacción los quita', async () => {
    await enviar(
      'quiero una nueva cita',
      extraccion({ intencion: 'agendar', servicio: 'laser-axilas' }),
      new RedactorFalso(),
    );
    const frase = 'Te la dejo apuntada, pendiente de que recepción la confirme.';
    await enviar('vale', extraccion({ intencion: 'otro' }), new RedactorFalso([frase, frase]));

    const [fila] = await admin`
      select id, validation_result from motor.messages
       where client_id = ${CLINICA} and direction = 'saliente'
         and (validation_result->>'regeneraciones')::int = 1
    `;
    const resultado = fila?.['validation_result'] as {
      regeneraciones: number;
      borradores?: Array<{ texto: string; motivos: Array<{ tipo: string }> }>;
    };
    // Antes había que deducir la frase a partir del motivo.
    expect(resultado.borradores?.map((b) => b.texto)).toEqual([frase, frase]);
    expect(resultado.borradores?.[0]?.motivos.map((m) => m.tipo)).toContain('reserva_afirmada');

    // Al vencer la retención, el texto se va; la telemetría (regla 6) se queda.
    await admin`update motor.messages set redacted_at = now() where id = ${String(fila?.['id'])}`;
    const [redactada] = await admin`
      select validation_result from motor.messages where id = ${String(fila?.['id'])}
    `;
    const tras = redactada?.['validation_result'] as Record<string, unknown>;
    expect(tras['borradores']).toBeUndefined();
    expect(tras['regeneraciones']).toBe(1);
  });
});
