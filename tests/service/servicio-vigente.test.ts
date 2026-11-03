import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Extraccion } from '../../src/agent/extraccion.js';
import { nombraElTratamiento, validarSalida } from '../../src/agent/output-validation.js';
import { createCore, type Core } from '../../src/db/client.js';
import {
  procesarMensajeEntrante,
  servicioVigente,
  type SalidaDeMensaje,
} from '../../src/service/pipeline.js';
import {
  AgendaFalsa,
  AgenteFalso,
  ClasificadorFalso,
  dependenciasDePrueba,
  RedactorFalso,
} from '../support/fakes.js';
import { APP_URL, conexionAdmin, prepararBaseDeDatos } from '../support/db.js';

/**
 * El respaldo de la regla 4 ter, con plazo.
 *
 * Del servidor de pruebas: «Quiero una nueva cita para el lunes», sin servicio.
 * La conversación tenía `laser-axilas` de agosto. Se propusieron huecos de axilas
 * —«para el lunes 12 tengo a las 10:00, 10:20 o 10:40»— sin nombrar el
 * tratamiento, y el paciente creía estar pidiendo una limpieza facial. Si hubiera
 * retenido el de las 10:20, habría ido a depilarse.
 */

const CLINICA = 'aaaabbbb-aaaa-4aaa-8aaa-aaaabbbb0000';
const AHORA = new Date('2026-09-14T10:00:00.000Z');
const horas = (n: number): Date => new Date(AHORA.getTime() + n * 3_600_000);

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
  guion: Extraccion,
  ahora: Date = AHORA,
  agente: AgenteFalso = new AgenteFalso(new ClasificadorFalso([guion]), new RedactorFalso()),
): Promise<SalidaDeMensaje> {
  contador += 1;
  const deps = dependenciasDePrueba({ core, agenda: new AgendaFalsa(), reloj: () => ahora });
  const { cuerpo } = await procesarMensajeEntrante(
    { ...deps, agente },
    {
      idempotencyKey: `vigente-${contador}`,
      clientId: CLINICA,
      telefono: '+34600111222',
      nombre: 'Marta',
      texto,
    },
  );
  return cuerpo;
}

async function propuestas(): Promise<number> {
  const filas = await admin`
    select count(*)::int as n from motor.holds where client_id = ${CLINICA} and state = 'propuesta'
  `;
  return Number(filas[0]?.['n']);
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
  for (const tabla of ['audit_log', 'idempotency_keys', 'appointments', 'escalations', 'messages', 'holds', 'conversations', 'patients']) {
    await admin.unsafe(`delete from motor.${tabla} where client_id = $1`, [CLINICA]);
  }
  await admin`delete from motor.clients where id = ${CLINICA}`;
  await admin`
    insert into motor.clients (id, slug, name, config, config_version)
    values (${CLINICA}, 'clinica-de-pruebas', 'Clínica Vigente', '{}'::jsonb, 'test')
  `;
  contador = 0;
});

describe('el servicio vigente caduca con la conversación', () => {
  it('es el plazo de una propuesta desde el último mensaje', () => {
    const conversacion = { serviceCode: 'laser-axilas', lastMessageAt: AHORA };
    expect(servicioVigente(conversacion, horas(5.9), 360)).toBe('laser-axilas');
    expect(servicioVigente(conversacion, horas(6), 360)).toBeNull();
    expect(servicioVigente({ serviceCode: 'laser-axilas', lastMessageAt: null }, AHORA, 360)).toBeNull();
  });

  it('dentro del intercambio sigue valiendo: «¿y por la tarde?» propone de lo que se hablaba', async () => {
    await enviar('quiero axilas', extraccion({ intencion: 'agendar', servicio: 'laser-axilas' }));

    const redactor = new RedactorFalso();
    const agente = new AgenteFalso(
      new ClasificadorFalso([
        extraccion({
          intencion: 'agendar',
          preferencia: {
            dias: [],
            diasExcluidos: [],
            franjas: ['tarde'],
            desde: null,
            horaExacta: null,
            cuantoAntes: false,
          },
        }),
      ]),
      redactor,
    );
    await enviar('¿y por la tarde?', extraccion(), horas(1), agente);

    expect(agente.contextos[0]?.servicioVigente).toBe('laser-axilas');
    expect(redactor.estados[0]?.servicio).toBe('Láser axilas');
  });

  it('pasado el plazo, «quiero una nueva cita» NO propone axilas: pregunta', async () => {
    await enviar('quiero axilas', extraccion({ intencion: 'agendar', servicio: 'laser-axilas' }));
    // El servicio quedó guardado: es lo que antes se usaba semanas después.
    const [conversacion] = await admin`select service_code from motor.conversations where client_id = ${CLINICA}`;
    expect(conversacion?.['service_code']).toBe('laser-axilas');

    const redactor = new RedactorFalso();
    const agente = new AgenteFalso(
      new ClasificadorFalso([extraccion({ intencion: 'agendar' })]),
      redactor,
    );
    await enviar('Quiero una nueva cita para el lunes', extraccion(), horas(7), agente);

    // Las de axilas de hace 7 horas no están vivas, y no se ha creado ninguna.
    expect(await propuestas()).toBe(3);
    expect(redactor.estados[0]?.faltaServicio).toBe(true);
    expect(redactor.huecosRecibidos[0]).toEqual([]);
    // Y el clasificador tampoco lo recibe como «ya determinado»: si lo
    // recibiera, lo devolvería como si lo hubiera dicho el paciente.
    expect(agente.contextos[0]?.servicioVigente).toBeNull();
  });
});

describe('lo que anuncia una hora dice de qué es', () => {
  it('la retención nombra el tratamiento', async () => {
    await enviar('quiero axilas', extraccion({ intencion: 'agendar', servicio: 'laser-axilas' }));

    const eleccion = await enviar('la primera', extraccion({ intencion: 'elegir_hueco', opcion: 1 }));

    expect(eleccion.respuesta ?? '').toMatch(/láser axilas/i);
  });

  it('el modelo que PROPONE huecos sin decir de qué se corrige', async () => {
    // Como en el servidor de pruebas: «para el lunes tengo a las 10:00, 10:20 o
    // 10:40», huecos nuevos sin tratamiento. Las horas no se saben hasta
    // proponer, así que el texto no las nombra: lo que se mide es el tratamiento.
    const redactor = new RedactorFalso([
      'Para el lunes tengo varias horas por la mañana, ¿cuál te viene mejor?',
      'Para láser de axilas tengo varias horas por la mañana, ¿cuál te viene mejor?',
    ]);
    const agente = new AgenteFalso(
      new ClasificadorFalso([extraccion({ intencion: 'agendar', servicio: 'laser-axilas' })]),
      redactor,
    );
    const salida = await enviar('quiero una cita', extraccion(), AHORA, agente);

    expect(redactor.correcciones[0]?.explicacion).toMatch(/de qué tratamiento/);
    expect(salida.respuesta).toMatch(/axilas/);
  });

  it('reproponer dentro del mismo intercambio no lo exige otra vez', async () => {
    await enviar('quiero axilas', extraccion({ intencion: 'agendar', servicio: 'laser-axilas' }));

    const redactor = new RedactorFalso(['Por la tarde tengo otras tres, ¿te encaja alguna?']);
    const agente = new AgenteFalso(
      new ClasificadorFalso([
        extraccion({
          intencion: 'agendar',
          preferencia: {
            dias: [],
            diasExcluidos: [],
            franjas: ['tarde'],
            desde: null,
            horaExacta: null,
            cuantoAntes: false,
          },
        }),
      ]),
      redactor,
    );
    await enviar('¿y por la tarde?', extraccion(), AHORA, agente);

    expect(redactor.correcciones).toEqual([]);
  });

  it('volver a enseñar las mismas opciones no lo exige otra vez', async () => {
    // Ya se nombró al proponerlas. Medido en el banco: exigirlo en cada
    // continuación regeneraba la mitad de los turnos.
    await enviar('quiero axilas', extraccion({ intencion: 'agendar', servicio: 'laser-axilas' }));

    const redactor = new RedactorFalso(['Justo los tres que te decía, ¿te encaja alguno?']);
    const agente = new AgenteFalso(new ClasificadorFalso([extraccion({ intencion: 'otro' })]), redactor);
    await enviar('¿cuáles eran?', extraccion(), AHORA, agente);

    expect(redactor.correcciones).toEqual([]);
  });
});

describe('nombrar el tratamiento, sin exigir copiar el catálogo', () => {
  it.each([
    ['Para las axilas tengo a las 10:00', 'Láser axilas'],
    ['La depilación de piernas te la puedo dar a las 12:00', 'Láser piernas'],
    ['Para la limpieza tengo el lunes a las 10:00', 'Limpieza facial profunda'],
    ['De peeling tengo el martes', 'Peeling médico facial'],
  ])('«%s» nombra «%s»', (texto, tratamiento) => {
    expect(nombraElTratamiento(texto, tratamiento)).toBe(true);
  });

  it.each([
    ['Para el lunes 12 tengo a las 10:00, 10:20 o 10:40', 'Láser axilas'],
    ['Tengo láser el lunes a las 10:00', 'Láser axilas'],
    ['Para la limpieza tengo el lunes', 'Láser axilas'],
  ])('«%s» NO nombra «%s»', (texto, tratamiento) => {
    expect(nombraElTratamiento(texto, tratamiento)).toBe(false);
  });

  it('la validación sólo lo exige con huecos delante', () => {
    const base = {
      precios: [39.9],
      huecosPropuestos: [],
      citasVigentes: [],
      consultaRealizada: true,
      citaConfirmada: false,
      horasQueNombroElPaciente: [],
      reservasDesmentidas: [],
      zonaHoraria: 'Europe/Madrid',
      ahora: AHORA,
    };
    expect(validarSalida('Hola, ¿en qué te ayudo?', { ...base, tratamientoDeLosHuecos: null }).valido).toBe(true);
    expect(
      validarSalida('Hola, ¿en qué te ayudo?', { ...base, tratamientoDeLosHuecos: 'Láser axilas' }).valido,
    ).toBe(false);
  });
});
