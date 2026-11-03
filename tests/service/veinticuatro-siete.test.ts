import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createCore, type Core } from '../../src/db/client.js';
import { procesarMensajeEntrante, type SalidaDeMensaje } from '../../src/service/pipeline.js';
import { accionRecepcion } from '../../src/service/reception.js';
import { caducarRetenciones } from '../../src/service/vencimientos.js';
import { AgendaFalsa, dependenciasDePrueba, huecosDesde } from '../support/fakes.js';
import { APP_URL, conexionAdmin, prepararBaseDeDatos } from '../support/db.js';

/**
 * La atención es 24/7 y no se negocia: el producto se vende porque contesta al
 * momento a cualquier hora.
 *
 * La franja de contacto vive en lo que **el sistema inicia** —vencimientos,
 * oleadas, aviso a recepción—, nunca en `/mensaje-entrante`. Estos tests lo
 * comprueban en vez de deducirlo.
 */

const CLINICA = 'bbbb0000-bbbb-4bbb-8bbb-bbbb00000000';
const TELEFONO = '+34600777666';

/** Martes 15 de septiembre de 2026, 22:30 en Madrid. La clínica cerró a las 20:00. */
const NOCHE = new Date('2026-09-15T20:30:00.000Z');
/** 23:40 del mismo martes. */
const MADRUGADA_TEMPRANA = new Date('2026-09-15T21:40:00.000Z');
/** Miércoles 16 a las 09:05 de Madrid: la franja de contacto ya está abierta. */
const MANANA = new Date('2026-09-16T07:05:00.000Z');

const admin = conexionAdmin();
let core: Core;
let agenda: AgendaFalsa;
let contador = 0;

function deps(reloj: () => Date) {
  return dependenciasDePrueba({ core, agenda, reloj });
}

async function enviar(texto: string, reloj: () => Date): Promise<SalidaDeMensaje> {
  contador += 1;
  const { cuerpo } = await procesarMensajeEntrante(deps(reloj), {
    idempotencyKey: `noche-${contador}`,
    clientId: CLINICA,
    telefono: TELEFONO,
    nombre: 'Nuria',
    texto,
  });
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
    values (${CLINICA}, 'clinica-de-pruebas', 'Clínica 24/7', '{}'::jsonb, 'test')
  `;
  agenda = new AgendaFalsa(huecosDesde(new Date('2026-09-25T09:00:00.000Z'), 3));
});

describe('recorrido completo de un paciente que escribe a las 22:30', () => {
  it('contesta, propone, retiene de noche y confirma por la mañana', async () => {
    // 22:30 — un paciente nuevo escribe. La clínica lleva dos horas cerrada.
    const saludo = await enviar('hola quiero pedir cita de laser de axilas', () => NOCHE);

    expect(saludo.respuesta).not.toBeNull();
    expect(saludo.corte).toBeNull();
    expect(saludo.estadoConversacion).toBe('abierta');
    // Y puede elegir: se le proponen huecos a las 22:30, no «te contestamos mañana».
    expect(saludo.respuesta).toContain('opcion 1');

    const propuestos = await admin`
      select count(*)::int as n from motor.holds
      where client_id = ${CLINICA} and state = 'propuesta'
    `;
    expect(propuestos[0]?.['n']).toBe(3);

    // 22:31 — elige. El hueco se retiene EN EL MOMENTO.
    const eleccion = await enviar('me viene bien la primera', () => NOCHE);

    expect(eleccion.holdId).toBeDefined();
    /**
     * Lo que NO puede pasar: diez horas de silencio. Recibe respuesta al momento,
     * con su hora, y le dice que la confirmación está por llegar — no que ya
     * está confirmada.
     *
     * Y no le vende inseguridad: «la clínica está cerrada ahora mismo» convierte
     * en un problema lo que es el funcionamiento normal, y de noche es justo
     * cuando peor sienta leerlo.
     */
    expect(eleccion.respuesta).not.toBeNull();
    expect(eleccion.respuesta).toContain('confirmación');
    expect(eleccion.respuesta).toContain('recepción');
    expect(eleccion.respuesta?.toLowerCase()).not.toContain('confirmada tu cita');
    expect(eleccion.respuesta).not.toMatch(/cerrad/i);
    // A recepción no se le molesta a las 22:31.
    expect(eleccion.efectos.some((e) => e.tipo === 'avisar_a_recepcion')).toBe(false);

    const deNoche = await admin`
      select state, reception_notified_at, expires_at from motor.holds
      where id = ${String(eleccion.holdId)}
    `;
    // El hueco está vivo y bloqueando durante toda la noche.
    expect(deNoche[0]?.['state']).toBe('pendiente_recepcion');
    expect(deNoche[0]?.['reception_notified_at']).toBeNull();

    // 03:00 — el cron sigue corriendo. No pasa nada, y sobre todo no caduca.
    const madrugada = await caducarRetenciones(deps(() => new Date('2026-09-16T01:00:00.000Z')), {
      clientId: CLINICA,
    });
    expect(madrugada.diferidoPorHorario).toBe(true);
    expect(madrugada.aplicados).toEqual([]);

    const trasLaNoche = await admin`select state from motor.holds where id = ${String(eleccion.holdId)}`;
    expect(trasLaNoche[0]?.['state']).toBe('pendiente_recepcion');

    // 09:05 — abre la clínica. AHORA se avisa a recepción.
    const primeraHora = await caducarRetenciones(deps(() => MANANA), { clientId: CLINICA });

    expect(primeraHora.diferidoPorHorario).toBe(false);
    const aviso = primeraHora.aplicados.find((a) => a.holdId === String(eleccion.holdId));
    expect(aviso?.efectos.map((e) => e.tipo)).toContain('avisar_a_recepcion');

    const avisado = await admin`
      select reception_notified_at from motor.holds where id = ${String(eleccion.holdId)}
    `;
    expect(avisado[0]?.['reception_notified_at']).not.toBeNull();

    // 09:10 — recepción pulsa «Ya la he metido en agenda».
    const { cuerpo: confirmacion } = await accionRecepcion(deps(() => MANANA), {
      idempotencyKey: 'noche-confirma',
      clientId: CLINICA,
      holdId: String(eleccion.holdId),
    });

    expect(confirmacion.estado).toBe('confirmada');
    expect(confirmacion.citaId).not.toBeNull();
    expect(confirmacion.respuesta).toContain('Confirmada');
  });

  it('los plazos de recepción no corren de noche: a las 09:05 no llega ya escalado', async () => {
    await enviar('quiero cita de axilas', () => NOCHE);
    const eleccion = await enviar('la primera', () => NOCHE);

    // Se avisa a recepción a las 09:05.
    await caducarRetenciones(deps(() => MANANA), { clientId: CLINICA });

    // A las 10:00 —menos de dos horas después del aviso— no toca nada todavía.
    const alasDiez = await caducarRetenciones(deps(() => new Date('2026-09-16T08:00:00.000Z')), {
      clientId: CLINICA,
    });
    expect(alasDiez.aplicados).toEqual([]);

    // Si los plazos hubieran arrancado a las 22:31, a las 09:05 llevarían más de
    // 10 h corridas y recepción habría recibido recordatorio y escalado por algo
    // que acababa de ver.
    const escalados = await admin`
      select count(*)::int as n from motor.escalations
      where client_id = ${CLINICA} and hold_id = ${String(eleccion.holdId)}
    `;
    expect(escalados[0]?.['n']).toBe(0);

    // A las 11:10, dos horas después del aviso real, sí toca el recordatorio.
    const dosHorasDespues = await caducarRetenciones(
      deps(() => new Date('2026-09-16T09:10:00.000Z')),
      { clientId: CLINICA },
    );
    expect(dosHorasDespues.aplicados[0]?.efectos.map((e) => e.tipo)).toEqual([
      'recordar_a_recepcion',
    ]);
  });
});

describe('la franja NO se aplica a urgencia clínica ni a minoría de edad', () => {
  it('«me sale pus de la zona» a las 23:40 escala en ese momento', async () => {
    const corte = await enviar('me sale pus de la zona', () => MADRUGADA_TEMPRANA);

    expect(corte.corte?.categoria).toBe('urgencia_clinica');
    // El escalado sale AHORA, a las 23:40, con severidad 3.
    const escalado = corte.efectos.find((e) => e.tipo === 'escalar_a_humano');
    expect(escalado).toBeDefined();
    if (escalado?.tipo === 'escalar_a_humano') expect(escalado.severidad).toBe(3);

    // Y al paciente se le contesta en el momento, no a las nueve de la mañana.
    expect(corte.respuesta).not.toBeNull();
    expect(corte.respuesta).toContain('112');

    const enBase = await admin`
      select reason, severity, notified_at from motor.escalations where client_id = ${CLINICA}
    `;
    expect(enBase).toHaveLength(1);
    expect(enBase[0]?.['reason']).toBe('urgencia_clinica');
    expect(enBase[0]?.['notified_at']).not.toBeNull();
  });

  it('una minoría de edad declarada de madrugada también escala en el momento', async () => {
    const corte = await enviar('tengo 16 años, puedo hacermelo?', () => MADRUGADA_TEMPRANA);

    expect(corte.corte?.categoria).toBe('minoria_de_edad');
    expect(corte.estadoConversacion).toBe('pausada');
    expect(corte.efectos.some((e) => e.tipo === 'escalar_a_humano')).toBe(true);
    expect(corte.respuesta).not.toBeNull();
  });

  it('una consulta normal de madrugada se contesta igual, sin escalar', async () => {
    const normal = await enviar('cuanto cuesta el laser de axilas?', () => MADRUGADA_TEMPRANA);

    expect(normal.corte).toBeNull();
    expect(normal.respuesta).not.toBeNull();
    expect(normal.efectos).toEqual([]);
  });
});
