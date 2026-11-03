import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { instanteDe, partesLocales } from '../core/disponibilidad.js';
import { DomainError } from '../core/errors.js';
import type { Tx } from '../db/client.js';
import * as q from '../db/queries.js';
import type { CanalDelPaciente } from '../db/schema.js';
import { marcarEscaladoAtendido, registrarResultadoDeCita } from '../service/appointments.js';
import { accionRecepcion } from '../service/reception.js';
import { encolarParaElPaciente, HORAS_DE_VENTANA, type Dependencias } from '../service/pipeline.js';

/**
 * Lo que lee y hace el panel del operador.
 *
 * **El operador ve todas las clínicas, pero ninguna consulta cruza clínicas**:
 * cada lectura se hace dentro de `withClient` de su clínica, con RLS, y se
 * juntan después. Una consulta del panel sin contexto falla igual que
 * cualquier otra (regla 1).
 */

export class PanelError extends DomainError {
  readonly code = 'panel';
  readonly httpStatus = 409;
}

export interface Clinica {
  readonly clientId: string;
  readonly slug: string;
  readonly nombre: string;
  readonly zonaHoraria: string;
  /** Código → nombre, para enseñar «Limpieza facial profunda» y no «limpieza-facial». */
  readonly servicios: Readonly<Record<string, string>>;
}

/**
 * El id de cada clínica, recordado un minuto. Cada petición del panel lo
 * preguntaba a la base, y con la base en otro país eso era un viaje más por
 * petición —un tercio de lo que tarda—. Un minuto es lo que tarda en notarse
 * en el panel que una clínica se ha dado de baja; los webhooks no usan esto y
 * siguen preguntando siempre.
 */
const MS_DE_RECUERDO = 60_000;
const idsRecordados = new WeakMap<Dependencias['core'], Map<string, { id: string | undefined; hasta: number }>>();

async function idDeClinica(deps: Dependencias, slug: string): Promise<string | undefined> {
  let recordados = idsRecordados.get(deps.core);
  if (recordados === undefined) {
    recordados = new Map();
    idsRecordados.set(deps.core, recordados);
  }
  const ahora = Date.now();
  const recordado = recordados.get(slug);
  if (recordado !== undefined && recordado.hasta > ahora) return recordado.id;
  const id = await deps.core.idDeClinicaPorSlug(slug);
  recordados.set(slug, { id, hasta: ahora + MS_DE_RECUERDO });
  return id;
}

export async function clinicas(deps: Dependencias): Promise<Clinica[]> {
  const salida: Clinica[] = [];
  const slugs = deps.configuracion.slugs();
  const ids = await Promise.all(slugs.map((slug) => idDeClinica(deps, slug)));
  for (const [i, slug] of slugs.entries()) {
    const clientId = ids[i];
    if (clientId === undefined) continue;
    const { config } = deps.configuracion.obtener(slug);
    salida.push({
      clientId,
      slug,
      nombre: config.nombre,
      zonaHoraria: config.zonaHoraria,
      servicios: Object.fromEntries(config.servicios.map((sv) => [sv.codigo, sv.nombre])),
    });
  }
  return salida;
}

async function clinica(deps: Dependencias, clientId: string): Promise<Clinica> {
  const c = (await clinicas(deps)).find((x) => x.clientId === clientId);
  if (c === undefined) throw new PanelError('Esa clínica no existe.');
  return c;
}

function filas<T>(resultado: unknown): T[] {
  return [...(resultado as Iterable<T>)];
}

/** Los chats, los que se movieron hace menos primero. */
export async function listarConversaciones(deps: Dependencias) {
  const todas = [];
  for (const c of await clinicas(deps)) {
    const resultado = await deps.core.withClient(c.clientId, (tx) =>
      tx.execute(sql`
        select c.id, c.status, p.id as patient_id, p.given_name, p.family_name, p.phone_e164,
               p.agent_stopped_at, c.reply_channel,
               m.body as ultimo, m.direction as ultimo_sentido, m.created_at as ultimo_en,
               (select count(*)::int from motor.escalations e
                 where e.client_id = c.client_id and e.conversation_id = c.id and e.state = 'abierta') as escalados
          from motor.conversations c
          join motor.patients p on p.id = c.patient_id and p.client_id = c.client_id
          left join lateral (
            select body, direction, created_at from motor.messages
             where client_id = c.client_id and conversation_id = c.id
             order by created_at desc, direction desc limit 1
          ) m on true
         where c.client_id = ${c.clientId}
         order by m.created_at desc nulls last
         limit 200
      `),
    );
    for (const f of filas<Record<string, unknown>>(resultado)) {
      todas.push({
        clientId: c.clientId,
        clinica: c.nombre,
        zonaHoraria: c.zonaHoraria,
        id: String(f['id']),
        estado: String(f['status']),
        pacienteId: String(f['patient_id']),
        nombre: [f['given_name'], f['family_name']].filter((x) => typeof x === 'string' && x !== '').join(' '),
        telefono: String(f['phone_e164']),
        agenteParado: f['agent_stopped_at'] !== null,
        puedeResponder: f['reply_channel'] !== null,
        ultimo: typeof f['ultimo'] === 'string' ? f['ultimo'].slice(0, 140) : null,
        ultimoSentido: f['ultimo_sentido'] ?? null,
        ultimoEn: f['ultimo_en'] ?? null,
        escalados: Number(f['escalados'] ?? 0),
        // Escribió y nadie le ha contestado todavía (agente parado, o algo falló).
        esperando: f['ultimo_sentido'] === 'entrante',
      });
    }
  }
  return todas.sort((a, b) => String(b.ultimoEn ?? '').localeCompare(String(a.ultimoEn ?? '')));
}

/** Un chat entero: sus mensajes, sus citas vivas y sus escalados abiertos. */
export async function verConversacion(deps: Dependencias, clientId: string, conversationId: string) {
  const c = await clinica(deps, clientId);
  return deps.core.withClient(clientId, async (tx) => {
    const [conv] = filas<Record<string, unknown>>(
      await tx.execute(sql`
        select c.id, c.status, c.reply_channel, p.id as patient_id, p.given_name, p.family_name, p.phone_e164, p.agent_stopped_at,
               p.last_visit_at, p.created_at as paciente_desde
          from motor.conversations c join motor.patients p on p.id = c.patient_id and p.client_id = c.client_id
         where c.client_id = ${clientId} and c.id = ${conversationId}
      `),
    );
    if (conv === undefined) throw new PanelError('Esa conversación no existe.');
    const pacienteId = String(conv['patient_id']);

    const mensajes = filas<Record<string, unknown>>(
      await tx.execute(sql`
        select id, direction, body, created_at, model, sent_by, firewall_category, is_clinical, redacted_at, disproved_at, disproved_note
          from motor.messages
         where client_id = ${clientId} and conversation_id = ${conversationId}
         -- Un turno guarda el mensaje del paciente y la respuesta con la misma
         -- hora: a igualdad, primero lo que entra (el enum va en ese orden).
         order by created_at asc, direction asc
         limit 500
      `),
    ).map((m) => ({
      id: String(m['id']),
      sentido: String(m['direction']),
      texto: m['redacted_at'] !== null ? null : (m['body'] ?? null),
      en: m['created_at'],
      autor:
        m['direction'] === 'entrante'
          ? 'paciente'
          : m['sent_by'] === 'panel'
            ? 'persona'
            : m['sent_by'] === 'equipo'
              ? 'equipo'
            : m['model'] !== null
              ? 'agente'
              : 'sistema',
      corte: m['firewall_category'] ?? null,
      clinico: m['is_clinical'] === true,
      redactado: m['redacted_at'] !== null,
      desmentido: m['disproved_at'] === null ? null : (m['disproved_note'] ?? 'desmentido'),
    }));

    const citas = await citasDe(tx, c, deps.reloj(), sql`and h.patient_id = ${pacienteId}`);
    const escalados = await escaladosDe(tx, c, sql`and e.conversation_id = ${conversationId}`);
    const porConfirmar = await asistenciaDe(tx, c, deps.reloj(), sql`and a.patient_id = ${pacienteId}`);
    const ultimoDelPaciente = await q.ultimoMensajeDelPaciente(clientId, tx, conversationId);
    const ventanaCierra =
      ultimoDelPaciente === null ? null : new Date(ultimoDelPaciente.getTime() + HORAS_DE_VENTANA * 3_600_000);

    return {
      clientId,
      clinica: c.nombre,
      zonaHoraria: c.zonaHoraria,
      id: conversationId,
      estado: String(conv['status']),
      pacienteId,
      nombre: [conv['given_name'], conv['family_name']].filter((x) => typeof x === 'string' && x !== '').join(' '),
      telefono: String(conv['phone_e164']),
      agenteParado: conv['agent_stopped_at'] !== null,
      puedeResponder: conv['reply_channel'] !== null,
      ultimaVisita: conv['last_visit_at'] ?? null,
      pacienteDesde: conv['paciente_desde'] ?? null,
      mensajes,
      citas,
      escalados,
      porConfirmar,
      /** Hasta cuándo se le puede escribir texto libre (WhatsApp, 24 h desde su último mensaje). */
      ventanaCierra,
      ventanaAbierta: ventanaCierra !== null && ventanaCierra.getTime() > deps.reloj().getTime(),
    };
  });
}

/** Lo que bloquea un hueco y no ha pasado: retenidas, pendientes y confirmadas. */
async function citasDe(tx: Tx, c: Clinica, ahora: Date, filtro: ReturnType<typeof sql>) {
  return filas<Record<string, unknown>>(
    await tx.execute(sql`
      select h.id, h.state, h.slot_start, h.slot_end, h.service_code, h.conversation_id, p.given_name, p.family_name, p.phone_e164
        from motor.holds h join motor.patients p on p.id = h.patient_id and p.client_id = h.client_id
       where h.client_id = ${c.clientId}
         and h.state in ('retenida', 'pendiente_recepcion', 'confirmada')
         and h.slot_end > ${ahora.toISOString()}
         ${filtro}
       order by h.slot_start
       limit 300
    `),
  ).map((h) => ({
    clientId: c.clientId,
    clinica: c.nombre,
    zonaHoraria: c.zonaHoraria,
    id: String(h['id']),
    estado: String(h['state']),
    inicio: h['slot_start'],
    fin: h['slot_end'],
    servicio: c.servicios[String(h['service_code'])] ?? String(h['service_code']),
    conversacionId: String(h['conversation_id']),
    nombre: [h['given_name'], h['family_name']].filter((x) => typeof x === 'string' && x !== '').join(' '),
    telefono: String(h['phone_e164']),
  }));
}

async function escaladosDe(tx: Tx, c: Clinica, filtro: ReturnType<typeof sql>) {
  return filas<Record<string, unknown>>(
    await tx.execute(sql`
      select e.id, e.reason, e.severity, e.created_at, e.detail, e.conversation_id, p.given_name, p.family_name
        from motor.escalations e left join motor.patients p on p.id = e.patient_id and p.client_id = e.client_id
       where e.client_id = ${c.clientId} and e.state = 'abierta'
         ${filtro}
       order by e.severity desc, e.created_at asc
       limit 300
    `),
  ).map((e) => ({
    clientId: c.clientId,
    clinica: c.nombre,
    zonaHoraria: c.zonaHoraria,
    id: String(e['id']),
    motivo: String(e['reason']),
    severidad: Number(e['severity']),
    en: e['created_at'],
    detalle: e['detail'] ?? null,
    conversacionId: e['conversation_id'] === null ? null : String(e['conversation_id']),
    nombre: [e['given_name'], e['family_name']].filter((x) => typeof x === 'string' && x !== '').join(' '),
  }));
}

/** Citas que ya pasaron y esperan «Asistió» / «No vino». */
async function asistenciaDe(tx: Tx, c: Clinica, ahora: Date, filtro: ReturnType<typeof sql>) {
  return filas<Record<string, unknown>>(
    await tx.execute(sql`
      select a.id, a.slot_start, a.service_code, a.conversation_id, a.attendance_requested_at,
             p.given_name, p.family_name, p.phone_e164
        from motor.appointments a join motor.patients p on p.id = a.patient_id and p.client_id = a.client_id
       where a.client_id = ${c.clientId}
         and a.outcome = 'pendiente'
         and a.slot_end <= ${ahora.toISOString()}
         ${filtro}
       order by a.slot_start
       limit 500
    `),
  ).map((a) => ({
    clientId: c.clientId,
    clinica: c.nombre,
    zonaHoraria: c.zonaHoraria,
    id: String(a['id']),
    inicio: a['slot_start'],
    servicio: c.servicios[String(a['service_code'])] ?? String(a['service_code']),
    conversacionId: String(a['conversation_id']),
    pedidaEn: a['attendance_requested_at'] ?? null,
    nombre: [a['given_name'], a['family_name']].filter((x) => typeof x === 'string' && x !== '').join(' '),
    telefono: String(a['phone_e164']),
  }));
}

export async function listarAsistencia(deps: Dependencias) {
  const todas = [];
  for (const c of await clinicas(deps)) {
    todas.push(...(await deps.core.withClient(c.clientId, (tx) => asistenciaDe(tx, c, deps.reloj(), sql``))));
  }
  return todas.sort((a, b) => String(a.inicio).localeCompare(String(b.inicio)));
}

/** «Asistió» / «No vino», desde el panel. La misma función que usa la presunción. */
export async function anotarAsistencia(
  deps: Dependencias,
  datos: { clientId: string; citaId: string; resultado: 'asistida' | 'no_asistida' },
) {
  await clinica(deps, datos.clientId);
  return registrarResultadoDeCita(deps, { clientId: datos.clientId, citaId: datos.citaId, outcome: datos.resultado, fuente: 'recepcion' });
}

const DIAS_LUNES_PRIMERO = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'] as const;
const ETIQUETA_DIA: Readonly<Record<string, string>> = {
  lunes: 'lun', martes: 'mar', miercoles: 'mié', jueves: 'jue', viernes: 'vie', sabado: 'sáb', domingo: 'dom',
};

/**
 * **La semana del calendario, en hora de la clínica.** El servidor coloca cada
 * cita en su día y su minuto locales: el navegador del operador puede estar en
 * otra zona (Texas) y no tiene que convertir nada, que es justo donde se lía una
 * hora. `semana` es 0 para la actual, −1 la anterior, +1 la siguiente.
 *
 * Lo que se ve: lo que bloquea un hueco (retenida, pendiente, confirmada) y las
 * citas ya pasadas con su asistencia. No se ven propuestas (no son citas), ni
 * caducadas, ni canceladas.
 */
export async function semanaDelCalendario(deps: Dependencias, semana: number) {
  const ahora = deps.reloj();
  const resultado = [];
  for (const c of await clinicas(deps)) {
    const { config } = deps.configuracion.obtener(c.slug);
    const hoy = partesLocales(ahora, c.zonaHoraria);
    const desdeLunes = DIAS_LUNES_PRIMERO.indexOf(hoy.dia as (typeof DIAS_LUNES_PRIMERO)[number]);
    const dias = Array.from({ length: 7 }, (_, i) => {
      const fecha = new Date(Date.UTC(hoy.anio, hoy.mes - 1, hoy.diaMes - desdeLunes + i + semana * 7));
      const [anio, mes, dia] = [fecha.getUTCFullYear(), fecha.getUTCMonth() + 1, fecha.getUTCDate()];
      const nombre = DIAS_LUNES_PRIMERO[i] ?? 'lunes';
      return {
        fecha: `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`,
        etiqueta: `${ETIQUETA_DIA[nombre] ?? nombre} ${dia}`,
        esHoy: anio === hoy.anio && mes === hoy.mes && dia === hoy.diaMes,
        inicio: instanteDe(anio, mes, dia, 0, 0, c.zonaHoraria),
        fin: instanteDe(anio, mes, dia + 1, 0, 0, c.zonaHoraria),
        abierto: config.horario.filter((h) => h.dia === nombre).map((h) => ({ abre: h.abre, cierra: h.cierra })),
      };
    });
    const desde = dias[0]?.inicio ?? ahora;
    const hasta = dias[6]?.fin ?? ahora;

    const filasDeCitas = await deps.core.withClient(c.clientId, async (tx) =>
      filas<Record<string, unknown>>(
        await tx.execute(sql`
          select h.id, h.state, h.slot_start, h.slot_end, h.service_code, h.conversation_id,
                 a.outcome, p.given_name, p.family_name
            from motor.holds h
            join motor.patients p on p.id = h.patient_id and p.client_id = h.client_id
            left join motor.appointments a on a.hold_id = h.id and a.client_id = h.client_id
           where h.client_id = ${c.clientId}
             and h.slot_start >= ${desde.toISOString()} and h.slot_start < ${hasta.toISOString()}
             and (h.state in ('retenida', 'pendiente_recepcion', 'confirmada')
                  or (h.state = 'liberada' and a.outcome in ('asistida', 'no_asistida', 'pendiente')))
           order by h.slot_start
        `),
      ),
    );

    const citas = filasDeCitas.flatMap((h) => {
      const inicio = new Date(String(h['slot_start'] instanceof Date ? (h['slot_start'] as Date).toISOString() : h['slot_start']));
      const fin = new Date(String(h['slot_end'] instanceof Date ? (h['slot_end'] as Date).toISOString() : h['slot_end']));
      const dia = dias.findIndex((d) => inicio >= d.inicio && inicio < d.fin);
      const delDia = dias[dia];
      if (delDia === undefined) return [];
      return [
        {
          id: String(h['id']),
          dia,
          inicioMin: Math.round((inicio.getTime() - delDia.inicio.getTime()) / 60_000),
          finMin: Math.round((fin.getTime() - delDia.inicio.getTime()) / 60_000),
          inicio,
          servicio: c.servicios[String(h['service_code'])] ?? String(h['service_code']),
          nombre: [h['given_name'], h['family_name']].filter((x) => typeof x === 'string' && x !== '').join(' '),
          estado: h['outcome'] === 'asistida' || h['outcome'] === 'no_asistida' ? String(h['outcome']) : String(h['state']),
          conversacionId: String(h['conversation_id']),
        },
      ];
    });

    resultado.push({
      clientId: c.clientId,
      clinica: c.nombre,
      zonaHoraria: c.zonaHoraria,
      dias: dias.map(({ fecha, etiqueta, esHoy, abierto }) => ({ fecha, etiqueta, esHoy, abierto })),
      citas,
    });
  }
  return { semana, clinicas: resultado };
}

export async function listarCitas(deps: Dependencias) {
  const todas = [];
  for (const c of await clinicas(deps)) {
    todas.push(...(await deps.core.withClient(c.clientId, (tx) => citasDe(tx, c, deps.reloj(), sql``))));
  }
  return todas.sort((a, b) => String(a.inicio).localeCompare(String(b.inicio)));
}

export async function listarEscalados(deps: Dependencias) {
  const todos = [];
  for (const c of await clinicas(deps)) {
    todos.push(...(await deps.core.withClient(c.clientId, (tx) => escaladosDe(tx, c, sql``))));
  }
  return todos;
}

/**
 * Contestar desde el panel. Se registra como mensaje de una persona (regla 6)
 * —entra en la ventana del modelo, así que al reactivar el agente sabe lo que
 * se dijo— y sale por el canal de la conversación, por la tabla de salida.
 */
export async function responder(
  deps: Dependencias,
  datos: { clientId: string; conversationId: string; texto: string; operador: string },
): Promise<{ mensajeId: string }> {
  const c = await clinica(deps, datos.clientId);
  const texto = datos.texto.trim();
  if (texto === '') throw new PanelError('El mensaje está vacío.');
  const ahora = deps.reloj();
  return deps.core.withClient(datos.clientId, async (tx) => {
    const canal = await q.canalDeLaConversacion(datos.clientId, tx, datos.conversationId);
    if (canal === null) {
      throw new PanelError('Esta conversación no ha entrado nunca por Chatwoot: no hay por dónde contestarle.');
    }
    // Pasadas las 24 h desde su último mensaje, WhatsApp no entrega texto libre:
    // se dice aquí, en vez de dejar que Chatwoot lo acepte y Meta lo tire.
    const ultimo = await q.ultimoMensajeDelPaciente(datos.clientId, tx, datos.conversationId);
    if (ultimo === null || ahora.getTime() - ultimo.getTime() >= HORAS_DE_VENTANA * 3_600_000) {
      throw new PanelError(
        'Han pasado más de 24 h desde el último mensaje del paciente: WhatsApp no le entregaría un texto libre. Hasta que vuelva a escribir, sólo se le pueden mandar plantillas aprobadas.',
      );
    }
    const mensajeId = await q.guardarMensaje(datos.clientId, tx, {
      conversationId: datos.conversationId,
      direction: 'saliente',
      body: texto,
      isClinical: false,
      sentBy: 'panel',
      createdAt: ahora,
    });
    await encolarParaElPaciente(datos.clientId, tx, {
      clave: `panel:${mensajeId}`,
      canal,
      clinica: c.nombre,
      respuesta: texto,
      efectos: [],
      ahora,
    });
    await q.anotarAuditoria(datos.clientId, tx, {
      entity: 'messages',
      entityId: mensajeId,
      action: 'mensaje_del_panel',
      actor: 'operador',
      // Sin el texto: la auditoría vive 12 meses y el mensaje tiene su propia retención.
      payload: { por: datos.operador },
    });
    return { mensajeId };
  });
}

/**
 * El interruptor, desde el panel. Lo que manda es la base; la etiqueta de
 * Chatwoot se mueve para que diga lo mismo —si no, el siguiente mensaje que
 * entrara con la etiqueta vieja deshacería el botón—.
 */
export async function cambiarAgente(
  deps: Dependencias,
  datos: { clientId: string; pacienteId: string; parado: boolean; operador: string },
): Promise<{ cambiado: boolean }> {
  const c = await clinica(deps, datos.clientId);
  const ahora = deps.reloj();
  return deps.core.withClient(datos.clientId, async (tx) => {
    const cambiado = await q.cambiarInterruptorDelAgente(datos.clientId, tx, {
      patientId: datos.pacienteId,
      parado: datos.parado,
      por: `panel:${datos.operador}`,
      ahora,
    });
    if (!cambiado) return { cambiado };
    await q.anotarAuditoria(datos.clientId, tx, {
      entity: 'patients',
      entityId: datos.pacienteId,
      action: datos.parado ? 'agente_parado' : 'agente_reactivado',
      actor: 'operador',
      payload: { por: `panel:${datos.operador}` },
    });

    const etiqueta = deps.configuracion.obtener(c.slug).config.canal.chatwoot?.etiquetaAgenteParado ?? 'agente-parado';
    const canales = filas<{ reply_channel: CanalDelPaciente | null }>(
      await tx.execute(sql`
        select distinct reply_channel from motor.conversations
         where client_id = ${datos.clientId} and patient_id = ${datos.pacienteId} and reply_channel is not null
      `),
    );
    for (const { reply_channel: canal } of canales) {
      if (canal?.por !== 'chatwoot') continue;
      await q.encolarSalida(datos.clientId, tx, {
        kind: 'chatwoot',
        dedupeKey: `etiqueta:${randomUUID()}`,
        payload: { cuentaId: canal.cuentaId, conversacionId: canal.conversacionId, etiqueta, poner: datos.parado },
        ahora,
      });
    }
    return { cambiado };
  });
}

/**
 * **«Ya la he metido en agenda», desde el panel.** Lo mismo que hacía el botón
 * del aviso de n8n: relee la agenda (paso 6) y confirma, o detecta la colisión,
 * o dice que el aviso ya no valía. Lo que haya que decirle al paciente se encola
 * en la misma transacción, por el canal de su conversación.
 */
export async function meterEnAgenda(
  deps: Dependencias,
  datos: { clientId: string; holdId: string; operador: string },
): Promise<{ estado: string; mensaje: string | null }> {
  const c = await clinica(deps, datos.clientId);
  const { config } = deps.configuracion.obtener(c.slug);
  const { cuerpo } = await accionRecepcion(
    deps,
    { idempotencyKey: `panel:${datos.holdId}:${randomUUID()}`, clientId: datos.clientId, holdId: datos.holdId },
    async (tx, salida) => {
      const hueco = await q.buscarHueco(datos.clientId, tx, datos.holdId);
      if (hueco === undefined) return;
      const canal = await q.canalDeLaConversacion(datos.clientId, tx, hueco.conversationId);
      if (canal !== null) {
        await encolarParaElPaciente(datos.clientId, tx, {
          clave: `recepcion:${datos.holdId}:${salida.estado}`,
          canal,
          conversationId: hueco.conversationId,
          clinica: config.nombre,
          plantillas: config.plantillas,
          respuesta: salida.respuesta,
          efectos: salida.efectos,
          ahora: deps.reloj(),
        });
      }
      await q.anotarAuditoria(datos.clientId, tx, {
        entity: 'holds',
        entityId: datos.holdId,
        action: `metida_desde_el_panel:${salida.estado}`,
        actor: 'operador',
        payload: { por: datos.operador },
      });
    },
  );
  const mensajes: Record<string, string> = {
    confirmada: 'Confirmada. El paciente recibe su confirmación.',
    colisionada: 'Ese hueco ya estaba ocupado en la agenda: se le ofrece otra hora al paciente.',
  };
  return { estado: cuerpo.estado, mensaje: cuerpo.mensajeParaRecepcion ?? mensajes[cuerpo.estado] ?? null };
}

/**
 * Las cifras de la página de inicio, en hora de cada clínica: lo de hoy, lo que
 * necesita a alguien, y lo que se ha generado en el mes.
 */
export async function resumen(deps: Dependencias) {
  const ahora = deps.reloj();
  const salida = [];
  for (const c of await clinicas(deps)) {
    const hoy = partesLocales(ahora, c.zonaHoraria);
    const inicioHoy = instanteDe(hoy.anio, hoy.mes, hoy.diaMes, 0, 0, c.zonaHoraria);
    const finHoy = instanteDe(hoy.anio, hoy.mes, hoy.diaMes + 1, 0, 0, c.zonaHoraria);
    const inicioMes = instanteDe(hoy.anio, hoy.mes, 1, 0, 0, c.zonaHoraria);
    const enSieteDias = new Date(ahora.getTime() + 7 * 86_400_000);
    const datos = await deps.core.withClient(c.clientId, async (tx) => {
      const [cifras] = filas<Record<string, unknown>>(
        await tx.execute(sql`
          select
            (select count(*)::int from motor.holds where client_id = ${c.clientId}
               and state in ('retenida', 'pendiente_recepcion', 'confirmada')
               and slot_start > ${ahora.toISOString()} and slot_start <= ${enSieteDias.toISOString()}) as semana,
            (select count(*)::int from motor.holds where client_id = ${c.clientId}
               and state = 'pendiente_recepcion' and slot_end > ${ahora.toISOString()}) as pendientes_recepcion,
            (select count(distinct conversation_id)::int from motor.messages where client_id = ${c.clientId}
               and created_at >= ${inicioHoy.toISOString()}) as chats_hoy,
            (select count(*)::int from motor.escalations where client_id = ${c.clientId} and state = 'abierta') as escalados,
            (select count(*)::int from motor.appointments where client_id = ${c.clientId}
               and outcome = 'pendiente' and slot_end <= ${ahora.toISOString()}) as asistencia,
            (select count(*)::int from motor.appointments where client_id = ${c.clientId}
               and outcome = 'asistida' and slot_start >= ${inicioMes.toISOString()} and slot_start < ${finHoy.toISOString()}) as asistidas_mes,
            (select count(*)::int from motor.appointments where client_id = ${c.clientId}
               and slot_start >= ${inicioMes.toISOString()} and confirmed_at >= ${inicioMes.toISOString()}) as citas_mes
        `),
      );
      const deHoy = filas<Record<string, unknown>>(
        await tx.execute(sql`
          select h.id, h.state, h.slot_start, h.slot_end, h.service_code, h.conversation_id, a.outcome, p.given_name, p.family_name
            from motor.holds h
            join motor.patients p on p.id = h.patient_id and p.client_id = h.client_id
            left join motor.appointments a on a.hold_id = h.id and a.client_id = h.client_id
           where h.client_id = ${c.clientId}
             and h.slot_start >= ${inicioHoy.toISOString()} and h.slot_start < ${finHoy.toISOString()}
             and (h.state in ('retenida', 'pendiente_recepcion', 'confirmada')
                  or (h.state = 'liberada' and a.outcome in ('asistida', 'no_asistida')))
           order by h.slot_start
        `),
      ).map((h) => ({
        id: String(h['id']),
        inicio: h['slot_start'],
        fin: h['slot_end'],
        servicio: c.servicios[String(h['service_code'])] ?? String(h['service_code']),
        nombre: [h['given_name'], h['family_name']].filter((x) => typeof x === 'string' && x !== '').join(' '),
        estado: h['outcome'] === 'asistida' || h['outcome'] === 'no_asistida' ? String(h['outcome']) : String(h['state']),
        conversacionId: String(h['conversation_id']),
      }));
      return { cifras: cifras ?? {}, deHoy };
    });
    salida.push({ clientId: c.clientId, clinica: c.nombre, zonaHoraria: c.zonaHoraria, ...datos });
  }
  return salida;
}

export async function atenderEscalado(
  deps: Dependencias,
  datos: { clientId: string; escaladoId: string; operador: string },
) {
  await clinica(deps, datos.clientId);
  return marcarEscaladoAtendido(deps, {
    idempotencyKey: `panel:${datos.escaladoId}:${randomUUID()}`,
    clientId: datos.clientId,
    escaladoId: datos.escaladoId,
    atendidoPor: datos.operador,
  });
}
