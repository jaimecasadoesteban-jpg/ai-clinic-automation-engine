import { and, eq, inArray, isNull, lte, ne, or } from 'drizzle-orm';

import type { Tx } from '../db/client.js';
import { holds, jobRuns, rightsRequests } from '../db/schema.js';
import * as q from '../db/queries.js';
import { dentroDeFranja, resolverCliente } from './contexto.js';
import type { Dependencias, EfectoDeSalida } from './pipeline.js';
import { resolverEfectos, type EfectoResuelto } from './efectos.js';

/**
 * Vigilar lo que el sistema promete.
 *
 * Dos obligaciones que estaban escritas y que no miraba nadie. **Registrar el
 * incumplimiento en vez de evitarlo es peor que no registrarlo, porque deja la
 * prueba**: `rights_requests` guardaba la fecha de vencimiento del plazo legal y
 * nada la leía, así que el sistema documentaba puntualmente que la clínica se
 * había pasado de fecha.
 *
 * Y la ausencia de señal —que un cron deje de llamar— es el fallo más
 * traicionero que existe: no produce ningún error, simplemente no pasa nada.
 */

/** Días desde la recepción a los que se avisa, antes de que venza el mes. */
export const AVISOS_DE_DERECHOS = [20, 27] as const;

/**
 * Cuánto puede tardar cada cron en volver a llamar antes de que se dé por
 * perdido. Con holgura: el objetivo es detectar que algo lleva horas muerto, no
 * quejarse porque una ejecución llegó tarde.
 */
export const LATIDO_MAXIMO_MINUTOS: Readonly<Record<string, number>> = {
  'caducar-retenciones': 90,
  'verificar-citas': 180,
};

export type Job = keyof typeof LATIDO_MAXIMO_MINUTOS;

/**
 * Los estados de hueco que cada cron tiene que vigilar. Si alguno lleva en ese
 * estado más que el latido máximo y el cron no ha llamado nunca, el cron no es
 * «nuevo»: hay trabajo suyo esperando.
 */
const ESTADOS_QUE_VIGILA: Readonly<Record<string, readonly ('propuesta' | 'retenida' | 'pendiente_recepcion' | 'confirmada')[]>> = {
  'caducar-retenciones': ['propuesta', 'retenida', 'pendiente_recepcion'],
  'verificar-citas': ['confirmada'],
};

async function hayTrabajoEsperando(
  clientId: string,
  tx: Tx,
  job: string,
  desde: Date,
): Promise<boolean> {
  const estados = ESTADOS_QUE_VIGILA[job];
  if (estados === undefined || estados.length === 0) return false;
  const [fila] = await tx
    .select({ id: holds.id })
    .from(holds)
    .where(
      and(
        eq(holds.clientId, clientId),
        inArray(holds.state, [...estados]),
        lte(holds.stateChangedAt, desde),
      ),
    )
    .limit(1);
  return fila !== undefined;
}

/**
 * Deja constancia de que este cron ha llamado.
 *
 * Con `ahora`, el reloj inyectado, y no con `now()` de Postgres: quien compara
 * contra este latido es `revisarLatidos`, que usa el inyectado. Con dos relojes
 * distintos, un test con fecha fija dejó de detectar el latido perdido el día
 * que el reloj de verdad pasó esa fecha, y nadie había tocado el código.
 */
export async function registrarLatido(
  clientId: string,
  tx: Tx,
  job: string,
  ahora: Date,
): Promise<void> {
  await tx
    .insert(jobRuns)
    .values({ clientId, job, lastRunAt: ahora, updatedAt: ahora })
    .onConflictDoUpdate({
      target: [jobRuns.clientId, jobRuns.job],
      set: { lastRunAt: ahora, updatedAt: ahora },
    });
}

export interface LatidoPerdido {
  readonly job: string;
  readonly ultimaLlamada: Date | null;
  readonly minutosSinLlamar: number | null;
}

/**
 * Qué crons llevan sin llamar más de lo tolerable.
 *
 * Se comprueba **sólo dentro de la franja de contacto de la clínica**: fuera de
 * ella los crons no hacen nada útil de todas formas, y avisar a las cuatro de la
 * mañana de que no ha corrido lo que no tenía que correr es la fatiga de alertas
 * otra vez.
 */
export async function latidosPerdidos(
  clientId: string,
  tx: Tx,
  ahora: Date,
): Promise<LatidoPerdido[]> {
  const filas = await tx
    .select({ job: jobRuns.job, lastRunAt: jobRuns.lastRunAt })
    .from(jobRuns)
    .where(eq(jobRuns.clientId, clientId));

  const porJob = new Map(filas.map((f) => [f.job, f.lastRunAt]));
  const perdidos: LatidoPerdido[] = [];

  for (const [job, maximo] of Object.entries(LATIDO_MAXIMO_MINUTOS)) {
    const ultima = porJob.get(job);
    if (ultima === undefined) {
      // Nunca ha llamado. Antes se callaba siempre, para no confundir una
      // clínica recién dada de alta con una rota. Y así se calló en producción:
      // tras migrar el servidor no se montó ningún cron, `job_runs` estaba vacía,
      // y un aviso a recepción diferido de madrugada iba a esperar para siempre
      // sin que nada lo dijera.
      //
      // Lo que distingue «nuevo» de «roto» no es si ha llamado, es si hay trabajo
      // suyo esperando: un hueco vivo que lleva más que el latido máximo en un
      // estado que este cron tiene que mirar. Una clínica recién dada de alta no
      // tiene ninguno.
      const desde = new Date(ahora.getTime() - maximo * 60_000);
      if (await hayTrabajoEsperando(clientId, tx, job, desde)) {
        perdidos.push({ job, ultimaLlamada: null, minutosSinLlamar: null });
      }
      continue;
    }
    const minutos = Math.floor((ahora.getTime() - ultima.getTime()) / 60_000);
    if (minutos > maximo) {
      perdidos.push({ job, ultimaLlamada: ultima, minutosSinLlamar: minutos });
    }
  }

  return perdidos;
}

/**
 * Comprueba los latidos aprovechando el tráfico de pacientes.
 *
 * Es deliberado que el detector no dependa de otro cron: **si los crons se
 * mueren, un cron que los vigile se muere con ellos.** Los mensajes entrantes
 * los provoca el paciente, no nosotros, así que son una señal de vida
 * independiente de nuestra propia infraestructura.
 *
 * Su límite, y hay que saberlo: si no hay tráfico Y los crons están caídos, esto
 * no detecta nada. Por eso además se expone en el informe semanal.
 */
export async function revisarLatidos(
  tx: Tx,
  datos: {
    clientId: string;
    conversationId: string;
    patientId: string;
    ahora: Date;
    cliente: Awaited<ReturnType<typeof resolverCliente>>;
  },
): Promise<EfectoDeSalida[]> {
  if (!dentroDeFranja(datos.ahora, datos.cliente)) return [];

  const perdidos = await latidosPerdidos(datos.clientId, tx, datos.ahora);
  if (perdidos.length === 0) return [];

  // Uno abierto basta: si ya hay un aviso sin atender, repetirlo cada mensaje
  // entrante sería convertir una alarma en ruido de fondo.
  const yaAvisado = await q.escaladoAbiertoPorMotivo(
    datos.clientId,
    tx,
    datos.conversationId,
    'latido_perdido',
  );
  if (yaAvisado) return [];

  const escaladoId = await q.crearEscalado(datos.clientId, tx, {
    conversationId: datos.conversationId,
    patientId: datos.patientId,
    reason: 'latido_perdido',
    severity: 2,
    notifiedAt: datos.ahora,
    createdAt: datos.ahora,
  });
  await q.anotarAuditoria(datos.clientId, tx, {
    entity: 'job_runs',
    entityId: datos.conversationId,
    action: `latido_perdido:${perdidos.map((p) => p.job).join(',')}`,
    actor: 'sistema',
  });

  return [{ tipo: 'escalar_a_humano', escaladoId, severidad: 2, motivo: 'latido_perdido' }];
}

export interface SalidaDeVigilanciaDeDerechos {
  readonly clientId: string;
  readonly avisadas: Array<{
    readonly solicitudId: string;
    readonly derecho: string;
    readonly diasRestantes: number;
    readonly umbral: number;
  }>;
  readonly efectos: EfectoResuelto[];
}

/**
 * Cron diario: avisa de las solicitudes de derechos que se acercan al plazo.
 *
 * **Antes de que venza, no cuando ya ha vencido.** A los 20 días y a los 27, y
 * cada aviso se marca para no repetirlo cada día — un aviso diario sobre lo
 * mismo se deja de leer en tres días, que es justo cuando haría falta.
 */
export async function vigilarDerechos(
  deps: Dependencias,
  entrada: { readonly clientId: string },
  /**
   * Para quien envía desde el núcleo (el planificador): corre **dentro** de la
   * transacción, así lo que haya que mandar se encola junto con el cambio de
   * estado (regla 3). Por HTTP no se pasa y la salida vuelve a quien llamó.
   */
  alTerminar?: (tx: Tx, salida: SalidaDeVigilanciaDeDerechos) => Promise<void>,
): Promise<SalidaDeVigilanciaDeDerechos> {
  const ahora = deps.reloj();

  return deps.core.withClient(entrada.clientId, async (tx) => {
    const cliente = await resolverCliente(entrada.clientId, tx, deps.configuracion);

    const avisadas: SalidaDeVigilanciaDeDerechos['avisadas'] = [];
    const efectos: EfectoDeSalida[] = [];

    for (const umbral of AVISOS_DE_DERECHOS) {
      const columna = umbral === 20 ? rightsRequests.warned20At : rightsRequests.warned27At;
      const limite = new Date(ahora.getTime() - umbral * 86_400_000);

      const pendientes = await tx
        .select({
          id: rightsRequests.id,
          kind: rightsRequests.kind,
          answerDueAt: rightsRequests.answerDueAt,
          patientId: rightsRequests.patientId,
          conversationId: rightsRequests.conversationId,
        })
        .from(rightsRequests)
        .where(
          and(
            eq(rightsRequests.clientId, entrada.clientId),
            ne(rightsRequests.state, 'cerrada'),
            lte(rightsRequests.receivedAt, limite),
            isNull(columna),
          ),
        );

      for (const solicitud of pendientes) {
        await tx
          .update(rightsRequests)
          .set(umbral === 20 ? { warned20At: ahora } : { warned27At: ahora })
          .where(eq(rightsRequests.id, solicitud.id));

        const escaladoId = await q.crearEscalado(entrada.clientId, tx, {
          conversationId: solicitud.conversationId,
          patientId: solicitud.patientId,
          reason: 'derechos_rgpd',
          severity: umbral >= 27 ? 3 : 2,
          notifiedAt: ahora,
          createdAt: ahora,
        });
        efectos.push({
          tipo: 'escalar_a_humano',
          escaladoId,
          severidad: umbral >= 27 ? 3 : 2,
          motivo: 'derechos_rgpd',
        });

        avisadas.push({
          solicitudId: solicitud.id,
          derecho: solicitud.kind,
          diasRestantes: Math.ceil(
            (solicitud.answerDueAt.getTime() - ahora.getTime()) / 86_400_000,
          ),
          umbral,
        });
      }
    }

    const salida: SalidaDeVigilanciaDeDerechos = {
      clientId: entrada.clientId,
      avisadas,
      // Resueltos, como en todas las demás salidas: estos van a quien la clínica
      // haya designado para protección de datos, que NO es recepción.
      efectos: await resolverEfectos(entrada.clientId, tx, cliente, efectos),
    };
    await alTerminar?.(tx, salida);
    return salida;
  });
}

/** Las solicitudes abiertas con sus días restantes, para el informe semanal. */
export async function derechosAbiertos(
  clientId: string,
  tx: Tx,
  ahora: Date,
): Promise<Array<{ derecho: string; estado: string; diasRestantes: number }>> {
  const filas = await tx
    .select({
      kind: rightsRequests.kind,
      state: rightsRequests.state,
      answerDueAt: rightsRequests.answerDueAt,
    })
    .from(rightsRequests)
    .where(
      and(
        eq(rightsRequests.clientId, clientId),
        or(ne(rightsRequests.state, 'cerrada'), isNull(rightsRequests.closedAt)),
      ),
    )
    .orderBy(rightsRequests.answerDueAt);

  return filas.map((f) => ({
    derecho: f.kind,
    estado: f.state,
    diasRestantes: Math.ceil((f.answerDueAt.getTime() - ahora.getTime()) / 86_400_000),
  }));
}
