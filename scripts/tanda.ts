import { existsSync } from 'node:fs';

import postgres from 'postgres';

import { AgenteAnthropic, crearCliente } from '../src/agent/anthropic.js';
import { cargarConfiguracion } from '../src/config/registry.js';
import type { Intervalo } from '../src/core/disponibilidad.js';
import { createCore } from '../src/db/client.js';
import { procesarMensajeEntrante, type Dependencias } from '../src/service/pipeline.js';
import type { Agenda } from '../src/service/ports.js';
import { CONVERSACIONES, type Tipo } from './tanda/conversaciones.js';
import { seDesdice } from '../src/agent/retractacion.js';

/**
 * **Cuánto bloquea la validación de lo que está bien.**
 *
 * Cada regla de validación se ha probado con sus adversariales: miden lo que se
 * cuela. Nadie medía lo que se tira. La primera vez que se midió, un 12 % de los
 * turnos corrientes acababa escalado — todos por preguntar el horario, que la
 * regla de horas tomaba por huecos inventados — y un saludo escaló por leer un
 * mensaje falso del historial.
 *
 * Regla de docs/DESIGN_RULES.md: **ninguna regla de validación entra sin pasar esto antes y
 * después.** Va contra el Docker local y el modelo REAL: cuesta dinero (unos
 * 0,50 $ por pasada) y no es determinista, así que mide tasas, no aciertos.
 *
 *   npm run tanda            una pasada
 *   npm run tanda -- 3       tres pasadas
 */

if (existsSync('.env')) process.loadEnvFile('.env');

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
    console.error(`Falta ${nombre} en .env. La tanda va contra el Docker local: npm run db:test:up`);
    process.exit(1);
  }
}

/** Agenda vacía: todo libre. Lo que se mide es la validación, no la agenda. */
class AgendaLibre implements Agenda {
  ocupacion(): Promise<readonly Intervalo[]> {
    return Promise.resolve([]);
  }
  sigueLibre(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

type Resultado =
  | 'a_la_primera'
  | 'regenerado'
  | 'bloqueado_y_escalado'
  | 'texto_fijo'
  | 'cortafuegos'
  | 'proveedor_caido';

interface Fila {
  readonly conversacion: string;
  readonly turno: string;
  readonly tipo: Tipo;
  readonly revisar: boolean;
  readonly respuesta: string;
  readonly resultado: Resultado;
  readonly borradores: ReadonlyArray<{ texto: string; motivos: ReadonlyArray<{ tipo: string }> }>;
}

const pasadas = Number(process.argv[2] ?? 1);
// Para medir algo concreto con el mínimo de casos: `npm run tanda -- 3 cita`
// pasa sólo las conversaciones cuyo nombre contiene «cita». La tanda entera
// se corre antes de fusionar, no después de cada ajuste.
const filtro = process.argv[3];
const conversaciones = CONVERSACIONES.filter((c) => filtro === undefined || c.nombre.includes(filtro));
const admin = postgres(URL_ADMIN as string, { max: 2, onnotice: () => {} });
const core = createCore(URL_LOCAL as string);
const registro = cargarConfiguracion();
const { config, version } = registro.obtener('ejemplo');

const deps: Dependencias = {
  core,
  configuracion: registro,
  agente: new AgenteAnthropic(crearCliente(CLAVE as string)),
  agenda: new AgendaLibre(),
  pimienta: PIMIENTA as string,
  reloj: () => new Date(),
};

async function clinica(): Promise<string> {
  const filas = await admin`
    insert into motor.clients (id, slug, name, timezone, config, config_version)
    values (gen_random_uuid(), ${config.slug}, ${config.nombre}, ${config.zonaHoraria},
            ${admin.json(JSON.parse(JSON.stringify(config)))}, ${version})
    on conflict (slug) do update
      set config = excluded.config, config_version = excluded.config_version, active = true
    returning id
  `;
  return String(filas[0]?.['id']);
}

async function resultadoDelTurno(conversacionId: string): Promise<{
  resultado: Resultado;
  borradores: Fila['borradores'];
}> {
  const [fila] = await admin`
    select validation_result, firewall_category from motor.messages
     where conversation_id = ${conversacionId} and direction = 'saliente'
     order by created_at desc limit 1
  `;
  if (fila?.['firewall_category'] != null) return { resultado: 'cortafuegos', borradores: [] };
  const v = fila?.['validation_result'] as {
    valido?: boolean;
    proveedorCaido?: string | null;
    regeneraciones?: number;
    borradores?: Fila['borradores'];
  } | null;
  if (v == null) return { resultado: 'texto_fijo', borradores: [] };
  const borradores = v.borradores ?? [];
  if (v.proveedorCaido != null) return { resultado: 'proveedor_caido', borradores };
  if (v.valido === false) return { resultado: 'bloqueado_y_escalado', borradores };
  return { resultado: (v.regeneraciones ?? 0) > 0 ? 'regenerado' : 'a_la_primera', borradores };
}

async function main(): Promise<void> {
  const clientId = await clinica();
  const filas: Fila[] = [];

  for (let pasada = 1; pasada <= pasadas; pasada += 1) {
    for (const conversacion of conversaciones) {
      const telefono = `+34611${String(Math.floor(Math.random() * 900000) + 100000)}`;
      let n = 0;
      for (const turno of conversacion.turnos) {
        n += 1;
        const { cuerpo } = await procesarMensajeEntrante(deps, {
          idempotencyKey: `tanda-${telefono}-${n}`,
          clientId,
          telefono,
          nombre: 'Paciente',
          texto: turno.texto,
        });
        const { resultado, borradores } = await resultadoDelTurno(cuerpo.conversacionId);
        filas.push({
          conversacion: conversacion.nombre,
          turno: turno.texto,
          tipo: turno.tipo,
          revisar: turno.revisar === true,
          respuesta: cuerpo.respuesta ?? '(sin respuesta)',
          resultado,
          borradores,
        });
        process.stdout.write(resultado === 'a_la_primera' ? '.' : resultado[0] ?? '?');
      }
    }
  }
  console.log('\n');

  const validadas = filas.filter((f) =>
    ['a_la_primera', 'regenerado', 'bloqueado_y_escalado'].includes(f.resultado),
  );
  const cuenta = (r: Resultado, de: readonly Fila[] = filas): number =>
    de.filter((f) => f.resultado === r).length;
  const pct = (a: number, b: number): string => (b === 0 ? '—' : `${Math.round((100 * a) / b)} %`);

  console.log(`${filas.length} turnos · ${validadas.length} pasan por la validación`);
  for (const r of [
    'a_la_primera',
    'regenerado',
    'bloqueado_y_escalado',
    'texto_fijo',
    'cortafuegos',
    'proveedor_caido',
  ] as const) {
    console.log(`  ${r.padEnd(22)} ${cuenta(r)}`);
  }
  console.log(
    `\nSe tira (regenerado o escalado): ${pct(cuenta('regenerado') + cuenta('bloqueado_y_escalado'), validadas.length)}` +
      ` · escalado: ${pct(cuenta('bloqueado_y_escalado'), validadas.length)}`,
  );

  console.log('\nPor tipo de turno (se tira / validados):');
  const tipos = [...new Set(filas.map((f) => f.tipo))];
  for (const tipo of tipos) {
    const deTipo = validadas.filter((f) => f.tipo === tipo);
    const tirados = cuenta('regenerado', deTipo) + cuenta('bloqueado_y_escalado', deTipo);
    console.log(`  ${tipo.padEnd(12)} ${tirados}/${deTipo.length}`);
  }

  const malos = filas.filter((f) => f.borradores.length > 0 || f.resultado === 'bloqueado_y_escalado');
  if (malos.length > 0) console.log('\nLo que se tiró, con el borrador y la regla:');
  for (const f of malos) {
    console.log(`\n  [${f.resultado}] ${f.conversacion} · «${f.turno}»`);
    for (const b of f.borradores) {
      console.log(`    borrador: «${b.texto}»`);
      console.log(`    reglas:   ${b.motivos.map((m) => m.tipo).join(', ')}`);
    }
    console.log(`    salió:    «${f.respuesta}»`);
  }

  /**
   * El agente se desdice de algo que dijo la clínica. Aviso, no bloqueo: es
   * difuso y la defensa buena es estructural. Pero tiene que verse aquí, al
   * medir, y no la primera vez que lo lee un paciente. En conversación corriente
   * no debería salir nunca.
   */
  const retractaciones = filas.flatMap((f) =>
    [f.respuesta, ...f.borradores.map((b) => b.texto)]
      .map((t) => ({ f, t, hallado: seDesdice(t) }))
      .filter((x) => x.hallado !== null),
  );
  console.log(`\nSe desdice de algo dicho antes (aviso, no bloquea): ${retractaciones.length}`);
  for (const { f, t, hallado } of retractaciones) {
    console.log(`  ${f.conversacion} · «${f.turno}» → «${t}»  [${hallado?.id ?? ''}]`);
  }

  console.log('\nA leer a mano —ninguna regla puede comprobar si esto es verdad—:');
  for (const f of filas.filter((x) => x.revisar)) {
    console.log(`  «${f.turno}» → «${f.respuesta}»`);
  }

  await core.close();
  await admin.end();
}

await main();
