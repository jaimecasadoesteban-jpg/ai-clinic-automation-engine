/**
 * El panel en local, contra la base de pruebas (Docker) y con datos sembrados,
 * para verlo en el navegador sin desplegar: `npx tsx scripts/panel-local.ts`
 * y abrir http://localhost:3999/panel (usuario `prueba`, clave `contraseña-de-prueba`).
 * Borra y siembra una clínica de pruebas propia; no toca nada más.
 */
import { buildServer } from '../src/api/server.js';
import { createCore } from '../src/db/client.js';
import { hashDeClave } from '../src/panel/sesion.js';
import { AgendaFalsa, configDePrueba, dependenciasDePrueba, registroDePrueba } from '../tests/support/fakes.js';
import { APP_URL, conexionAdmin, prepararBaseDeDatos } from '../tests/support/db.js';

const CLINICA = 'feed0000-0000-4000-8000-00000000feed';
const admin = conexionAdmin();
await prepararBaseDeDatos(admin);
for (const t of ['outbox', 'audit_log', 'escalations', 'messages', 'appointments', 'holds', 'conversations', 'patients']) {
  await admin.unsafe(`delete from motor.${t} where client_id = $1`, [CLINICA]);
}
await admin`delete from motor.clients where id = ${CLINICA}`;
await admin`insert into motor.clients (id, slug, name, config, config_version) values (${CLINICA}, 'clinica-de-pruebas', 'Clínica', '{}'::jsonb, 'local')`;
const pacientes = [
  ['Lola', '+34600123456', [['entrante', 'Hola, quería cita para láser de axilas'], ['saliente', 'Tengo el martes 20 a las 10:00, 11:00 o 12:00, ¿te encaja alguna?', 'claude-opus-5'], ['entrante', 'Martes a las 10'], ['saliente', 'Confirmada tu cita de láser axilas del martes 20, 10:00, ahí te esperamos.', null]]],
  ['Marta', '+34611222333', [['entrante', 'Desde la última sesión tengo la zona un poco roja, no sé si es normal'], ['saliente', 'Gracias por contárnoslo. Lo ve ahora una persona del equipo y te escribe.', null]]],
  ['Ana', '+34622333444', [['entrante', '¿Cuánto cuesta la limpieza facial?'], ['saliente', 'La limpieza facial profunda son 55 €.', 'claude-opus-5']]],
  ['Rocío', '+34633444555', Array.from({ length: 40 }, (_, k) => (k % 2 === 0 ? ['entrante', `Mensaje ${k} de la paciente, bastante largo para ocupar sitio en la pantalla`] : ['saliente', `Respuesta ${k} del agente`, 'claude-opus-5']))],
] as const;
let t = Date.now() - 3 * 3_600_000;
for (const [i, [nombre, tel, mensajes]] of pacientes.entries()) {
  const [p] = await admin`insert into motor.patients (client_id, given_name, phone_e164, agent_stopped_at) values (${CLINICA}, ${nombre}, ${tel}, ${i === 1 ? new Date().toISOString() : null}) returning id`;
  const [c] = await admin`insert into motor.conversations (client_id, patient_id, reply_channel) values (${CLINICA}, ${p?.['id']}, ${JSON.stringify({ por: 'chatwoot', cuentaId: 7, conversacionId: 100 + i })}::jsonb) returning id`;
  for (const [dir, body, model] of mensajes as ReadonlyArray<readonly [string, string, (string | null)?]>) {
    t += 4 * 60_000;
    await admin`insert into motor.messages (client_id, conversation_id, direction, body, is_clinical, purge_at, created_at, model, firewall_category)
                values (${CLINICA}, ${c?.['id']}, ${dir}, ${body}, false, now() + interval '1 year', ${new Date(t).toISOString()}, ${model ?? null}, ${i === 1 && dir === 'entrante' ? 'urgencia_clinica' : null})`;
  }
  // Citas repartidas por la semana para ver el calendario: a horas en punto de Madrid.
  const enMadrid = (dias: number, hora: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + dias);
    d.setUTCHours(hora - 2, 0, 0, 0); // Madrid en verano: UTC+2
    return d;
  };
  for (const [dias, hora, estado, servicio] of [
    [i + 1, 10 + i, 'confirmada', 'laser-axilas'],
    [i + 2, 17, 'retenida', 'laser-piernas'],
    [-(i + 1), 11 + i, 'liberada', 'laser-axilas'],
  ] as const) {
    const inicio = enMadrid(dias, hora);
    const dur = servicio === 'laser-piernas' ? 45 : 20;
    const [h] = await admin`insert into motor.holds (client_id, patient_id, conversation_id, slot_start, slot_end, service_code, state, state_changed_at, release_reason)
                values (${CLINICA}, ${p?.['id']}, ${c?.['id']}, ${inicio.toISOString()}, ${new Date(inicio.getTime() + dur * 60_000).toISOString()}, ${servicio}, ${estado}, now(), ${estado === 'liberada' ? 'ciclo_cerrado' : null})
                returning id`;
    if (estado !== 'retenida') {
      await admin`insert into motor.appointments (client_id, patient_id, conversation_id, hold_id, slot_start, slot_end, service_code, outcome)
                  values (${CLINICA}, ${p?.['id']}, ${c?.['id']}, ${h?.['id']}, ${inicio.toISOString()}, ${new Date(inicio.getTime() + dur * 60_000).toISOString()}, ${servicio}, ${estado === 'liberada' ? (i === 1 ? 'no_asistida' : 'asistida') : 'pendiente'})`;
    }
  }
  // Una cita de hoy pendiente de meter en la agenda, y un chat esperando respuesta.
  if (i === 2) {
    const inicio = enMadrid(0, 19);
    await admin`insert into motor.holds (client_id, patient_id, conversation_id, slot_start, slot_end, service_code, state, state_changed_at, reception_notified_at)
                values (${CLINICA}, ${p?.['id']}, ${c?.['id']}, ${inicio.toISOString()}, ${new Date(inicio.getTime() + 20 * 60_000).toISOString()}, 'laser-axilas', 'pendiente_recepcion', now(), now())`;
    t += 60_000;
    await admin`insert into motor.messages (client_id, conversation_id, direction, body, is_clinical, purge_at, created_at)
                values (${CLINICA}, ${c?.['id']}, 'entrante', '¿Y aceptáis pago con tarjeta?', false, now() + interval '1 year', now() - interval '5 minutes')`;
  }
  if (i === 99) {
    const inicio = new Date(Date.now() + 2 * 86_400_000);
    await admin`insert into motor.holds (client_id, patient_id, conversation_id, slot_start, slot_end, service_code, state, state_changed_at)
                values (${CLINICA}, ${p?.['id']}, ${c?.['id']}, ${inicio.toISOString()}, ${new Date(inicio.getTime() + 20 * 60_000).toISOString()}, 'laser-axilas', 'confirmada', now())`;
  }
  if (i === 1) {
    await admin`insert into motor.escalations (client_id, conversation_id, patient_id, reason, severity, created_at) values (${CLINICA}, ${c?.['id']}, ${p?.['id']}, 'urgencia_clinica', 3, now())`;
    await admin`insert into motor.escalations (client_id, conversation_id, patient_id, reason, severity, created_at) values (${CLINICA}, ${c?.['id']}, ${p?.['id']}, 'latido_perdido', 2, now() - interval '3 days')`;
  }
  if (i === 2) {
    await admin`insert into motor.escalations (client_id, conversation_id, patient_id, reason, severity, created_at) values (${CLINICA}, ${c?.['id']}, ${p?.['id']}, 'validacion_fallida', 2, now() - interval '2 hours')`;
  }
}
await admin.end();

const core = createCore(APP_URL);
const configuracion = registroDePrueba([{ slug: 'clinica-de-pruebas', config: configDePrueba({ canal: { tipo: 'whatsapp', remitenteId: '000', chatwoot: { cuentaId: 7, inboxId: 42 } } }) }]);
const app = await buildServer({
  logLevel: 'warn',
  token: 'token-local-del-nucleo-de-pruebas',
  deps: dependenciasDePrueba({ core, agenda: new AgendaFalsa(), reloj: () => new Date(), configuracion }),
  panel: { usuario: 'prueba', claveHash: hashDeClave('contraseña-de-prueba'), secreto: 'secreto-local-de-sesiones-del-panel' },
});
await app.listen({ host: '127.0.0.1', port: 3999 });
console.log('panel en http://localhost:3999/panel');
