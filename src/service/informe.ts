import { sql } from 'drizzle-orm';

import { resolverCliente } from './contexto.js';
import { derechosAbiertos, latidosPerdidos } from './vigilancia.js';
import type { Dependencias } from './pipeline.js';

/**
 * Métricas del periodo. Un informe semanal justifica la cuota igual de bien que
 * un panel y libera 20-30 h de implantación, así que en fase 1 no hay panel.
 *
 * Incluye la **tasa de corte del cortafuegos por categoría**: si una clínica
 * normal pasa de tres o cuatro escalados al día, recepción dejará de mirarlos y
 * el escalado no servirá para nada el día que llegue el caso de verdad.
 */

export interface EntradaDeInforme {
  readonly clientId: string;
  readonly desde: string;
  readonly hasta: string;
}

export interface SalidaDeInforme {
  readonly clientId: string;
  readonly desde: string;
  readonly hasta: string;
  readonly citasGeneradas: number;
  readonly citasConfirmadas: number;
  readonly noShows: number;
  readonly cancelaciones: number;
  readonly conversaciones: number;
  readonly mensajesEntrantes: number;
  readonly huecosPropuestos: number;
  readonly colisiones: number;
  readonly escalados: { motivo: string; total: number }[];
  readonly cortesPorCategoria: { categoria: string; total: number; porDia: number }[];
  /** Días del periodo, para leer la carga diaria de escalados. */
  readonly dias: number;
  /**
   * Solicitudes de derechos abiertas, con los días que quedan de plazo legal.
   *
   * Va en el informe semanal para que esté **delante de sus ojos sin tener que
   * buscarlo**: el cron avisa, pero un aviso se lee y se olvida, y el plazo es
   * de un mes.
   */
  readonly derechosAbiertos: Array<{ derecho: string; estado: string; diasRestantes: number }>;
  /** Crons que llevan sin llamar más de lo tolerable. Vacío es lo normal. */
  readonly latidosPerdidos: Array<{ job: string; minutosSinLlamar: number | null }>;
}

export async function generarInforme(
  deps: Dependencias,
  entrada: EntradaDeInforme,
): Promise<SalidaDeInforme> {
  return deps.core.withClient(entrada.clientId, async (tx) => {
    await resolverCliente(entrada.clientId, tx, deps.configuracion);

    const rango = sql`created_at >= ${entrada.desde}::date and created_at < ${entrada.hasta}::date + 1`;

    const totales = await tx.execute<Record<string, number>>(sql`
      select
        (select count(*) from motor.appointments
          where client_id = ${entrada.clientId} and counts_as_generated
            and slot_start >= ${entrada.desde}::date and slot_start < ${entrada.hasta}::date + 1) as citas_generadas,
        (select count(*) from motor.appointments
          where client_id = ${entrada.clientId}
            and slot_start >= ${entrada.desde}::date and slot_start < ${entrada.hasta}::date + 1) as citas_confirmadas,
        (select count(*) from motor.appointments
          where client_id = ${entrada.clientId} and outcome = 'no_asistida'
            and slot_start >= ${entrada.desde}::date and slot_start < ${entrada.hasta}::date + 1) as no_shows,
        (select count(*) from motor.appointments
          where client_id = ${entrada.clientId} and outcome = 'cancelada'
            and slot_start >= ${entrada.desde}::date and slot_start < ${entrada.hasta}::date + 1) as cancelaciones,
        (select count(*) from motor.conversations
          where client_id = ${entrada.clientId} and ${rango}) as conversaciones,
        (select count(*) from motor.messages
          where client_id = ${entrada.clientId} and direction = 'entrante' and ${rango}) as mensajes_entrantes,
        (select count(*) from motor.holds
          where client_id = ${entrada.clientId} and ${rango}) as huecos_propuestos,
        (select count(*) from motor.holds
          where client_id = ${entrada.clientId} and state = 'colisionada' and ${rango}) as colisiones,
        (${entrada.hasta}::date - ${entrada.desde}::date + 1) as dias
    `);
    const t = totales[0] ?? {};

    const escalados = await tx.execute<{ reason: string; total: number }>(sql`
      select reason, count(*)::int as total
        from motor.escalations
       where client_id = ${entrada.clientId} and ${rango}
       group by reason order by total desc
    `);

    const cortes = await tx.execute<{ categoria: string; total: number }>(sql`
      select firewall_category as categoria, count(*)::int as total
        from motor.messages
       where client_id = ${entrada.clientId} and direction = 'entrante'
         and firewall_category is not null and ${rango}
       group by firewall_category order by total desc
    `);

    const dias = Math.max(1, Number(t['dias'] ?? 1));
    const ahora = deps.reloj();
    const abiertos = await derechosAbiertos(entrada.clientId, tx, ahora);
    const latidos = await latidosPerdidos(entrada.clientId, tx, ahora);

    return {
      clientId: entrada.clientId,
      desde: entrada.desde,
      hasta: entrada.hasta,
      citasGeneradas: Number(t['citas_generadas'] ?? 0),
      citasConfirmadas: Number(t['citas_confirmadas'] ?? 0),
      noShows: Number(t['no_shows'] ?? 0),
      cancelaciones: Number(t['cancelaciones'] ?? 0),
      conversaciones: Number(t['conversaciones'] ?? 0),
      mensajesEntrantes: Number(t['mensajes_entrantes'] ?? 0),
      huecosPropuestos: Number(t['huecos_propuestos'] ?? 0),
      colisiones: Number(t['colisiones'] ?? 0),
      escalados: escalados.map((e) => ({ motivo: e.reason, total: Number(e.total) })),
      cortesPorCategoria: cortes.map((c) => ({
        categoria: c.categoria,
        total: Number(c.total),
        porDia: Math.round((Number(c.total) / dias) * 100) / 100,
      })),
      dias,
      derechosAbiertos: abiertos,
      latidosPerdidos: latidos.map((l) => ({ job: l.job, minutosSinLlamar: l.minutosSinLlamar })),
    };
  });
}
