import { and, eq } from 'drizzle-orm';

import type { Patron } from '../agent/firewall-patterns.js';
import type { ClienteConfig } from '../config/cliente.js';
import { instanteLocal, patronesDe, politicaDe, textosDe } from '../config/derivar.js';
import type { RegistroDeConfiguracion } from '../config/registry.js';
import { DomainError } from '../core/errors.js';
import type { PoliticaDeVencimientos } from '../core/hold-state-machine.js';
import type { Tx } from '../db/client.js';
import { clients } from '../db/schema.js';
import type { Textos } from './ports.js';

/**
 * Resuelve, para un `client_id`, todo lo que la clínica configura: vencimientos,
 * textos, patrones extra y catálogo.
 *
 * Regla 7 en la práctica. Ninguna capa de servicio vuelve a saber de horarios ni
 * de precios: los pide aquí.
 */

export class ClinicaDesconocida extends DomainError {
  readonly code = 'clinica_desconocida';
  readonly httpStatus = 404;
}

export interface ContextoDeCliente {
  readonly clientId: string;
  readonly slug: string;
  readonly config: ClienteConfig;
  readonly configVersion: string;
  readonly politica: PoliticaDeVencimientos;
  readonly textos: Textos;
  readonly patronesAdicionales: Patron[];
}

export async function resolverCliente(
  clientId: string,
  tx: Tx,
  registro: RegistroDeConfiguracion,
): Promise<ContextoDeCliente> {
  const filas = await tx
    .select({ slug: clients.slug, activo: clients.active })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);

  const fila = filas[0];
  if (fila === undefined) throw new ClinicaDesconocida(`No existe la clínica ${clientId}.`);
  if (!fila.activo) throw new ClinicaDesconocida(`La clínica ${fila.slug} está dada de baja.`);

  const { config, version } = registro.obtener(fila.slug);

  return {
    clientId,
    slug: fila.slug,
    config,
    configVersion: version,
    politica: politicaDe(config),
    textos: textosDe(config),
    patronesAdicionales: patronesDe(config),
  };
}

/**
 * Deja en `clients.config` la configuración vigente.
 *
 * El YAML manda en tiempo de ejecución; esta copia existe para que una consulta
 * a la base de datos pueda reconstruir con qué configuración se respondió, sin
 * depender de qué fichero había en el servidor aquel día.
 */
export async function sincronizarConfiguracion(
  clientId: string,
  tx: Tx,
  contexto: ContextoDeCliente,
): Promise<void> {
  await tx
    .update(clients)
    .set({ config: contexto.config, configVersion: contexto.configVersion })
    .where(and(eq(clients.id, clientId), eq(clients.slug, contexto.slug)));
}

/**
 * ¿Se puede escribir ahora mismo a un paciente?
 *
 * **Sólo se consulta para lo que puede esperar.** La atención de
 * `/mensaje-entrante` es 24/7 y no pasa por aquí: quien escribe a las 22:30
 * recibe respuesta en segundos y puede elegir hueco. Esto acota los envíos que
 * los inicia el sistema —avisos de caducidad, oleadas, aviso a recepción— para
 * que nadie reciba nada a las tres de la mañana.
 */
export function dentroDeFranja(ahora: Date, cliente: ContextoDeCliente): boolean {
  const dtf = new Intl.DateTimeFormat('en-GB', {
    timeZone: cliente.config.zonaHoraria,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const actual = dtf.format(ahora);
  return actual >= cliente.config.envios.horaMinima && actual < cliente.config.envios.horaMaxima;
}

/** El instante en que se abre la franja de contacto, a partir de `ahora`. */
export function inicioDeFranja(ahora: Date, cliente: ContextoDeCliente): Date {
  const [hh, mm] = cliente.config.envios.horaMinima.split(':').map(Number);
  for (let salto = 0; salto < 2; salto += 1) {
    const dia = new Date(ahora.getTime() + salto * 86_400_000);
    const candidato = instanteLocal(dia, cliente.config.zonaHoraria, hh ?? 9, mm ?? 0);
    if (candidato > ahora) return candidato;
  }
  return new Date(ahora.getTime() + 86_400_000);
}
