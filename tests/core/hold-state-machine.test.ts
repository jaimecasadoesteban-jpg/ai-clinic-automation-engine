import { describe, expect, it } from 'vitest';

import {
  bloqueaElHueco,
  cambiaDeEstado,
  esTerminal,
  ESTADOS,
  ESTADOS_QUE_BLOQUEAN,
  EVENTOS,
  sigueVivo,
  transicionar,
  VENCIMIENTOS_POR_DEFECTO,
  type Efecto,
  type HoldEvent,
  type HoldState,
  type Hueco,
  type PoliticaDeVencimientos,
  type Transicion,
} from '../../src/core/hold-state-machine.js';

const AHORA = new Date('2026-09-01T10:00:00.000Z');
const HUECO = new Date('2026-09-10T09:00:00.000Z');

/** Jornada que termina a las 20:00 UTC del mismo día. Vendría del YAML de la clínica. */
const POLITICA: PoliticaDeVencimientos = {
  ...VENCIMIENTOS_POR_DEFECTO,
  finDeJornada: (desde) => {
    const fin = new Date(desde);
    fin.setUTCHours(20, 0, 0, 0);
    return fin;
  },
};

function hueco(state: HoldState, extra: Partial<Hueco> = {}): Hueco {
  return {
    state,
    stateChangedAt: AHORA,
    slotStart: HUECO,
    reminderSentAt: null,
    escalatedAt: null,
    // Por defecto, recepción ya ha sido avisada en el mismo instante: es el
    // caso de una elección dentro del horario de la clínica.
    receptionNotifiedAt: AHORA,
    ...extra,
  };
}

function transicion(
  state: HoldState,
  evento: HoldEvent,
  opciones: { ahora?: Date; hueco?: Partial<Hueco> } = {},
): Transicion {
  const resultado = transicionar({
    hueco: hueco(state, opciones.hueco ?? {}),
    evento,
    ahora: opciones.ahora ?? AHORA,
    politica: POLITICA,
  });

  if (!resultado.ok) {
    throw new Error(`se esperaba una transición válida: ${resultado.error.message}`);
  }
  return resultado.transicion;
}

function minutosDespues(minutos: number): Date {
  return new Date(AHORA.getTime() + minutos * 60_000);
}

function tiposDeEfecto(efectos: readonly Efecto[]): string[] {
  return efectos.map((e) => e.tipo);
}

/** Un evento de muestra de cada tipo, para recorrer la matriz completa. */
const EVENTOS_DE_MUESTRA: readonly HoldEvent[] = [
  { tipo: 'paciente_elige' },
  { tipo: 'recepcion_avisada' },
  { tipo: 'recepcion_confirma', huecoSigueLibre: true },
  { tipo: 'agenda_responde', resultado: 'creado' },
  { tipo: 'cita_cancelada' },
  { tipo: 'ciclo_cerrado' },
  { tipo: 'tiempo' },
];

/** La matriz de lo que SÍ es válido. Todo lo demás debe rechazarse. */
const VALIDAS: ReadonlyArray<readonly [HoldState, HoldEvent['tipo']]> = [
  ['propuesta', 'paciente_elige'],
  ['propuesta', 'tiempo'],
  ['retenida', 'recepcion_avisada'],
  ['retenida', 'tiempo'],
  // Modo `automatica`: en `retenida` es donde el hueco espera a que n8n diga si
  // creó el evento. En `recepcion` este evento no llega nunca, pero el grafo es
  // el mismo: lo que cambia es qué arista se toma al elegir hueco.
  ['retenida', 'agenda_responde'],
  // Se puede cancelar antes de que recepción confirme. Antes sólo valía desde
  // `confirmada`, y «déjalo, que al final no puedo» a los cinco minutos de
  // elegir acababa en un escalado por algo trivial.
  ['retenida', 'cita_cancelada'],
  ['pendiente_recepcion', 'recepcion_confirma'],
  ['pendiente_recepcion', 'tiempo'],
  ['pendiente_recepcion', 'cita_cancelada'],
  ['confirmada', 'cita_cancelada'],
  ['confirmada', 'ciclo_cerrado'],
  ['confirmada', 'tiempo'],
];

describe('transiciones válidas', () => {
  it('propuesta → retenida cuando el paciente elige, y se avisa a recepción', () => {
    const t = transicion('propuesta', { tipo: 'paciente_elige' });

    expect(t.hasta).toBe('retenida');
    expect(tiposDeEfecto(t.efectos)).toEqual(['mensaje_al_paciente', 'avisar_a_recepcion']);
    expect(t.expiresAt).toEqual(minutosDespues(30));
  });

  it('retenida → pendiente_recepcion al avisar, y vence al fin de la jornada', () => {
    const t = transicion('retenida', { tipo: 'recepcion_avisada' });

    expect(t.hasta).toBe('pendiente_recepcion');
    expect(t.expiresAt).toEqual(new Date('2026-09-01T20:00:00.000Z'));
  });

  it('pendiente_recepcion → confirmada si al releer la agenda el hueco sigue libre', () => {
    const t = transicion('pendiente_recepcion', {
      tipo: 'recepcion_confirma',
      huecoSigueLibre: true,
    });

    expect(t.hasta).toBe('confirmada');
    expect(t.expiresAt).toBeNull();
    expect(t.efectos).toContainEqual({
      tipo: 'mensaje_al_paciente',
      plantilla: 'cita_confirmada',
    });
  });

  it('confirmada → liberada al cerrarse el ciclo, y el hueco deja de bloquear', () => {
    const t = transicion('confirmada', { tipo: 'ciclo_cerrado' });

    expect(t.hasta).toBe('liberada');
    expect(t.motivoLiberacion).toBe('ciclo_cerrado');
    // Éste era el agujero: sin `liberada`, un hueco confirmado se quedaba
    // dentro del índice parcial para siempre, también en el camino feliz.
    expect(bloqueaElHueco(t.hasta)).toBe(false);
  });

  it('retenida → liberada al cancelar, sin encolar relleno', () => {
    const t = transicion('retenida', { tipo: 'cita_cancelada' });

    expect(t.hasta).toBe('liberada');
    expect(t.motivoLiberacion).toBe('cancelacion');
    // Soltar una retención que recepción ni había visto no le quita capacidad a
    // nadie: el relleno de cancelaciones es para citas que existieron.
    expect(tiposDeEfecto(t.efectos)).not.toContain('encolar_relleno_de_cancelacion');
  });

  it('confirmada → liberada al cancelar, con aviso al paciente', () => {
    const t = transicion('confirmada', { tipo: 'cita_cancelada' });

    expect(t.hasta).toBe('liberada');
    expect(t.motivoLiberacion).toBe('cancelacion');
    expect(t.efectos).toContainEqual({
      tipo: 'mensaje_al_paciente',
      plantilla: 'cancelacion_confirmada',
    });
  });
});

describe('el paso 6 es innegociable: nunca se confirma sobre información vieja', () => {
  it('si al releer la agenda el hueco ya está ocupado → colisionada y 2ª opción', () => {
    const t = transicion('pendiente_recepcion', {
      tipo: 'recepcion_confirma',
      huecoSigueLibre: false,
    });

    expect(t.hasta).toBe('colisionada');
    expect(tiposDeEfecto(t.efectos)).toContain('proponer_alternativa');
    // Al paciente NO se le ha dicho que su cita está confirmada.
    expect(t.efectos).not.toContainEqual({
      tipo: 'mensaje_al_paciente',
      plantilla: 'cita_confirmada',
    });
  });
});

describe('vencimientos', () => {
  it('propuesta caduca a las 6 h, y ni un minuto antes', () => {
    expect(cambiaDeEstado(transicion('propuesta', { tipo: 'tiempo' }, { ahora: minutosDespues(359) }))).toBe(false);
    expect(transicion('propuesta', { tipo: 'tiempo' }, { ahora: minutosDespues(360) }).hasta).toBe(
      'caducada',
    );
  });

  it('retenida caduca a los 30 min, y ni un minuto antes', () => {
    expect(cambiaDeEstado(transicion('retenida', { tipo: 'tiempo' }, { ahora: minutosDespues(29) }))).toBe(false);
    expect(transicion('retenida', { tipo: 'tiempo' }, { ahora: minutosDespues(30) }).hasta).toBe(
      'caducada',
    );
  });

  it('pendiente_recepcion recuerda a las 2 h sin cambiar de estado', () => {
    const t = transicion('pendiente_recepcion', { tipo: 'tiempo' }, { ahora: minutosDespues(120) });

    expect(cambiaDeEstado(t)).toBe(false);
    expect(tiposDeEfecto(t.efectos)).toEqual(['recordar_a_recepcion']);
  });

  it('no recuerda dos veces', () => {
    const t = transicion(
      'pendiente_recepcion',
      { tipo: 'tiempo' },
      { ahora: minutosDespues(150), hueco: { reminderSentAt: minutosDespues(120) } },
    );

    expect(t.efectos).toEqual([]);
  });

  it('pendiente_recepcion escala a las 4 h sin cambiar de estado', () => {
    const t = transicion('pendiente_recepcion', { tipo: 'tiempo' }, { ahora: minutosDespues(240) });

    expect(cambiaDeEstado(t)).toBe(false);
    expect(t.efectos).toEqual([
      { tipo: 'escalar_a_humano', motivo: 'sin_respuesta_recepcion' },
    ]);
  });

  it('no escala dos veces', () => {
    const t = transicion(
      'pendiente_recepcion',
      { tipo: 'tiempo' },
      {
        ahora: minutosDespues(300),
        hueco: { reminderSentAt: minutosDespues(120), escalatedAt: minutosDespues(240) },
      },
    );

    expect(t.efectos).toEqual([]);
  });

  it('pendiente_recepcion caduca al fin de la jornada, avisando y escalando', () => {
    const t = transicion(
      'pendiente_recepcion',
      { tipo: 'tiempo' },
      { ahora: new Date('2026-09-01T20:00:00.000Z') },
    );

    expect(t.hasta).toBe('caducada');
    expect(tiposDeEfecto(t.efectos)).toEqual(['mensaje_al_paciente', 'escalar_a_humano']);
  });

  it('una cita confirmada no caduca sola por mucho tiempo que pase', () => {
    const t = transicion(
      'confirmada',
      { tipo: 'tiempo' },
      { ahora: new Date('2027-01-01T00:00:00.000Z') },
    );

    expect(cambiaDeEstado(t)).toBe(false);
    expect(t.expiresAt).toBeNull();
  });
});

describe('relleno de cancelaciones', () => {
  it('cancelar con menos de 72 h de antelación encola el hueco', () => {
    const t = transicion(
      'confirmada',
      { tipo: 'cita_cancelada' },
      { ahora: new Date('2026-09-09T09:00:00.000Z') },
    );

    expect(t.efectos).toContainEqual({
      tipo: 'encolar_relleno_de_cancelacion',
      horasDeAntelacion: 24,
    });
  });

  it('cancelar con más de 72 h no lo encola: hay margen de sobra para llenarlo solo', () => {
    const t = transicion('confirmada', { tipo: 'cita_cancelada' }, { ahora: AHORA });

    expect(tiposDeEfecto(t.efectos)).not.toContain('encolar_relleno_de_cancelacion');
  });
});

describe('transiciones inválidas: se rechazan explícitamente', () => {
  const combinaciones = ESTADOS.flatMap((estado) =>
    EVENTOS_DE_MUESTRA.map((evento) => ({ estado, evento })),
  );

  it.each(combinaciones)('$estado + $evento.tipo', ({ estado, evento }) => {
    const resultado = transicionar({
      hueco: hueco(estado),
      evento,
      ahora: AHORA,
      politica: POLITICA,
    });

    const deberiaValer = VALIDAS.some(([e, t]) => e === estado && t === evento.tipo);

    expect(resultado.ok).toBe(deberiaValer);
    if (!resultado.ok) {
      expect(resultado.error.code).toBe('transicion_invalida');
      expect(resultado.error.message).toContain(estado);
      expect(resultado.error.message).toContain(evento.tipo);
    }
  });

  it('la matriz cubre todos los estados y todos los eventos', () => {
    // Si mañana alguien añade un estado o un evento, el recorrido de arriba lo
    // incluye solo; esto sólo confirma que no se ha quedado nada fuera.
    expect(combinaciones).toHaveLength(ESTADOS.length * EVENTOS.length);
    expect(EVENTOS_DE_MUESTRA.map((e) => e.tipo).sort()).toEqual([...EVENTOS].sort());
  });

  it('desde un estado terminal no se sale con ningún evento', () => {
    for (const estado of ['liberada', 'caducada', 'colisionada'] as const) {
      for (const evento of EVENTOS_DE_MUESTRA) {
        const resultado = transicionar({
          hueco: hueco(estado),
          evento,
          ahora: AHORA,
          politica: POLITICA,
        });
        expect(resultado.ok).toBe(false);
      }
    }
  });
});

describe('regla 4: ninguna ruta termina en silencio', () => {
  /**
   * Cerrar el ciclo tras la asistencia es el único camino a un estado terminal
   * que no le dice nada a nadie, y es correcto: la cita ya ocurrió. Está aquí
   * escrito y no como excepción implícita en el código.
   */
  const EXENTAS = [{ estado: 'confirmada', evento: 'ciclo_cerrado' }] as const;

  it.each(
    ESTADOS.flatMap((estado) =>
      EVENTOS_DE_MUESTRA.concat([{ tipo: 'recepcion_confirma', huecoSigueLibre: false }]).map(
        (evento) => ({ estado, evento }),
      ),
    ),
  )('$estado + $evento.tipo avisa a alguien si acaba en terminal', ({ estado, evento }) => {
    const resultado = transicionar({
      hueco: hueco(estado),
      evento,
      ahora: new Date('2026-09-01T23:00:00.000Z'),
      politica: POLITICA,
    });

    if (!resultado.ok) return;
    const { transicion: t } = resultado;
    if (!esTerminal(t.hasta) || !cambiaDeEstado(t)) return;
    if (EXENTAS.some((e) => e.estado === estado && e.evento === evento.tipo)) return;

    const avisa = t.efectos.some(
      (e) => e.tipo === 'mensaje_al_paciente' || e.tipo === 'escalar_a_humano',
    );
    expect(avisa).toBe(true);
  });
});

describe('la aplicación y la base de datos coinciden en qué bloquea un hueco', () => {
  it('los estados que bloquean son exactamente los del índice holds_slot_unico', () => {
    // El índice es `WHERE state IN ('retenida', 'pendiente_recepcion', 'confirmada')`.
    // Si esta lista y aquélla divergen, la aplicación y Postgres dejan de estar
    // de acuerdo sobre qué huecos están libres.
    expect([...ESTADOS_QUE_BLOQUEAN]).toEqual(['retenida', 'pendiente_recepcion', 'confirmada']);
    expect(ESTADOS.filter(bloqueaElHueco)).toEqual([...ESTADOS_QUE_BLOQUEAN]);
  });
});

/**
 * Modo `automatica`: el mismo grafo, una arista distinta.
 *
 * Lo único que mira la configuración es qué pasa después de `paciente_elige`.
 * `retenida` cambia de papel —de estado de paso a estado de espera— pero no hay
 * nodo nuevo, ni `ALTER TYPE`, ni un segundo índice único que mantener de
 * acuerdo con el primero.
 */
describe('confirmación automática', () => {
  const AUTOMATICA = { ...POLITICA, confirmacion: 'automatica' as const, agendaMinutos: 3 };

  function auto(estado: HoldState, evento: HoldEvent, desde = AHORA) {
    const resultado = transicionar({
      hueco: { ...hueco(estado), stateChangedAt: desde },
      evento,
      ahora: AHORA,
      politica: AUTOMATICA,
    });
    if (!resultado.ok) throw new Error(`transición rechazada: ${resultado.error.message}`);
    return resultado.transicion;
  }

  it('al elegir no se avisa a recepción: se pide el evento y no se dice nada al paciente', () => {
    const t = auto('propuesta', { tipo: 'paciente_elige' });

    expect(t.hasta).toBe('retenida');
    expect(tiposDeEfecto(t.efectos)).toEqual(['crear_evento_agenda']);
  });

  it('y en modo recepción la misma arista sigue haciendo lo de siempre', () => {
    const t = transicion('propuesta', { tipo: 'paciente_elige' });

    expect(tiposDeEfecto(t.efectos)).toEqual(['mensaje_al_paciente', 'avisar_a_recepcion']);
  });

  it('evento creado → confirmada, y recepción se entera sin botón', () => {
    const t = auto('retenida', { tipo: 'agenda_responde', resultado: 'creado' });

    expect(t.hasta).toBe('confirmada');
    expect(tiposDeEfecto(t.efectos)).toEqual(['mensaje_al_paciente', 'informar_a_recepcion']);
    expect(t.efectos).toContainEqual({ tipo: 'mensaje_al_paciente', plantilla: 'cita_confirmada' });
  });

  it('hueco ocupado → colisión y segunda opción, como en el paso 6', () => {
    const t = auto('retenida', { tipo: 'agenda_responde', resultado: 'ocupado' });

    expect(t.hasta).toBe('colisionada');
    expect(tiposDeEfecto(t.efectos)).toContain('proponer_alternativa');
  });

  /**
   * La tercera salida, que es la que importa. «No se pudo» no es «está ocupado»:
   * no sabemos si el evento existe, así que **no se le toca la cita al paciente**.
   * Pasarlo a la segunda opción podría dejar un evento fantasma quitándole
   * capacidad real a la clínica, que es justo lo que la regla 3 evitaba.
   */
  it('no se pudo escribir → NO se suelta el hueco: degrada al camino de recepción', () => {
    const t = auto('retenida', { tipo: 'agenda_responde', resultado: 'no_se_pudo' });

    expect(t.hasta).toBe('pendiente_recepcion');
    expect(tiposDeEfecto(t.efectos)).toEqual([
      'mensaje_al_paciente',
      'avisar_a_recepcion',
      'escalar_a_humano',
    ]);
    expect(t.efectos).toContainEqual({
      tipo: 'escalar_a_humano',
      motivo: 'agenda_no_escrita',
    });
  });

  it('el hueco no se marca colisionado ni liberado cuando no se sabe qué pasó', () => {
    const t = auto('retenida', { tipo: 'agenda_responde', resultado: 'no_se_pudo' });

    expect(t.hasta).not.toBe('colisionada');
    expect(t.hasta).not.toBe('liberada');
    expect(t.motivoLiberacion).toBeNull();
  });

  /** Y si n8n no contesta nunca, el reloj hace lo mismo que el fallo declarado. */
  it('si n8n no contesta, el vencimiento degrada igual', () => {
    const hace4Minutos = new Date(AHORA.getTime() - 4 * 60_000);
    const t = auto('retenida', { tipo: 'tiempo' }, hace4Minutos);

    expect(t.hasta).toBe('pendiente_recepcion');
    expect(tiposDeEfecto(t.efectos)).toContain('escalar_a_humano');
  });

  it('antes del plazo no pasa nada: n8n todavía puede contestar', () => {
    const haceUnMinuto = new Date(AHORA.getTime() - 60_000);
    const t = auto('retenida', { tipo: 'tiempo' }, haceUnMinuto);

    expect(t.hasta).toBe('retenida');
    expect(t.efectos).toEqual([]);
  });

  /**
   * En modo recepción el plazo de `retenida` sigue siendo el suyo —30 minutos—,
   * así que a los cuatro no pasa nada. Es lo que confirma que el plazo corto lo
   * trae la configuración y no se ha colado para todos.
   */
  it('el plazo corto es sólo del modo automático', () => {
    const hace4Minutos = new Date(AHORA.getTime() - 4 * 60_000);
    const t = transicion('retenida', { tipo: 'tiempo' }, {
      hueco: { stateChangedAt: hace4Minutos },
    });

    expect(t.hasta).toBe('retenida');
    expect(t.efectos).toEqual([]);
  });
});

/**
 * **Un cron materializa el estado; no lo define.** Las lecturas preguntan a
 * `sigueVivo` con la misma regla que aplica el cron, para que lo que diga la
 * fila no cuente más que el reloj. Sin crons, el agente ofreció huecos de agosto
 * en octubre y recordó tres veces una cita del 28 de agosto como futura.
 */
describe('qué sigue vivo, haya pasado o no el cron', () => {
  const minutos = (n: number): Date => new Date(AHORA.getTime() + n * 60_000);

  it('una propuesta vive sus 6 horas y ni un minuto más', () => {
    expect(sigueVivo(hueco('propuesta'), minutos(6 * 60 - 1), POLITICA)).toBe(true);
    expect(sigueVivo(hueco('propuesta'), minutos(6 * 60), POLITICA)).toBe(false);
  });

  it('nada cuya hora ya pasó está vivo, ni siquiera una cita confirmada', () => {
    const despues = new Date(HUECO.getTime() + 60_000);
    for (const estado of ['propuesta', 'retenida', 'pendiente_recepcion', 'confirmada'] as const) {
      expect(sigueVivo(hueco(estado, { stateChangedAt: despues }), despues, POLITICA)).toBe(false);
    }
  });

  it('pendiente de recepción muere al acabar la jornada en que se le avisó', () => {
    expect(sigueVivo(hueco('pendiente_recepcion'), new Date('2026-09-01T19:59:00Z'), POLITICA)).toBe(
      true,
    );
    expect(sigueVivo(hueco('pendiente_recepcion'), new Date('2026-09-01T20:00:00Z'), POLITICA)).toBe(
      false,
    );
  });

  it('pendiente sin avisar a recepción no corre: vive hasta su hora', () => {
    // Elegido de madrugada: a recepción no se le ha dicho nada todavía.
    const sinAviso = hueco('pendiente_recepcion', { receptionNotifiedAt: null });
    expect(sigueVivo(sinAviso, new Date('2026-09-05T10:00:00Z'), POLITICA)).toBe(true);
  });

  it('retenida en automática que agota su plazo SIGUE viva: degrada, no caduca', () => {
    // n8n no contestó. El hueco sigue siendo del paciente; lo que cambia es
    // quién lo mete en la agenda.
    const automatica = { ...POLITICA, confirmacion: 'automatica' as const, agendaMinutos: 3 };
    expect(sigueVivo(hueco('retenida'), minutos(10), automatica)).toBe(true);
  });

  it('retenida en modo recepción muere a los 30 minutos', () => {
    expect(sigueVivo(hueco('retenida'), minutos(29), POLITICA)).toBe(true);
    expect(sigueVivo(hueco('retenida'), minutos(30), POLITICA)).toBe(false);
  });

  it('los estados terminales nunca están vivos', () => {
    for (const estado of ['liberada', 'caducada', 'colisionada'] as const) {
      expect(sigueVivo(hueco(estado), AHORA, POLITICA)).toBe(false);
    }
  });
});
