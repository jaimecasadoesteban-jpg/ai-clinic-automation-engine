/**
 * Public demo. Runs the REAL pipeline, state machine, safety firewall, output
 * validation and Row-Level Security against a throwaway local Postgres.
 *
 *     npm run db:test:up && npm run demo
 *
 * What is simulated, and only this:
 *   - The LLM. A scripted classifier and writer stand in for the two models, so
 *     the demo needs no API key and always prints the same result.
 *   - Google Calendar. An in-memory calendar returns raw busy times.
 *
 * All clinics, patients, phone numbers and messages here are fictional. Nothing
 * leaves this machine. Patient-facing text is in Spanish because the product
 * serves clinics in Spain.
 */
import type { Extraccion } from '../src/agent/extraccion.js';
import type { Correccion, HuecoDisponible, Redaccion, Redactor } from '../src/service/ports.js';

const LOCAL_ADMIN = 'postgres://postgres@127.0.0.1:5544/motor_test';
const LOCAL_APP = 'postgres://motor_app@127.0.0.1:5544/motor_test';
process.env['TEST_DATABASE_URL'] ??= LOCAL_ADMIN;
process.env['TEST_APP_DATABASE_URL'] ??= LOCAL_APP;

// The demo recreates the schema, so it must never point at anything but localhost.
for (const name of ['TEST_DATABASE_URL', 'TEST_APP_DATABASE_URL']) {
  const host = new URL(process.env[name] ?? '').hostname;
  if (host !== '127.0.0.1' && host !== 'localhost') {
    console.error(`Refusing to run: ${name} does not point at localhost.`);
    process.exit(1);
  }
}

const { createCore } = await import('../src/db/client.js');
const { cargarConfiguracion } = await import('../src/config/registry.js');
const { procesarMensajeEntrante } = await import('../src/service/pipeline.js');
const { accionRecepcion } = await import('../src/service/reception.js');
const { AgendaFalsa, AgenteFalso, ClasificadorFalso } = await import('../tests/support/fakes.js');
const { APP_URL, conexionAdmin, conexionApp, prepararBaseDeDatos } = await import('../tests/support/db.js');

const NOW = new Date('2030-03-04T10:00:00.000Z'); // A Monday, so the output is stable.
const TZ = 'Europe/Madrid';
const CLINIC_A = 'a0000000-0000-4000-8000-00000000000a';
const CLINIC_B = 'b0000000-0000-4000-8000-00000000000b';

const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;
const grey = (s: string): string => `\x1b[90m${s}\x1b[0m`;
const green = (s: string): string => `\x1b[32m${s}\x1b[0m`;
const red = (s: string): string => `\x1b[31m${s}\x1b[0m`;

function slot(fecha: Date): string {
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: TZ,
    weekday: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .format(fecha)
    .replace(',', ' a las');
}

/** Stand-in for the writing model. It may be told to say something false. */
class ScriptedWriter implements Redactor {
  calls = 0;
  readonly blocked: Correccion[] = [];
  constructor(private readonly script: string[] = []) {}

  redactar(entrada: {
    huecos?: readonly HuecoDisponible[];
    correccion?: Correccion | undefined;
  }): Promise<Redaccion> {
    this.calls += 1;
    if (entrada.correccion !== undefined) this.blocked.push(entrada.correccion);
    const huecos = entrada.huecos ?? [];
    const texto =
      this.script.shift() ??
      `Para depilación láser de axilas tengo ${huecos.map((h) => slot(h.inicio)).join(', ')}. ¿Cuál te viene mejor?`;
    return Promise.resolve({ texto, modelo: 'scripted-writer', tokensEntrada: 0, tokensSalida: 0 });
  }
}

function extraction(extra: Partial<Extraccion>): Extraccion {
  return {
    intencion: 'otro',
    servicio: null,
    opcion: null,
    preferencia: null,
    escalar: null,
    cita: null,
    sustitucion: null,
    tema: null,
    ...extra,
  };
}

const admin = conexionAdmin();
await prepararBaseDeDatos(admin);

const registry = cargarConfiguracion();
const { config, version } = registry.obtener('ejemplo');
for (const [id, slug, name] of [
  [CLINIC_A, 'ejemplo', config.nombre],
  [CLINIC_B, 'otra-clinica', 'Second Demo Clinic'],
] as const) {
  await admin`
    insert into motor.clients (id, slug, name, timezone, config, config_version)
    values (${id}, ${slug}, ${name}, ${config.zonaHoraria}, ${JSON.stringify(config)}::jsonb, ${version})
  `;
}

const core = createCore(APP_URL);
let key = 0;

/** One patient turn through the real pipeline. Returns the agent's reply. */
async function turn(input: {
  phone: string;
  name: string;
  text: string;
  english: string;
  extractions: readonly Extraccion[];
  writer: ScriptedWriter;
  calendar: InstanceType<typeof AgendaFalsa>;
}): Promise<void> {
  key += 1;
  console.log(`  ${bold('Patient:')} ${input.text} ${grey(`(${input.english})`)}`);
  const { cuerpo } = await procesarMensajeEntrante(
    {
      core,
      configuracion: registry,
      agente: new AgenteFalso(new ClasificadorFalso(input.extractions), input.writer),
      agenda: input.calendar,
      pimienta: 'demo-pepper-not-a-secret',
      reloj: () => NOW,
    },
    { idempotencyKey: `demo-${key}`, clientId: CLINIC_A, telefono: input.phone, nombre: input.name, texto: input.text },
  );
  console.log(`  ${bold('Agent:  ')} ${cuerpo.respuesta ?? grey('(no message yet)')}`);
}

async function holdsOf(phone: string): Promise<Array<{ id: string; state: string; start: Date; end: Date }>> {
  const rows = await admin`
    select h.id, h.state, h.slot_start, h.slot_end from motor.holds h
      join motor.patients p on p.id = h.patient_id
     where h.client_id = ${CLINIC_A} and p.phone_e164 = ${phone}
     order by h.rank nulls last, h.slot_start
  `;
  return rows.map((r) => ({
    id: String(r['id']),
    state: String(r['state']),
    start: new Date(String(r['slot_start'])),
    end: new Date(String(r['slot_end'])),
  }));
}

async function printHolds(phone: string): Promise<void> {
  for (const h of await holdsOf(phone)) console.log(grey(`           database: ${h.state.padEnd(20)} ${slot(h.start)}`));
}

function heading(n: number, title: string, why: string): void {
  console.log(`\n${bold(`${n}. ${title}`)}\n${grey(`   ${why}`)}`);
}

console.log(bold('\nAI Clinic Automation Engine: demo'));
console.log(grey('Real pipeline and database. The LLM and the calendar are simulated. All data is fictional.'));

// ---------------------------------------------------------------------------
heading(1, 'Booking, with a human in the loop', 'The agent cannot book. Code decides, and the patient hears "confirmed" only after staff act and the calendar is re-read.');
{
  const calendar = new AgendaFalsa();
  const writer = new ScriptedWriter();
  const phone = '+34600000101';
  await turn({
    phone, name: 'Lucía', calendar, writer,
    text: 'Hola, quiero cita para láser de axilas',
    english: 'Hi, I would like a laser underarm appointment',
    extractions: [extraction({ intencion: 'agendar', servicio: 'laser-axilas' })],
  });
  await printHolds(phone);
  await turn({
    phone, name: 'Lucía', calendar, writer,
    text: 'La segunda',
    english: 'The second one',
    extractions: [extraction({ intencion: 'elegir_hueco', opcion: 2 })],
  });
  await printHolds(phone);
  const pending = (await holdsOf(phone)).find((h) => h.state === 'pendiente_recepcion');
  if (pending === undefined) throw new Error('Demo expected a slot waiting for reception.');
  console.log(`  ${bold('Staff:  ')} clicks "Ya la he metido en agenda" ${grey('(I have added it to the calendar)')}`);
  key += 1;
  const { cuerpo } = await accionRecepcion(
    { core, configuracion: registry, agente: new AgenteFalso(new ClasificadorFalso(), writer), agenda: calendar, pimienta: 'demo-pepper-not-a-secret', reloj: () => NOW },
    { idempotencyKey: `demo-${key}`, clientId: CLINIC_A, holdId: pending.id },
  );
  console.log(`  ${bold('Agent:  ')} ${cuerpo.respuesta}`);
  await printHolds(phone);
}

// ---------------------------------------------------------------------------
heading(2, 'Calendar conflict caught before confirming', 'Someone takes the slot at the front desk. The re-read detects it and the patient moves to their next option instead of receiving a false confirmation.');
{
  const calendar = new AgendaFalsa();
  const writer = new ScriptedWriter();
  const phone = '+34600000102';
  await turn({
    phone, name: 'Marta', calendar, writer,
    text: 'Quiero cita para láser de axilas',
    english: 'I would like a laser underarm appointment',
    extractions: [extraction({ intencion: 'agendar', servicio: 'laser-axilas' })],
  });
  await turn({
    phone, name: 'Marta', calendar, writer,
    text: 'La primera',
    english: 'The first one',
    extractions: [extraction({ intencion: 'elegir_hueco', opcion: 1 })],
  });
  const pending = (await holdsOf(phone)).find((h) => h.state === 'pendiente_recepcion');
  if (pending === undefined) throw new Error('Demo expected a slot waiting for reception.');
  calendar.ocupar(pending.start, pending.end);
  console.log(`  ${bold('Staff:  ')} books that slot by phone for someone else, then clicks the button`);
  key += 1;
  const { cuerpo } = await accionRecepcion(
    { core, configuracion: registry, agente: new AgenteFalso(new ClasificadorFalso(), writer), agenda: calendar, pimienta: 'demo-pepper-not-a-secret', reloj: () => NOW },
    { idempotencyKey: `demo-${key}`, clientId: CLINIC_A, holdId: pending.id },
  );
  console.log(`  ${bold('Agent:  ')} ${cuerpo.respuesta}`);
  await printHolds(phone);
}

// ---------------------------------------------------------------------------
heading(3, 'Clinical safety firewall', 'A soft-spoken possible side effect. Deterministic rules run BEFORE any LLM call; the reply is fixed text approved by the clinic.');
{
  const writer = new ScriptedWriter();
  const phone = '+34600000103';
  await turn({
    phone, name: 'Nuria', calendar: new AgendaFalsa(), writer,
    text: 'Por cierto, desde la última sesión tengo la zona un poco roja, no sé si es normal',
    english: 'By the way, since my last session the area is a little red, not sure if that is normal',
    extractions: [],
  });
  const [e] = await admin`select reason, severity from motor.escalations where client_id = ${CLINIC_A} order by created_at desc limit 1`;
  const [c] = await admin`select c.status from motor.conversations c join motor.patients p on p.id = c.patient_id where p.phone_e164 = ${phone}`;
  console.log(grey(`           LLM calls: ${writer.calls} · escalated: ${String(e?.['reason'])} (severity ${String(e?.['severity'])}) · conversation: ${String(c?.['status'])}`));
}

// ---------------------------------------------------------------------------
heading(4, 'Output validation', 'The model is told to invent a price. Every euro amount is checked against the catalog; a bad draft is regenerated and never reaches the patient.');
{
  const writer = new ScriptedWriter(['La limpieza facial te sale por 40 €.', 'La limpieza facial profunda son 55 €.']);
  await turn({
    phone: '+34600000104', name: 'Ana', calendar: new AgendaFalsa(), writer,
    text: '¿Cuánto cuesta la limpieza facial?',
    english: 'How much is the facial?',
    extractions: [extraction({ intencion: 'precio', servicio: 'limpieza-facial' })],
  });
  for (const b of writer.blocked) console.log(`  ${red('Blocked:')} ${b.textoAnterior}`);
  console.log(grey(`           LLM drafts written: ${writer.calls} · catalog price: 55 €`));
}

// ---------------------------------------------------------------------------
heading(5, 'Tenant isolation, enforced by the database', 'Postgres Row-Level Security with a role that cannot bypass it. A query with no clinic context fails instead of returning rows.');
{
  const app = conexionApp();
  try {
    await app`select count(*) from motor.patients`;
    console.log(red('  No context: query succeeded. THIS WOULD BE A BUG.'));
  } catch (error) {
    console.log(`  No clinic context:   ${green('rejected')} (Postgres error ${String((error as { code?: string }).code)})`);
  }
  for (const [label, id] of [['Clinic A context:', CLINIC_A], ['Clinic B context:', CLINIC_B]] as const) {
    const n = await app.begin(async (sql) => {
      await sql`select set_config('app.client_id', ${id}, true)`;
      const [row] = await sql`select count(*)::int as n from motor.patients`;
      return Number(row?.['n']);
    });
    console.log(`  ${label.padEnd(20)} sees ${n} patient(s)`);
  }
  await app.end();
  const failures = await core.comprobarAislamiento();
  console.log(`  Startup self-check:  ${failures.length === 0 ? green('passed') : red(failures.join('; '))} ${grey('(in production the server refuses to start if this fails)')}`);
}

console.log(green('\nDemo finished. Nothing was sent anywhere.\n'));
await core.close();
await admin.end();
