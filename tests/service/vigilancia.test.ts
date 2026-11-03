import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createCore, type Core } from '../../src/db/client.js';
import { generarInforme } from '../../src/service/informe.js';
import { procesarMensajeEntrante } from '../../src/service/pipeline.js';
import { caducarRetenciones } from '../../src/service/vencimientos.js';
import { vigilarDerechos } from '../../src/service/vigilancia.js';
import { AgendaFalsa, dependenciasDePrueba } from '../support/fakes.js';
import { APP_URL, conexionAdmin, prepararBaseDeDatos } from '../support/db.js';

/**
 * Vigilar lo que el sistema promete.
 *
 * **Registrar el incumplimiento en vez de evitarlo es peor que no registrarlo,
 * porque deja la prueba.** `rights_requests` guardaba la fecha de vencimiento
 * del plazo legal y nada la leía: el sistema documentaba puntualmente que la
 * clínica se había pasado de fecha.
 *
 * Y la ausencia de señal es el fallo más traicionero que hay: si el cron de
 * vencimientos deja de llamar, no salta ningún error — simplemente la gente se
 * queda con huecos que no caducan y sin el mensaje que le tocaba.
 */

const CLINICA = '55556666-5555-4555-8555-555566660000';
const AHORA = new Date('2026-09-14T10:00:00.000Z');

const admin = conexionAdmin();
let core: Core;
let contador = 0;

function deps(ahora = AHORA) {
  return dependenciasDePrueba({ core, agenda: new AgendaFalsa(), reloj: () => ahora });
}

async function enviar(texto: string, ahora = AHORA): Promise<Awaited<ReturnType<typeof procesarMensajeEntrante>>> {
  contador += 1;
  return procesarMensajeEntrante(deps(ahora), {
    idempotencyKey: `vig-${contador}`,
    clientId: CLINICA,
    telefono: '+34600505050',
    nombre: 'Pilar',
    texto,
  });
}

beforeAll(async () => {
  await prepararBaseDeDatos(admin);
  core = createCore(APP_URL);
}, 60_000);

afterAll(async () => {
  await core.close();
  await admin.end();
});

beforeEach(async () => {
  for (const tabla of [
    'audit_log',
    'idempotency_keys',
    'job_runs',
    'rights_requests',
    'appointments',
    'escalations',
    'messages',
    'holds',
    'conversations',
    'suppression',
    'patients',
  ]) {
    await admin.unsafe(`delete from motor.${tabla} where client_id = $1`, [CLINICA]);
  }
  await admin`delete from motor.clients where id = ${CLINICA}`;
  await admin`
    insert into motor.clients (id, slug, name, config, config_version)
    values (${CLINICA}, 'clinica-de-pruebas', 'Clínica Vigilancia', '{}'::jsonb, 'test')
  `;
  contador = 0;
});

describe('el plazo de un mes se avisa ANTES de que venza', () => {
  it('a los 20 días avisa, y no repite al día siguiente', async () => {
    await enviar('quiero que borreis mis datos');

    const alDia19 = await vigilarDerechos(deps(new Date(AHORA.getTime() + 19 * 86_400_000)), {
      clientId: CLINICA,
    });
    expect(alDia19.avisadas).toEqual([]);

    const alDia20 = await vigilarDerechos(deps(new Date(AHORA.getTime() + 20 * 86_400_000)), {
      clientId: CLINICA,
    });
    expect(alDia20.avisadas).toHaveLength(1);
    expect(alDia20.avisadas[0]?.derecho).toBe('supresion');
    expect(alDia20.avisadas[0]?.diasRestantes).toBe(10);

    // Un aviso diario sobre lo mismo se deja de leer en tres días, que es justo
    // cuando haría falta.
    const alDia21 = await vigilarDerechos(deps(new Date(AHORA.getTime() + 21 * 86_400_000)), {
      clientId: CLINICA,
    });
    expect(alDia21.avisadas).toEqual([]);
  });

  it('a los 27 vuelve a avisar, y con severidad mayor', async () => {
    await enviar('quiero que borreis mis datos');
    await vigilarDerechos(deps(new Date(AHORA.getTime() + 20 * 86_400_000)), { clientId: CLINICA });

    const alDia27 = await vigilarDerechos(deps(new Date(AHORA.getTime() + 27 * 86_400_000)), {
      clientId: CLINICA,
    });

    expect(alDia27.avisadas).toHaveLength(1);
    expect(alDia27.efectos).toContainEqual(
      expect.objectContaining({ severidad: 3, motivo: 'derechos_rgpd' }),
    );
  });

  it('una solicitud cerrada deja de avisar', async () => {
    await enviar('quiero que borreis mis datos');
    await admin`update motor.rights_requests set state = 'cerrada', closed_at = now()
                 where client_id = ${CLINICA}`;

    const salida = await vigilarDerechos(deps(new Date(AHORA.getTime() + 27 * 86_400_000)), {
      clientId: CLINICA,
    });
    expect(salida.avisadas).toEqual([]);
  });

  it('el informe semanal las lleva delante, con los días que quedan', async () => {
    await enviar('quiero una copia de mis datos');

    const informe = await generarInforme(deps(), {
      clientId: CLINICA,
      desde: '2026-09-01',
      hasta: '2026-09-30',
    });

    expect(informe.derechosAbiertos).toHaveLength(1);
    expect(informe.derechosAbiertos[0]?.derecho).toBe('acceso');
    expect(informe.derechosAbiertos[0]?.diasRestantes).toBe(30);
  });
});

describe('la ausencia de señal', () => {
  it('el cron deja constancia de que ha llamado', async () => {
    await caducarRetenciones(deps(), { clientId: CLINICA });

    const filas = await admin`
      select job from motor.job_runs where client_id = ${CLINICA}
    `;
    expect(filas.map((f) => String(f['job']))).toContain('caducar-retenciones');
  });

  it('si lleva horas sin llamar, el siguiente mensaje de un paciente lo destapa', async () => {
    await caducarRetenciones(deps(), { clientId: CLINICA });
    // Cinco horas después, el cron no ha vuelto a llamar.
    const tarde = new Date(AHORA.getTime() + 5 * 3_600_000);

    const { cuerpo } = await enviar('hola, queria informacion', tarde);

    // El detector no depende de otro cron: si los crons se mueren, un cron que
    // los vigile se muere con ellos. El tráfico de pacientes es señal de vida
    // independiente de nuestra infraestructura.
    expect(cuerpo.efectos).toContainEqual(
      expect.objectContaining({ tipo: 'escalar_a_humano', motivo: 'latido_perdido' }),
    );
  });

  it('no repite el aviso en cada mensaje mientras siga sin atenderse', async () => {
    await caducarRetenciones(deps(), { clientId: CLINICA });
    const tarde = new Date(AHORA.getTime() + 5 * 3_600_000);

    await enviar('hola', tarde);
    const segundo = await enviar('sigues ahi?', tarde);

    // Convertir una alarma en ruido de fondo es cómo se deja de mirar.
    expect(
      segundo.cuerpo.efectos.filter((e) => e.tipo === 'escalar_a_humano'),
    ).toEqual([]);
  });

  it('un cron que nunca ha llamado, sin trabajo suyo esperando, NO se confunde con uno roto', async () => {
    // Una clínica recién dada de alta no ha recibido su primer cron todavía.
    const { cuerpo } = await enviar('hola');

    expect(cuerpo.efectos.filter((e) => e.tipo === 'escalar_a_humano')).toEqual([]);
  });

  it('pero si NUNCA ha llamado y hay trabajo suyo esperando, sí: eso no es nuevo, es roto', async () => {
    // El caso real, tras migrar el servidor: ningún cron montado, `job_runs`
    // vacía, y un aviso a recepción diferido de madrugada —pendiente_recepcion
    // sin avisar— que iba a esperar para siempre. El vigilante se callaba
    // porque «nunca ha llamado» se trataba como clínica recién dada de alta.
    const hace3h = new Date(AHORA.getTime() - 3 * 3_600_000);
    await enviar('hola', hace3h);
    const [conv] = await admin`select id, patient_id from motor.conversations where client_id = ${CLINICA}`;
    const inicio = new Date(AHORA.getTime() + 2 * 86_400_000);
    await admin`
      insert into motor.holds
        (client_id, conversation_id, patient_id, service_code, slot_start, slot_end, rank, state, state_changed_at, created_at)
      values (${CLINICA}, ${String(conv?.['id'])}, ${String(conv?.['patient_id'])}, 'laser-axilas',
              ${inicio.toISOString()}, ${new Date(inicio.getTime() + 20 * 60_000).toISOString()},
              1, 'pendiente_recepcion', ${new Date(AHORA.getTime() - 2 * 3_600_000).toISOString()}, ${hace3h.toISOString()})
    `;

    const { cuerpo } = await enviar('hola de nuevo');

    expect(cuerpo.efectos).toContainEqual(
      expect.objectContaining({ tipo: 'escalar_a_humano', motivo: 'latido_perdido' }),
    );
    const informe = await generarInforme(deps(), { clientId: CLINICA, desde: '2026-09-01', hasta: '2026-09-30' });
    expect(informe.latidosPerdidos).toContainEqual({ job: 'caducar-retenciones', minutosSinLlamar: null });
  });

  it('un hueco recién creado todavía no es trabajo esperando: el cron puede no haber pasado aún', async () => {
    await enviar('hola');
    const [conv] = await admin`select id, patient_id from motor.conversations where client_id = ${CLINICA}`;
    const inicio = new Date(AHORA.getTime() + 2 * 86_400_000);
    await admin`
      insert into motor.holds
        (client_id, conversation_id, patient_id, service_code, slot_start, slot_end, rank, state, state_changed_at)
      values (${CLINICA}, ${String(conv?.['id'])}, ${String(conv?.['patient_id'])}, 'laser-axilas',
              ${inicio.toISOString()}, ${new Date(inicio.getTime() + 20 * 60_000).toISOString()},
              1, 'pendiente_recepcion', ${new Date(AHORA.getTime() - 10 * 60_000).toISOString()})
    `;

    const { cuerpo } = await enviar('sigo aquí');

    expect(cuerpo.efectos.filter((e) => e.tipo === 'escalar_a_humano')).toEqual([]);
  });

  it('y el informe semanal lo enseña también', async () => {
    await caducarRetenciones(deps(), { clientId: CLINICA });
    const tarde = new Date(AHORA.getTime() + 5 * 3_600_000);

    const informe = await generarInforme(deps(tarde), {
      clientId: CLINICA,
      desde: '2026-09-01',
      hasta: '2026-09-30',
    });

    expect(informe.latidosPerdidos.map((l) => l.job)).toContain('caducar-retenciones');
  });
});
