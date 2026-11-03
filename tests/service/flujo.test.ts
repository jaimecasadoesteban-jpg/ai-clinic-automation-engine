import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createCore, type Core } from '../../src/db/client.js';
import { registrarResultadoDeCita, marcarEscaladoAtendido } from '../../src/service/appointments.js';
import { procesarMensajeEntrante, type SalidaDeMensaje } from '../../src/service/pipeline.js';
import type { Redactor } from '../../src/service/ports.js';
import { accionRecepcion } from '../../src/service/reception.js';
import { AgendaFalsa, dependenciasDePrueba, huecosDesde, RedactorFalso } from '../support/fakes.js';
import { APP_URL, conexionAdmin, prepararBaseDeDatos } from '../support/db.js';

/**
 * El flujo de agendado extremo a extremo, con el cortafuegos real y las piezas
 * no deterministas falseadas. Sin modelo.
 */

const CLINICA = 'ffff0000-ffff-4fff-8fff-ffff00000000';
const TELEFONO = '+34600111222';
const AHORA = new Date('2026-09-01T09:00:00.000Z');
const PRIMER_HUECO = new Date('2026-09-15T09:00:00.000Z');

const admin = conexionAdmin();
let core: Core;
let agenda: AgendaFalsa;
let contador = 0;

function clave(): string {
  contador += 1;
  return `k-${contador}`;
}

function deps(opciones: { reloj?: () => Date; redactor?: Redactor } = {}) {
  return dependenciasDePrueba({
    core,
    agenda,
    reloj: opciones.reloj ?? (() => AHORA),
    ...(opciones.redactor === undefined ? {} : { redactor: opciones.redactor }),
  });
}

async function enviar(
  texto: string,
  opciones: { telefono?: string; reloj?: () => Date; redactor?: Redactor } = {},
): Promise<SalidaDeMensaje> {
  const { cuerpo } = await procesarMensajeEntrante(deps(opciones), {
    idempotencyKey: clave(),
    clientId: CLINICA,
    telefono: opciones.telefono ?? TELEFONO,
    nombre: 'Marta',
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
  // Cada test parte de una clínica limpia, para que el estado de conversación
  // de uno no contamine al siguiente.
  await admin`delete from motor.audit_log where client_id = ${CLINICA}`;
  await admin`delete from motor.idempotency_keys where client_id = ${CLINICA}`;
  await admin`delete from motor.appointments where client_id = ${CLINICA}`;
  await admin`delete from motor.escalations where client_id = ${CLINICA}`;
  await admin`delete from motor.messages where client_id = ${CLINICA}`;
  await admin`delete from motor.holds where client_id = ${CLINICA}`;
  await admin`delete from motor.conversations where client_id = ${CLINICA}`;
  await admin`delete from motor.suppression where client_id = ${CLINICA}`;
  await admin`delete from motor.patients where client_id = ${CLINICA}`;
  await admin`delete from motor.clients where id = ${CLINICA}`;
  await admin`
    insert into motor.clients (id, slug, name, config, config_version)
    values (${CLINICA}, 'clinica-de-pruebas', 'Clínica Flujo', '{}'::jsonb, 'test')
  `;
  agenda = new AgendaFalsa(huecosDesde(PRIMER_HUECO, 3));
});

describe('flujo completo de agendado', () => {
  it('pedir cita → elegir → recepción confirma → cita creada', async () => {
    const propuesta = await enviar('hola quiero pedir cita para depilacion de axilas');
    expect(propuesta.corte).toBeNull();
    expect(propuesta.respuesta).toContain('opcion 1');

    const propuestos = await admin`
      select count(*)::int as n from motor.holds
      where client_id = ${CLINICA} and state = 'propuesta'
    `;
    // Tres huecos propuestos, y ninguno bloquea todavía.
    expect(propuestos[0]?.['n']).toBe(3);

    const eleccion = await enviar('me viene bien la primera');
    expect(eleccion.holdId).toBeDefined();
    /**
     * El efecto sale **resuelto**: con a quién va y con el texto ya compuesto,
     * para que n8n sólo tenga que enviarlo. `objectContaining` porque lo que se
     * afirma aquí es el enrutado, no el contenido del aviso — eso lo cubre
     * `tests/service/avisos.test.ts`.
     */
    expect(eleccion.efectos).toContainEqual(
      expect.objectContaining({ tipo: 'avisar_a_recepcion', holdId: eleccion.holdId }),
    );
    const aviso = eleccion.efectos.find((e) => e.tipo === 'avisar_a_recepcion');
    expect(aviso?.destinatarios).toEqual([
      { nombre: 'Recepción', canal: 'whatsapp', destino: '+34600111111' },
    ]);
    expect(aviso?.texto).toContain('Cita nueva');

    const trasElegir = await admin`
      select state from motor.holds where id = ${String(eleccion.holdId)}
    `;
    expect(trasElegir[0]?.['state']).toBe('pendiente_recepcion');

    const { cuerpo: confirmacion } = await accionRecepcion(deps(), {
      idempotencyKey: clave(),
      clientId: CLINICA,
      holdId: String(eleccion.holdId),
    });

    expect(confirmacion.estado).toBe('confirmada');
    expect(confirmacion.citaId).not.toBeNull();
    expect(confirmacion.respuesta).toContain('Confirmada');
  });

  it('el paso 6 caza la colisión: si el hueco se ocupó, NO se confirma', async () => {
    await enviar('quiero cita de axilas');
    const eleccion = await enviar('la primera');

    // Alguien de la clínica mete otra cosa en ese hueco por su cuenta, después
    // de que el paciente lo eligiera. Es exactamente el caso del paso 6.
    const elegido = await admin`
      select slot_start, slot_end from motor.holds where id = ${String(eleccion.holdId)}
    `;
    agenda.ocupar(
      new Date(String(elegido[0]?.['slot_start'])),
      new Date(String(elegido[0]?.['slot_end'])),
    );

    const { cuerpo } = await accionRecepcion(deps(), {
      idempotencyKey: clave(),
      clientId: CLINICA,
      holdId: String(eleccion.holdId),
    });

    expect(cuerpo.estado).toBe('colisionada');
    expect(cuerpo.citaId).toBeNull();
    // Al paciente NO se le ha dicho que su cita está confirmada.
    expect(cuerpo.respuesta).not.toContain('Confirmada');
    expect(cuerpo.efectos).toContainEqual(
      expect.objectContaining({ tipo: 'proponer_alternativa' }),
    );
    // Y se ha pasado a la 2ª opción, no se ha quedado la conversación colgada.
    expect(cuerpo.alternativaHoldId).toBeDefined();

    const citas = await admin`select count(*)::int as n from motor.appointments where client_id = ${CLINICA}`;
    expect(citas[0]?.['n']).toBe(0);
  });

  it('cerrar el ciclo libera el hueco, también en el camino feliz', async () => {
    await enviar('quiero cita de axilas');
    const eleccion = await enviar('la primera');
    const { cuerpo: confirmacion } = await accionRecepcion(deps(), {
      idempotencyKey: clave(),
      clientId: CLINICA,
      holdId: String(eleccion.holdId),
    });

    // La asistencia se anota cuando la cita ha pasado.
    const [hueco] = await admin`select slot_end from motor.holds where id = ${String(eleccion.holdId)}`;
    const despues = new Date(new Date(String(hueco?.['slot_end'])).getTime() + 3_600_000);
    const resultado = await registrarResultadoDeCita(deps({ reloj: () => despues }), {
      clientId: CLINICA,
      citaId: String(confirmacion.citaId),
      outcome: 'asistida',
      fuente: 'recepcion',
    });

    expect(resultado.estadoHueco).toBe('liberada');
    expect(resultado.motivoLiberacion).toBe('ciclo_cerrado');
    expect(resultado.cuentaComoGenerada).toBe(true);

    // El hueco vuelve a poder retenerse: ya no está dentro del índice parcial.
    const libre = admin`
      insert into motor.holds (client_id, patient_id, conversation_id, slot_start, slot_end, service_code, state)
      select client_id, patient_id, conversation_id, slot_start, slot_end, service_code, 'retenida'
        from motor.holds where id = ${resultado.holdId}
    `;
    await expect(libre).resolves.not.toThrow();
  });

  it('cancelar con poca antelación libera el hueco y encola el relleno', async () => {
    await enviar('quiero cita de axilas');
    const eleccion = await enviar('la primera');
    const { cuerpo: confirmacion } = await accionRecepcion(deps(), {
      idempotencyKey: clave(),
      clientId: CLINICA,
      holdId: String(eleccion.holdId),
    });

    // A 24 h de la cita: dentro de la ventana de 72 h. El hueco lo elige el
    // núcleo según el horario de la clínica, así que se lee de la base.
    const filas = await admin`
      select slot_start from motor.holds where id = ${String(eleccion.holdId)}
    `;
    const vispera = new Date(new Date(String(filas[0]?.['slot_start'])).getTime() - 24 * 3_600_000);
    const resultado = await registrarResultadoDeCita(deps({ reloj: () => vispera }), {
      clientId: CLINICA,
      citaId: String(confirmacion.citaId),
      outcome: 'cancelada',
      fuente: 'recepcion',
    });

    expect(resultado.motivoLiberacion).toBe('cancelacion');
    expect(resultado.rellenoEncolado).toBe(true);
    expect(resultado.cuentaComoGenerada).toBe(false);
  });
});

describe('idempotencia real', () => {
  it('el mismo webhook dos veces no crea dos conversaciones ni dos citas', async () => {
    const peticion = {
      idempotencyKey: 'meta-reintento-1',
      clientId: CLINICA,
      telefono: TELEFONO,
      nombre: 'Marta',
      texto: 'quiero pedir cita de axilas',
    };

    const primera = await procesarMensajeEntrante(deps(), peticion);
    const segunda = await procesarMensajeEntrante(deps(), peticion);

    // Misma respuesta, byte a byte: el reintento no recibe un error donde la
    // primera vez hubo un éxito.
    expect(segunda.cuerpo).toEqual(primera.cuerpo);

    const conteos = await admin`
      select
        (select count(*) from motor.conversations where client_id = ${CLINICA}) as conversaciones,
        (select count(*) from motor.holds where client_id = ${CLINICA}) as huecos,
        (select count(*) from motor.messages where client_id = ${CLINICA} and direction = 'entrante') as entrantes
    `;
    expect(Number(conteos[0]?.['conversaciones'])).toBe(1);
    // Tres huecos, no seis.
    expect(Number(conteos[0]?.['huecos'])).toBe(3);
    expect(Number(conteos[0]?.['entrantes'])).toBe(1);
  });

  it('reintentar la confirmación de recepción no crea dos citas', async () => {
    await enviar('quiero cita de axilas');
    const eleccion = await enviar('la primera');
    const peticion = {
      idempotencyKey: 'meta-reintento-2',
      clientId: CLINICA,
      holdId: String(eleccion.holdId),
    };

    await accionRecepcion(deps(), peticion);
    await accionRecepcion(deps(), peticion);

    const citas = await admin`select count(*)::int as n from motor.appointments where client_id = ${CLINICA}`;
    // Ésta es la que de verdad duele: dos citas para el mismo hueco.
    expect(citas[0]?.['n']).toBe(1);
  });

  it('la misma clave con otro cuerpo es un error de quien llama', async () => {
    const base = {
      idempotencyKey: 'clave-repetida',
      clientId: CLINICA,
      telefono: TELEFONO,
      nombre: 'Marta',
      texto: 'hola',
    };
    await procesarMensajeEntrante(deps(), base);

    await expect(
      procesarMensajeEntrante(deps(), { ...base, texto: 'otra cosa distinta' }),
    ).rejects.toMatchObject({ code: 'idempotency_key_reutilizada' });
  });
});

describe('idempotencia bajo concurrencia', () => {
  it('dos entregas simultáneas del mismo webhook: sólo una se procesa', async () => {
    // Éste es el que de verdad prueba la restricción. El reintento secuencial lo
    // resuelve la búsqueda de la respuesta previa; dos entregas a la vez no ven
    // nada la una de la otra, y lo único que las separa es
    // `idempotency_keys_unico` fallando en Postgres.
    const otroCore = createCore(APP_URL);
    try {
      const peticion = {
        idempotencyKey: 'meta-entrega-simultanea',
        clientId: CLINICA,
        telefono: TELEFONO,
        nombre: 'Marta',
        texto: 'quiero pedir cita de axilas',
      };

      const resultados = await Promise.allSettled([
        procesarMensajeEntrante(deps(), peticion),
        procesarMensajeEntrante(
          dependenciasDePrueba({ core: otroCore, agenda, reloj: () => AHORA }),
          peticion,
        ),
      ]);

      const conExito = resultados.filter((r) => r.status === 'fulfilled');
      expect(conExito).toHaveLength(1);

      const conteos = await admin`
        select
          (select count(*) from motor.conversations where client_id = ${CLINICA}) as conversaciones,
          (select count(*) from motor.holds where client_id = ${CLINICA}) as huecos
      `;
      // Una conversación y tres huecos. Sin la restricción serían dos y seis.
      expect(Number(conteos[0]?.['conversaciones'])).toBe(1);
      expect(Number(conteos[0]?.['huecos'])).toBe(3);
    } finally {
      await otroCore.close();
    }
  });
});

describe('qué pasa con la conversación después de un corte', () => {
  it('urgencia: la conversación queda en pausa y el agente no vuelve a responder solo', async () => {
    const corte = await enviar('me sale pus de la herida');
    expect(corte.corte?.categoria).toBe('urgencia_clinica');
    expect(corte.estadoConversacion).toBe('pausada');

    // Diez minutos después pregunta por el precio. El agente NO contesta el precio.
    const despues = await enviar('oye y cuanto cuesta el laser?', {
      reloj: () => new Date(AHORA.getTime() + 10 * 60_000),
    });

    expect(despues.estadoConversacion).toBe('pausada');
    expect(despues.respuesta ?? '').not.toContain('respuesta-falsa');

    const salientes = await admin`
      select body from motor.messages
      where client_id = ${CLINICA} and direction = 'saliente' order by created_at
    `;
    expect(salientes.map((f) => f['body']).join(' ')).not.toContain('respuesta-falsa');
  });

  it('en pausa, el paciente recibe aviso pero no uno por mensaje', async () => {
    await enviar('estoy sangrando mucho');

    // 30 minutos entre avisos: es el valor por defecto de la configuración.
    const uno = await enviar('hola?', { reloj: () => new Date(AHORA.getTime() + 60_000) });
    const dos = await enviar('sigues ahi?', {
      reloj: () => new Date(AHORA.getTime() + 120_000),
    });
    const tres = await enviar('bueno pues nada', {
      reloj: () => new Date(AHORA.getTime() + 40 * 60_000),
    });

    // La fatiga de alertas también aplica al paciente: no se le contesta lo
    // mismo diez veces seguidas.
    expect(uno.respuesta).toBeNull();
    expect(dos.respuesta).toBeNull();
    expect(tres.respuesta).toContain('equipo');
  });

  it('una persona marca el escalado como atendido y la conversación se reanuda', async () => {
    const corte = await enviar('me sale pus de la herida');
    const escalado = corte.efectos.find((e) => e.tipo === 'escalar_a_humano');
    expect(escalado).toBeDefined();
    if (escalado === undefined || escalado.tipo !== 'escalar_a_humano') return;

    const reanudada = await marcarEscaladoAtendido(deps(), {
      idempotencyKey: 'atender-flujo-1',
      clientId: CLINICA,
      escaladoId: escalado.escaladoId,
      atendidoPor: 'Dra. Responsable',
    });
    expect(reanudada.estadoConversacion).toBe('abierta');

    const despues = await enviar('vale, entonces queria pedir cita de axilas');
    expect(despues.estadoConversacion).toBe('abierta');
    expect(despues.respuesta).toContain('opcion 1');
  });

  it('contenido clínico NO pausa: se responde, se escala y la conversación sigue', async () => {
    const corte = await enviar('me ha salido un bultito donde me pincharon');
    expect(corte.corte?.categoria).toBe('contenido_clinico');
    expect(corte.estadoConversacion).toBe('abierta');

    const despues = await enviar('vale gracias, y para pedir cita de axilas?', {
      reloj: () => new Date(AHORA.getTime() + 10 * 60_000),
    });
    expect(despues.corte).toBeNull();
    expect(despues.respuesta).toContain('opcion 1');
  });

  it('si vuelve a tocar terreno clínico, vuelve a cortar', async () => {
    await enviar('me ha salido un bultito');
    const otra = await enviar('y ademas tengo un lunar raro', {
      reloj: () => new Date(AHORA.getTime() + 10 * 60_000),
    });

    expect(otra.corte?.categoria).toBe('contenido_clinico');
  });

  it('baja: se cierra, pero si el paciente vuelve a escribir se le atiende', async () => {
    const baja = await enviar('no me mandeis mas mensajes por favor');
    expect(baja.corte?.categoria).toBe('baja');
    expect(baja.estadoConversacion).toBe('cerrada');
    // La confirmación de la baja sí se envía: es lo que la hace verificable.
    expect(baja.respuesta).not.toBeNull();

    const despues = await enviar('bueno pues queria pedir cita de axilas', {
      reloj: () => new Date(AHORA.getTime() + 3_600_000),
    });

    /**
     * Este test decía «no se envía nada más, nunca» y estaba mal.
     *
     * Honrar el opt-out es no escribirle POR INICIATIVA NUESTRA: nada de
     * oleadas ni recordatorios comerciales. Contestar a quien nos escribe
     * pidiendo cita no es una comunicación comercial, es atender su petición —y
     * el propio texto de la baja le dice «escríbenos cuando quieras».
     *
     * Con el comportamiento anterior, quien se daba de baja y pedía cita treinta
     * segundos después recibía silencio absoluto y la clínica perdía al
     * paciente.
     */
    expect(despues.respuesta).not.toBeNull();
    expect(despues.estadoConversacion).toBe('abierta');

    // Y NO se abre un escalado nuevo: el de la propia baja sigue abierto, así
    // que la clínica ya tiene ese hilo delante. Lo que queda es el rastro.
    const escalados = await admin`
      select count(*)::int as n from motor.escalations where client_id = ${CLINICA}
    `;
    expect(escalados[0]?.['n']).toBe(1);
    const acciones = await admin`select action from motor.audit_log where client_id = ${CLINICA}`;
    expect(acciones.map((f) => String(f['action']))).toContain(
      'reabierta_por_paciente_con_baja_vigente',
    );

    // Y la baja NO se levanta: pedir cita no revoca el consentimiento comercial.
    const bajas = await admin`select count(*)::int as n from motor.suppression where client_id = ${CLINICA}`;
    expect(bajas[0]?.['n']).toBe(1);
  });
});

describe('validación de salida: regenerar una vez y si no, escalar', () => {
  it('una salida inválida se regenera, y si la segunda vale, se envía', async () => {
    // El modelo se inventa un precio; a la segunda, con la corrección delante,
    // lo dice bien.
    const redactor = new RedactorFalso([
      'La sesión son 45 €, ¿te viene bien?',
      'La sesión son 39,90 €, ¿te viene bien?',
    ]);

    const salida = await enviar('cuanto cuesta el laser?', { redactor });

    expect(salida.respuesta).toContain('39,90');
    expect(redactor.correcciones).toHaveLength(1);
    expect(redactor.correcciones[0]?.explicacion).toContain('no está en el catálogo');
    // Al paciente no le ha llegado el precio inventado.
    expect(salida.respuesta).not.toContain('45');
  });

  it('si vuelve a fallar, NO se envía el texto del modelo: se escala', async () => {
    const redactor = new RedactorFalso([
      'Son 45 € y te garantizo que queda perfecto.',
      'Bueno, en realidad son 47 € y te lo garantizo igual.',
    ]);

    const salida = await enviar('cuanto cuesta?', { redactor });

    expect(salida.respuesta).toContain('alguien del equipo');
    expect(salida.respuesta).not.toContain('45');
    expect(salida.respuesta).not.toContain('47');
    expect(salida.respuesta).not.toContain('garantiz');
    expect(salida.efectos.some((e) => e.tipo === 'escalar_a_humano')).toBe(true);

    const escalados = await admin`
      select reason from motor.escalations where client_id = ${CLINICA}
    `;
    expect(escalados.map((f) => f['reason'])).toContain('validacion_fallida');
  });

  it('queda registrado por qué se bloqueó y con qué versión de configuración', async () => {
    const redactor = new RedactorFalso(['Son 45 €.', 'Siguen siendo 45 €.']);
    await enviar('cuanto cuesta?', { redactor });

    const filas = await admin`
      select validation_result from motor.messages
      where client_id = ${CLINICA} and direction = 'saliente'
      order by created_at desc limit 1
    `;
    const resultado = filas[0]?.['validation_result'] as {
      valido: boolean;
      regeneraciones: number;
      configVersion: string;
      motivos: Array<{ tipo: string }>;
    };

    expect(resultado.valido).toBe(false);
    expect(resultado.regeneraciones).toBe(1);
    // Con esto se puede reconstruir qué precio estaba vigente aunque la clínica
    // cambie el YAML después.
    expect(resultado.configVersion.length).toBeGreaterThan(0);
    expect(resultado.motivos.map((m) => m.tipo)).toContain('precio_inexistente');
  });

  it('una salida correcta a la primera no se regenera', async () => {
    const redactor = new RedactorFalso(['El láser de piernas son 89 €.']);

    const salida = await enviar('cuanto cuesta el laser de piernas?', { redactor });

    expect(salida.respuesta).toContain('89');
    expect(redactor.correcciones).toEqual([]);
  });
});

describe('métrica de tasa de corte', () => {
  it('cuenta los cortes por categoría y día, para poder medir la fatiga de alertas', async () => {
    await enviar('me sale pus');
    await enviar('cuanto cuesta el laser?', { telefono: '+34600111333' });
    await enviar('tengo un lunar raro', { telefono: '+34600111444' });
    await enviar('a que hora abris?', { telefono: '+34600111555' });

    const filas = await admin`
      select categoria, cortes, entrantes
      from motor.firewall_daily_rates(${'2026-09-01'}::date, ${'2026-09-01'}::date)
      where client_id = ${CLINICA}
      order by categoria
    `;

    const porCategoria = Object.fromEntries(
      filas.map((f) => [String(f['categoria']), Number(f['cortes'])]),
    );
    expect(porCategoria).toEqual({ contenido_clinico: 1, urgencia_clinica: 1 });
    expect(Number(filas[0]?.['entrantes'])).toBe(4);
  });
});
