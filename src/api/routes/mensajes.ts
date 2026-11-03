import { z } from 'zod';

import { generarInforme } from '../../service/informe.js';
import { consolidarPeriodo } from '../../service/consolidacion.js';
import { marcarEscaladoAtendido, reactivarComunicaciones } from '../../service/appointments.js';
import { vigilarDerechos } from '../../service/vigilancia.js';
import { ejecutarOleada } from '../../service/oleadas.js';
import { accionRecepcion } from '../../service/reception.js';
import { eventoDeAgenda } from '../../service/agenda-evento.js';
import { caducarRetenciones } from '../../service/vencimientos.js';
import { verificarCitas } from '../../service/verificacion.js';
import { procesarMensajeEntrante, type Dependencias } from '../../service/pipeline.js';
import { DomainError } from '../../core/errors.js';
import type { App } from '../server.js';

/**
 * El borde HTTP. Recibe de n8n datos ya normalizados y devuelve qué hacer; los
 * efectos los ejecuta n8n. El núcleo no habla con el exterior.
 *
 * Zod en entrada y salida: nada entra ni sale sin esquema.
 */

/**
 * A quién va un aviso. **Lo resuelve el núcleo desde el YAML, no n8n.**
 *
 * Si el efecto no lo llevara, n8n necesitaría su propia tabla de contactos: la
 * misma configuración en dos sitios, uno sin tests. El día que alguien cambie el
 * número de recepción en uno y no en el otro, los avisos se irían a un móvil que
 * ya no mira nadie y **no fallaría nada** — simplemente dejarían de llegar.
 */
const destinatarioSchema = z.object({
  nombre: z.string(),
  canal: z.enum(['whatsapp', 'email', 'telefono']),
  destino: z.string(),
});

/** Lo que se le añade a TODO efecto: a quién va y qué dice. */
const resuelto = {
  destinatarios: z.array(destinatarioSchema),
  /** Ya compuesto, del YAML de la clínica. n8n envía; no redacta. */
  texto: z.string(),
};

const efectoSchema = z.discriminatedUnion('tipo', [
  z.object({ tipo: z.literal('avisar_a_recepcion'), holdId: z.uuid(), ...resuelto }),
  z.object({
    tipo: z.literal('escalar_a_humano'),
    /** A quién va: severidad 2 son cosas que van a personas distintas. */
    motivo: z.string(),
    escaladoId: z.uuid(),
    severidad: z.number().int(),
    ...resuelto,
  }),
  z.object({ tipo: z.literal('registrar_baja'), ...resuelto }),
  z.object({ tipo: z.literal('proponer_alternativa'), ...resuelto }),
  z.object({
    tipo: z.literal('avisar_a_recepcion_de_anulacion'),
    holdId: z.uuid(),
    sustituidoPorHoldId: z.uuid().nullable(),
    ...resuelto,
  }),
  z.object({
    tipo: z.literal('encolar_relleno_de_cancelacion'),
    horasDeAntelacion: z.number(),
    ...resuelto,
  }),
  /**
   * Modo `automatica`. Lleva el evento ya compuesto: n8n no tiene que saber del
   * catálogo ni del formato del título, sólo escribirlo y volver a llamar.
   */
  z.object({
    tipo: z.literal('crear_evento_agenda'),
    holdId: z.uuid(),
    calendarioId: z.string().min(1),
    idempotencyKey: z.string().min(1).max(200),
    inicio: z.iso.datetime(),
    fin: z.iso.datetime(),
    resumen: z.string().min(1),
    descripcion: z.string(),
    ...resuelto,
  }),
  z.object({ tipo: z.literal('informar_a_recepcion'), holdId: z.uuid(), ...resuelto }),
]);

/**
 * Tipos de mensaje que puede mandar un paciente.
 *
 * Los que no son texto **también entran**: hasta ahora n8n los descartaba y el
 * paciente se quedaba sin respuesta creyendo que su nota de voz había llegado.
 * Es la regla 4 vista desde fuera. Entran para que queden registrados en
 * `messages` como todo lo demás y para que la respuesta salga del núcleo, no de
 * un nodo de n8n que nadie versiona.
 */
export const TIPOS_DE_MENSAJE = [
  'texto',
  'audio',
  'imagen',
  'documento',
  'ubicacion',
  'otro',
] as const;

export const mensajeEntranteSchema = z
  .object({
    idempotencyKey: z.string().min(1).max(200),
    clientId: z.uuid(),
    /** El teléfono entra aquí y se queda en la base de datos. Nunca va al prompt. */
    telefono: z.string().regex(/^\+[1-9]\d{6,14}$/, 'debe ser un E.164 válido'),
    nombre: z.string().min(1).max(100),
    /**
     * 4096 es el límite del propio canal. Estaba en 4000 y eso rechazaba
     * mensajes que WhatsApp sí entrega: poner un tope más bajo que el del canal
     * es inventarse un fallo.
     */
    texto: z.string().max(4096).optional(),
    tipo: z.enum(TIPOS_DE_MENSAJE).default('texto'),
    proveedorMensajeId: z.string().max(200).optional(),
    servicio: z.string().max(100).optional(),
  })
  // `strict`: un campo que sobra es un 400, no un descarte en silencio. Si n8n
  // manda `telefno` por una errata, hay que enterarse en la primera prueba y no
  // el día que alguien se pregunte por qué no llega nada.
  .strict()
  .superRefine((valor, ctx) => {
    // Un mensaje de texto sin texto no es un mensaje: es un error de quien lo
    // manda. Los demás tipos no lo llevan, y exigírselo obligaría a n8n a
    // inventarse un contenido que acabaría en la base de datos.
    if (valor.tipo === 'texto' && (valor.texto === undefined || valor.texto.length === 0)) {
      ctx.addIssue({
        code: 'custom',
        path: ['texto'],
        message: 'obligatorio cuando el tipo es texto',
      });
    }
  });

export const mensajeEntranteRespuestaSchema = z.object({
  conversacionId: z.uuid(),
  estadoConversacion: z.enum(['abierta', 'pausada', 'cerrada']),
  /** `null` = no se envía nada al paciente. */
  respuesta: z.string().nullable(),
  corte: z
    .object({
      categoria: z.enum([
      'urgencia_clinica',
      'contenido_clinico',
      'baja',
      'minoria_de_edad',
      'derechos_rgpd',
    ]),
      patrones: z.array(z.string()),
    })
    .nullable(),
  efectos: z.array(efectoSchema),
  holdId: z.uuid().optional(),
});

export const accionRecepcionSchema = z.object({
  idempotencyKey: z.string().min(1).max(200),
  clientId: z.uuid(),
  holdId: z.uuid(),
  /**
   * El botón dice «Ya la he metido en agenda», no «Confirmar». Recepción
   * declara un hecho consumado; no autoriza nada.
   */
  accion: z.literal('ya_esta_en_agenda'),
});

/**
 * Lo que n8n cuenta después de intentar escribir el evento. **Modo `automatica`.**
 *
 * `creado: false` **exige** `motivo`, y no por gusto: `ocupado` significa que el
 * hueco estaba cogido —colisión de verdad, se pasa a la segunda opción— mientras
 * que `rechazado` y `error` significan que no sabemos si el evento existe, y
 * entonces no se le toca nada al paciente y lo mira una persona. Dejar que n8n
 * omita el motivo sería dejar que el núcleo adivine cuál de las dos cosas pasó.
 */
export const eventoDeAgendaSchema = z
  .object({
    idempotencyKey: z.string().min(1).max(200),
    clientId: z.uuid(),
    holdId: z.uuid(),
    creado: z.boolean(),
    /** Identificador del evento en el proveedor. Sólo cuando `creado`. */
    eventoId: z.string().max(1024).optional(),
    motivo: z.enum(['ocupado', 'rechazado', 'error']).optional(),
  })
  .strict()
  .superRefine((valor, ctx) => {
    if (!valor.creado && valor.motivo === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['motivo'],
        message:
          'Si el evento no se creó, hace falta el motivo: «ocupado» pasa a la segunda ' +
          'opción, «rechazado» y «error» dejan la cita como está y avisan a una persona.',
      });
    }
  });

export const eventoDeAgendaRespuestaSchema = z.object({
  holdId: z.uuid(),
  estado: z.enum(['confirmada', 'colisionada', 'pendiente_recepcion']),
  citaId: z.uuid().nullable(),
  /** `null` mientras no haya nada cierto que contarle al paciente. */
  respuesta: z.string().nullable(),
  mensajeParaRecepcion: z.string().nullable(),
  efectos: z.array(efectoSchema),
  alternativaHoldId: z.uuid().optional(),
});

export const accionRecepcionRespuestaSchema = z.object({
  holdId: z.uuid(),
  /** `agenda_no_disponible`: no se pudo releer; no se ha tocado nada y hay que volver a pulsar. */
  estado: z.enum(['confirmada', 'colisionada', 'anulada', 'agenda_no_disponible']),
  citaId: z.uuid().nullable(),
  // `null` cuando el aviso estaba anulado: no se le repite nada al paciente.
  respuesta: z.string().nullable(),
  /** Qué tiene que hacer recepción: cuando el aviso ya no valía, o cuando hay que volver a pulsar. */
  mensajeParaRecepcion: z.string().nullable(),
  efectos: z.array(efectoSchema),
  alternativaHoldId: z.uuid().optional(),
});

/** No hay clínica para ese remitente. 404, y nunca una por defecto. */
export class ClienteDesconocidoError extends DomainError {
  readonly code = 'cliente_desconocido';
  readonly httpStatus = 404;
}

export const clientePorRemitenteRespuestaSchema = z.object({
  clientId: z.uuid(),
  slug: z.string(),
});

export const escaladoAtendidoSchema = z.object({
  idempotencyKey: z.string().min(1).max(200),
  clientId: z.uuid(),
  escaladoId: z.uuid(),
  /** Quién lo ha atendido. Obligatorio: ante una reclamación, es lo que se pregunta. */
  atendidoPor: z.string().trim().min(1).max(120),
});

export const escaladoAtendidoRespuestaSchema = z.object({
  escaladoId: z.uuid(),
  estado: z.enum(['atendida', 'ya_estaba_atendida']),
  conversacionId: z.uuid().nullable(),
  estadoConversacion: z.enum(['abierta', 'pausada', 'cerrada']).nullable(),
  sigueParadaPor: z.array(z.string()),
});

export const clinicasRespuestaSchema = z.object({
  /** Las que tienen YAML cargado Y alta activa en la base: a éstas llaman los crons. */
  clinicas: z.array(z.object({ clientId: z.uuid(), slug: z.string() })),
  /**
   * Con YAML y sin alta activa. No reciben crons, y tiene que verse: es un fallo
   * de implantación, no algo que se resuelva solo.
   */
  sinAlta: z.array(z.string()),
});

export function registrarRutasDeMensajes(deps: Dependencias) {
  return async function rutas(app: App): Promise<void> {
    /**
     * `GET /cliente-por-remitente/:remitenteId` — de la línea de WhatsApp al
     * `clientId`.
     *
     * n8n recibe de Meta el `phone_number_id` y necesita el UUID. Sin esto el
     * mapeo vivía a mano en n8n y se desincronizaba en cuanto alguien cambiaba
     * una línea, **con un fallo silencioso**: mensajes yendo a la clínica que no
     * es, o no yendo a ninguna.
     *
     * **404 si no hay clínica con ese remitente, nunca una por defecto.** Elegir
     * «la primera» ante un remitente desconocido mandaría la conversación de un
     * paciente a otra clínica, que es la regla 1 rota por la puerta de entrada.
     */
    app.get(
      '/cliente-por-remitente/:remitenteId',
      {
        schema: {
          params: z.object({ remitenteId: z.string().min(1).max(100) }),
          response: { 200: clientePorRemitenteRespuestaSchema },
        },
      },
      async (peticion) => {
        const slug = deps.configuracion.porRemitente(peticion.params.remitenteId);
        if (slug === undefined) {
          throw new ClienteDesconocidoError(
            `Ninguna clínica configurada tiene el remitente ${peticion.params.remitenteId}.`,
          );
        }

        const clientId = await deps.core.idDeClinicaPorSlug(slug);
        if (clientId === undefined) {
          // El YAML existe pero la clínica no está dada de alta o está inactiva.
          // Es un fallo de implantación y tiene que verse, no resolverse solo.
          throw new ClienteDesconocidoError(
            `La clínica «${slug}» tiene configuración pero no está activa en la base de datos.`,
          );
        }

        return { clientId, slug };
      },
    );

    /**
     * `POST /escalado-atendido` — una persona de la clínica ha atendido un
     * escalado. Es la única forma de que una conversación parada por una
     * urgencia, una queja o una baja vuelva a tener agente.
     */
    app.post(
      '/escalado-atendido',
      { schema: { body: escaladoAtendidoSchema, response: { 200: escaladoAtendidoRespuestaSchema } } },
      async (request) => marcarEscaladoAtendido(deps, request.body),
    );

    /**
     * `GET /clinicas` — a qué clínicas tienen que llamar los crons.
     *
     * Cada cron de n8n llevaba la lista de clientIds escrita en un nodo, que es
     * el mismo parche que el mapa de «Resolver clinica1»: dar de alta una
     * clínica exigía tocar cuatro workflows (regla 7), y olvidarse de uno dejaba
     * a esa clínica sin vencimientos sin que fallara nada. La lista sale de aquí:
     * lo que está cargado y dado de alta, y nada más.
     */
    app.get(
      '/clinicas',
      { schema: { response: { 200: clinicasRespuestaSchema } } },
      async () => {
        const clinicas: Array<{ clientId: string; slug: string }> = [];
        const sinAlta: string[] = [];
        for (const slug of deps.configuracion.slugs()) {
          const clientId = await deps.core.idDeClinicaPorSlug(slug);
          if (clientId === undefined) sinAlta.push(slug);
          else clinicas.push({ clientId, slug });
        }
        return { clinicas, sinAlta };
      },
    );

    app.post(
      '/mensaje-entrante',
      {
        schema: {
          body: mensajeEntranteSchema,
          response: { 200: mensajeEntranteRespuestaSchema },
        },
      },
      async (request) => {
        const { cuerpo } = await procesarMensajeEntrante(deps, request.body);
        return cuerpo;
      },
    );

    app.post(
      '/accion-recepcion',
      {
        schema: {
          body: accionRecepcionSchema,
          response: { 200: accionRecepcionRespuestaSchema },
        },
      },
      async (request) => {
        const { cuerpo } = await accionRecepcion(deps, request.body);
        return cuerpo;
      },
    );

    app.post(
      '/evento-de-agenda',
      {
        schema: {
          body: eventoDeAgendaSchema,
          response: { 200: eventoDeAgendaRespuestaSchema },
        },
      },
      async (request) => {
        const { cuerpo } = await eventoDeAgenda(deps, request.body);
        return cuerpo;
      },
    );
  };
}

// --- Los cuatro endpoints de mantenimiento -----------------------------------

export const caducarSchema = z.object({
  idempotencyKey: z.string().min(1).max(200),
  clientId: z.uuid(),
  limite: z.number().int().positive().max(500).optional(),
});

export const caducarRespuestaSchema = z.object({
  aplicados: z.array(
    z.object({
      holdId: z.uuid(),
      desde: z.string(),
      hasta: z.string(),
      efectos: z.array(z.object({ tipo: z.string() }).loose()),
    }),
  ),
  restantes: z.number().int(),
  diferidoPorHorario: z.boolean(),
});

export const verificarRespuestaSchema = z.object({
  verificados: z.array(
    z.object({
      holdId: z.uuid(),
      slotStart: z.iso.datetime(),
      estado: z.enum(['ok', 'colisionada']),
    }),
  ),
  colisiones: z.number().int(),
  /** El escalado de cada cita confirmada que aparece libre, ya resuelto. */
  efectos: z.array(efectoSchema),
});

export const oleadaSchema = z.object({
  idempotencyKey: z.string().min(1).max(200),
  clientId: z.uuid(),
  waveId: z.uuid(),
  limite: z.number().int().positive().max(500).optional(),
});

export const oleadaRespuestaSchema = z.object({
  waveId: z.uuid(),
  destinatarios: z.array(
    z.object({
      recipientId: z.uuid(),
      patientId: z.uuid(),
      telefono: z.string(),
      nombre: z.string(),
      texto: z.string(),
    }),
  ),
  suprimidos: z.number().int(),
  restantes: z.number().int(),
  diferidoPorHorario: z.boolean(),
});

export const informeRespuestaSchema = z.object({
  clientId: z.uuid(),
  desde: z.string(),
  hasta: z.string(),
  citasGeneradas: z.number().int(),
  citasConfirmadas: z.number().int(),
  noShows: z.number().int(),
  cancelaciones: z.number().int(),
  conversaciones: z.number().int(),
  mensajesEntrantes: z.number().int(),
  huecosPropuestos: z.number().int(),
  colisiones: z.number().int(),
  escalados: z.array(z.object({ motivo: z.string(), total: z.number().int() })),
  cortesPorCategoria: z.array(
    z.object({ categoria: z.string(), total: z.number().int(), porDia: z.number() }),
  ),
  dias: z.number().int(),
  /** Solicitudes de derechos abiertas y días de plazo que quedan. */
  derechosAbiertos: z.array(
    z.object({ derecho: z.string(), estado: z.string(), diasRestantes: z.number().int() }),
  ),
  /** Crons que llevan sin llamar. Vacío es lo normal; con contenido, algo está muerto. */
  latidosPerdidos: z.array(
    z.object({ job: z.string(), minutosSinLlamar: z.number().int().nullable() }),
  ),
});

const consolidarSchema = z.object({
  clientId: z.uuid(),
  /** Mes natural. Si falta, se consolida el anterior al de hoy. */
  periodo: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
});

const consolidarRespuestaSchema = z.object({
  clientId: z.uuid(),
  periodo: z.string(),
  citasGeneradas: z.number().int(),
  huecosPropuestos: z.number().int(),
  conversaciones: z.number().int(),
  noShows: z.number().int(),
});

const reactivarSchema = z.object({
  clientId: z.uuid(),
  patientId: z.uuid(),
  /**
   * Sólo `true`. No es un adorno: el esquema hace imposible mandar esta petición
   * sin afirmar que lo pidió el paciente, y deja constancia de dónde consta.
   */
  loPidioElPaciente: z.literal(true),
  constancia: z.string().min(3).max(180),
});

const vigilarRespuestaSchema = z.object({
  clientId: z.uuid(),
  avisadas: z.array(
    z.object({
      solicitudId: z.uuid(),
      derecho: z.string(),
      diasRestantes: z.number().int(),
      umbral: z.number().int(),
    }),
  ),
  efectos: z.array(efectoSchema),
});

export function registrarRutasDeMantenimiento(deps: Dependencias) {
  return async function rutas(app: App): Promise<void> {
    app.post(
      '/caducar-retenciones',
      { schema: { body: caducarSchema, response: { 200: caducarRespuestaSchema } } },
      async (request) =>
        caducarRetenciones(deps, {
          clientId: request.body.clientId,
          ...(request.body.limite === undefined ? {} : { limite: request.body.limite }),
        }),
    );

    app.post(
      '/verificar-citas',
      {
        schema: {
          body: caducarSchema,
          response: { 200: verificarRespuestaSchema },
        },
      },
      async (request) =>
        verificarCitas(deps, {
          clientId: request.body.clientId,
          ...(request.body.limite === undefined ? {} : { limite: request.body.limite }),
        }),
    );

    app.post(
      '/oleada/ejecutar',
      { schema: { body: oleadaSchema, response: { 200: oleadaRespuestaSchema } } },
      async (request) =>
        ejecutarOleada(deps, {
          idempotencyKey: request.body.idempotencyKey,
          clientId: request.body.clientId,
          waveId: request.body.waveId,
          ...(request.body.limite === undefined ? {} : { limite: request.body.limite }),
        }),
    );

    /**
     * Cron mensual, el día 1. Consolidar primero, purgar después: la purga de
     * los 24 meses sólo borra el detalle de periodos ya consolidados, así que
     * si esto no corre, no se borra nada. Es idempotente, se puede repetir.
     */
    app.post(
      '/consolidar-periodo',
      { schema: { body: consolidarSchema, response: { 200: consolidarRespuestaSchema } } },
      async (request) =>
        consolidarPeriodo(deps, {
          clientId: request.body.clientId,
          ...(request.body.periodo === undefined ? {} : { periodo: request.body.periodo }),
        }),
    );

    /**
     * El paciente ha pedido volver a recibir comunicaciones. Es lo ÚNICO que
     * levanta una baja: pedir cita no la revoca, y recepción no puede hacerlo
     * por su cuenta.
     */
    app.post(
      '/reactivar-comunicaciones',
      {
        schema: {
          body: reactivarSchema,
          response: { 200: z.object({ reactivado: z.boolean() }) },
        },
      },
      async (request) =>
        reactivarComunicaciones(deps, {
          clientId: request.body.clientId,
          patientId: request.body.patientId,
          loPidioElPaciente: request.body.loPidioElPaciente,
          constancia: request.body.constancia,
        }),
    );

    /**
     * Cron diario. Avisa de las solicitudes de derechos que se acercan al plazo
     * legal **antes de que venza**, no cuando ya ha vencido.
     */
    app.post(
      '/vigilar-derechos',
      {
        schema: {
          body: z.object({ clientId: z.uuid() }),
          response: { 200: vigilarRespuestaSchema },
        },
      },
      async (request) => vigilarDerechos(deps, { clientId: request.body.clientId }),
    );

    app.get(
      '/informe/:clientId',
      {
        schema: {
          params: z.object({ clientId: z.uuid() }),
          querystring: z.object({ desde: z.iso.date(), hasta: z.iso.date() }),
          response: { 200: informeRespuestaSchema },
        },
      },
      async (request) =>
        generarInforme(deps, {
          clientId: request.params.clientId,
          desde: request.query.desde,
          hasta: request.query.hasta,
        }),
    );
  };
}
