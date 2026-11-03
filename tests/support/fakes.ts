import { AgendaNoDisponibleError } from '../../src/service/agenda-n8n.js';
import type { TurnoDeConversacion } from '../../src/agent/prompt.js';
import type { Extraccion, Intencion, Preferencia } from '../../src/agent/extraccion.js';
import type { Intervalo } from '../../src/core/disponibilidad.js';
import { clienteConfigSchema, type ClienteConfig } from '../../src/config/cliente.js';
import { RegistroDeConfiguracion } from '../../src/config/registry.js';
import type { Core } from '../../src/db/client.js';
import type { Dependencias } from '../../src/service/pipeline.js';
import type {
  LlamadaAlModelo,
  Agenda,
  Agente,
  Clasificacion,
  ClasificadorDeIntencion,
  ContextoDeAgente,
  Correccion,
  EstadoParaRedactar,
  FabricaDeAgente,
  HuecoDisponible,
  Redaccion,
  Redactor,
} from '../../src/service/ports.js';

/**
 * Implementaciones falsas y **deterministas** de las piezas no deterministas.
 *
 * Con esto el flujo de agendado se prueba entero —incluida la colisión del
 * paso 6— sin que la aleatoriedad de un modelo enturbie el resultado. El modelo
 * real entra en su sitio en la fase siguiente sin tocar nada más.
 */

/**
 * Clasificador por palabras clave. Nada de modelo, pero con la MISMA salida
 * cerrada que el real: intención, servicio del catálogo o null, preferencia y
 * señal de escalado.
 */
export class ClasificadorFalso implements ClasificadorDeIntencion {
  /** Extracciones guionadas, para probar rutas concretas sin depender del texto. */
  private readonly guion: Extraccion[];

  constructor(guion: readonly Extraccion[] = []) {
    this.guion = [...guion];
  }

  clasificar(entrada: { texto: string }): Promise<Clasificacion> {
    const guionada = this.guion.shift();
    if (guionada !== undefined) {
      return Promise.resolve({
        ...guionada,
        modelo: 'clasificador-falso',
        tokensEntrada: 10,
        tokensSalida: 4,
      });
    }

    const t = entrada.texto.toLowerCase();
    let intencion: Intencion = 'otro';
    let opcion: number | null = null;
    let servicio: string | null = null;

    if (/\bcita\b|\bagendar\b|\breservar\b|\bhueco/.test(t)) intencion = 'agendar';
    if (/\bprecio\b|\bcuanto\s+(cuesta|vale)\b/.test(t)) intencion = 'precio';
    if (/\bhorario\b|\babris\b/.test(t)) intencion = 'horario';

    // Servicio: sólo si se menciona uno y sólo uno del catálogo de pruebas.
    const mencionados = [
      /\baxilas?\b/.test(t) ? 'laser-axilas' : null,
      /\bpiernas?\b/.test(t) ? 'laser-piernas' : null,
      /\bbono\b/.test(t) ? 'bono5' : null,
    ].filter((x): x is string => x !== null);
    servicio = mencionados.length === 1 ? (mencionados[0] ?? null) : null;

    const eleccion = /\bopcion\s*([123])\b|\bla\s+([123])\b|\bprimera\b|\bsegunda\b|\btercera\b/.exec(t);
    if (eleccion !== null) {
      intencion = 'elegir_hueco';
      if (t.includes('primera')) opcion = 1;
      else if (t.includes('segunda')) opcion = 2;
      else if (t.includes('tercera')) opcion = 3;
      else opcion = Number(eleccion[1] ?? eleccion[2] ?? 1);
    }

    const preferencia: Preferencia | null = /\btarde\b|\bmanana\b|\bmañana\b/.test(t)
      ? {
          dias: [],
          diasExcluidos: [],
          franjas: /\btarde\b/.test(t) ? ['tarde'] : ['manana'],
          desde: null,
          horaExacta: null,
          cuantoAntes: false,
        }
      : null;

    const escalar = /\bhablar\s+con\s+(alguien|una\s+persona)\b/.test(t)
      ? ('pide_persona' as const)
      : /\bqueja\b|\bharta?\b|\bvergüenza\b/.test(t)
        ? ('queja' as const)
        : null;

    return Promise.resolve({
      intencion,
      servicio,
      opcion,
      preferencia,
      escalar,
      cita: null,
      sustitucion: null,
      tema: null,
      modelo: 'clasificador-falso',
      tokensEntrada: 10,
      tokensSalida: 4,
    });
  }
}

/**
 * Hora en la zona de la clínica. Un modelo real escribe «a las 11:00», no un
 * ISO en UTC — y la validación de salida compara contra la hora local, así que
 * el falso tiene que comportarse igual o estaría probando otra cosa.
 */
function horaLocal(fecha: Date, zonaHoraria = 'Europe/Madrid'): string {
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: zonaHoraria,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(fecha);
}

export class RedactorFalso implements Redactor {
  /** Textos que se devolverán en orden, para simular un modelo que se desmanda. */
  private readonly guion: string[];
  readonly correcciones: Correccion[] = [];
  /** El estado que recibió en cada llamada: lo que el sistema le dijo que había hecho. */
  readonly estados: Array<EstadoParaRedactar | undefined> = [];
  /** Los huecos que se le pusieron delante en cada llamada. */
  readonly huecosRecibidos: Array<readonly HuecoDisponible[]> = [];

  constructor(guion: readonly string[] = []) {
    this.guion = [...guion];
  }

  redactar(entrada: {
    intencion: Intencion;
    huecos?: readonly HuecoDisponible[];
    correccion?: Correccion | undefined;
    estado?: EstadoParaRedactar | undefined;
  }): Promise<Redaccion> {
    if (entrada.correccion !== undefined) this.correcciones.push(entrada.correccion);
    this.estados.push(entrada.estado);
    this.huecosRecibidos.push(entrada.huecos ?? []);

    const guionado = this.guion.shift();
    const huecos = entrada.huecos ?? [];
    const texto =
      guionado ??
      ((entrada.intencion === 'agendar' || entrada.intencion === 'reagendar') &&
      huecos.length > 0
        ? // Como el modelo de verdad: con huecos delante, dice de qué son.
          `Te propongo ${huecos.length} huecos de ${entrada.estado?.servicio ?? 'tu tratamiento'}: ${huecos
            .map((h, i) => `opcion ${i + 1} a las ${horaLocal(h.inicio)}`)
            .join(', ')}. ¿Cuál prefieres y cuál sería tu alternativa?`
        : `respuesta-falsa:${entrada.intencion}`);

    return Promise.resolve({
      texto,
      modelo: 'redactor-falso',
      tokensEntrada: 50,
      tokensSalida: 20,
    });
  }
}

/**
 * Agenda controlable desde el test. Devuelve **ocupación en bruto**, como la de
 * verdad: qué es proponible lo decide el núcleo (regla 3 y principio 2).
 */
export class AgendaFalsa implements Agenda {
  private readonly ocupados: Intervalo[] = [];

  /** `libres` se mantiene por compatibilidad con los tests que ya existían. */
  constructor(private readonly libres: readonly HuecoDisponible[] = []) {}

  /** Simula que alguien de la clínica ha metido una cita ahí por su cuenta. */
  ocupar(inicio: Date, fin?: Date): void {
    this.ocupados.push({ inicio, fin: fin ?? new Date(inicio.getTime() + 60 * 60_000) });
  }

  /**
   * Todo está libre salvo lo marcado. Los tests que quieran acotar la
   * disponibilidad lo hacen con `ocupar`, no devolviendo una lista de huecos:
   * es lo que hace la agenda real.
   */
  ocupacion(): Promise<readonly Intervalo[]> {
    if (this.caida !== null) return Promise.reject(this.caida);
    return Promise.resolve(this.ocupados);
  }

  private caida: Error | null = null;

  /** Simula que la agenda no responde (token caducado, Google caído, n8n parado). */
  fallar(error: Error = new AgendaNoDisponibleError('La agenda ha respondido 500.')): void {
    this.caida = error;
  }

  recuperar(): void {
    this.caida = null;
    this.caidaAlReleer = null;
  }

  private caidaAlReleer: Error | null = null;

  /** Que falle sólo la relectura de un hueco (el paso 6), no la lectura de la ocupación. */
  fallarAlReleer(error: Error = new AgendaNoDisponibleError('La agenda ha respondido 500.')): void {
    this.caidaAlReleer = error;
  }

  sigueLibre(entrada: { inicio: Date; fin: Date }): Promise<boolean> {
    if (this.caidaAlReleer !== null) return Promise.reject(this.caidaAlReleer);
    return Promise.resolve(
      !this.ocupados.some((o) => entrada.inicio < o.fin && o.inicio < entrada.fin),
    );
  }

  /** Los huecos con los que se construyó, para los tests que los necesiten. */
  huecosDeReferencia(): readonly HuecoDisponible[] {
    return this.libres;
  }
}

/** Configuración mínima válida de una clínica de pruebas. */
export function configDePrueba(extra: Record<string, unknown> = {}): ClienteConfig {
  return clienteConfigSchema.parse({
    slug: 'clinica-de-pruebas',
    nombre: 'Clínica de Pruebas',
    zonaHoraria: 'Europe/Madrid',
    canal: { tipo: 'whatsapp', remitenteId: '000' },
    horario: [
      { dia: 'lunes', abre: '09:00', cierra: '20:00' },
      { dia: 'martes', abre: '09:00', cierra: '20:00' },
      { dia: 'miercoles', abre: '09:00', cierra: '20:00' },
      { dia: 'jueves', abre: '09:00', cierra: '20:00' },
      { dia: 'viernes', abre: '09:00', cierra: '20:00' },
      { dia: 'sabado', abre: '10:00', cierra: '14:00' },
      { dia: 'domingo', abre: '10:00', cierra: '14:00' },
    ],
    agenda: { nivel: 'A', calendarioId: 'pruebas@group.calendar.google.com' },
    servicios: [
      { codigo: 'laser-axilas', nombre: 'Láser axilas', precio: 39.9, duracionMinutos: 20 },
      { codigo: 'laser-piernas', nombre: 'Láser piernas', precio: 89, duracionMinutos: 45 },
      {
        codigo: 'bono5',
        nombre: 'Bono 5 sesiones',
        precio: 399,
        duracionMinutos: 45,
        esBono: true,
        sesiones: 5,
      },
    ],
    escalado: {
      recepcion: [{ nombre: 'Recepción', canal: 'whatsapp', destino: '+34600111111' }],
      contactos: [
        { nombre: 'Recepción', canal: 'whatsapp', destino: '+34600000000', severidadMinima: 1 },
      ],
      proteccionDeDatos: [
        { nombre: 'DPD', canal: 'email', destino: 'datos@clinica.example' },
      ],
    },
    ...extra,
  });
}

/** Registro en memoria, sin tocar el disco. */
export function registroDePrueba(
  configs: readonly { slug: string; config: ClienteConfig }[],
): RegistroDeConfiguracion {
  const registro = new RegistroDeConfiguracion('(memoria)');
  const mapa = registro as unknown as {
    porSlug: Map<string, { config: ClienteConfig; version: string; cargadaEn: Date }>;
  };
  for (const { slug, config } of configs) {
    mapa.porSlug.set(slug, { config, version: `v-${slug}`, cargadaEn: new Date() });
  }
  return registro;
}

/** Fábrica falsa: devuelve siempre las mismas piezas deterministas. */
export class AgenteFalso implements FabricaDeAgente {
  constructor(
    private readonly clasificador: ClasificadorDeIntencion,
    private readonly redactor: Redactor,
    /** Lo que el agente dice haber llamado al modelo en cada turno. */
    private readonly llamadasDelTurno: readonly LlamadaAlModelo[] = [],
  ) {}

  /** Con qué se construyó el agente en cada turno: lo que vio el clasificador. */
  readonly contextos: ContextoDeAgente[] = [];

  /** Lo que se le ha pedido resumir, en orden. */
  readonly resumenesPedidos: Array<{ resumenAnterior: string | null; turnos: readonly TurnoDeConversacion[] }> = [];

  para(contexto: ContextoDeAgente): Agente {
    this.contextos.push(contexto);
    return {
      clasificador: this.clasificador,
      redactor: this.redactor,
      resumidor: {
        resumir: (entrada) => {
          this.resumenesPedidos.push(entrada);
          // Determinista: el número de turnos resumidos hasta ahora.
          const previos = Number(/(\d+) turnos/.exec(entrada.resumenAnterior ?? '')?.[1] ?? 0);
          return Promise.resolve(`Resumen de ${previos + entrada.turnos.length} turnos.`);
        },
      },
      llamadas: () => this.llamadasDelTurno,
    };
  }
}

export interface OpcionesDeDependencias {
  readonly core: Core;
  readonly agenda?: AgendaFalsa;
  readonly reloj?: () => Date;
  readonly redactor?: Redactor;
  readonly configuracion?: RegistroDeConfiguracion;
  readonly slug?: string;
}

export function dependenciasDePrueba(opciones: OpcionesDeDependencias): Dependencias {
  const slug = opciones.slug ?? 'clinica-de-pruebas';
  return {
    core: opciones.core,
    agente: new AgenteFalso(new ClasificadorFalso(), opciones.redactor ?? new RedactorFalso()),
    agenda: opciones.agenda ?? new AgendaFalsa([]),
    configuracion:
      opciones.configuracion ?? registroDePrueba([{ slug, config: configDePrueba({ slug }) }]),
    // Pimienta de pruebas. No es un secreto: la base es de usar y tirar.
    pimienta: 'pimienta-de-pruebas-no-es-un-secreto',
    reloj: opciones.reloj ?? (() => new Date()),
  };
}

export function huecosDesde(inicio: Date, cuantos: number): HuecoDisponible[] {
  return Array.from({ length: cuantos }, (_, i) => ({
    inicio: new Date(inicio.getTime() + i * 3_600_000),
    fin: new Date(inicio.getTime() + i * 3_600_000 + 1_800_000),
  }));
}
