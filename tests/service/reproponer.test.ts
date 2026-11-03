import { describe, expect, it } from 'vitest';

import type { Preferencia } from '../../src/agent/extraccion.js';
import {
  cubrenLaPreferencia,
  motivoParaProponer,
  type HuecoPropuesto,
} from '../../src/service/pipeline.js';

/**
 * Cuándo se (re)proponen huecos, y sobre todo cuándo NO.
 *
 * Las dos mitades salieron de la misma sesión real, y son el mismo agujero
 * visto desde los dos lados:
 *
 * - **Se reproponía sin motivo.** El paciente escribió «Gracias!» después de
 *   coger hora, el clasificador lo etiquetó `agendar`, y el sistema caducó sus
 *   dos opciones vivas y creó tres huecos nuevos de los que nunca supo nada
 *   —porque lo que leyó fue un escalado—. Tres filas de basura por dar las
 *   gracias.
 * - **No se reproponía cuando hacía falta.** «¿Y por la tarde tienes alguna
 *   hora?» salió como `horario`, nadie miró la tarde, y el agente se inventó que
 *   no había nada.
 *
 * De ahí que la decisión se tome mirando el ESTADO —qué hay propuesto y qué se
 * pide— y no la etiqueta que el clasificador le ponga al mensaje.
 */

const ZONA = 'Europe/Madrid';

/** Lunes 24 de agosto de 2026, en hora de Madrid. */
function hueco(hora: number, servicio = 'limpieza-facial'): HuecoPropuesto {
  const inicio = new Date(Date.UTC(2026, 7, 24, hora - 2, 0));
  return {
    serviceCode: servicio,
    slotStart: inicio,
    slotEnd: new Date(inicio.getTime() + 60 * 60_000),
  };
}

function preferencia(campos: Partial<Preferencia>): Preferencia {
  return {
    dias: [],
    diasExcluidos: [],
    franjas: [],
    desde: null,
    horaExacta: null,
    cuantoAntes: false,
    ...campos,
  };
}

/** Las tres de la mañana que se le ofrecieron de verdad. */
const LA_MANANA = [hueco(10), hueco(11), hueco(12)];

/**
 * Los valores por defecto son los del caso más común: pide cita, todavía no
 * tiene hora cogida. Cada test dice sólo lo que le importa.
 */
function motivo(args: {
  intencion?: string;
  servicio?: string | null;
  preferencia?: Preferencia | null;
  propuestasVivas?: readonly HuecoPropuesto[];
  tieneHoraCogida?: boolean;
}) {
  return motivoParaProponer({
    intencion: args.intencion ?? 'agendar',
    servicio: args.servicio === undefined ? 'limpieza-facial' : args.servicio,
    preferencia: args.preferencia ?? null,
    propuestasVivas: args.propuestasVivas ?? [],
    tieneHoraCogida: args.tieneHoraCogida ?? false,
    zonaHoraria: ZONA,
  });
}

/**
 * **La línea que separa los dos casos es si el paciente ya tiene hora cogida.**
 *
 * Quien no la tiene no pierde nada porque se mire la agenda otra vez: recibe
 * tres huecos frescos en vez de tres que llevan horas propuestos y pueden
 * haberse ocupado. Quien sí la tiene lo pierde todo: se le caducan las opciones
 * que quedaban como alternativa ante una colisión y se le crean huecos que no ha
 * visto. El daño de la sesión real estaba de ese lado.
 */
describe('con hora ya cogida no se toca nada sin motivo', () => {
  it('«Gracias!» clasificado como agendar no toca nada', () => {
    expect(motivo({ propuestasVivas: LA_MANANA, tieneHoraCogida: true })).toBeNull();
  });

  it('tampoco con una preferencia que sus opciones ya cubren', () => {
    expect(
      motivo({
        preferencia: preferencia({ franjas: ['manana'] }),
        propuestasVivas: LA_MANANA,
        tieneHoraCogida: true,
      }),
    ).toBeNull();
  });

  /** Pero preguntar por otra franja sigue siendo motivo, tenga cita o no. */
  it('salvo que pregunte por algo que sus opciones no cubren', () => {
    expect(
      motivo({
        preferencia: preferencia({ franjas: ['tarde'] }),
        propuestasVivas: LA_MANANA,
        tieneHoraCogida: true,
      }),
    ).toBe('preferencia_nueva');
  });
});

describe('sin hora cogida se vuelve a mirar', () => {
  it('el primer turno, sin nada propuesto', () => {
    expect(motivo({})).toBe('sin_propuestas');
  });

  /**
   * Volver a pedir cita con opciones delante SÍ repropone. No es churn: los
   * huecos propuestos envejecen, y la clínica puede haber llenado ese hueco en
   * su agenda sin que nosotros nos enteremos —no escribimos en ella—.
   */
  it('volver a pedir cita con opciones delante las refresca', () => {
    expect(motivo({ propuestasVivas: LA_MANANA })).toBe('refresco');
  });

  it('sin servicio no se propone nada, se pregunta', () => {
    expect(
      motivo({ servicio: null, preferencia: preferencia({ franjas: ['tarde'] }) }),
    ).toBeNull();
  });

  it('una intención que no es agendar tampoco propone porque sí', () => {
    expect(motivo({ intencion: 'precio' })).toBeNull();
  });

  it('cambiar de tratamiento invalida lo propuesto', () => {
    expect(motivo({ servicio: 'laser-axilas', propuestasVivas: LA_MANANA })).toBe(
      'cambio_de_servicio',
    );
  });

  /**
   * Los tres adversariales del punto 4. Ninguno pide cita: los tres preguntan
   * por algo que no está entre las opciones vivas, y la única respuesta honesta
   * sale de volver a consultar.
   */
  it.each([
    { caso: '«¿y por la tarde?»', pref: preferencia({ franjas: ['tarde'] }), intencion: 'horario' },
    { caso: '«¿el sábado tenéis algo?»', pref: preferencia({ dias: ['sabado'] }), intencion: 'otro' },
    { caso: '«¿no tienes nada antes?»', pref: preferencia({ cuantoAntes: true }), intencion: 'otro' },
  ])('$caso se resuelve consultando, no adivinando', ({ pref, intencion }) => {
    expect(motivo({ intencion, preferencia: pref, propuestasVivas: LA_MANANA })).toBe(
      'preferencia_nueva',
    );
  });
});

describe('qué cubre una propuesta viva', () => {
  it('la mañana cubre «por la mañana» y no cubre «por la tarde»', () => {
    expect(cubrenLaPreferencia(LA_MANANA, preferencia({ franjas: ['manana'] }), ZONA)).toBe(true);
    expect(cubrenLaPreferencia(LA_MANANA, preferencia({ franjas: ['tarde'] }), ZONA)).toBe(false);
  });

  it('sin preferencia está todo cubierto: no hay nada que buscar', () => {
    expect(cubrenLaPreferencia(LA_MANANA, null, ZONA)).toBe(true);
  });

  it('sin propuestas no hay nada que cubra nada', () => {
    expect(cubrenLaPreferencia([], preferencia({ franjas: ['manana'] }), ZONA)).toBe(false);
  });

  /**
   * «¿no tienes nada antes?» pregunta justo por lo que no se le enseñó, así que
   * no se puede responder mirando lo enseñado. Nunca está cubierto.
   */
  it('«cuanto antes» no lo cubre ni la propuesta más temprana', () => {
    expect(cubrenLaPreferencia(LA_MANANA, preferencia({ cuantoAntes: true }), ZONA)).toBe(false);
  });

  it('pedir una hora que sí está entre las opciones es elegir, no cambiar', () => {
    expect(cubrenLaPreferencia(LA_MANANA, preferencia({ horaExacta: '11:00' }), ZONA)).toBe(true);
    expect(cubrenLaPreferencia(LA_MANANA, preferencia({ horaExacta: '17:30' }), ZONA)).toBe(false);
  });
});
