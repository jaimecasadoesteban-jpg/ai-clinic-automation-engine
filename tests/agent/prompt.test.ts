import { describe, expect, it } from 'vitest';

import { construirSistema, type EstadoDelSistema } from '../../src/agent/prompt.js';
import { cargarConfiguracion } from '../../src/config/registry.js';
import { configDePrueba } from '../support/fakes.js';

/**
 * Lo que el prompt le dice al modelo sobre las citas del paciente.
 *
 * Regla 4 bis: el mensaje y el estado tienen que coincidir. El modelo no ve la
 * base; ve estas líneas. Si dicen «tu cita» cuando hay dos, o callan que no se
 * ha reservado nada, el mensaje que salga va a decir otra cosa que la base.
 */

const CONFIG = configDePrueba();
const PACIENTE = { ref: 'pac_1', nombre: 'Lucía' };

function estado(extra: Partial<EstadoDelSistema> = {}): EstadoDelSistema {
  return {
    faltaServicio: false,
    servicio: null,
    preferencia: null,
    preferenciaNoSatisfecha: false,
    servicioCambiado: false,
    reagendando: null,
    cancelada: false,
    faltaOpcion: false,
    alternativasAlejadas: false,
    consultada: false,
    citasVigentes: [],
    preguntarCual: null,
    preguntarSiSustituye: null,
    desmentidos: [],
    ...extra,
  };
}

function sistema(e: EstadoDelSistema): string {
  return construirSistema({ config: CONFIG, paciente: PACIENTE, turnos: [], resumen: null, estado: e });
}

const LIMPIEZA = { descripcion: 'Limpieza facial, miércoles, 26, 16:00', confirmada: false };
const LASER = { descripcion: 'Láser axilas, viernes, 28, 17:00', confirmada: true };

describe('varias citas en el prompt', () => {
  it('nombra TODAS sus citas, no sólo la primera', () => {
    const texto = sistema(estado({ citasVigentes: [LIMPIEZA, LASER] }));
    expect(texto).toContain(LIMPIEZA.descripcion);
    expect(texto).toContain(LASER.descripcion);
  });

  it('con una sin confirmar, prohíbe despedirse dando por hecho que ocurren', () => {
    const texto = sistema(estado({ citasVigentes: [LIMPIEZA, LASER] }));
    expect(texto).toMatch(/no todas están confirmadas/i);
    expect(texto).not.toMatch(/Todas están CONFIRMADAS/);
  });

  it('sólo si TODAS están confirmadas puede contar con ellas', () => {
    const texto = sistema(
      estado({ citasVigentes: [{ ...LIMPIEZA, confirmada: true }, LASER] }),
    );
    expect(texto).toMatch(/Todas están CONFIRMADAS/);
  });

  it('si no se sabe cuál quiere cambiar, dice que no se ha tocado ninguna', () => {
    const texto = sistema(estado({ citasVigentes: [LIMPIEZA, LASER], preguntarCual: 'cambiar' }));
    expect(texto).toMatch(/NO se\s+ha tocado ninguna/);
    expect(texto).toMatch(/cuál quiere cambiar/);
  });

  it('si se pregunta si sustituye, dice que NO se ha reservado nada', () => {
    const texto = sistema(
      estado({
        citasVigentes: [LIMPIEZA],
        preguntarSiSustituye: {
          nueva: 'Limpieza facial, lunes, 31, 10:00',
          citas: [LIMPIEZA.descripcion],
        },
      }),
    );
    expect(texto).toMatch(/TODAVÍA NO SE HA RESERVADO NADA/);
    expect(texto).toContain('en lugar de la que tiene o además');
  });

  it('sin ninguna cita, lo dice: lo hablado antes no son citas', () => {
    const texto = sistema(estado({ citasVigentes: [] }));
    expect(texto).toMatch(/NO tiene ninguna cita cogida/);
  });

  it('con citas, no dice que no tenga ninguna', () => {
    expect(sistema(estado({ citasVigentes: [LIMPIEZA] }))).not.toMatch(/NO tiene ninguna cita/);
  });

  it('el reagendado dice CUÁL se está cambiando', () => {
    const texto = sistema(estado({ reagendando: LIMPIEZA.descripcion }));
    expect(texto).toContain(`quiere CAMBIAR esta cita: ${LIMPIEZA.descripcion}`);
  });
});

/**
 * Disculparse por un error que no ha cometido le dice al paciente —y a la
 * clínica que lee las conversaciones— que el sistema se equivoca. Medido en el
 * banco: al pedir otra franja u otro día, «perdona, me he liado antes» o «me he
 * equivocado con las horas de antes» en 2 de cada 6 respuestas, sin ningún error.
 */
describe('no se disculpa por lo que no ha hecho mal', () => {
  it('la regla general está en el estilo', () => {
    expect(sistema(estado())).toMatch(/No pidas perdón ni digas que te has liado o equivocado/);
  });

  it('y junto a los huecos, que es donde ve que han cambiado', () => {
    const texto = construirSistema({
      config: CONFIG,
      paciente: PACIENTE,
      turnos: [],
      resumen: null,
      estado: estado({ consultada: true }),
      huecos: [{ inicio: new Date('2026-10-12T08:00:00Z'), fin: new Date('2026-10-12T09:00:00Z') }],
    });
    const lista = texto.indexOf('HUECOS PROPUESTOS');
    const aviso = texto.indexOf('NO es un error tuyo: no pidas perdón');
    expect(aviso).toBeGreaterThan(-1);
    expect(lista - aviso).toBeLessThan(200);
  });
});

describe('lo que sabe y lo que no sabe de la clínica salen del mismo sitio', () => {
  const conTodo = configDePrueba({
    informacion: {
      direccion: 'Calle Uno 1.',
      aparcamiento: 'Parking en la esquina.',
      formasDePago: 'Efectivo y tarjeta.',
      cancelacion: 'Avisa con 24 horas.',
      primeraVisita: 'Sin coste.',
    },
  });

  function noSabe(config: ReturnType<typeof configDePrueba>): string {
    const texto = construirSistema({ config, paciente: PACIENTE, turnos: [], resumen: null, estado: estado() });
    return texto.split('\n').find((l) => l.startsWith('NO SABES:')) ?? '';
  }

  it('sin datos, sólo sabe catálogo y horario, y lo demás lo confirma recepción', () => {
    // En la tanda, sin base de conocimiento: «aparcamiento propio no tenemos» y
    // «la zona tiene que venir rasurada» salieron sin un solo dato detrás.
    const linea = noSabe(configDePrueba());
    expect(linea).toMatch(/aparcamiento/);
    expect(linea).toMatch(/formas de pago/);
    expect(linea).toMatch(/cómo prepararse para un tratamiento/);
    expect(linea).toMatch(/recepción/);
  });

  it('un tema con dato en el YAML NUNCA aparece como desconocido', () => {
    // El caso real: el freno seguía diciendo «aparcamiento, formas de pago… NO
    // lo sabes» con los dos datos en el YAML. El paciente recibió las respuestas
    // compuestas, pidió cita, y el modelo se desdijo de las dos.
    const linea = noSabe(conTodo);
    for (const tema of ['dirección', 'aparcamiento', 'formas de pago', 'cancelación', 'primera visita']) {
      expect(linea).not.toMatch(new RegExp(tema));
    }
  });

  it('cada dato del YAML está en el prompt, y con él la orden de no desdecirse', () => {
    const texto = construirSistema({ config: conTodo, paciente: PACIENTE, turnos: [], resumen: null, estado: estado() });
    for (const valor of Object.values(conTodo.informacion)) expect(texto).toContain(valor);
    expect(texto).toMatch(/no te desdigas/);
  });

  it('la preparación: la que existe se enseña, la que falta se nombra por servicio', () => {
    const base = configDePrueba();
    const [primero, ...resto] = base.servicios;
    if (primero === undefined) throw new Error('la configuración de prueba no tiene servicios');
    const config = { ...base, servicios: [{ ...primero, preparacion: 'Ven sin crema.' }, ...resto] };
    const texto = construirSistema({ config, paciente: PACIENTE, turnos: [], resumen: null, estado: estado() });
    expect(texto).toContain(`Cómo venir a ${primero.nombre}: Ven sin crema.`);
    const linea = noSabe(config);
    expect(linea).not.toContain(primero.nombre);
    for (const s of resto) expect(linea).toContain(s.nombre);
  });

  it('el estado de la plantilla real: lo que tiene dato no se niega', () => {
    const linea = noSabe(cargarConfiguracion('config/clientes').obtener('ejemplo').config);
    expect(linea).not.toMatch(/aparcamiento|formas de pago|dirección/);
  });
});

describe('el prompt no se contradice con el estado ni con la validación', () => {
  it('confirmada lo dice el estado, no una regla general que lo prohíba siempre', () => {
    // Convivían «Nunca digas que una cita está confirmada. Sólo recepción
    // confirma» —anterior al modo automática— y, en el mismo prompt, «Su cita
    // está CONFIRMADA, puedes despedirte contando con ella».
    const texto = sistema(estado({ citasVigentes: [{ descripcion: 'limpieza, martes 13 10:00', confirmada: true }] }));
    expect(texto).not.toMatch(/Nunca digas que una cita está confirmada/);
    expect(texto).toMatch(/sólo está confirmada si el ESTADO dice que lo está/);
    expect(texto).toMatch(/Su cita está CONFIRMADA/);
  });

  it('las horas que puede nombrar son las que acepta la validación: también las de sus citas', () => {
    // «Usa SOLO las de los huecos propuestos» prohibía nombrar la hora de su
    // propia cita, que la validación sí acepta desde hace semanas.
    const texto = sistema(estado({ citasVigentes: [{ descripcion: 'limpieza, martes 13 10:00', confirmada: false }] }));
    expect(texto).not.toMatch(/usa SOLO las que aparezcan como huecos propuestos/);
    expect(texto).not.toMatch(/los únicos que puedes mencionar/);
    expect(texto).toMatch(/puedes nombrar las citas que el paciente ya tiene/);
  });
});

describe('lo que se le dijo y no era verdad', () => {
  it('el modelo lo tiene delante para poder aclararlo, sin sacarlo él', () => {
    const texto = sistema(estado({ desmentidos: ['No existe ninguna cita el lunes 12 a las 10:20.'] }));
    expect(texto).toMatch(/le dijo algo que NO era verdad/);
    expect(texto).toContain('No existe ninguna cita el lunes 12 a las 10:20.');
    expect(texto).toMatch(/Si no sale, no lo saques tú/);
  });
});
