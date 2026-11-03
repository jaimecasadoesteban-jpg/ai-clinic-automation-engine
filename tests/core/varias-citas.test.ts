import { describe, expect, it } from 'vitest';

import {
  citaAludida,
  destinoDeLaEleccion,
  tieneHoraDe,
  type CitaViva,
} from '../../src/core/varias-citas.js';

/**
 * La regla de varias citas, caso por caso y sin base de datos.
 *
 * El caso que la trajo: limpieza facial pendiente el miércoles, la paciente pide
 * láser de axilas para el viernes, elige el viernes — y el sistema le suelta la
 * limpieza. Elegir con una cita viva era reagendar, sin mirar el servicio.
 */

const LIMPIEZA = {
  id: 'limpieza-mie',
  serviceCode: 'limpieza-facial',
  slotStart: new Date('2026-08-26T14:00:00.000Z'),
  state: 'pendiente_recepcion',
} satisfies CitaViva;

const LASER = {
  id: 'laser-vie',
  serviceCode: 'laser-axilas',
  slotStart: new Date('2026-08-28T15:00:00.000Z'),
  state: 'confirmada',
} satisfies CitaViva;

const OTRA_LIMPIEZA = {
  id: 'limpieza-lun',
  serviceCode: 'limpieza-facial',
  slotStart: new Date('2026-08-31T08:00:00.000Z'),
  state: 'confirmada',
} satisfies CitaViva;

describe('elegir un hueco con citas vivas', () => {
  it('EL CASO: láser con una limpieza viva es una cita NUEVA, no se suelta nada', () => {
    const destino = destinoDeLaEleccion({
      elegido: { serviceCode: 'laser-axilas', replacesHoldId: null },
      vivas: [LIMPIEZA],
      cambioPedido: null,
      sustitucion: null,
    });

    expect(destino).toEqual({ tipo: 'nueva' });
  });

  it('sin ninguna cita viva, cita nueva', () => {
    expect(
      destinoDeLaEleccion({
        elegido: { serviceCode: 'laser-axilas', replacesHoldId: null },
        vivas: [],
        cambioPedido: null,
        sustitucion: null,
      }),
    ).toEqual({ tipo: 'nueva' });
  });

  it('el mismo servicio que una cita viva NO se decide: se pregunta, sin soltar nada', () => {
    const destino = destinoDeLaEleccion({
      elegido: { serviceCode: 'limpieza-facial', replacesHoldId: null },
      vivas: [LIMPIEZA, LASER],
      cambioPedido: null,
      sustitucion: null,
    });

    // Sólo la del mismo tratamiento es candidata: el láser no se toca nunca.
    expect(destino).toEqual({ tipo: 'preguntar_si_sustituye', candidatas: [LIMPIEZA] });
  });

  it('«además» con el mismo servicio: cita nueva, la que tenía sigue', () => {
    expect(
      destinoDeLaEleccion({
        elegido: { serviceCode: 'limpieza-facial', replacesHoldId: null },
        vivas: [LIMPIEZA],
        cambioPedido: null,
        sustitucion: 'ademas',
      }),
    ).toEqual({ tipo: 'nueva' });
  });

  it('«en lugar» con UNA del mismo servicio: sustituye a ésa', () => {
    expect(
      destinoDeLaEleccion({
        elegido: { serviceCode: 'limpieza-facial', replacesHoldId: null },
        vivas: [LIMPIEZA, LASER],
        cambioPedido: null,
        sustitucion: 'en_lugar',
      }),
    ).toEqual({ tipo: 'sustituye', cita: LIMPIEZA });
  });

  it('«en lugar» con DOS del mismo servicio no adivina cuál: vuelve a preguntar', () => {
    const destino = destinoDeLaEleccion({
      elegido: { serviceCode: 'limpieza-facial', replacesHoldId: null },
      vivas: [LIMPIEZA, OTRA_LIMPIEZA],
      cambioPedido: null,
      sustitucion: 'en_lugar',
    });

    expect(destino.tipo).toBe('preguntar_si_sustituye');
  });

  it('un hueco propuesto para cambiar una cita concreta la sustituye a ella', () => {
    expect(
      destinoDeLaEleccion({
        elegido: { serviceCode: 'limpieza-facial', replacesHoldId: OTRA_LIMPIEZA.id },
        vivas: [LIMPIEZA, OTRA_LIMPIEZA],
        cambioPedido: null,
        sustitucion: null,
      }),
    ).toEqual({ tipo: 'sustituye', cita: OTRA_LIMPIEZA });
  });

  it('si la cita vinculada ya no está viva, no se suelta otra en su lugar', () => {
    // La cambiaba, pero entre medias la canceló. Lo que elija ahora no puede
    // llevarse por delante la OTRA limpieza.
    const destino = destinoDeLaEleccion({
      elegido: { serviceCode: 'limpieza-facial', replacesHoldId: 'ya-cancelada' },
      vivas: [OTRA_LIMPIEZA],
      cambioPedido: null,
      sustitucion: null,
    });

    expect(destino.tipo).toBe('preguntar_si_sustituye');
  });

  it('pedir cambiar una cita y elegir OTRO tratamiento no la sustituye', () => {
    // Cambiar de tratamiento es cancelar y pedir otra; no se decide por él.
    const destino = destinoDeLaEleccion({
      elegido: { serviceCode: 'laser-axilas', replacesHoldId: null },
      vivas: [LIMPIEZA],
      cambioPedido: LIMPIEZA,
      sustitucion: null,
    });

    expect(destino).toEqual({ tipo: 'nueva' });
  });

  it('pedir cambiar una cita y elegir su mismo tratamiento la sustituye', () => {
    expect(
      destinoDeLaEleccion({
        elegido: { serviceCode: 'limpieza-facial', replacesHoldId: null },
        vivas: [LIMPIEZA, OTRA_LIMPIEZA],
        cambioPedido: OTRA_LIMPIEZA,
        sustitucion: null,
      }),
    ).toEqual({ tipo: 'sustituye', cita: OTRA_LIMPIEZA });
  });
});

describe('a qué cita se refiere', () => {
  it('sin citas, ninguna', () => {
    expect(citaAludida([], null)).toEqual({ tipo: 'ninguna_viva' });
  });

  it('con una sola y sin decir cuál, es ésa', () => {
    expect(citaAludida([LIMPIEZA], null)).toEqual({ tipo: 'identificada', cita: LIMPIEZA });
  });

  it('con varias y sin decir cuál, NO se elige por él', () => {
    expect(citaAludida([LIMPIEZA, LASER], null)).toEqual({
      tipo: 'sin_identificar',
      candidatas: [LIMPIEZA, LASER],
    });
  });

  it('con varias y diciendo cuál, ésa', () => {
    expect(citaAludida([LIMPIEZA, LASER], 2)).toEqual({ tipo: 'identificada', cita: LASER });
  });

  it('un número que no existe se pregunta, AUNQUE sólo haya una', () => {
    // Nombró algo que no está —o que dejó de estar vivo mientras pensaba el
    // modelo—. Quedarse con la única sería tocarle una cita de la que no hablaba.
    expect(citaAludida([LIMPIEZA], 2).tipo).toBe('sin_identificar');
    expect(citaAludida([LIMPIEZA], 0).tipo).toBe('sin_identificar');
  });
});

describe('qué cuenta como «ya tiene hora» para no reproponer', () => {
  it('sólo una cita del servicio que pide', () => {
    expect(tieneHoraDe([LIMPIEZA], 'laser-axilas')).toBe(false);
    expect(tieneHoraDe([LIMPIEZA], 'limpieza-facial')).toBe(true);
    expect(tieneHoraDe([LIMPIEZA], null)).toBe(false);
  });
});
