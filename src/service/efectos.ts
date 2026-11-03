import type { ContextoDeCliente } from './contexto.js';
import type { Tx } from '../db/client.js';
import * as q from '../db/queries.js';
import {
  componerAviso,
  destinatariosDeEscalado,
  destinatariosDeRecepcion,
  MOTIVOS_DEL_OPERADOR,
  nombreDelMotivo,
  type Destinatario,
} from './avisos.js';
import type { EfectoDeSalida } from './pipeline.js';
import type { PlantillaPaciente } from '../core/hold-state-machine.js';
import { momento } from '../config/derivar.js';

/**
 * Resolver los efectos antes de que salgan: a quién van y qué dicen.
 *
 * ## Por qué en un solo sitio y no en cada emisor
 *
 * `escalar_a_humano` se emite desde nueve puntos distintos —cortafuegos, señal de
 * escalado, validación fallida, proveedor caído, vencimientos, vigilancia, agenda
 * no escrita…— y `avisar_a_recepcion` desde cuatro. Añadir la resolución en cada
 * uno sería trece oportunidades de olvidarse, y olvidarse aquí no rompe nada: el
 * efecto sale sin destinatario y **el aviso simplemente no llega**.
 *
 * Así que los emisores siguen diciendo sólo QUÉ ha pasado, y esto —una vez, justo
 * antes de devolver la respuesta— resuelve a quién y con qué texto.
 */

/**
 * El efecto de siempre **más** a quién va y qué dice.
 *
 * Es una intersección con la unión, no un tipo nuevo con `tipo: string`: así se
 * distribuye sobre cada variante y `efecto.tipo === 'avisar_a_recepcion'` sigue
 * estrechando a la variante que tiene `holdId`. Con una firma de índice abierta
 * se perdía eso y cualquier campo se leía como `unknown`.
 */
export type EfectoResuelto = EfectoDeSalida & {
  /** A quién hay que mandarlo. n8n no decide: envía. */
  readonly destinatarios: Destinatario[];
  /** El mensaje ya compuesto, del YAML de la clínica. n8n no redacta. */
  readonly texto: string;
};

/**
 * El texto de un mensaje que el sistema le manda al paciente **por su cuenta**,
 * sin que él haya escrito: sólo los emite `/caducar-retenciones`.
 *
 * Los demás no se resuelven aquí porque no salen como efecto: viajan como
 * `respuesta` del endpoint que los produce, y n8n ya sabe a quién contestar.
 * El `switch` es exhaustivo a propósito: una plantilla nueva no compila hasta
 * que alguien decide cómo llega al paciente.
 */
function textoParaElPaciente(
  cliente: ContextoDeCliente,
  plantilla: PlantillaPaciente,
  datos: { servicio: string; hueco: Date; avisoDiferido: boolean },
): string | null {
  switch (plantilla) {
    case 'propuesta_caducada':
      return cliente.textos.propuestaCaducada({ servicio: datos.servicio });
    case 'retencion_caducada':
      return cliente.textos.retencionCaducada(datos);
    case 'sin_respuesta_de_recepcion':
      return cliente.textos.sinRespuestaDeRecepcion(datos);
    // En automática, n8n no dijo nunca si escribió el evento: degrada al camino
    // de recepción, y el paciente, que eligió hace tres minutos, se entera ya.
    case 'hueco_retenido':
      return cliente.textos.retenido({
        hueco: datos.hueco,
        servicio: datos.servicio,
        avisoDiferidoHasta: datos.avisoDiferido ? datos.hueco : null,
      });
    case 'cita_confirmada':
    case 'hueco_ocupado_proponemos_alternativa':
    case 'cancelacion_confirmada':
      return null;
  }
}

/** Los efectos que van a una persona de la clínica. El resto pasan tal cual. */
const HACIA_LA_CLINICA = new Set([
  'escalar_a_humano',
  'avisar_a_recepcion',
  'recordar_a_recepcion',
  'informar_a_recepcion',
  'avisar_a_recepcion_de_anulacion',
]);

/**
 * Datos del hueco para componer el aviso. Se leen aquí porque el emisor no
 * siempre los tiene a mano —el cron de vencimientos trabaja con `id` y estado— y
 * porque son una lectura barata en un camino que ya va a mandar un WhatsApp.
 */
async function datosDelHueco(
  clientId: string,
  tx: Tx,
  cliente: ContextoDeCliente,
  holdId: string,
): Promise<{ paciente: q.PatientRow | undefined; servicio: string; hueco: Date | undefined }> {
  const fila = await q.buscarHueco(clientId, tx, holdId);
  if (fila === undefined) return { paciente: undefined, servicio: '', hueco: undefined };

  return {
    paciente: await q.buscarPaciente(clientId, tx, fila.patientId),
    servicio: cliente.config.servicios.find((s) => s.codigo === fila.serviceCode)?.nombre ?? '',
    hueco: fila.slotStart,
  };
}

/**
 * Genérica sobre la forma del efecto **a propósito**: los endpoints emiten
 * `EfectoDeSalida` y el cron de vencimientos emite los de la máquina de estados,
 * que no llevan `holdId` porque lo lleva el registro que los envuelve. Forzar una
 * forma en la otra habría sido contorsionar tipos para nada; lo que comparten es
 * lo único que importa aquí: `tipo`, y de dónde sacar el destinatario.
 */
export async function resolverEfectos<T extends { readonly tipo: string }>(
  clientId: string,
  tx: Tx,
  cliente: ContextoDeCliente,
  efectos: readonly T[],
  /** Lo que el efecto no trae consigo. El cron sí sabe de qué hueco habla. */
  contexto: {
    holdId?: string | undefined;
    escaladoId?: string | undefined;
    /** Fuera de la franja: el aviso a recepción espera, y el texto lo dice. */
    avisoDiferido?: boolean;
  } = {},
): Promise<Array<T & { destinatarios: Destinatario[]; texto: string }>> {
  const salida: Array<T & { destinatarios: Destinatario[]; texto: string }> = [];

  for (const efecto of efectos) {
    /**
     * **Al paciente, resuelto igual que a la clínica.** El cron no tiene a quién
     * contestar —nadie le ha escrito—, así que el efecto tiene que llevar el
     * teléfono y el texto. El teléfono va a n8n, que es quien envía; nunca al
     * prompt (regla 2).
     */
    if (efecto.tipo === 'mensaje_al_paciente') {
      const conPlantilla = efecto as T & { plantilla?: PlantillaPaciente };
      const holdId = contexto.holdId;
      const fila = holdId === undefined ? undefined : await q.buscarHueco(clientId, tx, holdId);
      const paciente = fila === undefined ? undefined : await q.buscarPaciente(clientId, tx, fila.patientId);
      const texto =
        fila === undefined || conPlantilla.plantilla === undefined
          ? null
          : textoParaElPaciente(cliente, conPlantilla.plantilla, {
              servicio: fila.serviceCode,
              hueco: fila.slotStart,
              avisoDiferido: contexto.avisoDiferido ?? false,
            });
      salida.push(
        texto === null || paciente === undefined || fila === undefined
          ? { ...efecto, destinatarios: [], texto: '' }
          : {
              ...efecto,
              destinatarios: [{ nombre: paciente.givenName, canal: 'whatsapp', destino: paciente.phoneE164 }],
              texto,
              // Por si hay que mandarlo con plantilla (fuera de las 24 h): los
              // datos de sus variables, ya compuestos. Nada más que el nombre de pila.
              variables: {
                nombre: paciente.givenName,
                servicio: cliente.config.servicios.find((s) => s.codigo === fila.serviceCode)?.nombre ?? fila.serviceCode,
                cuando: momento(fila.slotStart, cliente.config.zonaHoraria),
                clinica: cliente.config.nombre,
              },
            },
      );
      continue;
    }

    if (!HACIA_LA_CLINICA.has(efecto.tipo)) {
      salida.push({ ...efecto, destinatarios: [], texto: '' });
      continue;
    }

    if (efecto.tipo === 'escalar_a_humano') {
      const conDatos = efecto as T & { escaladoId?: string; severidad?: number; motivo?: string };
      const escaladoId = conDatos.escaladoId ?? contexto.escaladoId;
      /**
       * El paciente se busca por el escalado, no se le pide al emisor: hay
       * escalados sin paciente —`latido_perdido` lo emite un cron— y exigirlo
       * obligaría a inventárselo.
       */
      const escalado =
        escaladoId === undefined || escaladoId === ''
          ? undefined
          : await q.buscarEscalado(clientId, tx, escaladoId);
      const paciente =
        escalado?.patientId == null
          ? undefined
          : await q.buscarPaciente(clientId, tx, escalado.patientId);

      const motivo = conDatos.motivo ?? 'peticion_paciente';
      const severidad = conDatos.severidad ?? 2;

      /**
       * Los de infraestructura van al operador, por correo y desde la tabla de
       * salida: se encolan aquí, dentro de la transacción, y los envía el
       * ejecutor después del commit. Sin datos del paciente: el operador no los
       * necesita para saber qué se ha roto.
       */
      if (MOTIVOS_DEL_OPERADOR.has(motivo) && escaladoId !== undefined && escaladoId !== '') {
        await q.encolarSalida(clientId, tx, {
          kind: 'correo_operador',
          dedupeKey: `escalado:${escaladoId}`,
          payload: {
            asunto: `[Motor de Citas] ${nombreDelMotivo(motivo)} · ${cliente.config.nombre}`,
            cuerpo: [
              `Clínica: ${cliente.config.nombre} (${cliente.slug})`,
              `Motivo: ${nombreDelMotivo(motivo)}`,
              ...(escalado?.detail == null || escalado.detail === '' ? [] : [`Detalle: ${escalado.detail}`]),
              `Escalado: ${escaladoId}`,
              `Hora: ${(escalado?.createdAt ?? new Date()).toISOString()}`,
            ].join('\n'),
          },
          ahora: escalado?.createdAt ?? new Date(),
        });
      }
      salida.push({
        ...efecto,
        destinatarios: destinatariosDeEscalado(cliente.config, motivo, severidad),
        texto: componerAviso({
          plantilla: cliente.config.avisos.escalado,
          config: cliente.config,
          paciente,
          motivo,
          detalle: escalado?.detail ?? null,
          severidad,
        }),
      });
      continue;
    }

    // Los avisos de cita. Van todos a recepción y todos llevan la hora.
    const conHold = efecto as T & { holdId?: string };
    const holdId = conHold.holdId ?? contexto.holdId;
    const datos =
      holdId === undefined
        ? { paciente: undefined, servicio: '', hueco: undefined }
        : await datosDelHueco(clientId, tx, cliente, holdId);

    const plantilla =
      efecto.tipo === 'informar_a_recepcion'
        ? cliente.config.avisos.citaYaEnAgenda
        : cliente.config.avisos.citaNueva;

    salida.push({
      ...efecto,
      destinatarios: destinatariosDeRecepcion(cliente.config),
      texto: componerAviso({
        plantilla,
        config: cliente.config,
        paciente: datos.paciente,
        servicio: datos.servicio,
        hueco: datos.hueco,
      }),
    });
  }

  return salida;
}
