import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Extraccion } from '../../src/agent/extraccion.js';
import { huecosProponibles } from '../../src/core/disponibilidad.js';
import { createCore, type Core } from '../../src/db/client.js';
import { procesarMensajeEntrante } from '../../src/service/pipeline.js';
import { accionRecepcion } from '../../src/service/reception.js';
import {
  AgendaFalsa,
  AgenteFalso,
  ClasificadorFalso,
  RedactorFalso,
  configDePrueba,
  dependenciasDePrueba,
  registroDePrueba,
} from '../support/fakes.js';
import { APP_URL, conexionAdmin, prepararBaseDeDatos } from '../support/db.js';

/**
 * El domingo 25 de octubre de 2026 España pasa de CEST (UTC+2) a CET (UTC+1):
 * a las 03:00 son las 02:00, y las 02:00-03:00 locales ocurren dos veces.
 *
 * Ningún `+02:00` está escrito en el código —la zona sale de `zonaHoraria` del
 * YAML—, pero «no hay un desfase fijo» se afirma leyendo, y esto lo prueba: el
 * sábado 24 las 10:00 son las 08:00Z, el domingo 25 son las 09:00Z. Un desfase
 * fijo de +2 pondría la cita del domingo y la del lunes una hora antes de lo que
 * lee el paciente.
 */

const CLINICA = 'ed0c0000-ed0c-4d0c-8d0c-ed0c00000000';
const admin = conexionAdmin();
let core: Core;
let contador = 0;

const hora = (d: Date): string =>
  new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
const diaLocal = (d: Date): string =>
  new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', day: 'numeric', month: 'numeric' }).format(d);

describe('disponibilidad alrededor del cambio de hora', () => {
  // Nivel B: sin las 24 h de antelación, para ver los tres días enteros.
  const clinica = configDePrueba({
    agenda: { nivel: 'B', calendarioId: 'pruebas@group.calendar.google.com' },
  }); // sáb y dom 10-14, lun-vie 09-20
  const servicio = clinica.servicios[0]!;
  const de = (ahora: string, dias = 5) =>
    huecosProponibles({ config: clinica, servicio, ahora: new Date(ahora), ocupacion: [], dias });

  it('abre a la misma hora LOCAL los tres días, aunque en UTC se mueva una hora', () => {
    const huecos = de('2026-10-23T10:00:00.000Z');
    const primero = (dia: string) => huecos.find((h) => diaLocal(h.inicio) === dia);

    expect(primero('24/10')?.inicio.toISOString()).toBe('2026-10-24T08:00:00.000Z'); // sábado 10:00 CEST
    expect(primero('25/10')?.inicio.toISOString()).toBe('2026-10-25T09:00:00.000Z'); // domingo 10:00 CET
    expect(primero('26/10')?.inicio.toISOString()).toBe('2026-10-26T08:00:00.000Z'); // lunes 09:00 CET
    expect(['24/10', '25/10'].map((d) => hora(primero(d)!.inicio))).toEqual(['10:00', '10:00']);
    expect(hora(primero('26/10')!.inicio)).toBe('09:00');
  });

  /** Los días locales que tiene que haber: `ahora` y los siguientes, uno a uno. */
  function diasEsperados(ahora: string, cuantos: number): string[] {
    const [d, m] = diaLocal(new Date(ahora)).split('/').map(Number);
    return Array.from({ length: cuantos }, (_, n) => {
      const f = new Date(Date.UTC(2026, (m ?? 1) - 1, (d ?? 1) + n, 12));
      return `${f.getUTCDate()}/${f.getUTCMonth() + 1}`;
    });
  }

  it.each([
    ['viernes 23, 23:30 locales', '2026-10-23T21:30:00.000Z'],
    ['sábado 24, 23:30 locales', '2026-10-24T21:30:00.000Z'],
    ['domingo 25, 00:30 locales (antes del cambio)', '2026-10-24T22:30:00.000Z'],
    ['domingo 25, 23:30 locales (después del cambio)', '2026-10-25T22:30:00.000Z'],
  ])('desde %s no se salta un día ni se repite', (_nombre, ahora) => {
    // Se avanza de 24 h en 24 h desde `ahora`. El día del cambio dura 25 h, y
    // sin cuidado, cerca de medianoche un día se repite o se pierde.
    const huecos = de(ahora);
    const dias = [...new Set(huecos.map((h) => diaLocal(h.inicio)))];

    // El primer día puede quedar a medias o vacío (ya pasó la hora de cierre),
    // pero desde ahí tiene que estar cada día, una sola vez y en orden.
    const esperados = diasEsperados(ahora, 8);
    const primero = esperados.indexOf(dias[0] ?? '');
    expect(primero).toBeGreaterThanOrEqual(0);
    expect(dias).toEqual(esperados.slice(primero, primero + dias.length));
    expect(dias.length).toBeGreaterThanOrEqual(5);
    const instantes = huecos.map((h) => h.inicio.getTime());
    expect(new Set(instantes).size).toBe(instantes.length);
  });

  it('la hora que se repite: dos huecos distintos, con instantes distintos', () => {
    // Una clínica de guardia, abierta de 01:00 a 05:00 el domingo. Ese día dura
    // 5 horas reales: 01:00, 02:00 (CEST), 02:00 (CET), 03:00 y 04:00.
    const noche = configDePrueba({
      agenda: { nivel: 'B', calendarioId: 'pruebas@group.calendar.google.com' },
      horario: [{ dia: 'domingo', abre: '01:00', cierra: '05:00' }],
      servicios: [{ codigo: 'g', nombre: 'Guardia', precio: 10, duracionMinutos: 60 }],
    });
    const huecos = huecosProponibles({
      config: noche,
      servicio: noche.servicios[0]!,
      ahora: new Date('2026-10-22T10:00:00.000Z'),
      ocupacion: [],
      dias: 5,
    });

    expect(huecos.map((h) => h.inicio.toISOString())).toEqual([
      '2026-10-24T23:00:00.000Z', // 01:00 CEST
      '2026-10-25T00:00:00.000Z', // 02:00 CEST
      '2026-10-25T01:00:00.000Z', // 02:00 CET (la segunda vez)
      '2026-10-25T02:00:00.000Z', // 03:00 CET
      '2026-10-25T03:00:00.000Z', // 04:00 CET
    ]);
    expect(huecos.map((h) => hora(h.inicio))).toEqual(['01:00', '02:00', '02:00', '03:00', '04:00']);
  });
});

function extraccion(extra: Partial<Extraccion> = {}): Extraccion {
  return {
    intencion: 'otro', servicio: null, opcion: null, preferencia: null,
    escalar: null, cita: null, sustitucion: null, tema: null, ...extra,
  };
}

function desde(fecha: string): Extraccion['preferencia'] {
  return { dias: [], diasExcluidos: [], franjas: [], desde: fecha, horaExacta: null, cuantoAntes: false };
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
  for (const tabla of ['audit_log', 'idempotency_keys', 'job_runs', 'appointments', 'escalations', 'messages', 'holds', 'conversations', 'patients']) {
    await admin.unsafe(`delete from motor.${tabla} where client_id = $1`, [CLINICA]);
  }
  await admin`delete from motor.clients where id = ${CLINICA}`;
  await admin`
    insert into motor.clients (id, slug, name, config, config_version)
    values (${CLINICA}, 'clinica-de-pruebas', 'Clínica', '{}'::jsonb, 'test')
  `;
  contador = 0;
});

/** Propone, elige y confirma: el recorrido completo, con el reloj en `ahora`. */
async function recorrido(opciones: {
  ahora: string;
  desdeDia: string;
  opcion: number;
  config?: ReturnType<typeof configDePrueba>;
}) {
  const ahora = new Date(opciones.ahora);
  const base = dependenciasDePrueba({
    core,
    agenda: new AgendaFalsa(),
    reloj: () => ahora,
    ...(opciones.config === undefined
      ? {}
      : { configuracion: registroDePrueba([{ slug: 'clinica-de-pruebas', config: opciones.config }]) }),
  });
  const servicio = (opciones.config ?? configDePrueba()).servicios[0]!.codigo;
  const agente = new AgenteFalso(
    new ClasificadorFalso([
      extraccion({ intencion: 'agendar', servicio, preferencia: desde(opciones.desdeDia) }),
      extraccion({ intencion: 'elegir_hueco', opcion: opciones.opcion }),
    ]),
    new RedactorFalso(),
  );
  const enviar = async (texto: string) => {
    contador += 1;
    const { cuerpo } = await procesarMensajeEntrante(
      { ...base, agente },
      { idempotencyKey: `dst-${contador}`, clientId: CLINICA, telefono: '+34600123123', nombre: 'Lola', texto },
    );
    return cuerpo;
  };

  await enviar('quiero cita');
  const propuestos = await admin`
    select slot_start from motor.holds where client_id = ${CLINICA} and state = 'propuesta' order by rank
  `;
  const eleccion = await enviar(`la ${opciones.opcion === 1 ? 'primera' : opciones.opcion === 2 ? 'segunda' : 'tercera'}`);
  const [retenido] = await admin`select state, slot_start from motor.holds where id = ${String(eleccion.holdId)}`;
  const { cuerpo: confirmacion } = await accionRecepcion(base, {
    idempotencyKey: `dst-r-${contador}`,
    clientId: CLINICA,
    holdId: String(eleccion.holdId),
  });
  const [confirmado] = await admin`select state, slot_start from motor.holds where id = ${String(eleccion.holdId)}`;
  return {
    propuestos: propuestos.map((f) => new Date(String(f['slot_start']))),
    retenido: { state: String(retenido?.['state']), inicio: new Date(String(retenido?.['slot_start'])) },
    confirmado: { state: String(confirmado?.['state']), inicio: new Date(String(confirmado?.['slot_start'])) },
    confirmacion,
  };
}

describe('proponer, retener y confirmar los días 24, 25 y 26', () => {
  it.each([
    ['sábado 24', '2026-10-24', '2026-10-24T08:00:00.000Z', '10:00', /sábado 24/],
    ['domingo 25', '2026-10-25', '2026-10-25T09:00:00.000Z', '10:00', /domingo 25/],
    ['lunes 26', '2026-10-26', '2026-10-26T08:00:00.000Z', '09:00', /lunes 26/],
  ])('%s: la hora local es la del YAML y el instante guardado es el correcto', async (_n, dia, utc, local, texto) => {
    const r = await recorrido({ ahora: '2026-10-22T10:00:00.000Z', desdeDia: dia, opcion: 1 });

    expect(r.propuestos[0]?.toISOString()).toBe(utc);
    expect(r.retenido.state).toBe('pendiente_recepcion');
    expect(r.retenido.inicio.toISOString()).toBe(utc);
    expect(r.confirmado.state).toBe('confirmada');
    expect(r.confirmado.inicio.toISOString()).toBe(utc);
    expect(hora(r.confirmado.inicio)).toBe(local);
    // Lo que lee el paciente: el día y la hora locales, no UTC.
    expect(r.confirmacion.respuesta).toMatch(texto);
    expect(r.confirmacion.respuesta).toContain(local);
  });

  it('la hora que se repite: se retiene y se confirma el instante exacto, el segundo 02:00', async () => {
    const noche = configDePrueba({
      horario: [{ dia: 'domingo', abre: '01:00', cierra: '05:00' }],
      servicios: [{ codigo: 'g', nombre: 'Guardia', precio: 10, duracionMinutos: 60 }],
    });

    const r = await recorrido({ ahora: '2026-10-22T10:00:00.000Z', desdeDia: '2026-10-25', opcion: 3, config: noche });

    // La tercera propuesta por cercanía puede no ser la que se espera: lo que se
    // exige es que lo que se retiene y se confirma sea LO MISMO que se propuso.
    expect(r.confirmado.inicio.getTime()).toBe(r.propuestos[2]?.getTime());
    expect(r.confirmado.state).toBe('confirmada');
    expect(r.confirmacion.respuesta).toMatch(/domingo 25/);
  });
});
