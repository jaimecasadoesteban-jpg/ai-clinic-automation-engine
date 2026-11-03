import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Extraccion } from '../../src/agent/extraccion.js';
import { createCore, type Core } from '../../src/db/client.js';
import { procesarMensajeEntrante, type SalidaDeMensaje } from '../../src/service/pipeline.js';
import { eventoDeAgenda } from '../../src/service/agenda-evento.js';
import { caducarRetenciones } from '../../src/service/vencimientos.js';
import type { FabricaDeAgente } from '../../src/service/ports.js';
import {
  AgendaFalsa,
  AgenteFalso,
  ClasificadorFalso,
  configDePrueba,
  dependenciasDePrueba,
  RedactorFalso,
  registroDePrueba,
} from '../support/fakes.js';
import { APP_URL, conexionAdmin, prepararBaseDeDatos } from '../support/db.js';

/**
 * Modo `automatica`: n8n escribe el evento y el paciente recibe la confirmación
 * en el momento.
 *
 * Lo que se prueba aquí es sobre todo **lo que NO pasa**: que no se confirme
 * nada antes de que el evento exista, y que cuando la escritura falla de forma
 * ambigua no se le toque la cita al paciente.
 */

const CLINICA = '11112222-1111-4111-8111-1111a1170000';
const TELEFONO = '+34600777666';
/** Lunes 14 de septiembre de 2026, 12:00 en Madrid: dentro de la franja. */
const AHORA = new Date('2026-09-14T10:00:00.000Z');
/** El mismo día a las 23:31, fuera de toda franja de contacto. */
const NOCHE = new Date('2026-09-14T21:31:00.000Z');

const admin = conexionAdmin();
let core: Core;
let agenda: AgendaFalsa;
let contador = 0;

const CONFIG = registroDePrueba([
  {
    slug: 'clinica-de-pruebas',
    config: configDePrueba({
      slug: 'clinica-de-pruebas',
      agenda: { nivel: 'A', calendarioId: 'pruebas@group.calendar.google.com', confirmacion: 'automatica' },
      vencimientos: { agendaMinutos: 3 },
    }),
  },
]);

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

async function enviar(
  texto: string,
  agente: FabricaDeAgente,
  reloj: () => Date = () => AHORA,
): Promise<SalidaDeMensaje> {
  contador += 1;
  const deps = dependenciasDePrueba({ core, agenda, reloj, configuracion: CONFIG });
  const { cuerpo } = await procesarMensajeEntrante(
    { ...deps, agente },
    {
      idempotencyKey: `auto-${contador}`,
      clientId: CLINICA,
      telefono: TELEFONO,
      nombre: 'Rocío',
      texto,
    },
  );
  return cuerpo;
}

async function responderAgenda(
  holdId: string,
  cuerpo: { creado: boolean; eventoId?: string; motivo?: 'ocupado' | 'rechazado' | 'error' },
  reloj: () => Date = () => AHORA,
) {
  contador += 1;
  const deps = dependenciasDePrueba({ core, agenda, reloj, configuracion: CONFIG });
  const { cuerpo: salida } = await eventoDeAgenda(deps, {
    idempotencyKey: `evento-cb-${contador}`,
    clientId: CLINICA,
    holdId,
    ...cuerpo,
  });
  return salida;
}

async function estadoDe(holdId: string): Promise<string> {
  const filas = await admin`select state from motor.holds where id = ${holdId}`;
  return String(filas[0]?.['state']);
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
    values (${CLINICA}, 'clinica-de-pruebas', 'Clínica Automática', '{}'::jsonb, 'test')
  `;
  agenda = new AgendaFalsa();
  contador = 0;
});

/** Propone y elige. Devuelve el hueco retenido, esperando a n8n. */
async function conHuecoElegido(reloj: () => Date = () => AHORA): Promise<SalidaDeMensaje> {
  await enviar(
    'quiero depilacion laser de axilas',
    agenteGuionado([extraccion({ intencion: 'agendar', servicio: 'laser-axilas' })]),
    reloj,
  );
  return enviar(
    'la primera',
    agenteGuionado([extraccion({ intencion: 'elegir_hueco', opcion: 1 })]),
    reloj,
  );
}

describe('al elegir, el paciente no recibe nada todavía', () => {
  it('sale el efecto de crear el evento y ninguna respuesta', async () => {
    const eleccion = await conHuecoElegido();

    /**
     * `null` a propósito: hasta que el evento exista no hay nada verdadero que
     * contarle. Confirmarle antes y desdecirse después es el fallo de confianza
     * que más caro sale.
     */
    expect(eleccion.respuesta).toBeNull();
    expect(await estadoDe(eleccion.holdId!)).toBe('retenida');

    const efecto = eleccion.efectos.find((e) => e.tipo === 'crear_evento_agenda');
    expect(efecto).toBeDefined();
    // Y NO se avisa a recepción con el botón: no hay nada que tenga que meter.
    expect(eleccion.efectos.some((e) => e.tipo === 'avisar_a_recepcion')).toBe(false);
  });

  /**
   * El evento va a la agenda de la clínica, que es la responsable del
   * tratamiento y ya tiene la ficha del paciente. Un evento que dijera
   * «Láser axilas — pac_8371» dejaría a recepción sin saber a quién llamar si
   * hay que mover la cita. No es la frontera del prompt: ver `service/evento.ts`.
   */
  it('el efecto lleva el evento ya compuesto, con lo que recepción necesita', async () => {
    const eleccion = await conHuecoElegido();
    const efecto = eleccion.efectos.find((e) => e.tipo === 'crear_evento_agenda');
    if (efecto?.tipo !== 'crear_evento_agenda') throw new Error('no salió el efecto');

    expect(efecto.resumen).toContain('Láser axilas');
    expect(efecto.resumen).toContain('Rocío');
    expect(efecto.descripcion).toContain(TELEFONO);
    expect(efecto.descripcion).toMatch(/pac_\d+/);
    // Estable para el mismo hueco: un reintento no crea dos eventos.
    expect(efecto.idempotencyKey).toBe(`evento-${eleccion.holdId}`);
    expect(efecto.inicio).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // El calendario sale del YAML: n8n no tiene su propio mapa de clínicas.
    expect(efecto.calendarioId).toBe('pruebas@group.calendar.google.com');
  });

  /** El paso 6, adelantado: si el hueco se ocupó por fuera, no se escribe nada. */
  it('si el hueco ya está ocupado en la agenda, se pasa a otro antes de escribir', async () => {
    await enviar(
      'quiero depilacion laser de axilas',
      agenteGuionado([extraccion({ intencion: 'agendar', servicio: 'laser-axilas' })]),
    );
    const propuestos = await admin`
      select id, slot_start from motor.holds
       where client_id = ${CLINICA} and state = 'propuesta' order by rank
    `;
    /**
     * Alguien de la clínica lo mete a mano entre que se propone y que elige.
     * Se ocupa SÓLO ese hueco —20 minutos, la duración del servicio— porque lo
     * que se prueba es que se pase al siguiente, no que se acaben los tres.
     */
    const ocupado = new Date(String(propuestos[0]?.['slot_start']));
    agenda.ocupar(ocupado, new Date(ocupado.getTime() + 20 * 60_000));

    const eleccion = await enviar(
      'la primera',
      agenteGuionado([extraccion({ intencion: 'elegir_hueco', opcion: 1 })]),
    );

    expect(await estadoDe(String(propuestos[0]?.['id']))).toBe('colisionada');
    expect(eleccion.holdId).not.toBe(String(propuestos[0]?.['id']));
    expect(await estadoDe(eleccion.holdId!)).toBe('retenida');
  });
});

describe('n8n dice que lo creó', () => {
  it('se confirma, se crea la cita y recepción se entera sin botón', async () => {
    const eleccion = await conHuecoElegido();
    const salida = await responderAgenda(eleccion.holdId!, {
      creado: true,
      eventoId: 'gcal-abc123',
    });

    expect(salida.estado).toBe('confirmada');
    expect(salida.citaId).not.toBeNull();
    expect(salida.respuesta).toContain('Confirmada');
    expect(salida.efectos.some((e) => e.tipo === 'informar_a_recepcion')).toBe(true);
    expect(salida.efectos.some((e) => e.tipo === 'avisar_a_recepcion')).toBe(false);

    const citas = await admin`select id from motor.appointments where client_id = ${CLINICA}`;
    expect(citas).toHaveLength(1);
  });

  it('la confirmación dice la hora', async () => {
    const eleccion = await conHuecoElegido();
    const filas = await admin`select slot_start from motor.holds where id = ${eleccion.holdId!}`;
    const hora = new Intl.DateTimeFormat('es-ES', {
      timeZone: 'Europe/Madrid',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(String(filas[0]?.['slot_start'])));

    const salida = await responderAgenda(eleccion.holdId!, { creado: true, eventoId: 'x' });

    expect(salida.respuesta).toContain(hora);
  });

  it('si n8n reintenta la llamada, no se crea una segunda cita', async () => {
    const eleccion = await conHuecoElegido();
    const deps = dependenciasDePrueba({ core, agenda, reloj: () => AHORA, configuracion: CONFIG });
    const peticion = {
      idempotencyKey: 'evento-cb-repetido',
      clientId: CLINICA,
      holdId: eleccion.holdId!,
      creado: true,
      eventoId: 'gcal-abc123',
    };

    const primera = await eventoDeAgenda(deps, peticion);
    const segunda = await eventoDeAgenda(deps, peticion);

    expect(segunda.cuerpo.citaId).toBe(primera.cuerpo.citaId);
    const citas = await admin`select id from motor.appointments where client_id = ${CLINICA}`;
    expect(citas).toHaveLength(1);
  });
});

describe('el hueco estaba ocupado', () => {
  it('colisiona y se intenta la segunda opción, sin decirle nada todavía', async () => {
    const eleccion = await conHuecoElegido();
    const salida = await responderAgenda(eleccion.holdId!, {
      creado: false,
      motivo: 'ocupado',
    });

    expect(salida.estado).toBe('colisionada');
    expect(await estadoDe(eleccion.holdId!)).toBe('colisionada');
    // La segunda opción pasa a esperar su propio evento.
    expect(salida.alternativaHoldId).toBeDefined();
    expect(await estadoDe(salida.alternativaHoldId!)).toBe('retenida');
    expect(salida.efectos.some((e) => e.tipo === 'crear_evento_agenda')).toBe(true);
    // Y el paciente sigue sin recibir nada: aún no hay nada cierto.
    expect(salida.respuesta).toBeNull();
  });

  it('sin alternativa sí se le dice, porque si no se queda esperando', async () => {
    const eleccion = await conHuecoElegido();
    await admin`
      update motor.holds set state = 'caducada'
       where client_id = ${CLINICA} and state = 'propuesta'
    `;

    const salida = await responderAgenda(eleccion.holdId!, { creado: false, motivo: 'ocupado' });

    expect(salida.respuesta).not.toBeNull();
    expect(salida.efectos.some((e) => e.tipo === 'proponer_alternativa')).toBe(true);
  });

  it('la segunda opción es del MISMO tratamiento: no se escribe en la agenda otro', async () => {
    // Un paciente puede tener varias citas en marcha. Eligió axilas y, mientras
    // n8n escribía, pidió piernas: lo propuesto vivo ahora es de piernas. Si las
    // axilas colisionan, «la siguiente propuesta» ya no es una segunda opción de
    // las axilas — y en este modo, pasar a ella es ESCRIBIR una cita de piernas
    // en la agenda de la clínica que nadie ha elegido.
    const eleccion = await conHuecoElegido();
    await enviar(
      'y otra de piernas',
      agenteGuionado([extraccion({ intencion: 'agendar', servicio: 'laser-piernas' })]),
    );

    const salida = await responderAgenda(eleccion.holdId!, { creado: false, motivo: 'ocupado' });

    expect(salida.alternativaHoldId).toBeUndefined();
    expect(salida.efectos.some((e) => e.tipo === 'crear_evento_agenda')).toBe(false);
    const piernas = await admin`
      select state from motor.holds
       where client_id = ${CLINICA} and service_code = 'laser-piernas'
    `;
    expect(piernas.every((f) => f['state'] === 'propuesta')).toBe(true);
  });
});

/**
 * La tercera salida. `rechazado` y `error` **no** son «está ocupado»: no sabemos
 * si el evento llegó a crearse. Pasar al paciente a otra hora podría dejar un
 * evento fantasma quitándole capacidad real a la clínica.
 */
describe('no se pudo escribir, y no sabemos si existe', () => {
  it('la cita del paciente NO se toca: degrada al camino de recepción', async () => {
    const eleccion = await conHuecoElegido();
    const salida = await responderAgenda(eleccion.holdId!, { creado: false, motivo: 'error' });

    expect(salida.estado).toBe('pendiente_recepcion');
    // El hueco sigue siendo suyo y sigue bloqueado.
    expect(await estadoDe(eleccion.holdId!)).toBe('pendiente_recepcion');
    expect(salida.citaId).toBeNull();
    // Y ahora sí recibe algo: lleva esperando desde que eligió.
    expect(salida.respuesta).toContain('recepción');
    expect(salida.efectos.some((e) => e.tipo === 'avisar_a_recepcion')).toBe(true);
  });

  it('lo mira una persona, y el motivo del escalado lo dice', async () => {
    const eleccion = await conHuecoElegido();
    await responderAgenda(eleccion.holdId!, { creado: false, motivo: 'rechazado' });

    const escalados = await admin`
      select reason from motor.escalations where client_id = ${CLINICA}
    `;
    expect(escalados.map((f) => String(f['reason']))).toContain('agenda_no_escrita');
  });

  it('no se pasa a la segunda opción: eso dejaría un evento fantasma', async () => {
    const eleccion = await conHuecoElegido();
    const antes = await admin`
      select id from motor.holds where client_id = ${CLINICA} and state = 'propuesta'
    `;

    const salida = await responderAgenda(eleccion.holdId!, { creado: false, motivo: 'error' });

    expect(salida.alternativaHoldId).toBeUndefined();
    const despues = await admin`
      select id from motor.holds where client_id = ${CLINICA} and state = 'propuesta'
    `;
    expect(despues).toHaveLength(antes.length);
  });
});

describe('n8n no contesta nunca', () => {
  it('el vencimiento degrada igual, y el paciente deja de esperar', async () => {
    const eleccion = await conHuecoElegido();
    const cuatroMinutosDespues = new Date(AHORA.getTime() + 4 * 60_000);
    const deps = dependenciasDePrueba({
      core,
      agenda,
      reloj: () => cuatroMinutosDespues,
      configuracion: CONFIG,
    });

    const salida = await caducarRetenciones(deps, { clientId: CLINICA });

    expect(await estadoDe(eleccion.holdId!)).toBe('pendiente_recepcion');
    const aplicado = salida.aplicados.find((a) => a.holdId === eleccion.holdId);
    expect(aplicado?.hasta).toBe('pendiente_recepcion');
    expect(aplicado?.efectos.map((e) => e.tipo)).toContain('escalar_a_humano');
  });

  /**
   * **De madrugada también.** Un hueco en `retenida` es alguien que eligió hace
   * dos minutos y espera su confirmación ahora: que n8n se haya muerto no
   * convierte su espera en algo que pueda contestarse mañana. Es la regla de
   * 24/7 por otra puerta.
   */
  it('de madrugada no se queda esperando diez horas', async () => {
    const eleccion = await conHuecoElegido(() => NOCHE);
    const despues = new Date(NOCHE.getTime() + 4 * 60_000);
    const deps = dependenciasDePrueba({
      core,
      agenda,
      reloj: () => despues,
      configuracion: CONFIG,
    });

    const salida = await caducarRetenciones(deps, { clientId: CLINICA });

    expect(salida.diferidoPorHorario).toBe(false);
    expect(await estadoDe(eleccion.holdId!)).toBe('pendiente_recepcion');
    // Pero a recepción no se la molesta a las 23:35: su aviso espera a que abra.
    const aplicado = salida.aplicados.find((a) => a.holdId === eleccion.holdId);
    expect(aplicado?.efectos.map((e) => e.tipo)).not.toContain('avisar_a_recepcion');
    const filas = await admin`
      select reception_notified_at from motor.holds where id = ${eleccion.holdId!}
    `;
    expect(filas[0]?.['reception_notified_at']).toBeNull();
  });
});

describe('llamadas que llegan tarde', () => {
  it('si el hueco ya degradó, la respuesta de n8n no lo deshace', async () => {
    const eleccion = await conHuecoElegido();
    await responderAgenda(eleccion.holdId!, { creado: false, motivo: 'error' });

    // n8n vuelve en sí y dice que sí lo había creado.
    const tardia = await responderAgenda(eleccion.holdId!, { creado: true, eventoId: 'tarde' });

    expect(tardia.estado).toBe('pendiente_recepcion');
    expect(tardia.citaId).toBeNull();
    expect(tardia.mensajeParaRecepcion).toContain('agenda');
    // Y no se le manda nada al paciente por segunda vez.
    expect(tardia.respuesta).toBeNull();
  });
});
