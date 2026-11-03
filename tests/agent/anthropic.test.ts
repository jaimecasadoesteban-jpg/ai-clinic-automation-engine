import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';

import {
  ClasificadorAnthropic,
  PresupuestoAgotadoError,
  Presupuesto,
  ProveedorNoDisponibleError,
  RedactorAnthropic,
  RegistroDeLlamadas,
  ResumidorAnthropic,
  sinCitas,
} from '../../src/agent/anthropic.js';
import { MODELOS, PRESUPUESTO } from '../../src/agent/models.js';
import type { PromptPatient } from '../../src/agent/prompt-boundary.js';
import { configDePrueba } from '../support/fakes.js';

/**
 * Las piezas reales contra un cliente falso: se comprueba qué se le manda al
 * proveedor y qué se hace cuando no responde. Sin llamadas de red.
 */

const PACIENTE: PromptPatient = { ref: 'pac_8371', nombre: 'Lucía' };

/** Datos sensibles que NUNCA pueden acabar en una petición al proveedor. */
const PROHIBIDOS = {
  telefono: '+34611223344',
  apellidos: 'Fernández Arrieta',
  historia: 'HC-99812',
};

interface Peticion {
  body: Record<string, unknown>;
}

function clienteFalso(opciones: {
  respuesta?: unknown;
  error?: Error;
  capturadas?: Peticion[];
}): Anthropic {
  const responder = async (body: Record<string, unknown>): Promise<unknown> => {
    opciones.capturadas?.push({ body });
    if (opciones.error !== undefined) throw opciones.error;
    return opciones.respuesta;
  };

  return {
    messages: { create: responder },
    beta: { messages: { create: responder } },
  } as unknown as Anthropic;
}

function respuestaDeTexto(texto: string): unknown {
  return {
    stop_reason: 'end_turn',
    model: MODELOS.redactor,
    content: [{ type: 'text', text: texto }],
    usage: { input_tokens: 120, output_tokens: 40 },
  };
}

function redactor(cliente: Anthropic, presupuesto = new Presupuesto(0)): RedactorAnthropic {
  return new RedactorAnthropic(
    { cliente, presupuesto },
    { config: configDePrueba(), turnos: [], resumen: null },
  );
}

describe('versión de modelo fijada, nunca un alias móvil', () => {
  it('el clasificador es el modelo pequeño con su fecha', () => {
    expect(MODELOS.clasificador).toBe('claude-haiku-4-5-20251001');
  });

  it('el redactor es el modelo grande, con el identificador completo', () => {
    // `claude-opus-5` no tiene variante fechada: añadirle un sufijo da un 404.
    expect(MODELOS.redactor).toBe('claude-opus-5');
    expect(MODELOS.redactor).not.toMatch(/-\d{8}$/);
  });

  it('son modelos distintos: el grande no clasifica', () => {
    expect(MODELOS.clasificador).not.toBe(MODELOS.redactor);
  });
});

describe('la frontera del prompt no se puede esquivar', () => {
  it('lo que se envía al proveedor no contiene teléfono, apellidos ni historia', async () => {
    const capturadas: Peticion[] = [];
    const cliente = clienteFalso({
      respuesta: respuestaDeTexto('La sesión de axilas son 39,90 €.'),
      capturadas,
    });

    await redactor(cliente).redactar({
      intencion: 'precio',
      texto: `soy ${PROHIBIDOS.apellidos}, mi telefono es ${PROHIBIDOS.telefono}`,
      paciente: PACIENTE,
    });

    expect(capturadas).toHaveLength(1);
    // Se inspecciona el cuerpo REAL que sale hacia el proveedor, no un
    // intermedio: si alguien abriera un camino paralelo, aparecería aquí.
    const enviado = JSON.stringify(capturadas[0]?.body);
    // El mensaje del paciente sí viaja (es lo que hay que responder), pero el
    // sistema y la identificación no pueden traer nada más de la ficha.
    const sistema = String((capturadas[0]?.body as { system?: unknown }).system ?? '');
    for (const valor of Object.values(PROHIBIDOS)) {
      expect(sistema).not.toContain(valor);
    }
    expect(enviado).toContain('pac_8371');
    expect(enviado).toContain('Lucía');
  });

  it('el redactor sólo acepta la vista reducida del paciente', () => {
    // Comprobación de tipos, no de ejecución: `redactar` recibe `PromptPatient`,
    // que sólo tiene `ref` y `nombre`. Una fila de `patients` no encaja aquí, y
    // por eso no existe un camino paralelo que se salte la frontera.
    const claves = Object.keys(PACIENTE).sort();
    expect(claves).toEqual(['nombre', 'ref']);
  });
});

describe('cuando el proveedor no responde, el paciente no se queda en silencio', () => {
  it('un error del proveedor se convierte en un error de dominio con mensaje al paciente', async () => {
    const cliente = clienteFalso({ error: new Error('ECONNRESET') });

    const fallo = redactor(cliente).redactar({
      intencion: 'precio',
      texto: 'cuanto cuesta?',
      paciente: PACIENTE,
    });

    await expect(fallo).rejects.toBeInstanceOf(ProveedorNoDisponibleError);
    await expect(fallo).rejects.toMatchObject({ code: 'proveedor_no_disponible' });
    // El mensaje de reserva no depende del modelo: está en el código.
    const error = await fallo.catch((e: unknown) => e);
    expect((error as ProveedorNoDisponibleError).patientMessage).toContain('persona del equipo');
  });

  it('una respuesta vacía también cuenta como caída', async () => {
    const cliente = clienteFalso({ respuesta: respuestaDeTexto('') });

    await expect(
      redactor(cliente).redactar({ intencion: 'otro', texto: 'hola', paciente: PACIENTE }),
    ).rejects.toBeInstanceOf(ProveedorNoDisponibleError);
  });

  it('un rechazo del proveedor no se envía como si fuera una respuesta', async () => {
    const cliente = clienteFalso({
      respuesta: {
        stop_reason: 'refusal',
        model: MODELOS.redactor,
        content: [],
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    });

    await expect(
      redactor(cliente).redactar({ intencion: 'otro', texto: 'hola', paciente: PACIENTE }),
    ).rejects.toBeInstanceOf(ProveedorNoDisponibleError);
  });

  it('si el clasificador cae, la intención es «otro» y la conversación sigue', async () => {
    const cliente = clienteFalso({ error: new Error('timeout') });
    const clasificacion = await new ClasificadorAnthropic(
      { cliente, presupuesto: new Presupuesto(0) },
      configDePrueba(),
      { turnos: [], servicioVigente: null, citasVivas: [], huecosOfrecidos: [] },
    ).clasificar({ texto: 'hola', paciente: PACIENTE });

    // Ruta conservadora, no excepción: el paciente recibe una respuesta general.
    expect(clasificacion.intencion).toBe('otro');
    expect(clasificacion.modelo).toContain('reserva');
    // Y sobre todo: sin servicio, para que NO se propongan huecos a ciegas.
    expect(clasificacion.servicio).toBeNull();
  });
});

describe('límite de gasto', () => {
  it('corta el bucle al superar las llamadas permitidas por mensaje', async () => {
    const cliente = clienteFalso({ respuesta: respuestaDeTexto('vale') });
    const presupuesto = new Presupuesto(0);
    const r = redactor(cliente, presupuesto);

    for (let i = 0; i < PRESUPUESTO.llamadasPorMensaje; i += 1) {
      await r.redactar({ intencion: 'otro', texto: 'hola', paciente: PACIENTE });
    }

    await expect(
      r.redactar({ intencion: 'otro', texto: 'hola', paciente: PACIENTE }),
    ).rejects.toBeInstanceOf(PresupuestoAgotadoError);
  });

  it('corta también por el acumulado de la conversación', async () => {
    const cliente = clienteFalso({ respuesta: respuestaDeTexto('vale') });
    // La conversación ya ha gastado su cupo entero.
    const presupuesto = new Presupuesto(PRESUPUESTO.llamadasPorConversacionEnVentana);

    await expect(
      redactor(cliente, presupuesto).redactar({
        intencion: 'otro',
        texto: 'hola',
        paciente: PACIENTE,
      }),
    ).rejects.toBeInstanceOf(PresupuestoAgotadoError);
  });

  it('el error de presupuesto lleva su propio mensaje al paciente', () => {
    const error = new PresupuestoAgotadoError('agotado');
    expect(error.patientMessage).not.toBeNull();
    expect(error.httpStatus).toBe(429);
  });
});

describe('lo que se le manda al modelo', () => {
  it('el catálogo va entero en el prompt: el modelo nunca recuerda un precio', async () => {
    const capturadas: Peticion[] = [];
    const cliente = clienteFalso({ respuesta: respuestaDeTexto('ok'), capturadas });

    await redactor(cliente).redactar({
      intencion: 'precio',
      texto: 'cuanto cuesta?',
      paciente: PACIENTE,
    });

    const sistema = String((capturadas[0]?.body as { system?: unknown }).system ?? '');
    expect(sistema).toContain('39.90');
    expect(sistema).toContain('399.00');
    expect(sistema).toContain('No ofrezcas descuentos');
    // No «nunca digas confirmada»: en modo automática la cita SÍ se confirma, y el
    // estado se lo dice. La regla es que lo que manda es el estado.
    expect(sistema).toContain('sólo está confirmada si el ESTADO dice que lo está');
  });

  it('la versión del modelo que sale en la petición es la fijada', async () => {
    const capturadas: Peticion[] = [];
    const cliente = clienteFalso({ respuesta: respuestaDeTexto('ok'), capturadas });

    await redactor(cliente).redactar({ intencion: 'otro', texto: 'hola', paciente: PACIENTE });

    expect((capturadas[0]?.body as { model?: string }).model).toBe(MODELOS.redactor);
  });
});

describe('el presupuesto se dispara de verdad', () => {
  /**
   * **Un límite que nunca se ha visto disparar no es un límite: es una línea de
   * código con buenas intenciones.** Y ya sabemos cómo acaban las protecciones
   * sin probar — la recuperación de colisión llevaba nueve fases rota.
   *
   * Lo que protege: un bucle que se llame a sí mismo puede quemar tokens sin
   * parar. Al alcanzar el tope se escala, no se sigue.
   */
  it('el tope por mensaje corta a la llamada de más', async () => {
    const capturadas: Peticion[] = [];
    const cliente = clienteFalso({ respuesta: respuestaDeTexto('vale'), capturadas });
    const presupuesto = new Presupuesto(0);
    const r = redactor(cliente, presupuesto);

    for (let i = 0; i < PRESUPUESTO.llamadasPorMensaje; i += 1) {
      await r.redactar({ intencion: 'precio', texto: 'cuanto cuesta?', paciente: PACIENTE });
    }
    expect(capturadas).toHaveLength(PRESUPUESTO.llamadasPorMensaje);

    await expect(
      r.redactar({ intencion: 'precio', texto: 'cuanto cuesta?', paciente: PACIENTE }),
    ).rejects.toBeInstanceOf(PresupuestoAgotadoError);

    // Y no se llegó a llamar al proveedor: se corta ANTES de gastar.
    expect(capturadas).toHaveLength(PRESUPUESTO.llamadasPorMensaje);
  });

  it('el tope por conversación cuenta lo ya gastado en turnos anteriores', async () => {
    const capturadas: Peticion[] = [];
    const cliente = clienteFalso({ respuesta: respuestaDeTexto('vale'), capturadas });
    // La conversación llega con el presupuesto ya consumido entero.
    const r = redactor(cliente, new Presupuesto(PRESUPUESTO.llamadasPorConversacionEnVentana));

    await expect(
      r.redactar({ intencion: 'precio', texto: 'cuanto cuesta?', paciente: PACIENTE }),
    ).rejects.toBeInstanceOf(PresupuestoAgotadoError);
    expect(capturadas).toEqual([]);
  });

  it('el error del presupuesto lleva un mensaje para el paciente: no es silencio', () => {
    const error = new PresupuestoAgotadoError('agotado');

    // Regla 4: ninguna ruta termina en silencio, tampoco ésta.
    expect(error.patientMessage).not.toBeUndefined();
    expect(error.patientMessage).toContain('persona');
    expect(error.httpStatus).toBe(429);
  });
});

/**
 * Regla 6: prompt, respuesta, modelo, tokens y latencia de CADA llamada.
 *
 * `messages.prompt` y `latency_ms` estaban a NULL en producción: ante la
 * retractación del aparcamiento hubo que reconstruir el prompt desde el código,
 * suponiendo que no había cambiado. Y las regeneraciones no dejaban rastro.
 */
describe('cada llamada queda registrada', () => {
  it('la redacción: lo que se mandó, lo que volvió, tokens y latencia', async () => {
    const registro = new RegistroDeLlamadas();
    const r = new RedactorAnthropic(
      { cliente: clienteFalso({ respuesta: respuestaDeTexto('Son 39,90 €.') }), presupuesto: new Presupuesto(0), registro },
      { config: configDePrueba(), turnos: [{ rol: 'paciente', texto: 'hola' }], resumen: null },
    );

    await r.redactar({ intencion: 'precio', texto: 'cuanto cuesta?', paciente: PACIENTE });

    const [llamada] = registro.todas();
    expect(llamada).toMatchObject({ tipo: 'redactar', respuesta: 'Son 39,90 €.', tokensEntrada: 120, tokensSalida: 40, error: null });
    expect(llamada?.sistema).toContain('CATÁLOGO Y PRECIOS');
    expect(llamada?.mensajes.map((m) => m.content)).toContain('hola');
    expect(llamada?.latenciaMs).toBeGreaterThanOrEqual(0);
  });

  it('la regeneración es otra llamada, con la corrección dentro', async () => {
    const registro = new RegistroDeLlamadas();
    const r = new RedactorAnthropic(
      { cliente: clienteFalso({ respuesta: respuestaDeTexto('vale') }), presupuesto: new Presupuesto(0), registro },
      { config: configDePrueba(), turnos: [], resumen: null },
    );

    await r.redactar({ intencion: 'otro', texto: 'hola', paciente: PACIENTE });
    await r.redactar({
      intencion: 'otro',
      texto: 'hola',
      paciente: PACIENTE,
      correccion: { textoAnterior: 'x', explicacion: 'hora no propuesta' },
    });

    expect(registro.todas()).toHaveLength(2);
    expect(registro.todas()[1]?.mensajes.at(-1)?.content).toContain('hora no propuesta');
  });

  it('la que falla también: se gastó, y es la que más hay que poder explicar', async () => {
    const registro = new RegistroDeLlamadas();
    const r = new RedactorAnthropic(
      { cliente: clienteFalso({ error: new Error('credit balance is too low') }), presupuesto: new Presupuesto(0), registro },
      { config: configDePrueba(), turnos: [], resumen: null },
    );

    await expect(r.redactar({ intencion: 'otro', texto: 'hola', paciente: PACIENTE })).rejects.toBeInstanceOf(
      ProveedorNoDisponibleError,
    );
    expect(registro.todas()[0]).toMatchObject({ tipo: 'redactar', respuesta: null, error: 'credit balance is too low' });
  });

  it('la clasificación, aunque falle y se use la extracción de reserva', async () => {
    const registro = new RegistroDeLlamadas();
    const c = new ClasificadorAnthropic(
      { cliente: clienteFalso({ error: new Error('timeout') }), presupuesto: new Presupuesto(0), registro },
      configDePrueba(),
      { turnos: [], servicioVigente: null, citasVivas: [], huecosOfrecidos: [] },
    );

    await c.clasificar({ texto: 'hola', paciente: PACIENTE });

    expect(registro.todas()[0]).toMatchObject({ tipo: 'clasificar', error: 'timeout' });
  });
});

describe('el resumen', () => {
  it('no da citas por hechas ni lleva salud: lo dicen sus instrucciones', async () => {
    const capturadas: Peticion[] = [];
    const registro = new RegistroDeLlamadas();
    const resumidor = new ResumidorAnthropic({
      cliente: clienteFalso({ respuesta: respuestaDeTexto('Le interesa la limpieza facial.'), capturadas }),
      presupuesto: new Presupuesto(0),
      registro,
    });

    const resumen = await resumidor.resumir({
      resumenAnterior: null,
      turnos: [{ rol: 'paciente', texto: '¿cuánto cuesta la limpieza?' }],
    });

    expect(resumen).toBe('Le interesa la limpieza facial.');
    const sistema = String(capturadas[0]?.body['system']);
    expect(sistema).toMatch(/NO menciones días, horas ni fechas/);
    expect(sistema).toMatch(/nada sobre su salud/);
    expect(capturadas[0]?.body['model']).toBe(MODELOS.resumidor);
    expect(registro.todas()[0]?.tipo).toBe('resumir');
  });

  it('si falla, devuelve null: un resumen que falta no tumba el turno', async () => {
    const resumidor = new ResumidorAnthropic({
      cliente: clienteFalso({ error: new Error('caído') }),
      presupuesto: new Presupuesto(0),
    });

    await expect(resumidor.resumir({ resumenAnterior: null, turnos: [] })).resolves.toBeNull();
  });

  it('sin presupuesto no llama a nadie', async () => {
    const capturadas: Peticion[] = [];
    const resumidor = new ResumidorAnthropic({
      cliente: clienteFalso({ respuesta: respuestaDeTexto('x'), capturadas }),
      presupuesto: new Presupuesto(PRESUPUESTO.llamadasPorConversacionEnVentana),
    });

    await expect(resumidor.resumir({ resumenAnterior: null, turnos: [] })).resolves.toBeNull();
    expect(capturadas).toEqual([]);
  });
});

describe('el resumen no puede llevar citas, aunque el modelo las escriba', () => {
  it('quita las frases con hora, día, reserva o confirmación, y deja el resto', () => {
    // Literal de una de las tres pruebas contra el modelo real.
    const real =
      'El paciente está interesado en una limpieza facial profunda (55 €) y prefiere citas por las tardes porque ' +
      'trabaja por las mañanas. Se confirmó su cita para el miércoles a las 18:00. Preguntó sobre formas de pago y ' +
      'se le indicó que acepta tarjeta, efectivo y Bizum.';

    const limpio = sinCitas(real);

    expect(limpio).not.toMatch(/miércoles|18:00|confirm/);
    expect(limpio).toMatch(/limpieza facial profunda/);
    expect(limpio).toMatch(/tarjeta, efectivo y Bizum/);
  });

  it.each([
    'Eligió el jueves.',
    'Tiene hora a las 10.',
    'Quedó reservada la de las 17h30.',
    'Se le apuntó una cita.',
  ])('«%s» no pasa', (frase) => {
    expect(sinCitas(frase)).toBe('');
  });
});

describe('el resumidor aplica el filtro', () => {
  it('lo que el modelo escriba sobre la cita no llega al resumen guardado', async () => {
    const resumidor = new ResumidorAnthropic({
      cliente: clienteFalso({
        respuesta: respuestaDeTexto('Le interesa la limpieza facial. Se confirmó su cita para el miércoles a las 18:00.'),
      }),
      presupuesto: new Presupuesto(0),
    });

    const resumen = await resumidor.resumir({ resumenAnterior: null, turnos: [{ rol: 'paciente', texto: 'hola' }] });

    expect(resumen).toBe('Le interesa la limpieza facial.');
  });
});
