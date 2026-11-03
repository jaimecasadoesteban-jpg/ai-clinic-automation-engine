import { RESPUESTAS_POR_DEFECTO, type Categoria } from '../agent/firewall.js';
import type { Patron } from '../agent/firewall-patterns.js';
import type { PoliticaDeVencimientos } from '../core/hold-state-machine.js';
import type { Textos } from '../service/ports.js';
import type { ClienteConfig } from './cliente.js';

/**
 * Lo que el código necesita, derivado del YAML de la clínica.
 *
 * Regla 7: aquí es donde la configuración se convierte en comportamiento. Si
 * algún día hace falta un `if (cliente === 'x')` en otro sitio, el sitio
 * correcto era éste.
 */

const DIAS = [
  'domingo',
  'lunes',
  'martes',
  'miercoles',
  'jueves',
  'viernes',
  'sabado',
] as const;

/** Milisegundos que la zona va por delante de UTC en ese instante. */
function desfase(fecha: Date, zonaHoraria: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: zonaHoraria,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(fecha).map((x) => [x.type, x.value]));
  const comoUtc = Date.UTC(
    Number(p['year']),
    Number(p['month']) - 1,
    Number(p['day']),
    Number(p['hour']) === 24 ? 0 : Number(p['hour']),
    Number(p['minute']),
    Number(p['second']),
  );
  return comoUtc - fecha.getTime();
}

/** El instante en que son las HH:MM de la zona, el mismo día local que `fecha`. */
export function instanteLocal(
  fecha: Date,
  zonaHoraria: string,
  horas: number,
  minutos: number,
): Date {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: zonaHoraria,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const [anio, mes, dia] = dtf.format(fecha).split('-').map(Number);
  const tentativa = Date.UTC(anio ?? 1970, (mes ?? 1) - 1, dia ?? 1, horas, minutos);
  // Se corrige con el desfase del propio instante tentativo: basta para
  // cualquier hora que no caiga dentro del salto de horario.
  return new Date(tentativa - desfase(new Date(tentativa), zonaHoraria));
}

type Dia = (typeof DIAS)[number];

function diaLocal(fecha: Date, zonaHoraria: string): Dia {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: zonaHoraria, weekday: 'short' });
  const corto = dtf.format(fecha).toLowerCase();
  const indice = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(corto.slice(0, 3));
  return DIAS[indice === -1 ? 0 : indice] ?? 'domingo';
}

/**
 * Fin de la jornada a partir de un instante.
 *
 * Si la clínica está cerrada ese día, o ya ha cerrado, se va al cierre del
 * siguiente día que abra. Un `pendiente_recepcion` que vence un domingo a
 * medianoche caducaría sin que nadie hubiera tenido ocasión de atenderlo.
 */
export function finDeJornadaDe(config: ClienteConfig): (desde: Date) => Date {
  const porDia = new Map<Dia, string>(config.horario.map((h) => [h.dia, h.cierra]));

  return (desde: Date): Date => {
    for (let salto = 0; salto < 8; salto += 1) {
      const candidato = new Date(desde.getTime() + salto * 86_400_000);
      const cierre = porDia.get(diaLocal(candidato, config.zonaHoraria));
      if (cierre === undefined) continue;

      const [hh, mm] = cierre.split(':').map(Number);
      const instante = instanteLocal(candidato, config.zonaHoraria, hh ?? 0, mm ?? 0);
      if (instante > desde) return instante;
    }
    // Ninguna clínica puede tener el horario vacío (el esquema lo exige), así
    // que esto sólo se alcanza con una semana entera cerrada.
    return new Date(desde.getTime() + 86_400_000);
  };
}

export function politicaDe(config: ClienteConfig): PoliticaDeVencimientos {
  return {
    propuestaMinutos: config.vencimientos.propuestaMinutos,
    retenidaMinutos: config.vencimientos.retenidaMinutos,
    recordatorioRecepcionMinutos: config.vencimientos.recordatorioRecepcionMinutos,
    escaladoRecepcionMinutos: config.vencimientos.escaladoRecepcionMinutos,
    ventanaDeRellenoHoras: config.vencimientos.ventanaDeRellenoHoras,
    agendaMinutos: config.vencimientos.agendaMinutos,
    confirmacion: config.agenda.confirmacion,
    finDeJornada: finDeJornadaDe(config),
  };
}

const RESPALDO: Readonly<Record<Categoria, keyof typeof RESPUESTAS_POR_DEFECTO>> = {
  urgencia_clinica: 'urgencia_derivar',
  contenido_clinico: 'clinico_derivar',
  baja: 'baja_confirmada',
  minoria_de_edad: 'menor_no_atendemos',
  derechos_rgpd: 'derechos_acuse',
};

/**
 * Los textos fijos, reescritos con el tono de los turnos que funcionan.
 *
 * Los dos que peor sonaban en la primera sesión real eran plantillas, no salida
 * del modelo: «Te he guardado ese hueco… No tienes que hacer nada más» y
 * «Prefiero que esto te lo confirme una persona del equipo». Tres cosas cambian:
 *
 * 1. **Dicen la hora.** El texto de retención no la decía, igual que le pasaba
 *    al de reagendado antes de arreglarlo: quien acababa de coger hora leía «ese
 *    hueco» y no sabía cuál. La hora sale de la base de datos, no del modelo.
 * 2. **No venden inseguridad.** «La clínica está cerrada ahora mismo» convierte
 *    una espera normal en un problema. Que recepción confirme por la mañana es
 *    el funcionamiento, no una avería.
 * 3. **Una frase, seguida.** El detector de estilo es el suelo —`retenidoDiferido`
 *    lo incumplía con tres frases— pero el listón es leerlo como lo escribiría
 *    la recepcionista.
 *
 * Lo que NO se toca: los textos del cortafuegos. Son respuestas clínicas
 * aprobadas por la clínica (regla 5) y su forma no se negocia por estilo.
 */
/**
 * Todos los que anuncian una hora dicen también **de qué**. Sin el tratamiento,
 * «te reservo el hueco del lunes a las 10:20» con un servicio vigente de hace
 * seis semanas habría mandado a depilarse a quien pidió una limpieza facial.
 */
const RETENIDO_POR_DEFECTO =
  'Te reservo el hueco del {hueco} para {servicio} y te llega la confirmación en cuanto recepción lo pase a la agenda.';

const RETENIDO_DIFERIDO_POR_DEFECTO =
  'Te reservo el hueco del {hueco} para {servicio}; te llega la confirmación en cuanto recepción abra y lo pase a la agenda.';

/**
 * Con el tono de los demás mensajes. Dice la hora nueva y que la anterior queda
 * libre, que es exactamente lo que pregunta quien acaba de cambiar su cita.
 */
const REAGENDADO_POR_DEFECTO =
  'Hecho, te cambio {servicio} al {nueva} y suelto el de {anterior}; te llega la confirmación en cuanto recepción lo pase a la agenda.';

const REAGENDADO_DIFERIDO_POR_DEFECTO =
  'Hecho, te cambio {servicio} al {nueva} y suelto el de {anterior}; te llega la confirmación en cuanto recepción abra y lo pase a la agenda.';

/**
 * La confirmación también dice la hora, por lo mismo que la retención: es el
 * mensaje que el paciente va a buscar en el hilo tres días después.
 */
const CONFIRMADA_POR_DEFECTO = 'Confirmada tu cita de {servicio} del {hueco}, ahí te esperamos.';

const COLISION_CON_ALTERNATIVA_POR_DEFECTO =
  'Ese hueco se acaba de ocupar, así que te paso {servicio} al {hueco} y te llega la confirmación en cuanto recepción lo pase a la agenda.';

const COLISION_SIN_ALTERNATIVA_POR_DEFECTO =
  'Ese hueco se acaba de ocupar y no me quedan alternativas guardadas, así que te escribe alguien del equipo con horas nuevas.';

/**
 * Cuando la validación de salida bloquea dos veces.
 *
 * «Prefiero que esto te lo confirme una persona del equipo. Te escriben
 * enseguida» suena a puerta cerrada, y es lo que le salió al paciente por
 * escribir «Gracias!». Dice lo mismo sin sonar a que algo ha ido mal.
 */
const ESCALADO_POR_DEFECTO =
  'Con esto prefiero no contestarte a medias, así que te escribe alguien del equipo en un momento.';

/**
 * Los tres que el sistema le escribe al paciente sin que él haya escrito.
 *
 * Cuidado con lo que prometen. Una propuesta no estaba reservada, así que no se
 * dice «ya no te la guardo»: se dice que puede haberse ocupado, que es verdad.
 * Ninguno reprocha que no contestara, y todos acaban con una salida que no
 * depende de que nadie le escriba.
 */
const PROPUESTA_CADUCADA_POR_DEFECTO =
  'Las horas que te pasé para {servicio} ya pueden haberse ocupado; si sigues queriendo cita, dime qué día te viene bien y te busco hueco.';

const RECORDATORIO_POR_DEFECTO =
  'Hola {nombre}, te recordamos tu cita de {servicio} del {hueco}. Si no puedes venir, contesta a este mensaje y te buscamos otra hora.';

const RETENCION_CADUCADA_POR_DEFECTO =
  'Tu hora de {servicio} del {hueco} no ha llegado a quedar reservada; si te sigue viniendo bien, dímelo y lo intento de nuevo, o te busco otra.';

const SIN_RESPUESTA_DE_RECEPCION_POR_DEFECTO =
  'Tu cita de {servicio} del {hueco} no ha llegado a confirmarse, así que todavía no te la puedo dar por hecha. El equipo de la clínica ya lo sabe; si prefieres, dime y te busco otra hora.';

/**
 * La agenda no responde. Antes el paciente recibía «te escribe una persona del
 * equipo enseguida», escrito en el código y falso: nadie recibía ningún aviso y
 * además el turno se perdía. Ahora dice lo que ocurre y le deja volver a pedirlo.
 */
const AGENDA_NO_DISPONIBLE_POR_DEFECTO =
  'Ahora mismo no consigo ver la agenda. Escríbeme en un rato y te busco hueco.';

/** No se ha podido atender el mensaje ni reintentando. Sin prometer a nadie. */
const FUERA_DE_SERVICIO_POR_DEFECTO =
  'Ahora mismo no puedo atenderte bien. Escríbeme de nuevo en unos minutos, por favor.';

/** Cuando el proveedor del modelo no responde. Nadie se queda en silencio. */
const PROVEEDOR_CAIDO_POR_DEFECTO =
  'Ahora mismo no te puedo contestar bien, así que te escribe alguien del equipo enseguida.';

/**
 * Mientras hay una supresión, limitación u oposición en curso no se le agenda
 * nada nuevo: seguir tratando sus datos para darle hora mientras pide que
 * dejemos de tratarlos es contradecirse. Las citas que ya tenga se mantienen —
 * ejercer un derecho no cancela lo que ya estaba acordado.
 */
const DERECHOS_EN_CURSO_POR_DEFECTO =
  'Tenemos en curso tu solicitud sobre tus datos, así que no te agendo nada nuevo hasta que ' +
  'el equipo de la clínica la resuelva y hable contigo. Si ya tenías cita, sigue en pie.';

/**
 * Lo que se contesta a una nota de voz, una foto o una ubicación.
 *
 * Antes no se contestaba nada: n8n filtraba esos mensajes y el paciente se
 * quedaba en silencio creyendo que su audio había llegado. Pedirle que lo
 * escriba es lo único que devuelve el mensaje al camino donde sí hay barreras —
 * el cortafuegos no puede leer un audio.
 */
const SOLO_TEXTO_POR_DEFECTO =
  'Por aquí sólo puedo leer mensajes escritos, ¿me lo pones en texto y te ayudo?';

/**
 * Cuando preguntan un dato de la clínica que no está en su YAML. Es verdad —lo
 * sabe recepción— y no se inventa nada: sin esto el modelo decía «aparcamiento
 * propio no tenemos» sin un solo dato detrás.
 */
const SIN_INFORMACION_POR_DEFECTO = 'Eso te lo confirma recepción, que lo tiene al día.';

/**
 * Preguntan cómo prepararse y no se sabe para qué tratamiento. La preparación
 * de otro sería falsa, y aquí lo falso roza lo clínico: se pregunta.
 */
const PREPARACION_SIN_SERVICIO_POR_DEFECTO =
  'Depende del tratamiento, ¿para cuál es? Así te digo cómo venir.';

const EN_PAUSA_POR_DEFECTO =
  'Tu mensaje ya está en manos del equipo de la clínica y te contestan en cuanto puedan. ' +
  'Si es urgente, llama a la clínica o al 112.';

/**
 * «De lunes a miércoles de 10:00 a 20:30, jueves y viernes de 10:00 a 21:00 y los
 * sábados de 10:00 a 14:00. Los domingos cerramos.»
 *
 * Agrupa los días seguidos con el mismo horario, para que se lea como lo diría
 * una recepcionista y no como una tabla. Los tramos partidos van con «y».
 */
const ORDEN_DE_DIAS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'] as const;
type DiaDeSemana = (typeof ORDEN_DE_DIAS)[number];

/** En singular para los rangos («de lunes a sábado»), en plural sueltos («los sábados»). */
const DIA: Readonly<Record<DiaDeSemana, { uno: string; varios: string }>> = {
  lunes: { uno: 'lunes', varios: 'lunes' },
  martes: { uno: 'martes', varios: 'martes' },
  miercoles: { uno: 'miércoles', varios: 'miércoles' },
  jueves: { uno: 'jueves', varios: 'jueves' },
  viernes: { uno: 'viernes', varios: 'viernes' },
  sabado: { uno: 'sábado', varios: 'sábados' },
  domingo: { uno: 'domingo', varios: 'domingos' },
};

function enumerar(partes: readonly string[]): string {
  if (partes.length <= 1) return partes[0] ?? '';
  return `${partes.slice(0, -1).join(', ')} y ${partes[partes.length - 1] ?? ''}`;
}

export function componerHorario(config: ClienteConfig): string {
  const tramosDe = (dia: DiaDeSemana): string =>
    enumerar(
      config.horario
        .filter((h) => h.dia === dia)
        .sort((a, b) => a.abre.localeCompare(b.abre))
        .map((h) => `de ${h.abre} a ${h.cierra}`),
    );

  // Días seguidos con el mismo horario, juntos.
  const grupos: Array<{ dias: DiaDeSemana[]; tramos: string }> = [];
  for (const dia of ORDEN_DE_DIAS) {
    const tramos = tramosDe(dia);
    const ultimo = grupos[grupos.length - 1];
    if (ultimo !== undefined && ultimo.tramos === tramos) ultimo.dias.push(dia);
    else grupos.push({ dias: [dia], tramos });
  }

  const nombrar = (dias: readonly DiaDeSemana[]): string => {
    const [primero] = dias;
    const ultimo = dias[dias.length - 1];
    if (primero === undefined || ultimo === undefined) return '';
    if (dias.length === 1) return `los ${DIA[primero].varios}`;
    if (dias.length === 2) return `${DIA[primero].uno} y ${DIA[ultimo].uno}`;
    return `de ${DIA[primero].uno} a ${DIA[ultimo].uno}`;
  };

  const abiertos = grupos.filter((g) => g.tramos !== '').map((g) => `${nombrar(g.dias)} ${g.tramos}`);
  const cerrados = grupos.filter((g) => g.tramos === '').flatMap((g) => g.dias);

  const frase = `Abrimos ${enumerar(abiertos)}.`;
  if (cerrados.length === 0) return frase;
  const cuales = enumerar(cerrados.map((d) => `los ${DIA[d].varios}`));
  return `${frase} ${cuales.charAt(0).toUpperCase()}${cuales.slice(1)} cerramos.`;
}

/** «sábado 15 a las 10:20», en hora de la clínica. */
export function momento(fecha: Date, zonaHoraria: string): string {
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: zonaHoraria,
    weekday: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(fecha);
}

/**
 * Textos de corte. Los de la clínica mandan, pero **siempre hay respaldo**: una
 * plantilla ausente en un YAML no puede acabar en un silencio (regla 4).
 */
export function textosDe(config: ClienteConfig): Textos {
  const propios: Partial<Record<Categoria, string | undefined>> = {
    urgencia_clinica: config.textos.urgencia,
    contenido_clinico: config.textos.clinico,
    baja: config.textos.baja,
    minoria_de_edad: config.textos.menor,
  };

  const cuando = (fecha: Date): string => momento(fecha, config.zonaHoraria);
  /** El nombre del catálogo, en minúscula inicial: va dentro de la frase. */
  const tratamiento = (codigo: string): string => {
    const nombre = config.servicios.find((s) => s.codigo === codigo)?.nombre ?? 'tu tratamiento';
    return nombre.charAt(0).toLowerCase() + nombre.slice(1);
  };

  return {
    corte: (categoria) => propios[categoria] ?? RESPUESTAS_POR_DEFECTO[RESPALDO[categoria]],
    enPausa: () => config.textos.enPausa ?? EN_PAUSA_POR_DEFECTO,
    retenido: ({ hueco, servicio, avisoDiferidoHasta }) => {
      const plantilla =
        avisoDiferidoHasta === null
          ? (config.textos.retenido ?? RETENIDO_POR_DEFECTO)
          : (config.textos.retenidoDiferido ?? RETENIDO_DIFERIDO_POR_DEFECTO);

      return plantilla.replace('{hueco}', cuando(hueco)).replace('{servicio}', tratamiento(servicio));
    },
    derechosEnCurso: () => config.textos.derechosEnCurso ?? DERECHOS_EN_CURSO_POR_DEFECTO,
    horario: () => (config.textos.horario ?? '{horario}').replace('{horario}', componerHorario(config)),
    informacion: (tema, servicio) => {
      const sinDato = config.textos.sinInformacion ?? SIN_INFORMACION_POR_DEFECTO;
      if (tema === 'preparacion') {
        if (servicio === null) {
          return config.textos.preparacionSinServicio ?? PREPARACION_SIN_SERVICIO_POR_DEFECTO;
        }
        return config.servicios.find((s) => s.codigo === servicio)?.preparacion ?? sinDato;
      }
      const dato = {
        direccion: config.informacion.direccion,
        aparcamiento: config.informacion.aparcamiento,
        pago: config.informacion.formasDePago,
        cancelacion: config.informacion.cancelacion,
        primera_visita: config.informacion.primeraVisita,
      }[tema];
      return dato ?? sinDato;
    },
    soloTexto: () => config.textos.soloTexto ?? SOLO_TEXTO_POR_DEFECTO,
    reagendado: ({ nueva, anterior, servicio, avisoDiferidoHasta }) => {
      const plantilla =
        avisoDiferidoHasta === null
          ? (config.textos.reagendado ?? REAGENDADO_POR_DEFECTO)
          : (config.textos.reagendadoDiferido ?? REAGENDADO_DIFERIDO_POR_DEFECTO);

      return plantilla
        .replace('{nueva}', cuando(nueva))
        .replace('{anterior}', cuando(anterior))
        .replace('{servicio}', tratamiento(servicio));
    },
    confirmada: ({ hueco, servicio }) =>
      (config.textos.confirmada ?? CONFIRMADA_POR_DEFECTO)
        .replace('{hueco}', cuando(hueco))
        .replace('{servicio}', tratamiento(servicio)),
    colisionConAlternativa: ({ alternativa, servicio }) =>
      (config.textos.colisionConAlternativa ?? COLISION_CON_ALTERNATIVA_POR_DEFECTO)
        .replace('{hueco}', cuando(alternativa))
        .replace('{servicio}', tratamiento(servicio)),
    colisionSinAlternativa: () =>
      config.textos.colisionSinAlternativa ?? COLISION_SIN_ALTERNATIVA_POR_DEFECTO,
    escaladoPorValidacion: () => config.textos.escalado ?? ESCALADO_POR_DEFECTO,
    proveedorCaido: () => config.textos.proveedorCaido ?? PROVEEDOR_CAIDO_POR_DEFECTO,
    agendaNoDisponible: () => config.textos.agendaNoDisponible ?? AGENDA_NO_DISPONIBLE_POR_DEFECTO,
    fueraDeServicio: () => config.textos.fueraDeServicio ?? FUERA_DE_SERVICIO_POR_DEFECTO,
    propuestaCaducada: ({ servicio }) =>
      (config.textos.propuestaCaducada ?? PROPUESTA_CADUCADA_POR_DEFECTO).replace(
        '{servicio}',
        tratamiento(servicio),
      ),
    retencionCaducada: ({ hueco, servicio }) =>
      (config.textos.retencionCaducada ?? RETENCION_CADUCADA_POR_DEFECTO)
        .replace('{hueco}', cuando(hueco))
        .replace('{servicio}', tratamiento(servicio)),
    sinRespuestaDeRecepcion: ({ hueco, servicio }) =>
      (config.textos.sinRespuestaDeRecepcion ?? SIN_RESPUESTA_DE_RECEPCION_POR_DEFECTO)
        .replace('{hueco}', cuando(hueco))
        .replace('{servicio}', tratamiento(servicio)),
    recordatorio: ({ nombre, hueco, servicio }) =>
      (config.textos.recordatorio ?? RECORDATORIO_POR_DEFECTO)
        .replace('{nombre}', nombre)
        .replace('{hueco}', cuando(hueco))
        .replace('{servicio}', tratamiento(servicio)),
  };
}

/** Los patrones extra de la clínica, compilados. Sólo añaden. */
export function patronesDe(config: ClienteConfig): Patron[] {
  return config.cortafuegos.patronesAdicionales.map((p) => ({
    id: p.id,
    categoria: p.categoria,
    regex: new RegExp(p.patron),
  }));
}
