import { z } from 'zod';

/**
 * Configuración por clínica. Regla 7: la diferencia entre clientes es esto y
 * nada más — si dar de alta una clínica exige tocar un `.ts`, el diseño ha
 * fallado.
 *
 * ## Qué es obligatorio y qué tiene valor por defecto
 *
 * Mismo criterio que en el cortafuegos: **lo que sea peligroso ausente, va
 * obligatorio; lo que sea cosmético, por defecto.** Un valor por defecto es una
 * suposición silenciosa, y las suposiciones silenciosas sobre precios, horarios
 * o a quién avisar son las que hacen daño.
 *
 * Obligatorio, sin excepción:
 * - `servicios` con su precio. Inventar un precio por defecto es impensable.
 * - `zona_horaria`. Parece cosmético y no lo es: una clínica en Canarias con la
 *   zona de la península tendría TODAS sus citas desplazadas una hora.
 * - `horario`. De él sale el «fin de jornada», que es un vencimiento real.
 * - `escalado.contactos`. Sin a quién avisar, la regla 4 no se puede cumplir:
 *   habría rutas que mueren sin que las vea nadie.
 * - `canal`. Sin él no se puede enviar nada.
 *
 * Por defecto en código:
 * - Vencimientos: son los de docs/DESIGN_RULES.md y casi ninguna clínica los tocará.
 * - Textos de corte: hay respaldo en código para que nunca haya silencio.
 * - Tono, parámetros de reactivación, ventana del cortafuegos.
 *
 * ## Todo objeto es estricto: una clave que sobra impide arrancar
 *
 * Mismo criterio que en el borde HTTP, y por el mismo motivo. Un campo de más se
 * descartaba en silencio, así que una errata —`remitenteld` por `remitenteId`,
 * `retenidoDiferido` mal escrito— dejaba el valor bueno sin poner y **no decía
 * nada**: el sistema arrancaba tan contento con el valor por defecto, o sin
 * clínica que resolviera un remitente, y el fallo aparecía como un 404 sin pista
 * o como un texto que nadie había escrito.
 *
 * Que no arranque es lo correcto y es barato: se ve en el primer despliegue, con
 * el fichero y la clave en el mensaje. Lo caro es lo otro — enterarse por un
 * paciente.
 *
 * Se aplica a **todos** los objetos, no sólo a la raíz: una errata en
 * `vencimientos.propuestaMinuots` es exactamente igual de silenciosa.
 */

const horaSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'debe ser HH:MM en 24 h');

const diaSchema = z.enum([
  'lunes',
  'martes',
  'miercoles',
  'jueves',
  'viernes',
  'sabado',
  'domingo',
]);

export const servicioSchema = z.strictObject({
  codigo: z.string().min(1).max(60),
  nombre: z.string().min(1).max(120),
  /** En euros. Se compara literalmente contra lo que salga en el mensaje. */
  precio: z.number().nonnegative().multipleOf(0.01),
  duracionMinutos: z.number().int().positive(),
  /** Bonos: el precio del paquete completo, no el de la sesión. */
  esBono: z.boolean().default(false),
  sesiones: z.number().int().positive().default(1),
  /**
   * Cómo lo llaman los pacientes cuando no es como lo llama el catálogo.
   *
   * Medido contra el modelo real: «¿tenéis higienes faciales?» salía sin
   * servicio 5 de 5 veces con «Limpieza facial profunda» en el catálogo, y
   * «algo reafirmante para el cuerpo» lo mismo con «Radiofrecuencia corporal».
   * Sin servicio no se propone nada y se le vuelve a preguntar lo que ya dijo.
   * Es de cada clínica —cada una llama a sus cosas a su manera— así que va en
   * el YAML (regla 7). Opcional: el nombre ya funciona solo en el caso normal.
   */
  alias: z.array(z.string().min(1).max(60)).max(20).default([]),
  /**
   * Cómo venir preparado a este tratamiento, con el texto que apruebe la
   * clínica. **Se dice tal cual, sin modelo**: roza lo clínico, y el modelo, sin
   * esto, se inventaba «la zona tiene que venir rasurada, sin cera las semanas
   * previas». Si falta, se remite a recepción; nunca se improvisa.
   */
  preparacion: z.string().min(1).max(600).optional(),
});

/**
 * Lo que un paciente pregunta de la clínica y no es el catálogo ni el horario.
 *
 * **Se compone sin modelo**, como el horario: cada respuesta es el texto de la
 * clínica, tal cual. Sin esta sección el modelo inventaba —«aparcamiento propio
 * no tenemos», «diría que sí» a pagar con tarjeta, una «primera visita de
 * valoración» que no existía— y nada de eso lo puede comprobar la validación.
 *
 * Todo opcional: un campo que falta se contesta remitiendo a recepción, que es
 * verdad. Rellenarlo es parte de la implantación de cada clínica.
 */
export const informacionSchema = z.strictObject({
  direccion: z.string().min(1).max(400).optional(),
  aparcamiento: z.string().min(1).max(400).optional(),
  formasDePago: z.string().min(1).max(400).optional(),
  cancelacion: z.string().min(1).max(400).optional(),
  primeraVisita: z.string().min(1).max(400).optional(),
});

export type Servicio = z.infer<typeof servicioSchema>;

/**
 * Para qué se usa cada plantilla. Los cuatro últimos son avisos que ya manda el
 * sistema (la máquina de estados); los tres primeros, los que llegan.
 */
export const USOS_DE_PLANTILLA = [
  'recordatorio',
  'resena',
  'reactivacion',
  'propuesta_caducada',
  'retencion_caducada',
  'sin_respuesta_de_recepcion',
  'hueco_retenido',
] as const;
export type UsoDePlantilla = (typeof USOS_DE_PLANTILLA)[number];

/** Lo que se puede poner en una variable. Cerrado: nada identificativo más allá del nombre de pila. */
export const VARIABLES_DE_PLANTILLA = ['nombre', 'servicio', 'cuando', 'clinica', 'enlace_resena'] as const;
export type VariableDePlantilla = (typeof VARIABLES_DE_PLANTILLA)[number];

export const clienteConfigSchema = z.strictObject({
  // --- Obligatorio: peligroso si falta ---------------------------------------
  slug: z.string().min(1).max(60).regex(/^[a-z0-9-]+$/),
  nombre: z.string().min(1).max(200),
  /** Una zona horaria equivocada desplaza todas las citas. Sin valor por defecto. */
  zonaHoraria: z.string().refine((tz) => {
    try {
      new Intl.DateTimeFormat('es-ES', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'zona horaria IANA no reconocida'),

  canal: z.strictObject({
    tipo: z.literal('whatsapp'),
    /** Identificador de la línea en el proveedor. Sin esto no se envía nada. */
    remitenteId: z.string().min(1),
    /**
     * Si la línea está en Chatwoot (coexistencia): la cuenta y el inbox. Por
     * aquí se resuelve la clínica de lo que llega a `/chatwoot`, igual que
     * `remitenteId` resuelve lo que llega de Meta. Sin esto, la clínica no
     * recibe nada por Chatwoot.
     */
    chatwoot: z
      .strictObject({
        cuentaId: z.number().int().positive(),
        inboxId: z.number().int().positive(),
        /**
         * La etiqueta que para el agente en una conversación. Puesta, el agente
         * se calla hasta que se quite. Es el interruptor mientras no haya
         * interfaz propia.
         */
        etiquetaAgenteParado: z.string().min(1).default('agente-parado'),
        /**
         * Para las pruebas en un número real: si está, el agente sólo atiende a
         * estos teléfonos (E.164). Lo demás sigue entrando en Chatwoot como
         * siempre, pero el núcleo no lo ve: ni lo guarda ni contesta. Sin esto,
         * encender el agente en el WhatsApp de la clínica le contesta a todos
         * sus contactos desde el primer minuto.
         */
        soloTelefonos: z.array(z.string().regex(/^\+\d{8,15}$/, 'teléfono en E.164, con +')).min(1).optional(),
      })
      .optional(),
  }),

  horario: z
    .array(
      z.strictObject({
        dia: diaSchema,
        abre: horaSchema,
        cierra: horaSchema,
      }),
    )
    .min(1, 'hace falta al menos un día de horario: de aquí sale el fin de jornada'),

  servicios: z.array(servicioSchema).min(1, 'el catálogo no puede estar vacío'),

  informacion: informacionSchema.prefault({}),

  escalado: z.strictObject({
    /**
     * A quién le llegan los avisos de cita: «mete esto en la agenda».
     *
     * **Obligatorio**, y aparte de `contactos` a propósito. Sin esto el efecto
     * `avisar_a_recepcion` no tiene a quién ir, y una cita se queda en
     * `pendiente_recepcion` para siempre porque nadie se entera — que es
     * exactamente el silencio que la regla 4 prohíbe.
     *
     * No se reutilizan los contactos de escalado aunque en una clínica pequeña
     * sean la misma persona: son dos trabajos distintos. A recepción se le dice
     * «mete esta cita»; al contacto de escalado se le dice «esto necesita a una
     * persona». Darlo por supuesto sería la suposición silenciosa de siempre.
     */
    recepcion: z
      .array(
        z.strictObject({
          nombre: z.string().min(1),
          canal: z.enum(['whatsapp', 'email', 'telefono']),
          destino: z.string().min(1),
        }),
      )
      .min(1, 'sin recepción, las citas se quedan pendientes y nadie se entera'),

    contactos: z
      .array(
        z.strictObject({
          nombre: z.string().min(1),
          canal: z.enum(['whatsapp', 'email', 'telefono']),
          destino: z.string().min(1),
          /** Severidad mínima que le llega. 3 = urgencia clínica. */
          severidadMinima: z.number().int().min(1).max(3).default(1),
        }),
      )
      .min(1, 'sin contactos de escalado habría rutas que mueren sin que las vea nadie'),

    /**
     * A quién van las solicitudes de derechos del RGPD. **Obligatorio.**
     *
     * No es recepción: la clínica designa a alguien para protección de datos, y
     * el contrato de encargo compromete el traslado en 48 h a esa persona. Si
     * esto tuviera valor por defecto —«que vaya a los de siempre»— sería una
     * suposición silenciosa sobre quién responde de una obligación legal con
     * plazo, y el día que fallara nadie se enteraría hasta la reclamación.
     */
    proteccionDeDatos: z
      .array(
        z.strictObject({
          nombre: z.string().min(1),
          canal: z.enum(['whatsapp', 'email', 'telefono']),
          destino: z.string().min(1),
        }),
      )
      .min(1, 'el contrato de encargo obliga a designar a alguien para protección de datos'),
  }),

  agenda: z.strictObject({
    /** Nivel A excluye las próximas 24 h de la disponibilidad. */
    nivel: z.enum(['A', 'B']),
    /**
     * El calendario de la clínica en el proveedor de agenda (en Google, el id
     * que acaba en `@group.calendar.google.com`). **Obligatorio.**
     *
     * Vivía en n8n, en un mapa `clientId → calendario` escrito a mano dentro de
     * dos nodos de código, y el modo automático iba a necesitar un tercero: dar
     * de alta una clínica exigía tocar un workflow (regla 7), y una errata en
     * uno de los tres sitios leía un calendario y escribía en otro. Ahora viaja
     * en cada petición de agenda y en cada `crear_evento_agenda`: n8n no decide
     * qué calendario es, lo recibe.
     */
    calendarioId: z.string().min(1),
    /**
     * Cómo se reparten las tres opciones que se ofrecen.
     *
     * `cercania` (por defecto): la primera respeta la preferencia; la 2ª y la 3ª
     * priorizan que sean pronto, aunque se aparten algo. Ante «martes a las 12»
     * evita ofrecer martes 18, martes 25 y martes 1 — tres veces la misma
     * opción, y ninguna esta semana.
     *
     * `fidelidad`: las tres respetan la preferencia. Para una clínica con agenda
     * muy rígida, donde apartarse de lo pedido sea ruido y no ayuda.
     */
    repartoDeHuecos: z.enum(['cercania', 'fidelidad']).default('cercania'),

    /**
     * Quién deja la cita metida en la agenda de la clínica.
     *
     * `recepcion` (por defecto): nadie escribe salvo una persona. El hueco espera
     * en `pendiente_recepcion` a que alguien pulse «ya la he metido».
     *
     * `automatica`: n8n crea el evento y el paciente recibe la confirmación en
     * el momento. **Sólo tiene sentido cuando la agenda operativa de la clínica
     * ES el calendario que leemos**: si la clínica trabaja sobre otro programa,
     * el evento que escribimos no lo ve nadie y la confirmación es falsa.
     *
     * Va por defecto en `recepcion` a propósito: el modo nuevo es opcional y
     * explícito, y el que no lo configure se queda en el que está probado.
     */
    confirmacion: z.enum(['recepcion', 'automatica']).default('recepcion'),

    /**
     * Qué se escribe en el evento, en modo `automatica`. Admiten `{servicio}`,
     * `{nombre}`, `{apellidos}`, `{nombreCompleto}`, `{telefono}` y `{ref}`.
     *
     * **Por defecto lleva nombre completo y teléfono**, y no es lo mismo que lo
     * que cruza hacia el modelo. El calendario es de la clínica, que es la
     * responsable del tratamiento y ya tiene a ese paciente en su ficha: un
     * evento que ponga «Limpieza facial — pac_8371» le quita utilidad a su propia
     * agenda, porque recepción no sabe a quién llamar si hay que mover la cita.
     *
     * Que sean marcadores y no un interruptor es lo que permite que cada clínica
     * decida: una recepción con la pantalla a la vista del público puede poner
     * sólo `{ref}` en el título y dejar el teléfono en la descripción, o quitarlo
     * del todo. Es su decisión, no nuestra (regla 7).
     */
    tituloDelEvento: z.string().min(1).default('{servicio} — {nombreCompleto}'),
    descripcionDelEvento: z
      .string()
      .min(1)
      .default('{nombreCompleto} · {telefono}\nCita pedida por WhatsApp. Paciente {ref}.'),
  }),

  /**
   * Los textos que van a la CLÍNICA, no al paciente.
   *
   * Van aquí y no en `textos` porque el criterio es distinto: los del paciente
   * son cara al público y no pueden decir «confirmada» antes de tiempo; éstos son
   * instrucciones para quien trabaja, y lo que tienen que hacer es decir **qué
   * hay que hacer**, no qué ha pasado. «Anulada» a secas obliga a investigar, y
   * lo que obliga a investigar con prisa se acaba ignorando.
   *
   * Van compuestos desde aquí y no desde n8n por lo mismo que el evento de la
   * agenda: un texto que vive en un nodo de n8n no lo versiona nadie y no se
   * puede probar.
   *
   * Marcadores: `{paciente}` `{telefono}` `{servicio}` `{hueco}` `{motivo}`
   * `{marca}`.
   */
  avisos: z
    .strictObject({
      /** `avisar_a_recepcion`: hay que meterla en la agenda y confirmarla. */
      citaNueva: z
        .string()
        .min(1)
        .default(
          'Cita nueva · {paciente} · {telefono}\n{servicio}, {hueco}.\n' +
            'Cuando la tengas en la agenda, confírmala.',
        ),
      /** `informar_a_recepcion`: ya está metida. No hay nada que hacer. */
      citaYaEnAgenda: z
        .string()
        .min(1)
        .default(
          'Cita nueva, ya metida en la agenda · {paciente} · {telefono}\n' +
            '{servicio}, {hueco}.\nNo hay que hacer nada.',
        ),
      /**
       * `escalar_a_humano`. `{marca}` se rellena con un aviso en mayúsculas
       * cuando la severidad es 3, y con nada cuando no lo es.
       */
      escalado: z
        .string()
        .min(1)
        .default('{marca}{motivo} · {paciente} · {telefono}\nMíralo en cuanto puedas.'),
    })
    .prefault({}),

  // --- Con valor por defecto: cosmético o con un valor sensato ---------------
  /**
   * Tono, y el estilo concreto que lo hace real.
   *
   * Antes era un enum de una palabra y el prompt le dedicaba una línea, así que
   * el agente escribía como un formulario: listas con guiones, un emoji en cada
   * mensaje, párrafos separados. Una recepcionista escribe por WhatsApp en una o
   * dos frases seguidas. El listón es ése, y por la regla 7 tiene que salir del
   * YAML, no del código.
   *
   * Se acepta la forma antigua (`tono: cercano`) para no romper los YAML que ya
   * existen: se normaliza a la nueva con los valores por defecto.
   */
  tono: z
    .union([
      z.enum(['cercano', 'neutro', 'formal']),
      z.strictObject({
        registro: z.enum(['cercano', 'neutro', 'formal']).default('cercano'),
        /** Frases por mensaje antes de sonar a folleto. Enumerar huecos no cuenta. */
        frasesMaximas: z.number().int().positive().max(6).default(2),
        /** Emojis por mensaje. Uno de vez en cuando, no en todos. */
        emojisMaximos: z.number().int().min(0).max(3).default(1),
        /** Listas con guiones o numeradas. Casi nunca en un WhatsApp. */
        permiteListas: z.boolean().default(false),
        /** Muletillas que no queremos encadenadas. */
        muletillasProhibidas: z
          .array(z.string().min(1))
          .default(['genial', 'perfecto', 'te comento', 'estupendo', 'fenomenal']),
      }),
    ])
    .default('cercano')
    .transform((valor) =>
      typeof valor === 'string'
        ? {
            registro: valor,
            frasesMaximas: 2,
            emojisMaximos: 1,
            permiteListas: false,
            muletillasProhibidas: ['genial', 'perfecto', 'te comento', 'estupendo', 'fenomenal'],
          }
        : valor,
    ),

  vencimientos: z
    .strictObject({
      propuestaMinutos: z.number().int().positive().default(360),
      retenidaMinutos: z.number().int().positive().default(30),
      recordatorioRecepcionMinutos: z.number().int().positive().default(120),
      escaladoRecepcionMinutos: z.number().int().positive().default(240),
      ventanaDeRellenoHoras: z.number().int().positive().default(72),
      /**
       * Cuánto se espera a que n8n diga si creó el evento, en modo `automatica`.
       *
       * Es el respaldo de «n8n no contesta nunca», no el reloj normal: el límite
       * que nota el paciente lo pone el nodo HTTP de n8n, que tiene que avisar de
       * su propio fallo. Esto es lo que impide que un hueco se quede retenido
       * para siempre si el workflow se muere entre medias.
       *
       * Corto a propósito: mientras corre, el paciente está en silencio.
       */
      agendaMinutos: z.number().int().positive().default(3),
    })
    .prefault({}),

  cortafuegos: z
    .strictObject({
      ventanaMensajes: z.number().int().positive().default(5),
      ventanaSegundos: z.number().int().positive().default(180),
      minutosEntreAvisosEnPausa: z.number().int().positive().default(30),
      /**
       * Patrones extra de esta clínica. Sólo pueden AÑADIR: no hay forma de
       * quitar ni sustituir uno del catálogo. El peor error de edición posible
       * es cortar de más.
       */
      patronesAdicionales: z
        .array(
          z.strictObject({
            id: z.string().min(1),
            categoria: z.enum([
              'urgencia_clinica',
              'contenido_clinico',
              'baja',
              'minoria_de_edad',
            ]),
            patron: z.string().min(1),
          }),
        )
        .default([]),
    })
    .prefault({}),

  /**
   * Cuándo y cuánto se puede escribir. Con valor por defecto porque el que hay
   * ya es seguro: nadie recibe mensajes de madrugada por olvidar ponerlo.
   */
  envios: z
    .strictObject({
      /** Franja en la que se puede escribir a un paciente, hora local de la clínica. */
      horaMinima: z
        .string()
        .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
        .default('09:00'),
      horaMaxima: z
        .string()
        .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
        .default('21:00'),
      /** Tope de vencimientos por llamada, para no soltar cien avisos de golpe. */
      loteDeVencimientos: z.number().int().positive().max(500).default(25),
      /** Tope de destinatarios por ejecución de oleada. */
      loteDeOleada: z.number().int().positive().max(500).default(50),
    })
    .prefault({}),

  textos: z
    .strictObject({
      urgencia: z.string().min(1).optional(),
      clinico: z.string().min(1).optional(),
      baja: z.string().min(1).optional(),
      menor: z.string().min(1).optional(),
      enPausa: z.string().min(1).optional(),
      retenido: z.string().min(1).optional(),
      retenidoDiferido: z.string().min(1).optional(),
      /**
       * Admiten `{nueva}` y `{anterior}`. Si la clínica escribe el suyo y se
       * deja un hueco fuera, el paciente vuelve a quedarse sin saber su hora:
       * por eso los de por defecto los llevan siempre.
       */
      derechosEnCurso: z.string().min(1).optional(),
      /** `{horario}` se sustituye por el horario compuesto desde `horario`. */
      horario: z.string().min(1).optional(),
      /** Cuando preguntan algo de la clínica que no está en `informacion`. */
      sinInformacion: z.string().min(1).optional(),
      /** Cuando preguntan cómo prepararse y no se sabe para qué tratamiento. */
      preparacionSinServicio: z.string().min(1).optional(),
      /** Respuesta a notas de voz, fotos, documentos y ubicaciones. */
      soloTexto: z.string().min(1).optional(),
      reagendado: z.string().min(1).optional(),
      reagendadoDiferido: z.string().min(1).optional(),
      /** Admiten `{hueco}`: la hora concreta, en zona de la clínica. */
      confirmada: z.string().min(1).optional(),
      colisionConAlternativa: z.string().min(1).optional(),
      colisionSinAlternativa: z.string().min(1).optional(),
      /**
       * Los dos que antes estaban escritos a mano en `pipeline.ts`. Que un texto
       * de cara al paciente sólo se pudiera cambiar tocando un `.ts` era la
       * regla 7 rota en el sitio donde peor suena: cuando algo ha fallado.
       */
      escalado: z.string().min(1).optional(),
      proveedorCaido: z.string().min(1).optional(),
      agendaNoDisponible: z.string().min(1).optional(),
      fueraDeServicio: z.string().min(1).optional(),
      /**
       * Los que le escribe el sistema sin que haya escrito él: propuestas que
       * vencen, una reserva que no llegó a quedar hecha, una cita que recepción
       * no confirmó en su jornada. Salen sólo dentro de la franja de contacto.
       */
      propuestaCaducada: z.string().min(1).optional(),
      retencionCaducada: z.string().min(1).optional(),
      sinRespuestaDeRecepcion: z.string().min(1).optional(),
      /** El recordatorio antes de la cita (dentro de las 24 h; fuera, la plantilla). Admite `{nombre}`. */
      recordatorio: z.string().min(1).optional(),
    })
    .prefault({})
    /**
     * **Una plantilla que anuncia una hora tiene que llevar su hueco.**
     *
     * El comentario de arriba ya avisaba de esto —«si la clínica escribe el suyo
     * y se deja un hueco fuera, el paciente vuelve a quedarse sin saber su
     * hora»— pero era un aviso, no una comprobación, y un aviso no impide nada.
     * Sin esto, una clínica que copiara el texto viejo al escribir el suyo
     * dejaría a sus pacientes sin la hora, en silencio y sólo en producción.
     *
     * Falla al cargar la configuración, que es cuando se puede arreglar.
     */
    .superRefine((textos, ctx) => {
      const EXIGIDOS: ReadonlyArray<[keyof typeof textos, readonly string[]]> = [
        ['retenido', ['{hueco}', '{servicio}']],
        ['retenidoDiferido', ['{hueco}', '{servicio}']],
        ['confirmada', ['{hueco}', '{servicio}']],
        ['colisionConAlternativa', ['{hueco}', '{servicio}']],
        ['reagendado', ['{nueva}', '{anterior}', '{servicio}']],
        ['reagendadoDiferido', ['{nueva}', '{anterior}', '{servicio}']],
        ['horario', ['{horario}']],
        // El paciente no ha escrito: sin el tratamiento no sabe de qué le hablan.
        ['propuestaCaducada', ['{servicio}']],
        ['retencionCaducada', ['{hueco}', '{servicio}']],
        ['sinRespuestaDeRecepcion', ['{hueco}', '{servicio}']],
        ['recordatorio', ['{hueco}', '{servicio}']],
      ];

      for (const [clave, marcas] of EXIGIDOS) {
        const texto = textos[clave];
        if (typeof texto !== 'string') continue;
        for (const marca of marcas) {
          if (texto.includes(marca)) continue;
          ctx.addIssue({
            code: 'custom',
            path: [clave],
            message:
              `«${clave}» anuncia una hora, así que tiene que llevar ${marca}. ` +
              'Sin eso el paciente lee que se le ha guardado algo y no cuál, o no de qué.',
          });
        }
      }
    }),

  reactivacion: z
    .strictObject({
      /** Se segmenta por antigüedad. Nunca por tratamiento: eso sería tratar datos de salud con fin comercial. */
      mesesSinVisitaMinimo: z.number().int().positive().default(6),
      mesesSinVisitaMaximo: z.number().int().positive().default(24),
      destinatariosPorOleada: z.number().int().positive().default(50),
    })
    .prefault({}),

  /**
   * Las plantillas de WhatsApp aprobadas por Meta, por uso. Pasadas 24 h desde
   * el último mensaje del paciente, WhatsApp sólo entrega plantillas: lo que el
   * sistema manda por su cuenta (recordatorios, reseñas, caducidades) sale con
   * la suya o no sale —y entonces se avisa al operador, nunca un texto que Meta
   * va a rechazar—. Dentro de las 24 h sale como texto normal.
   *
   * `variables` dice qué dato va en {{1}}, {{2}}…, en ese orden. El nombre y el
   * idioma, exactamente como en el WhatsApp Manager (`es`, `es_ES`…): si no
   * coinciden con una plantilla aprobada y sincronizada, Chatwoot no la envía.
   */
  /**
   * Recordatorios antes de la cita. **Sin esta sección, no se mandan**: escribir
   * a los pacientes de una clínica es decisión suya, no un valor por defecto.
   * Salen dentro de la franja de contacto; una cita pedida dentro del plazo (hoy
   * para mañana) no lo recibe, porque acaba de recibir su confirmación.
   */
  recordatorios: z
    .strictObject({
      horasAntes: z.number().int().min(2).max(72),
    })
    .optional(),

  plantillas: z
    .partialRecord(
      z.enum(USOS_DE_PLANTILLA),
      z.strictObject({
        nombre: z.string().regex(/^[a-z0-9_]+$/, 'el nombre de una plantilla de Meta: minúsculas, números y guiones bajos'),
        idioma: z.string().min(2),
        variables: z.array(z.enum(VARIABLES_DE_PLANTILLA)).max(10),
      }),
    )
    .default({}),
});

export type Plantillas = ClienteConfig['plantillas'];

export type ClienteConfig = z.infer<typeof clienteConfigSchema>;

/** Todos los precios del catálogo, para la validación de salida. */
export function preciosDelCatalogo(config: ClienteConfig): number[] {
  return config.servicios.map((s) => s.precio);
}
