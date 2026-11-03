import Anthropic from '@anthropic-ai/sdk';

import type { ClienteConfig } from '../config/cliente.js';
import { DomainError } from '../core/errors.js';
import type {
  Agente,
  Clasificacion,
  ClasificadorDeIntencion,
  ContextoDeAgente,
  EstadoParaRedactar,
  FabricaDeAgente,
  HuecoDisponible,
  LlamadaAlModelo,
  Redaccion,
  Redactor,
  Resumidor,
} from '../service/ports.js';
import {
  EXTRACCION_DE_RESERVA,
  esquemaJsonDeExtraccion,
  instruccionesDeExtraccion,
  interpretar,
} from './extraccion.js';
import { MODELOS, PRESUPUESTO, TIEMPOS } from './models.js';
import { construirMensajes, construirSistema, type TurnoDeConversacion } from './prompt.js';
import type { PromptPatient } from './prompt-boundary.js';

/**
 * Las dos piezas no deterministas, contra la API de Anthropic.
 *
 * ## Cuando el proveedor no responde
 *
 * Es la regla 4 en su forma más dura: el paciente no puede quedarse en silencio
 * porque una API de terceros esté caída. Tres capas:
 *
 * 1. **Tiempo límite corto** (8 s clasificar, 20 s redactar). El SDK de
 *    TypeScript cuenta en milisegundos.
 * 2. **Reintentos acotados** — 2, los que hace el SDK sobre 408/409/429/5xx y
 *    errores de conexión. Los tiempos límite también se reintentan, así que el
 *    reloj de pared llega a `tiempoLimite × 3`; está contado.
 * 3. **Respuesta de reserva que no depende del modelo.** Si tras eso no hay
 *    respuesta, `ProveedorNoDisponibleError` sube hasta el pipeline, que manda
 *    un texto fijo y escala. Nunca silencio.
 *
 * El clasificador tiene además una reserva propia: si no responde, la intención
 * es `otro`, que es la ruta conservadora.
 */

export class ProveedorNoDisponibleError extends DomainError {
  readonly code = 'proveedor_no_disponible';
  readonly httpStatus = 503;
  override readonly patientMessage =
    'Ahora mismo no puedo contestarte bien. Te escribe una persona del equipo en un momento.';
}

export class PresupuestoAgotadoError extends DomainError {
  readonly code = 'presupuesto_agotado';
  readonly httpStatus = 429;
  override readonly patientMessage =
    'Prefiero que siga una persona del equipo desde aquí. Te escriben enseguida.';
}

/**
 * Contador de llamadas al proveedor. Un bucle de herramientas que se llame a sí
 * mismo puede quemar tokens sin parar, así que hay dos topes: por mensaje y por
 * conversación. Al alcanzar cualquiera se escala en vez de seguir.
 */
export class Presupuesto {
  private enEsteMensaje = 0;

  constructor(private readonly yaGastadasEnLaConversacion: number) {}

  consumir(): void {
    this.enEsteMensaje += 1;
    if (this.enEsteMensaje > PRESUPUESTO.llamadasPorMensaje) {
      throw new PresupuestoAgotadoError(
        `Se han agotado las ${PRESUPUESTO.llamadasPorMensaje} llamadas al modelo permitidas para un mensaje.`,
      );
    }
    if (this.yaGastadasEnLaConversacion + this.enEsteMensaje > PRESUPUESTO.llamadasPorConversacionEnVentana) {
      throw new PresupuestoAgotadoError(
        `Se han agotado las ${PRESUPUESTO.llamadasPorConversacionEnVentana} llamadas al modelo permitidas ` +
          `para una conversación en ${PRESUPUESTO.ventanaHoras} horas.`,
      );
    }
  }

  get gastadas(): number {
    return this.enEsteMensaje;
  }
}

export function crearCliente(apiKey: string): Anthropic {
  return new Anthropic({ apiKey, maxRetries: TIEMPOS.reintentos });
}

function esRechazo(respuesta: { stop_reason: string | null }): boolean {
  return respuesta.stop_reason === 'refusal';
}

function textoDe(contenido: Array<{ type: string; text?: string }>): string {
  return contenido
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
    .trim();
}

/**
 * Lo que se ha llamado al modelo en un turno. Regla 6: prompt, respuesta,
 * modelo, tokens y latencia de **cada** llamada, también las que fallan y las
 * regeneraciones, que antes no dejaban rastro.
 */
export class RegistroDeLlamadas {
  private readonly lista: LlamadaAlModelo[] = [];

  anotar(llamada: LlamadaAlModelo): void {
    this.lista.push(llamada);
  }

  todas(): readonly LlamadaAlModelo[] {
    return [...this.lista];
  }
}

function mensajeDeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface OpcionesDelAgente {
  readonly cliente: Anthropic;
  readonly presupuesto: Presupuesto;
  readonly registro?: RegistroDeLlamadas;
}

export class ClasificadorAnthropic implements ClasificadorDeIntencion {
  constructor(
    private readonly opciones: OpcionesDelAgente,
    private readonly config: ClienteConfig,
    private readonly contexto: {
      turnos: readonly TurnoDeConversacion[];
      servicioVigente: string | null;
      citasVivas: readonly string[];
      huecosOfrecidos: readonly string[];
    },
  ) {}

  async clasificar(entrada: { texto: string; paciente: PromptPatient }): Promise<Clasificacion> {
    this.opciones.presupuesto.consumir();

    // La conversación reciente, no sólo el último mensaje: sin esto, «sí por
    // favor» tras haberle ofrecido un servicio no determina nada.
    const conversacion = this.contexto.turnos
      .slice(-6)
      .map((t) => `${t.rol === 'paciente' ? 'PACIENTE' : 'CLÍNICA'}: ${t.texto}`)
      .join('\n');

    const sistema = instruccionesDeExtraccion(
      this.config,
      this.contexto.servicioVigente,
      this.contexto.citasVivas,
      this.contexto.huecosOfrecidos,
    );
    const mensajes = [
      {
        role: 'user' as const,
        content:
          (conversacion.length === 0 ? '' : `Conversación reciente:\n${conversacion}\n\n`) +
          `Último mensaje del paciente: ${entrada.texto}`,
      },
    ];
    const inicio = performance.now();

    try {
      const respuesta = await this.opciones.cliente.messages.create(
        {
          model: MODELOS.clasificador,
          max_tokens: 512,
          system: sistema,
          output_config: {
            format: { type: 'json_schema', schema: esquemaJsonDeExtraccion(this.config) },
          },
          messages: mensajes,
        },
        { timeout: TIEMPOS.clasificadorMs },
      );

      const textoDevuelto = textoDe(respuesta.content);
      this.opciones.registro?.anotar({
        tipo: 'clasificar',
        modelo: MODELOS.clasificador,
        sistema,
        mensajes,
        respuesta: textoDevuelto,
        tokensEntrada: respuesta.usage.input_tokens,
        tokensSalida: respuesta.usage.output_tokens,
        latenciaMs: Math.round(performance.now() - inicio),
        error: null,
      });

      // `interpretar` valida contra el catálogo de ESTA clínica: un código que
      // no existe se convierte en null y el sistema preguntará.
      const extraccion = interpretar(JSON.parse(textoDevuelto), this.config);

      return {
        ...extraccion,
        modelo: MODELOS.clasificador,
        tokensEntrada: respuesta.usage.input_tokens,
        tokensSalida: respuesta.usage.output_tokens,
      };
    } catch (error: unknown) {
      if (error instanceof PresupuestoAgotadoError) throw error;
      this.opciones.registro?.anotar({
        tipo: 'clasificar',
        modelo: MODELOS.clasificador,
        sistema,
        mensajes,
        respuesta: null,
        tokensEntrada: 0,
        tokensSalida: 0,
        latenciaMs: Math.round(performance.now() - inicio),
        error: mensajeDeError(error),
      });
      // Si el modelo pequeño no responde, la extracción de reserva deja el
      // servicio en `null`: se preguntará en vez de proponer sobre una
      // suposición. Preguntar es siempre la salida segura.
      return {
        ...EXTRACCION_DE_RESERVA,
        modelo: `${MODELOS.clasificador}:reserva`,
        tokensEntrada: 0,
        tokensSalida: 0,
      };
    }
  }
}

export interface ContextoDeRedaccion {
  readonly config: ClienteConfig;
  readonly turnos: readonly TurnoDeConversacion[];
  readonly resumen: string | null;
}

export class RedactorAnthropic implements Redactor {
  constructor(
    private readonly opciones: OpcionesDelAgente,
    private readonly contexto: ContextoDeRedaccion,
  ) {}

  async redactar(entrada: {
    intencion: string;
    texto: string;
    paciente: PromptPatient;
    huecos?: readonly HuecoDisponible[];
    correccion?: { textoAnterior: string; explicacion: string } | undefined;
    estado?: EstadoParaRedactar | undefined;
  }): Promise<Redaccion> {
    this.opciones.presupuesto.consumir();

    // La frontera del prompt: el paciente entra ya reducido a `ref` y nombre.
    // No hay otro camino — este método no recibe una fila de `patients`.
    const datos = {
      config: this.contexto.config,
      paciente: entrada.paciente,
      turnos: this.contexto.turnos,
      resumen: this.contexto.resumen,
      ...(entrada.huecos === undefined ? {} : { huecos: entrada.huecos }),
      ...(entrada.estado === undefined ? {} : { estado: entrada.estado }),
    };

    const mensajes = construirMensajes(datos);
    if (entrada.correccion !== undefined) {
      mensajes.push({
        role: 'user',
        content:
          `Tu respuesta anterior no se ha enviado porque incumplía las reglas: ` +
          `${entrada.correccion.explicacion}\n` +
          `Reescríbela corrigiendo eso y sin añadir nada nuevo. El paciente no ` +
          `la ha visto: no te disculpes por ella ni la menciones.`,
      });
    }

    const sistema = construirSistema(datos);
    const inicio = performance.now();
    const anotar = (r: { respuesta: string | null; modelo: string; entrada: number; salida: number; error: string | null }) =>
      this.opciones.registro?.anotar({
        tipo: 'redactar',
        modelo: r.modelo,
        sistema,
        mensajes: [...mensajes],
        respuesta: r.respuesta,
        tokensEntrada: r.entrada,
        tokensSalida: r.salida,
        latenciaMs: Math.round(performance.now() - inicio),
        error: r.error,
      });

    try {
      const respuesta = await this.opciones.cliente.beta.messages.create(
        {
          model: MODELOS.redactor,
          max_tokens: 1024,
          system: sistema,
          messages: mensajes,
          // Respuestas cortas de WhatsApp: no hace falta más profundidad, y
          // `low` recorta latencia y coste sin apagar el razonamiento — que
          // apagarlo del todo tiene sus propios modos de fallo.
          output_config: { effort: 'low' },
          // Los clasificadores de seguridad pueden declinar una petición: en una
          // clínica se habla de heridas y de tratamientos. Con esto la propia
          // API reintenta en el modelo de reserva en la misma llamada.
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        },
        { timeout: TIEMPOS.redactorMs },
      );

      const texto = textoDe(respuesta.content as Array<{ type: string; text?: string }>);
      const rechazo = esRechazo(respuesta);
      anotar({
        respuesta: texto,
        modelo: respuesta.model,
        entrada: respuesta.usage.input_tokens,
        salida: respuesta.usage.output_tokens,
        error: rechazo ? 'rechazo' : texto.length === 0 ? 'respuesta_vacia' : null,
      });

      if (rechazo) {
        throw new ProveedorNoDisponibleError(
          'El proveedor ha declinado la petición y la reserva tampoco ha respondido.',
        );
      }
      if (texto.length === 0) {
        throw new ProveedorNoDisponibleError('El proveedor ha devuelto una respuesta vacía.');
      }

      return {
        texto,
        modelo: respuesta.model,
        tokensEntrada: respuesta.usage.input_tokens,
        tokensSalida: respuesta.usage.output_tokens,
      };
    } catch (error: unknown) {
      if (error instanceof DomainError) throw error;
      anotar({ respuesta: null, modelo: MODELOS.redactor, entrada: 0, salida: 0, error: mensajeDeError(error) });
      throw new ProveedorNoDisponibleError(
        `El proveedor del modelo no ha respondido: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}


/**
 * Quita del resumen toda frase que hable de una cita concreta: un día, una hora,
 * una reserva o una confirmación.
 *
 * Las instrucciones lo prohíben y no basta: medido contra el modelo real, 2 de 3
 * resúmenes la nombraban, y uno escribió «se confirmó su cita para el miércoles
 * a las 18:00» sobre una cita pendiente de recepción. En el prompt del redactor
 * eso es un historial falso, el mismo que se desmiente en otro sitio. Lo que no
 * puede pasar no se pide: se impide.
 */
const HABLA_DE_UNA_CITA =
  /\b\d{1,2}[:.h]\d{2}\b|\ba las \d|\b(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b|\b(confirm|reserv|apunt|eligi[oó]|retenid|guardad)\w*/i;

export function sinCitas(resumen: string): string {
  return (resumen.match(/[^.!?]+[.!?]*/g) ?? [])
    .map((f) => f.trim())
    .filter((f) => f.length > 0 && !HABLA_DE_UNA_CITA.test(f))
    .join(' ');
}

/**
 * El resumen de lo que ha salido de la ventana de turnos.
 *
 * docs/DESIGN_RULES.md decía «ventana de 8 turnos más resumen» y nada escribía el resumen:
 * a partir del noveno turno, el modelo no sabía lo que se habló antes. Lo hace
 * el modelo pequeño, con instrucciones cerradas: es extracción, no tono.
 *
 * Dos cosas que no puede hacer, y por las mismas razones que el prompt:
 * - **Dar citas por hechas.** Qué citas tiene lo dice el estado del sistema en
 *   cada turno, no un resumen que pudo quedarse viejo.
 * - **Llevar salud ni datos personales.** El resumen vive lo que la
 *   conversación —doce meses— y lo clínico vive noventa días. Los mensajes
 *   clínicos ni siquiera le llegan; esto es la segunda barrera.
 *
 * Si falla, devuelve `null` y se reintenta en otro turno: un resumen que falta
 * no puede tumbar la respuesta al paciente.
 */
export class ResumidorAnthropic implements Resumidor {
  constructor(private readonly opciones: OpcionesDelAgente) {}

  async resumir(entrada: {
    resumenAnterior: string | null;
    turnos: readonly TurnoDeConversacion[];
  }): Promise<string | null> {
    const sistema = [
      'Resumes una conversación de WhatsApp entre una clínica y un paciente, para que',
      'quien la siga sepa de qué se ha hablado. Escribe en español, en 2 a 4 frases.',
      'Recoge sólo: qué tratamientos le interesan, qué preguntó y qué se le contestó,',
      'qué prefiere (días, horas) y qué quedó pendiente.',
      'NO menciones días, horas ni fechas, ni si eligió, reservó o confirmó una cita:',
      'eso cambia y lo dice el sistema en cada mensaje.',
      'NO incluyas teléfonos, apellidos, direcciones ni nada sobre su salud.',
      'NO añadas nada que no esté en la conversación.',
    ].join('\n');
    const mensajes = [
      {
        role: 'user' as const,
        content:
          (entrada.resumenAnterior === null ? '' : `Resumen hasta ahora: ${entrada.resumenAnterior}\n\n`) +
          'Conversación que hay que añadir al resumen:\n' +
          entrada.turnos.map((t) => `${t.rol === 'paciente' ? 'PACIENTE' : 'CLÍNICA'}: ${t.texto}`).join('\n'),
      },
    ];
    const inicio = performance.now();

    try {
      this.opciones.presupuesto.consumir();
      const respuesta = await this.opciones.cliente.messages.create(
        { model: MODELOS.resumidor, max_tokens: 300, system: sistema, messages: mensajes },
        { timeout: TIEMPOS.resumidorMs },
      );
      const texto = sinCitas(textoDe(respuesta.content));
      this.opciones.registro?.anotar({
        tipo: 'resumir',
        modelo: MODELOS.resumidor,
        sistema,
        mensajes,
        respuesta: texto,
        tokensEntrada: respuesta.usage.input_tokens,
        tokensSalida: respuesta.usage.output_tokens,
        latenciaMs: Math.round(performance.now() - inicio),
        error: null,
      });
      return texto.length === 0 ? null : texto;
    } catch (error: unknown) {
      // Sin presupuesto no se resume, y no se anota: no se ha llamado a nadie.
      if (error instanceof PresupuestoAgotadoError) return null;
      this.opciones.registro?.anotar({
        tipo: 'resumir',
        modelo: MODELOS.resumidor,
        sistema,
        mensajes,
        respuesta: null,
        tokensEntrada: 0,
        tokensSalida: 0,
        latenciaMs: Math.round(performance.now() - inicio),
        error: mensajeDeError(error),
      });
      return null;
    }
  }
}

/**
 * La fábrica real. Construye clasificador y redactor para una conversación
 * concreta, con su catálogo, su ventana de turnos y su presupuesto ya gastado.
 */
export class AgenteAnthropic implements FabricaDeAgente {
  constructor(private readonly cliente: Anthropic) {}

  para(contexto: ContextoDeAgente): Agente {
    const presupuesto = new Presupuesto(contexto.llamadasPrevias);
    const registro = new RegistroDeLlamadas();
    const opciones = { cliente: this.cliente, presupuesto, registro };

    return {
      resumidor: new ResumidorAnthropic(opciones),
      llamadas: () => registro.todas(),
      clasificador: new ClasificadorAnthropic(opciones, contexto.config, {
        turnos: contexto.turnos,
        servicioVigente: contexto.servicioVigente,
        citasVivas: contexto.citasVivas,
        huecosOfrecidos: contexto.huecosOfrecidos,
      }),
      redactor: new RedactorAnthropic(opciones, {
        config: contexto.config,
        turnos: contexto.turnos,
        resumen: contexto.resumen,
      }),
    };
  }
}
