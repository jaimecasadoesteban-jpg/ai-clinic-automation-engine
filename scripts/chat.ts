import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';

import postgres from 'postgres';

import { AgenteAnthropic, crearCliente } from '../src/agent/anthropic.js';
import { costeAproximado } from '../src/agent/models.js';
import { cargarConfiguracion, type RegistroDeConfiguracion } from '../src/config/registry.js';
import { createCore, type Core } from '../src/db/client.js';
import { registrarResultadoDeCita, marcarEscaladoAtendido } from '../src/service/appointments.js';
import { procesarMensajeEntrante, type Dependencias } from '../src/service/pipeline.js';
import type { Intervalo } from '../src/core/disponibilidad.js';
import type { Agenda } from '../src/service/ports.js';
import { accionRecepcion } from '../src/service/reception.js';
import { caducarRetenciones } from '../src/service/vencimientos.js';
import { bajoLaLinea, c, dolares, hora, titulo } from './chat/consola.js';
import { AgenteEspia } from './chat/espia.js';

/**
 * Banco de pruebas conversacional.
 *
 *     npm run chat -- ejemplo
 *
 * Escribes como si fueras un paciente por WhatsApp y ves la respuesta del
 * agente, turno a turno, con lo que está pasando por debajo: qué se extrajo, si
 * el cortafuegos cortó, qué huecos hay y en qué estado, si la validación de
 * salida bloqueó algo, cuántos tokens ha costado y si se ha abierto un escalado.
 *
 * Existe porque probar a mano encuentra lo que los tests no pueden — un test
 * comprueba que el código hace lo que dijimos, no que lo que dijimos sea
 * correcto — y porque hasta ahora probar a mano significaba pelearse con curl.
 *
 * **Usa el modelo real y gasta dinero.** Va contra el Postgres de Docker; no
 * toca Supabase.
 */

if (existsSync('.env')) process.loadEnvFile('.env');

const slugInicial = process.argv[2] ?? 'ejemplo';

const URL_LOCAL = process.env['TEST_APP_DATABASE_URL'];
const URL_ADMIN = process.env['TEST_DATABASE_URL'];
const CLAVE = process.env['ANTHROPIC_API_KEY'];
const PIMIENTA = process.env['SUPPRESSION_PEPPER'];

for (const [nombre, valor] of [
  ['TEST_APP_DATABASE_URL', URL_LOCAL],
  ['TEST_DATABASE_URL', URL_ADMIN],
  ['ANTHROPIC_API_KEY', CLAVE],
  ['SUPPRESSION_PEPPER', PIMIENTA],
] as const) {
  if (valor === undefined || valor === '') {
    console.error(c.rojo(`Falta ${nombre} en .env.`));
    console.error('El banco de pruebas va contra el Docker local: `npm run db:test:up`.');
    process.exit(1);
  }
}

/**
 * Agenda de mentira, en el mismo proceso. Devuelve **ocupación en bruto**: qué
 * es proponible lo decide el núcleo, con el horario del YAML. Por eso ya no
 * puede proponer un domingo aunque la agenda esté vacía.
 */
class AgendaDeBanco implements Agenda {
  private readonly ocupados: Intervalo[] = [];

  ocupar(inicio: Date, fin: Date): void {
    this.ocupados.push({ inicio, fin });
  }

  ocupacion(): Promise<readonly Intervalo[]> {
    return Promise.resolve(this.ocupados);
  }

  sigueLibre(entrada: { inicio: Date; fin: Date }): Promise<boolean> {
    return Promise.resolve(
      !this.ocupados.some((o) => entrada.inicio < o.fin && o.inicio < entrada.fin),
    );
  }
}

const admin = postgres(URL_ADMIN as string, { max: 2, onnotice: () => {} });
const core: Core = createCore(URL_LOCAL as string);
const registro: RegistroDeConfiguracion = cargarConfiguracion();

let desfaseMs = 0;
const reloj = (): Date => new Date(Date.now() + desfaseMs);

const agenda = new AgendaDeBanco();
const espia = new AgenteEspia(new AgenteAnthropic(crearCliente(CLAVE as string)));

const deps: Dependencias = {
  core,
  configuracion: registro,
  agente: espia,
  agenda,
  pimienta: PIMIENTA as string,
  reloj,
};

let slug = slugInicial;
let clientId = '';
let telefono = `+34600${String(Math.floor(Math.random() * 900000) + 100000)}`;
let turno = 0;
let gasto = 0;
let tokensEntrada = 0;
let tokensSalida = 0;

async function asegurarCliente(nuevoSlug: string): Promise<void> {
  const { config, version } = registro.obtener(nuevoSlug);
  const filas = await admin`
    insert into motor.clients (id, slug, name, timezone, config, config_version)
    values (gen_random_uuid(), ${config.slug}, ${config.nombre}, ${config.zonaHoraria},
            ${admin.json(config)}, ${version})
    on conflict (slug) do update
      set config = excluded.config, config_version = excluded.config_version, active = true
    returning id
  `;
  clientId = String(filas[0]?.['id']);
  slug = nuevoSlug;
}

function zona(): string {
  return registro.obtener(slug).config.zonaHoraria;
}

/** Lo que pasó por debajo en el último turno, leído de la base de datos. */
async function panelDelTurno(conversacionId: string): Promise<void> {
  const clasificacion = espia.clasificacion;
  const lineas: (string | null)[] = [];

  if (clasificacion !== null) {
    const pref = clasificacion.preferencia;
    const prefTexto =
      pref === null
        ? '—'
        : [
            pref.cuantoAntes ? 'cuanto antes' : null,
            pref.dias.length > 0 ? `días: ${pref.dias.join('/')}` : null,
            pref.diasExcluidos.length > 0 ? `no: ${pref.diasExcluidos.join('/')}` : null,
            pref.franjas.length > 0 ? pref.franjas.join('/') : null,
            pref.desde !== null ? `desde ${pref.desde}` : null,
          ]
            .filter((x) => x !== null)
            .join(', ') || '—';

    lineas.push(
      `extracción [${
        clasificacion.modelo.endsWith(':reserva')
          ? c.rojo('RESERVA: el clasificador no ha respondido')
          : c.gris(clasificacion.modelo)
      }]`,
      `  intención: ${c.azul(clasificacion.intencion)} · servicio: ${
        clasificacion.servicio === null ? c.ambar('no determinado') : c.verde(clasificacion.servicio)
      } · preferencia: ${prefTexto}${
        clasificacion.escalar === null ? '' : ` · señal: ${c.ambar(clasificacion.escalar)}`
      }`,
    );
  }

  const salientes = await admin`
    select model, prompt_tokens, completion_tokens, firewall_category, firewall_rule,
           validation_result
      from motor.messages
     where client_id = ${clientId} and conversation_id = ${conversacionId}
       and direction = 'saliente'
     order by created_at desc limit 1
  `;
  const ultimo = salientes[0];

  const categoria = ultimo?.['firewall_category'];
  if (typeof categoria === 'string') {
    const severidades: Record<string, number> = {
      urgencia_clinica: 3,
      minoria_de_edad: 2,
      contenido_clinico: 2,
      baja: 1,
    };
    lineas.push(
      `cortafuegos · ${c.rojo(categoria)} · severidad ${severidades[categoria] ?? '?'} · patrones: ${String(ultimo?.['firewall_rule'] ?? '')}`,
    );
  }

  const validacion = ultimo?.['validation_result'] as {
    valido?: boolean;
    regeneraciones?: number;
    proveedorCaido?: string | null;
    motivos?: Array<{ tipo: string }>;
  } | null;
  if (validacion != null) {
    if (validacion.proveedorCaido != null) {
      lineas.push(`validación · ${c.rojo('proveedor caído')}: ${validacion.proveedorCaido}`);
    } else {
      const motivos = validacion.motivos ?? [];
      lineas.push(
        `validación · ${validacion.valido === true ? c.verde('pasa') : c.rojo('bloqueada')}` +
          ` · regeneraciones: ${validacion.regeneraciones ?? 0}` +
          (motivos.length > 0 ? ` · motivos: ${motivos.map((m) => m.tipo).join(', ')}` : ''),
      );
      for (const correccion of espia.correcciones) {
        lineas.push(`  bloqueado: «${correccion.textoAnterior}»`);
        lineas.push(`  por qué:   ${correccion.explicacion}`);
      }
    }
  }

  const huecos = await admin`
    select state, service_code, slot_start, rank from motor.holds
     where client_id = ${clientId} and conversation_id = ${conversacionId}
       and state in ('propuesta', 'retenida', 'pendiente_recepcion', 'confirmada')
     order by rank nulls last, slot_start
  `;
  if (huecos.length > 0) {
    const resumen = huecos
      .map(
        (h) =>
          `${String(h['rank'] ?? '-')}) ${hora(new Date(String(h['slot_start'])), zona())} ${c.azul(String(h['state']))}`,
      )
      .join(' · ');
    lineas.push(`huecos [${String(huecos[0]?.['service_code'])}] · ${resumen}`);
  } else {
    lineas.push(`huecos · ${c.gris('ninguno vivo')}`);
  }

  const escalados = await admin`
    select reason, severity, state from motor.escalations
     where client_id = ${clientId} and conversation_id = ${conversacionId}
     order by created_at desc limit 1
  `;
  const escalado = escalados[0];
  if (escalado !== undefined) {
    lineas.push(
      `escalado · ${c.ambar(String(escalado['reason']))} · severidad ${String(escalado['severity'])} · ${String(escalado['state'])}`,
    );
  }

  // Coste del turno: clasificador + las redacciones (incluida la regeneración).
  let costeTurno = 0;
  let entradaTurno = 0;
  let salidaTurno = 0;
  if (clasificacion !== null) {
    costeTurno += costeAproximado(
      clasificacion.modelo,
      clasificacion.tokensEntrada,
      clasificacion.tokensSalida,
    );
    entradaTurno += clasificacion.tokensEntrada;
    salidaTurno += clasificacion.tokensSalida;
  }
  for (const redaccion of espia.redacciones) {
    costeTurno += costeAproximado(redaccion.modelo, redaccion.tokensEntrada, redaccion.tokensSalida);
    entradaTurno += redaccion.tokensEntrada;
    salidaTurno += redaccion.tokensSalida;
  }
  gasto += costeTurno;
  tokensEntrada += entradaTurno;
  tokensSalida += salidaTurno;

  const llamadas = (clasificacion === null ? 0 : 1) + espia.redacciones.length;
  lineas.push(
    `coste · ${llamadas} llamada(s) · ${entradaTurno} in / ${salidaTurno} out · ${dolares(costeTurno)} · sesión: ${dolares(gasto)}`,
  );

  bajoLaLinea(lineas);
}

async function conversacionActual(): Promise<string | null> {
  const filas = await admin`
    select c.id from motor.conversations c
      join motor.patients p on p.id = c.patient_id
     where c.client_id = ${clientId} and p.phone_e164 = ${telefono}
     order by c.created_at desc limit 1
  `;
  return filas[0] === undefined ? null : String(filas[0]['id']);
}

async function huecoPendiente(): Promise<string | null> {
  const conversacion = await conversacionActual();
  if (conversacion === null) return null;
  const filas = await admin`
    select id from motor.holds
     where client_id = ${clientId} and conversation_id = ${conversacion}
       and state = 'pendiente_recepcion'
     order by created_at desc limit 1
  `;
  return filas[0] === undefined ? null : String(filas[0]['id']);
}

function ayuda(): void {
  titulo('Comandos');
  console.log(
    [
      '  /nuevo             empezar una conversación desde cero (paciente nuevo)',
      '  /cliente <slug>    cambiar de clínica',
      '  /tiempo +2h        saltar en el tiempo (+30m, +2h, +3d) para ver vencimientos',
      '  /caducar           ejecutar /caducar-retenciones ahora mismo',
      '  /recepcion         simular «Ya la he metido en agenda» del hueco pendiente',
      '  /ocupar <n>        que la clínica ocupe el hueco n por su cuenta (para el paso 6)',
      '  /asistida          cerrar el ciclo de la cita confirmada',
      '  /atender           marcar el último escalado como atendido (saca de pausa)',
      '  /estado            volcar el estado actual',
      '  /gasto             gasto acumulado de la sesión',
      '  /ayuda   /salir',
    ].join('\n'),
  );
}

async function estado(): Promise<void> {
  const conversacion = await conversacionActual();
  titulo('Estado');
  console.log(`  clínica:   ${slug} (${clientId})`);
  console.log(`  paciente:  ${telefono}`);
  console.log(`  reloj:     ${hora(reloj(), zona())}${desfaseMs === 0 ? '' : c.ambar(' (desplazado)')}`);
  if (conversacion === null) {
    console.log('  conversación: ninguna todavía');
    return;
  }
  const filas = await admin`
    select status, paused_at, pause_reason from motor.conversations where id = ${conversacion}
  `;
  console.log(
    `  conversación: ${String(filas[0]?.['status'])}${
      filas[0]?.['pause_reason'] == null ? '' : ` (${String(filas[0]['pause_reason'])})`
    }`,
  );
  await panelDelTurno(conversacion);
}

function desplazar(expresion: string): boolean {
  const m = /^([+-]?)(\d+)([mhd])$/.exec(expresion.trim());
  if (m === null) return false;
  const signo = m[1] === '-' ? -1 : 1;
  const cantidad = Number(m[2]);
  const unidad = { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[3] as 'm' | 'h' | 'd'];
  desfaseMs += signo * cantidad * unidad;
  return true;
}

async function comando(linea: string): Promise<boolean> {
  const [nombre, ...resto] = linea.slice(1).trim().split(/\s+/);
  const argumento = resto.join(' ');

  switch (nombre) {
    case 'salir':
      return false;

    case 'ayuda':
      ayuda();
      return true;

    case 'nuevo':
      telefono = `+34600${String(Math.floor(Math.random() * 900000) + 100000)}`;
      turno = 0;
      console.log(c.gris(`   nueva conversación · paciente ${telefono}`));
      return true;

    case 'cliente':
      try {
        await asegurarCliente(argumento);
        telefono = `+34600${String(Math.floor(Math.random() * 900000) + 100000)}`;
        console.log(c.gris(`   clínica ${slug} · paciente ${telefono}`));
      } catch (error: unknown) {
        console.log(c.rojo(`   ${error instanceof Error ? error.message : String(error)}`));
        console.log(c.gris(`   clínicas cargadas: ${registro.slugs().join(', ')}`));
      }
      return true;

    case 'tiempo':
      if (!desplazar(argumento)) {
        console.log(c.rojo('   formato: /tiempo +2h  (m, h o d)'));
        return true;
      }
      console.log(c.gris(`   reloj: ${hora(reloj(), zona())}`));
      return true;

    case 'caducar': {
      const salida = await caducarRetenciones(deps, { clientId });
      bajoLaLinea([
        salida.diferidoPorHorario
          ? `${c.ambar('diferido por horario')} · ${salida.restantes} esperando a que abra la franja`
          : `aplicados: ${salida.aplicados.length} · restantes: ${salida.restantes}`,
        ...salida.aplicados.map(
          (a) => `  ${a.desde} → ${a.hasta} · ${a.efectos.map((e) => e.tipo).join(', ')}`,
        ),
      ]);
      return true;
    }

    case 'recepcion': {
      const holdId = await huecoPendiente();
      if (holdId === null) {
        console.log(c.rojo('   no hay ningún hueco pendiente de recepción'));
        return true;
      }
      const { cuerpo } = await accionRecepcion(deps, {
        idempotencyKey: `chat-recepcion-${Date.now()}`,
        clientId,
        holdId,
      });
      console.log(`${c.fuerte('clínica →')} ${cuerpo.respuesta}`);
      bajoLaLinea([
        `recepción · ${cuerpo.estado === 'confirmada' ? c.verde('confirmada') : c.rojo('colisionada')}` +
          (cuerpo.citaId === null ? '' : ` · cita ${cuerpo.citaId}`),
      ]);
      return true;
    }

    case 'ocupar': {
      const conversacion = await conversacionActual();
      if (conversacion === null) return true;
      const filas = await admin`
        select slot_start, slot_end from motor.holds
         where client_id = ${clientId} and conversation_id = ${conversacion}
         order by rank nulls last limit 3
      `;
      const indice = Number(argumento || '1') - 1;
      const elegido = filas[indice];
      if (elegido === undefined) {
        console.log(c.rojo('   no hay hueco con ese número'));
        return true;
      }
      agenda.ocupar(new Date(String(elegido['slot_start'])), new Date(String(elegido['slot_end'])));
      console.log(c.gris(`   la clínica ha ocupado el hueco ${indice + 1} por su cuenta`));
      return true;
    }

    case 'asistida': {
      const conversacion = await conversacionActual();
      if (conversacion === null) return true;
      const filas = await admin`
        select id from motor.appointments
         where client_id = ${clientId} and conversation_id = ${conversacion}
         order by created_at desc limit 1
      `;
      if (filas[0] === undefined) {
        console.log(c.rojo('   no hay ninguna cita confirmada'));
        return true;
      }
      const salida = await registrarResultadoDeCita(deps, {
        clientId,
        citaId: String(filas[0]['id']),
        outcome: 'asistida',
        fuente: 'recepcion',
      });
      bajoLaLinea([
        `cita · asistida · hueco ${salida.estadoHueco} (${salida.motivoLiberacion}) · cuenta como generada: ${String(salida.cuentaComoGenerada)}`,
      ]);
      return true;
    }

    case 'atender': {
      const conversacion = await conversacionActual();
      if (conversacion === null) return true;
      const filas = await admin`
        select id from motor.escalations
         where client_id = ${clientId} and conversation_id = ${conversacion} and state = 'abierta'
         order by created_at desc limit 1
      `;
      if (filas[0] === undefined) {
        console.log(c.rojo('   no hay escalados abiertos'));
        return true;
      }
      const salida = await marcarEscaladoAtendido(deps, {
        idempotencyKey: `chat-atender-${String(filas[0]['id'])}`,
        clientId,
        escaladoId: String(filas[0]['id']),
        atendidoPor: 'banco de pruebas',
      });
      bajoLaLinea([
        `escalado ${salida.estado} · conversación: ${salida.estadoConversacion ?? 'sin conversación'}` +
          (salida.sigueParadaPor.length > 0 ? ` · sigue parada por: ${salida.sigueParadaPor.join(', ')}` : ''),
      ]);
      return true;
    }

    case 'estado':
      await estado();
      return true;

    case 'gasto':
      bajoLaLinea([
        `sesión · ${tokensEntrada} tokens de entrada · ${tokensSalida} de salida · ${dolares(gasto)} aproximados`,
      ]);
      return true;

    default:
      console.log(c.rojo(`   comando desconocido: /${String(nombre)}`));
      ayuda();
      return true;
  }
}

async function main(): Promise<void> {
  await asegurarCliente(slugInicial);

  titulo(`Banco de pruebas · ${registro.obtener(slug).config.nombre}`);
  console.log(c.gris('   Escribe como si fueras un paciente por WhatsApp.'));
  console.log(c.gris(`   Modelo REAL contra el Docker local. Cada turno cuesta dinero.`));
  console.log(c.gris(`   paciente ${telefono} · /ayuda para los comandos\n`));

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // Si la entrada se acaba (Ctrl-D, o una tubería que termina), se sale en vez
  // de quedarse esperando para siempre.
  let entradaCerrada = false;
  rl.on('close', () => {
    entradaCerrada = true;
  });

  for (;;) {
    if (entradaCerrada) break;
    const leida = await rl.question(c.fuerte('paciente → ')).catch(() => null);
    if (leida === null) break;
    const linea = leida.trim();
    if (linea.length === 0) continue;

    if (linea.startsWith('/')) {
      if (!(await comando(linea))) break;
      continue;
    }

    turno += 1;
    espia.reiniciarTurno();

    try {
      const { cuerpo } = await procesarMensajeEntrante(deps, {
        idempotencyKey: `chat-${telefono}-${turno}`,
        clientId,
        telefono,
        nombre: 'Paciente',
        texto: linea,
      });

      if (cuerpo.respuesta === null) {
        console.log(`${c.fuerte('clínica →')} ${c.gris('(silencio: no se envía nada)')}`);
      } else {
        console.log(`${c.fuerte('clínica →')} ${cuerpo.respuesta}`);
      }
      if (cuerpo.estadoConversacion !== 'abierta') {
        console.log(c.ambar(`   conversación ${cuerpo.estadoConversacion}`));
      }
      await panelDelTurno(cuerpo.conversacionId);
      if (cuerpo.efectos.length > 0) {
        bajoLaLinea([`efectos para n8n · ${cuerpo.efectos.map((e) => e.tipo).join(', ')}`]);
      }
    } catch (error: unknown) {
      console.log(c.rojo(`   error: ${error instanceof Error ? error.message : String(error)}`));
    }
    console.log('');
  }

  rl.close();
  titulo('Fin de la sesión');
  console.log(
    `  ${tokensEntrada} tokens de entrada · ${tokensSalida} de salida · ${c.fuerte(dolares(gasto))} aproximados\n`,
  );
  await core.close();
  await admin.end();
}

await main();
