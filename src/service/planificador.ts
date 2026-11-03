import { eq } from 'drizzle-orm';

import type { Tx } from '../db/client.js';
import * as q from '../db/queries.js';
import { jobRuns } from '../db/schema.js';
import { consolidarPeriodo } from './consolidacion.js';
import { dentroDeFranja, resolverCliente } from './contexto.js';
import { encolarAvisoAlPaciente, encolarEfectosDelSistema, type Dependencias } from './pipeline.js';
import { momento } from '../config/derivar.js';
import { caducarRetenciones } from './vencimientos.js';
import { verificarCitas } from './verificacion.js';
import { registrarLatido, vigilarDerechos } from './vigilancia.js';
import { registrarResultadoDeCita } from './appointments.js';

/**
 * **Los crons, dentro del núcleo.** Antes eran cuatro workflows de n8n que no
 * llegaron a activarse nunca; ahora es un bucle que cada minuto mira qué toca.
 *
 * - `caducar-retenciones`: cada minuto. Es lo que hace que la regla 4 ocurra:
 *   sin él, los vencimientos están escritos pero inertes.
 * - `verificar-citas`: cada 30 minutos.
 * - `vigilar-derechos`: a diario a las 09:05, **en hora de la clínica**: los
 *   avisos del plazo legal tienen que llegar en horario de trabajo.
 * - `consolidar-periodo`: el día 1 de cada mes a las 02:00 UTC, antes de la
 *   purga de las 03:15 (pg_cron). Consolidar primero, borrar después.
 *
 * **Qué toca lo decide `job_runs`, no la memoria del proceso**: tras un
 * reinicio no se repite lo diario ni se salta lo mensual. Y el cron sigue sin
 * definir qué es verdad (regla 8): sólo materializa y avisa.
 *
 * Lo que emite cada trabajo se encola **en su misma transacción** (regla 3) y
 * sale por el canal de cada conversación, como lo de un turno.
 */

export const TRABAJOS = [
  'caducar-retenciones',
  'verificar-citas',
  'vigilar-derechos',
  'consolidar-periodo',
  'relacion-de-asistencia',
  'presumir-asistencia',
  'recordatorios',
] as const;
export type Trabajo = (typeof TRABAJOS)[number];

/**
 * Cuándo toca cada trabajo. Lo diario y lo semanal, **en hora de la clínica**:
 * lo que llega a una persona tiene que llegar en su horario de trabajo.
 */
type Horario =
  | { readonly cada: number }
  | { readonly diario: number }
  | { readonly semanal: { readonly diaDeLaSemana: number; readonly minuto: number } }
  | { readonly mensualUtc: number };

const HORARIOS: Readonly<Record<Trabajo, Horario>> = {
  'caducar-retenciones': { cada: 1 },
  'verificar-citas': { cada: 30 },
  'vigilar-derechos': { diario: 9 * 60 + 5 },
  // Lunes a las 09:00: la relación de la semana anterior, para que recepción
  // confirme asistencias (contrato: si no contesta en 7 días, se presume).
  'relacion-de-asistencia': { semanal: { diaDeLaSemana: 1, minuto: 9 * 60 } },
  'presumir-asistencia': { diario: 9 * 60 + 10 },
  'recordatorios': { cada: 15 },
  // Antes de la purga de las 03:15 (pg_cron).
  'consolidar-periodo': { mensualUtc: 2 * 60 },
};

/** «Ahora» en una zona horaria: el día local (como número de días) y el minuto del día. */
function local(ahora: Date, zonaHoraria: string): { dia: number; minutos: number } {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: zonaHoraria,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(ahora)
      .map((p) => [p.type, p.value]),
  );
  return {
    dia: Date.UTC(Number(partes['year']), Number(partes['month']) - 1, Number(partes['day'])) / 86_400_000,
    minutos: Number(partes['hour']) * 60 + Number(partes['minute']),
  };
}

/** Compara dos momentos locales (día, minuto). */
const antes = (a: { dia: number; minutos: number }, b: { dia: number; minutos: number }): boolean =>
  a.dia < b.dia || (a.dia === b.dia && a.minutos < b.minutos);

/**
 * ¿Toca ejecutar este trabajo ahora? Pura: sólo mira la última vez, la hora y
 * la zona. Lo diario, lo semanal y lo mensual se deciden por **la última vez
 * que tocó** (en hora local), no por horas transcurridas: así un reinicio no lo
 * repite, y una caída a la hora de siempre lo ejecuta al volver, no a la vez
 * siguiente.
 */
export function tocaEjecutar(trabajo: Trabajo, ultima: Date | undefined, ahora: Date, zonaHoraria: string): boolean {
  const horario = HORARIOS[trabajo];
  if ('cada' in horario) {
    // Un segundo de margen hacia abajo: un tic que llega a los 59,9 s no se salta.
    return ultima === undefined || ahora.getTime() - ultima.getTime() >= horario.cada * 60_000 - 1_000;
  }

  if ('mensualUtc' in horario) {
    const inicioDeMes = Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), 1, 0, horario.mensualUtc);
    if (ahora.getTime() < inicioDeMes) return false;
    return ultima === undefined || ultima.getTime() < inicioDeMes;
  }

  // La última vez que debió correr, en hora local.
  const hoy = local(ahora, zonaHoraria);
  let debida: { dia: number; minutos: number };
  if ('diario' in horario) {
    debida = { dia: hoy.minutos >= horario.diario ? hoy.dia : hoy.dia - 1, minutos: horario.diario };
  } else {
    const { diaDeLaSemana, minuto } = horario.semanal;
    // El 1-1-1970 fue jueves (4): 0 = domingo.
    const semana = (hoy.dia + 4) % 7;
    let atras = (semana - diaDeLaSemana + 7) % 7;
    if (atras === 0 && hoy.minutos < minuto) atras = 7;
    debida = { dia: hoy.dia - atras, minutos: minuto };
  }
  // Nunca ha corrido: sólo si ya es su hora hoy (o esta semana), no por ponerse al día.
  if (ultima === undefined) {
    return 'diario' in horario ? hoy.minutos >= horario.diario : !antes(hoy, debida);
  }
  return antes(local(ultima, zonaHoraria), debida);
}

export interface ResultadoDeTrabajo {
  readonly trabajo: Trabajo;
  readonly resumen: Record<string, number | boolean>;
}

/** Ejecuta un trabajo para una clínica y encola lo que emita. */
export async function ejecutarTrabajo(
  deps: Dependencias,
  clientId: string,
  trabajo: Trabajo,
): Promise<ResultadoDeTrabajo> {
  const ahora = deps.reloj();
  const marca = ahora.getTime();

  switch (trabajo) {
    case 'caducar-retenciones': {
      const r = await caducarRetenciones(deps, { clientId }, async (tx, salida) => {
        const { config } = await resolverCliente(clientId, tx, deps.configuracion);
        for (const aplicado of salida.aplicados) {
          const hueco = await q.buscarHueco(clientId, tx, aplicado.holdId);
          await encolarEfectosDelSistema(clientId, tx, {
            clave: `cron:${aplicado.holdId}:${aplicado.desde}>${aplicado.hasta}:${marca}`,
            conversationId: hueco?.conversationId ?? null,
            clinica: config.nombre,
            efectos: aplicado.efectos,
            ahora,
            plantillas: config.plantillas,
          });
        }
      });
      return { trabajo, resumen: { aplicados: r.aplicados.length, restantes: r.restantes, diferido: r.diferidoPorHorario } };
    }

    case 'verificar-citas': {
      const r = await verificarCitas(deps, { clientId }, (tx, salida) => porEscalado(deps, clientId, tx, salida.efectos, `verificar:${marca}`, ahora));
      return { trabajo, resumen: { verificados: r.verificados.length, colisiones: r.colisiones } };
    }

    case 'vigilar-derechos': {
      const r = await vigilarDerechos(deps, { clientId }, async (tx, salida) => {
        await porEscalado(deps, clientId, tx, salida.efectos, `derechos:${marca}`, ahora);
        await registrarLatido(clientId, tx, 'vigilar-derechos', ahora);
      });
      return { trabajo, resumen: { avisadas: r.avisadas.length } };
    }

    case 'relacion-de-asistencia': {
      const n = await enviarRelacionDeAsistencia(deps, clientId, ahora);
      return { trabajo, resumen: { citas: n } };
    }

    case 'presumir-asistencia': {
      const n = await presumirAsistencias(deps, clientId, ahora);
      return { trabajo, resumen: { presumidas: n } };
    }

    case 'recordatorios': {
      const r = await enviarRecordatorios(deps, clientId, ahora);
      return { trabajo, resumen: r };
    }

    case 'consolidar-periodo': {
      await consolidarPeriodo(deps, { clientId });
      // Idempotente: si esto no llegara a guardarse, repetirlo no duplica nada.
      await deps.core.withClient(clientId, (tx) => registrarLatido(clientId, tx, 'consolidar-periodo', ahora));
      return { trabajo, resumen: { consolidado: true } };
    }
  }
}

/** Los efectos de escalados (verificar, derechos) salen por la conversación de cada escalado. */
async function porEscalado(
  deps: Dependencias,
  clientId: string,
  tx: Tx,
  efectos: ReadonlyArray<Parameters<typeof encolarEfectosDelSistema>[2]['efectos'][number]>,
  clave: string,
  ahora: Date,
): Promise<void> {
  const clinica = await nombreDeLaClinica(deps, clientId, tx);
  for (const [i, efecto] of efectos.entries()) {
    const conversationId =
      'escaladoId' in efecto && typeof efecto.escaladoId === 'string'
        ? await q.conversacionDelEscalado(clientId, tx, efecto.escaladoId)
        : null;
    await encolarEfectosDelSistema(clientId, tx, { clave: `${clave}:${i}`, conversationId, clinica, efectos: [efecto], ahora });
  }
}

async function nombreDeLaClinica(deps: Dependencias, clientId: string, tx: Tx): Promise<string> {
  return (await resolverCliente(clientId, tx, deps.configuracion)).config.nombre;
}

/** La última vez que corrió cada trabajo en esta clínica. */
export async function ultimasEjecuciones(deps: Dependencias, clientId: string): Promise<Map<string, Date>> {
  return deps.core.withClient(clientId, async (tx) => {
    const filas = await tx
      .select({ job: jobRuns.job, lastRunAt: jobRuns.lastRunAt })
      .from(jobRuns)
      .where(eq(jobRuns.clientId, clientId));
    return new Map(filas.map((f) => [f.job, f.lastRunAt]));
  });
}

/**
 * Una pasada del planificador para una clínica: lo que toque, en orden, y
 * cada trabajo por su lado —que falle uno no impide los demás—.
 */
export async function pasarPlanificador(
  deps: Dependencias,
  clientId: string,
  zonaHoraria: string,
): Promise<{ hechos: ResultadoDeTrabajo[]; fallos: Array<{ trabajo: Trabajo; error: string }> }> {
  const ahora = deps.reloj();
  const ultimas = await ultimasEjecuciones(deps, clientId);
  const hechos: ResultadoDeTrabajo[] = [];
  const fallos: Array<{ trabajo: Trabajo; error: string }> = [];
  for (const trabajo of TRABAJOS) {
    if (!tocaEjecutar(trabajo, ultimas.get(trabajo), ahora, zonaHoraria)) continue;
    try {
      hechos.push(await ejecutarTrabajo(deps, clientId, trabajo));
    } catch (error: unknown) {
      fallos.push({ trabajo, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { hechos, fallos };
}

/** Días que tiene recepción para contestar la relación antes de que se presuma la asistencia (contrato). */
export const DIAS_PARA_PRESUMIR = 7;

/**
 * **La relación semanal de asistencia.** Las citas que ya han pasado y no
 * tienen resultado, marcadas como «pedidas» hoy: desde aquí corren los 7 días
 * del contrato. Se contestan en el panel («Asistió» / «No vino»).
 *
 * Le llega a recepción por correo si tiene ese canal en su YAML. Si no lo tiene,
 * la relación vive en el panel y el operador recibe un aviso sin datos: que la
 * relación exista no puede depender de que nadie la mire.
 */
async function enviarRelacionDeAsistencia(deps: Dependencias, clientId: string, ahora: Date): Promise<number> {
  return deps.core.withClient(clientId, async (tx) => {
    const cliente = await resolverCliente(clientId, tx, deps.configuracion);
    const citas = await q.citasSinAsistencia(clientId, tx, { ahora, soloSinPedir: true });
    await registrarLatido(clientId, tx, 'relacion-de-asistencia', ahora);
    if (citas.length === 0) return 0;

    await q.marcarAsistenciaPedida(clientId, tx, citas.map((c) => c.id), ahora);

    const zona = cliente.config.zonaHoraria;
    const nombreServicio = (codigo: string) => cliente.config.servicios.find((sv) => sv.codigo === codigo)?.nombre ?? codigo;
    const cuando = (d: Date) =>
      new Intl.DateTimeFormat('es-ES', { timeZone: zona, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(d);
    const lista = citas.map((c) => `- ${cuando(c.slotStart)} · ${nombreServicio(c.serviceCode)} · ${c.nombre}`).join('\n');
    const plazo = new Intl.DateTimeFormat('es-ES', { timeZone: zona, weekday: 'long', day: 'numeric', month: 'long' }).format(
      new Date(ahora.getTime() + DIAS_PARA_PRESUMIR * 86_400_000),
    );
    const cuerpo = [
      `Citas pasadas sin asistencia anotada (${citas.length}):`,
      '',
      lista,
      '',
      'Márcalas en el panel como «Asistió» o «No vino».',
      `Las que sigan sin marcar el ${plazo} se darán por asistidas.`,
    ].join('\n');

    const correos = cliente.config.escalado.recepcion.filter((d) => d.canal === 'email');
    for (const d of correos) {
      await q.encolarSalida(clientId, tx, {
        kind: 'correo',
        dedupeKey: `relacion:${ahora.toISOString().slice(0, 10)}:${d.destino}`,
        payload: { correoA: d.destino, asunto: `[${cliente.config.nombre}] Asistencias por confirmar`, cuerpo },
        ahora,
      });
    }
    if (correos.length === 0) {
      await q.encolarSalida(clientId, tx, {
        kind: 'correo_operador',
        dedupeKey: `relacion:${ahora.toISOString().slice(0, 10)}`,
        payload: {
          asunto: `[Motor de Citas] Asistencias por confirmar · ${cliente.config.nombre}`,
          cuerpo: [
            `${citas.length} cita(s) pasadas sin asistencia anotada. Están en el panel, pestaña Asistencia.`,
            `Recepción no tiene correo en su YAML (escalado.recepcion), así que la relación no le ha llegado por ningún otro sitio.`,
            `Sin respuesta, se darán por asistidas en ${DIAS_PARA_PRESUMIR} días.`,
          ].join('\n'),
        },
        ahora,
      });
    }
    return citas.length;
  });
}

/**
 * **La presunción del contrato**: lo que recepción no ha contestado en 7 días
 * desde la relación, se da por asistido, con `fuente: presuncion`. Una
 * rectificación posterior no reescribe la historia: se anota y se compensa.
 * Cada cita en su transacción: que falle una no impide las demás.
 */
async function presumirAsistencias(deps: Dependencias, clientId: string, ahora: Date): Promise<number> {
  const limite = new Date(ahora.getTime() - DIAS_PARA_PRESUMIR * 86_400_000);
  const citas = await deps.core.withClient(clientId, async (tx) => {
    await registrarLatido(clientId, tx, 'presumir-asistencia', ahora);
    return q.citasParaPresumir(clientId, tx, { pedidasAntesDe: limite, limite: 200 });
  });
  for (const id of citas) {
    await registrarResultadoDeCita(deps, { clientId, citaId: id, outcome: 'asistida', fuente: 'presuncion' });
  }
  return citas.length;
}

/**
 * **Los recordatorios antes de la cita.** Sólo si la clínica los tiene en su
 * YAML, y sólo dentro de la franja de contacto: quien tiene cita a las 10:00 no
 * recibe el aviso a las 03:00, lo recibe a las 09:00. Dentro de las 24 h desde
 * su último mensaje sale como texto; fuera, con la plantilla `recordatorio`; sin
 * plantilla, no sale y lo sabe el operador. En los tres casos la cita queda
 * marcada: un recordatorio no se repite.
 */
async function enviarRecordatorios(
  deps: Dependencias,
  clientId: string,
  ahora: Date,
): Promise<{ texto: number; plantilla: number; sinPlantilla: number; fueraDeFranja: boolean }> {
  return deps.core.withClient(clientId, async (tx) => {
    await registrarLatido(clientId, tx, 'recordatorios', ahora);
    const cliente = await resolverCliente(clientId, tx, deps.configuracion);
    const cuenta = { texto: 0, plantilla: 0, sinPlantilla: 0, fueraDeFranja: false };
    const horasAntes = cliente.config.recordatorios?.horasAntes;
    if (horasAntes === undefined) return cuenta;
    if (!dentroDeFranja(ahora, cliente)) return { ...cuenta, fueraDeFranja: true };

    const citas = await q.citasParaRecordar(clientId, tx, { ahora, horasAntes, limite: 50 });
    for (const c of citas) {
      const canal = await q.canalDeLaConversacion(clientId, tx, c.conversationId);
      const texto = cliente.textos.recordatorio({ nombre: c.nombre, hueco: c.slotStart, servicio: c.serviceCode });
      const servicio = cliente.config.servicios.find((sv) => sv.codigo === c.serviceCode)?.nombre ?? c.serviceCode;
      const resultado =
        canal === null
          ? 'sin_plantilla'
          : await encolarAvisoAlPaciente(clientId, tx, {
              canal,
              conversationId: c.conversationId,
              uso: 'recordatorio',
              texto,
              variables: { nombre: c.nombre, servicio, cuando: momento(c.slotStart, cliente.config.zonaHoraria), clinica: cliente.config.nombre },
              plantillas: cliente.config.plantillas,
              clinica: cliente.config.nombre,
              dedupeKey: `recordatorio:${c.id}`,
              ahora,
            });
      if (canal === null) {
        await q.encolarSalida(clientId, tx, {
          kind: 'correo_operador',
          dedupeKey: `recordatorio_sin_canal:${c.id}`,
          payload: {
            asunto: `[Motor de Citas] Un recordatorio no tiene por dónde salir · ${cliente.config.nombre}`,
            cuerpo: `La cita ${c.id} es de una conversación que nunca ha entrado por Chatwoot ni por Meta en el núcleo.`,
          },
          ahora,
        });
      }
      // Regla 6: lo que sale al paciente se registra, y así el agente lo ve si contesta «no puedo».
      if (resultado !== 'sin_plantilla') {
        await q.guardarMensaje(clientId, tx, { conversationId: c.conversationId, direction: 'saliente', body: texto, isClinical: false, createdAt: ahora });
      }
      await q.marcarRecordatorio(clientId, tx, c.id, ahora);
      if (resultado === 'texto') cuenta.texto += 1;
      else if (resultado === 'plantilla') cuenta.plantilla += 1;
      else cuenta.sinPlantilla += 1;
    }
    return cuenta;
  });
}
