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
 * Elegir lo decide la forma del mensaje y el estado, no la etiqueta.
 *
 * Los dos fallos son el mismo visto de los dos lados:
 * - «¿Viernes a las 17:00 lo tienes libre?», etiquetado `elegir_hueco`, retuvo
 *   un hueco que el paciente nunca vio.
 * - «A las 10:20», etiquetado `agendar`, no retuvo nada mientras el modelo le
 *   decía «te la dejo apuntada».
 *
 * Aquí el clasificador es falso y se le hace equivocarse a propósito: lo que se
 * prueba es que una etiqueta mal puesta ya no decide.
 */

const CLINICA = '99990000-9999-4999-8999-999900000000';
const AHORA = new Date('2026-09-14T10:00:00.000Z');

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

function conHora(horaExacta: string): Extraccion['preferencia'] {
  return { dias: [], diasExcluidos: [], franjas: [], desde: null, horaExacta, cuantoAntes: false };
}

async function enviar(texto: string, guion: Extraccion): Promise<SalidaDeMensaje> {
  contador += 1;
  const deps = dependenciasDePrueba({ core, agenda: new AgendaFalsa(), reloj: () => AHORA });
  const { cuerpo } = await procesarMensajeEntrante(
    { ...deps, agente: new AgenteFalso(new ClasificadorFalso([guion]), new RedactorFalso()) },
    {
      idempotencyKey: `consulta-${contador}`,
      clientId: CLINICA,
      telefono: '+34600999000',
      nombre: 'Marta',
      texto,
    },
  );
  return cuerpo;
}

function hora(fecha: Date): string {
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(fecha);
}

/** Propone axilas y devuelve las propuestas vivas, en orden. */
async function propuestas(): Promise<Array<{ id: string; inicio: Date }>> {
  const filas = await admin`
    select id, slot_start from motor.holds
     where client_id = ${CLINICA} and state = 'propuesta' order by rank
  `;
  return filas.map((f) => ({ id: String(f['id']), inicio: new Date(String(f['slot_start'])) }));
}

async function retenidos(): Promise<string[]> {
  const filas = await admin`
    select id from motor.holds
     where client_id = ${CLINICA} and state in ('retenida', 'pendiente_recepcion', 'confirmada')
  `;
  return filas.map((f) => String(f['id']));
}

async function conPropuestas(): Promise<Array<{ id: string; inicio: Date }>> {
  await enviar('quiero axilas', extraccion({ intencion: 'agendar', servicio: 'laser-axilas' }));
  return propuestas();
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
    values (${CLINICA}, 'clinica-de-pruebas', 'Clínica Consulta', '{}'::jsonb, 'test')
  `;
  contador = 0;
});

describe('nombrar una opción sin preguntar ES elegir, diga lo que diga la etiqueta', () => {
  it('«A las HH:MM» etiquetado `agendar`: se retiene ESA y sale el aviso a recepción', async () => {
    // El turno del servidor de pruebas, con el clasificador equivocándose igual.
    const [, segunda] = await conPropuestas();
    if (segunda === undefined) throw new Error('sin propuestas');

    const salida = await enviar(
      `A las ${hora(segunda.inicio)}`,
      extraccion({ intencion: 'agendar', preferencia: conHora(hora(segunda.inicio)) }),
    );

    // La que vio, no una nueva con la misma hora: reproponer antes de elegir le
    // caducaría justo la que está eligiendo.
    expect(salida.holdId).toBe(segunda.id);
    expect(await retenidos()).toEqual([segunda.id]);
    expect(salida.efectos.some((e) => e.tipo === 'avisar_a_recepcion')).toBe(true);
  });

  it('«las HH:MM» etiquetado `otro` también', async () => {
    const [primera] = await conPropuestas();
    if (primera === undefined) throw new Error('sin propuestas');

    const salida = await enviar(
      `las ${hora(primera.inicio)}`,
      extraccion({ intencion: 'otro', preferencia: conHora(hora(primera.inicio)) }),
    );

    expect(salida.holdId).toBe(primera.id);
  });

  it('preguntar el precio de una de ellas NO es elegirla', async () => {
    const [primera] = await conPropuestas();
    if (primera === undefined) throw new Error('sin propuestas');

    await enviar(
      `¿cuánto cuesta la de las ${hora(primera.inicio)}?`,
      extraccion({ intencion: 'precio', preferencia: conHora(hora(primera.inicio)) }),
    );

    expect(await retenidos()).toEqual([]);
  });
});

describe('una consulta NO es una elección, aunque la etiqueta diga `elegir_hueco`', () => {
  it('«¿Tenéis las HH:MM?» sobre una opción viva: no se retiene, la opción sigue', async () => {
    const [, segunda] = await conPropuestas();
    if (segunda === undefined) throw new Error('sin propuestas');

    const salida = await enviar(
      `¿Tenéis las ${hora(segunda.inicio)}?`,
      extraccion({ intencion: 'elegir_hueco', preferencia: conHora(hora(segunda.inicio)) }),
    );

    expect(salida.holdId).toBeUndefined();
    expect(await retenidos()).toEqual([]);
    expect((await propuestas()).map((p) => p.id)).toContain(segunda.id);
  });

  it('«¿Viernes a las HH:MM lo tienes libre?» sobre una hora NO propuesta: se propone, no se retiene', async () => {
    // El caso que retuvo un hueco que el paciente nunca vio.
    const [primera] = await conPropuestas();
    if (primera === undefined) throw new Error('sin propuestas');
    const otra = hora(new Date(primera.inicio.getTime() + 3 * 3_600_000));

    const salida = await enviar(
      `¿Viernes a las ${otra} lo tienes libre?`,
      extraccion({ intencion: 'elegir_hueco', preferencia: conHora(otra) }),
    );

    expect(salida.holdId).toBeUndefined();
    expect(await retenidos()).toEqual([]);
    // Se ha consultado y ahora la tiene delante, para elegirla si quiere.
    expect((await propuestas()).map((p) => hora(p.inicio))).toContain(otra);
  });
});

describe('al reagendar, consultar tampoco es elegir', () => {
  it('«¿tenéis a las HH:MM para cambiarla?» no suelta la que tiene ni retiene otra', async () => {
    const [primera, segunda] = await conPropuestas();
    if (primera === undefined || segunda === undefined) throw new Error('sin propuestas');
    const eleccion = await enviar('la primera', extraccion({ intencion: 'elegir_hueco', opcion: 1 }));

    await enviar(
      `¿tenéis a las ${hora(segunda.inicio)} para cambiarla?`,
      extraccion({ intencion: 'reagendar', preferencia: conHora(hora(segunda.inicio)) }),
    );

    // Sigue teniendo la suya y sólo la suya.
    expect(await retenidos()).toEqual([eleccion.holdId]);
  });
});

describe('pedir una hora que no existe se contesta, no se escala', () => {
  it('«A las 10:07»: el modelo dice que no está y le llega al paciente', async () => {
    // Del banco: «A las 10:20» sobre una limpieza que va en punto. El modelo
    // contestó «A las 10:20 no me sale nada», la validación lo bloqueó dos veces
    // por hora no propuesta, y el paciente recibió un escalado por preguntar.
    await conPropuestas();
    const respuesta = 'A las 10:07 no me sale nada, lo siento. ¿Te miro otra hora?';
    contador += 1;
    const deps = dependenciasDePrueba({ core, agenda: new AgendaFalsa(), reloj: () => AHORA });
    const { cuerpo } = await procesarMensajeEntrante(
      {
        ...deps,
        agente: new AgenteFalso(
          new ClasificadorFalso([extraccion({ intencion: 'agendar', preferencia: conHora('10:07') })]),
          new RedactorFalso([respuesta]),
        ),
      },
      {
        idempotencyKey: `consulta-${contador}`,
        clientId: CLINICA,
        telefono: '+34600999000',
        nombre: 'Marta',
        texto: 'A las 10:07',
      },
    );

    expect(cuerpo.respuesta).toBe(respuesta);
    expect(cuerpo.efectos.some((e) => e.tipo === 'escalar_a_humano')).toBe(false);
  });
});

describe('el clasificador ve los huecos que el paciente tiene delante', () => {
  it('numerados con el mismo número que resuelve `opcion`', async () => {
    const [primera, segunda, tercera] = await conPropuestas();
    if (primera === undefined || segunda === undefined || tercera === undefined) {
      throw new Error('sin propuestas');
    }
    const agente = new AgenteFalso(
      new ClasificadorFalso([extraccion({ intencion: 'otro' })]),
      new RedactorFalso(),
    );
    contador += 1;
    const deps = dependenciasDePrueba({ core, agenda: new AgendaFalsa(), reloj: () => AHORA });
    await procesarMensajeEntrante(
      { ...deps, agente },
      { idempotencyKey: `consulta-${contador}`, clientId: CLINICA, telefono: '+34600999000', nombre: 'Marta', texto: 'hola' },
    );

    const ofrecidos = agente.contextos[0]?.huecosOfrecidos ?? [];
    expect(ofrecidos).toHaveLength(3);
    expect(ofrecidos[1]).toMatch(new RegExp(`^2\\) .*${hora(segunda.inicio)}`));
  });
});

describe('el horario de apertura se compone, la disponibilidad se consulta', () => {
  async function con(texto: string, guion: Extraccion): Promise<{ salida: SalidaDeMensaje; redactor: RedactorFalso }> {
    const redactor = new RedactorFalso();
    contador += 1;
    const deps = dependenciasDePrueba({ core, agenda: new AgendaFalsa(), reloj: () => AHORA });
    const { cuerpo } = await procesarMensajeEntrante(
      { ...deps, agente: new AgenteFalso(new ClasificadorFalso([guion]), redactor) },
      { idempotencyKey: `consulta-${contador}`, clientId: CLINICA, telefono: '+34600999000', nombre: 'Marta', texto },
    );
    return { salida: cuerpo, redactor };
  }

  it('«¿Qué horario tenéis?» sale del YAML y no pasa por el modelo', async () => {
    const { salida, redactor } = await con('¿Qué horario tenéis?', extraccion({ intencion: 'horario' }));

    expect(salida.respuesta).toMatch(/^Abrimos /);
    expect(redactor.estados).toEqual([]);
    expect(salida.efectos.some((e) => e.tipo === 'escalar_a_humano')).toBe(false);
  });

  it('«¿por la tarde tienes algo?» etiquetado `horario` consulta la agenda', async () => {
    await conPropuestas();
    const { salida, redactor } = await con(
      '¿por la tarde tienes algo?',
      extraccion({
        intencion: 'horario',
        preferencia: { dias: [], diasExcluidos: [], franjas: ['tarde'], desde: null, horaExacta: null, cuantoAntes: false },
      }),
    );

    expect(salida.respuesta).not.toMatch(/^Abrimos /);
    expect(redactor.huecosRecibidos[0]?.length).toBeGreaterThan(0);
  });
});

describe('los datos de la clínica se componen, las acciones se hacen', () => {
  async function con(texto: string, guion: Extraccion): Promise<{ salida: SalidaDeMensaje; redactor: RedactorFalso }> {
    const redactor = new RedactorFalso();
    contador += 1;
    const deps = dependenciasDePrueba({ core, agenda: new AgendaFalsa(), reloj: () => AHORA });
    const { cuerpo } = await procesarMensajeEntrante(
      { ...deps, agente: new AgenteFalso(new ClasificadorFalso([guion]), redactor) },
      { idempotencyKey: `consulta-${contador}`, clientId: CLINICA, telefono: '+34600999000', nombre: 'Marta', texto },
    );
    return { salida: cuerpo, redactor };
  }

  it('«¿tenéis aparcamiento?» no pasa por el modelo', async () => {
    const { salida, redactor } = await con('¿Tenéis aparcamiento?', extraccion({ intencion: 'otro', tema: 'aparcamiento' }));

    // La clínica de pruebas no lo tiene escrito: se remite a recepción, no se inventa.
    expect(salida.respuesta).toMatch(/recepción/);
    expect(redactor.estados).toEqual([]);
  });

  it('«cancela mi cita» es cancelar, aunque el clasificador vea el tema cancelación', async () => {
    const [primera] = await conPropuestas();
    if (primera === undefined) throw new Error('sin propuestas');
    await con('la primera', extraccion({ intencion: 'elegir_hueco', opcion: 1 }));

    await con('cancela mi cita', extraccion({ intencion: 'cancelar', tema: 'cancelacion' }));

    expect(await retenidos()).toEqual([]);
  });

  it('la preparación usa el tratamiento del que se está hablando', async () => {
    await conPropuestas();
    const { salida } = await con('¿hay que ir depilada?', extraccion({ intencion: 'otro', tema: 'preparacion' }));

    // Hay servicio en la conversación (axilas) pero la clínica de pruebas no
    // tiene preparación escrita: recepción. Lo que no puede salir es la
    // pregunta de qué tratamiento, porque eso ya se sabe.
    expect(salida.respuesta).toMatch(/recepción/);
    expect(salida.respuesta).not.toMatch(/para cuál es/);
  });
});

/**
 * **Lo que eligió lo dice su mensaje, no el número que ponga el clasificador.**
 *
 * En la tanda, tras proponer tres horas con un mensaje que no acababa en
 * pregunta, el paciente escribió «Gracias». El clasificador devolvió
 * `elegir_hueco` con `opcion: 1`, y el sistema retuvo el martes 20 a las 10:00 y
 * le contestó «te reservo el hueco». Dos de dos. «Gracias» no nombra ningún
 * número, ningún día ni ninguna hora: el número lo puso el clasificador.
 *
 * Y con una sola opción viva era peor: «con una sola no hay ambigüedad posible»
 * valía para cualquier mensaje etiquetado `agendar` u `otro`, así que
 * preguntar dónde estáis podía retenerla.
 */
describe('el número de la opción tiene que estar en el mensaje', () => {
  it('«Gracias» con tres opciones delante no elige ninguna, diga lo que diga el clasificador', async () => {
    await conPropuestas();

    const salida = await enviar('Gracias', extraccion({ intencion: 'elegir_hueco', opcion: 1 }));

    expect(salida.holdId).toBeUndefined();
    expect(await retenidos()).toEqual([]);
  });

  it.each(['La primera', 'la 2', 'me quedo con la última', 'Opción 3'])('«%s» sí elige', async (texto) => {
    const vivas = await conPropuestas();
    const numero = /2/.test(texto) ? 2 : /3|última/.test(texto) ? 3 : 1;

    const salida = await enviar(texto, extraccion({ intencion: 'elegir_hueco', opcion: numero }));

    expect(salida.holdId).toBe(vivas[numero - 1]?.id);
  });

  it('una hora que el clasificador pone y el mensaje no nombra tampoco elige', async () => {
    const [, segunda] = await conPropuestas();
    if (segunda === undefined) throw new Error('sin propuestas');

    const salida = await enviar('Gracias', extraccion({ intencion: 'agendar', preferencia: conHora(hora(segunda.inicio)) }));

    expect(salida.holdId).toBeUndefined();
    expect(await retenidos()).toEqual([]);
  });

  it('con una sola opción viva, una pregunta que no tiene nada que ver no la retiene', async () => {
    const [primera, ...resto] = await conPropuestas();
    await admin`update motor.holds set state = 'caducada' where id = any(${resto.map((h) => h.id)})`;
    if (primera === undefined) throw new Error('sin propuestas');

    const salida = await enviar('¿Dónde estáis?', extraccion({ intencion: 'otro' }));

    expect(salida.holdId).toBeUndefined();
    expect(await retenidos()).toEqual([]);
  });

  it('con una sola opción viva, «vale» la coge: ahí no hay ambigüedad', async () => {
    const [primera, ...resto] = await conPropuestas();
    await admin`update motor.holds set state = 'caducada' where id = any(${resto.map((h) => h.id)})`;

    const salida = await enviar('Vale, perfecto', extraccion({ intencion: 'elegir_hueco' }));

    expect(salida.holdId).toBe(primera?.id);
  });

  it('con una sola opción viva, «gracias» a secas no la coge', async () => {
    const [, ...resto] = await conPropuestas();
    await admin`update motor.holds set state = 'caducada' where id = any(${resto.map((h) => h.id)})`;

    const salida = await enviar('Gracias', extraccion({ intencion: 'elegir_hueco' }));

    expect(salida.holdId).toBeUndefined();
  });
});
