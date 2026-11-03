import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createCore, type Core } from '../../src/db/client.js';
import { ejecutarOleada } from '../../src/service/oleadas.js';
import { procesarMensajeEntrante, type SalidaDeMensaje } from '../../src/service/pipeline.js';
import { AgendaFalsa, dependenciasDePrueba } from '../support/fakes.js';
import { APP_URL, conexionAdmin, prepararBaseDeDatos } from '../support/db.js';

/**
 * Solicitudes de derechos del RGPD.
 *
 * **Una baja comercial y una solicitud de derechos no son lo mismo**, y estaban
 * en la misma categoría: una solicitud de supresión se «resolvía» añadiendo un
 * teléfono a una lista y nadie tramitaba nada.
 *
 * Una baja se ejecuta al momento —hay instrucción permanente del responsable en
 * el contrato de encargo— y se acaba con una fila. Acceso, rectificación,
 * supresión, oposición, limitación y portabilidad son derechos con plazo legal
 * de un mes que resuelve **la clínica**, que es la responsable del tratamiento.
 * Nosotros somos encargados: no decidimos, asistimos.
 */

const CLINICA = '44445555-4444-4444-8444-444455550000';
const TELEFONO = '+34600404040';
const AHORA = new Date('2026-09-14T10:00:00.000Z');

const admin = conexionAdmin();
let core: Core;
let agenda: AgendaFalsa;
let contador = 0;

async function enviar(texto: string): Promise<SalidaDeMensaje> {
  contador += 1;
  const deps = dependenciasDePrueba({ core, agenda, reloj: () => AHORA });
  const { cuerpo } = await procesarMensajeEntrante(deps, {
    idempotencyKey: `derechos-${contador}`,
    clientId: CLINICA,
    telefono: TELEFONO,
    nombre: 'Teresa',
    texto,
  });
  return cuerpo;
}

async function solicitudes(): Promise<
  Array<{
    kind: string;
    state: string;
    recibida: Date;
    trasladada: Date | null;
    cierre: Date | null;
    plazoTraslado: Date;
    plazoRespuesta: Date;
  }>
> {
  const filas = await admin`
    select kind, state, received_at, transferred_at, closed_at, transfer_due_at, answer_due_at
      from motor.rights_requests where client_id = ${CLINICA} order by received_at
  `;
  return filas.map((f) => ({
    kind: String(f['kind']),
    state: String(f['state']),
    recibida: new Date(String(f['received_at'])),
    trasladada: f['transferred_at'] === null ? null : new Date(String(f['transferred_at'])),
    cierre: f['closed_at'] === null ? null : new Date(String(f['closed_at'])),
    plazoTraslado: new Date(String(f['transfer_due_at'])),
    plazoRespuesta: new Date(String(f['answer_due_at'])),
  }));
}

async function huecos(): Promise<number> {
  const filas = await admin`
    select count(*)::int as n from motor.holds where client_id = ${CLINICA}
  `;
  return Number(filas[0]?.['n'] ?? 0);
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
    'wave_recipients',
    'waves',
    'suppression',
    'patients',
  ]) {
    await admin.unsafe(`delete from motor.${tabla} where client_id = $1`, [CLINICA]);
  }
  await admin`delete from motor.clients where id = ${CLINICA}`;
  await admin`
    insert into motor.clients (id, slug, name, config, config_version)
    values (${CLINICA}, 'clinica-de-pruebas', 'Clínica Derechos', '{}'::jsonb, 'test')
  `;
  agenda = new AgendaFalsa();
  contador = 0;
});

describe('una solicitud de derechos no es una baja', () => {
  it('el agente acusa recibo y NO responde a la solicitud por su cuenta', async () => {
    const salida = await enviar('quiero que borreis mis datos, todo lo que teneis de mi');

    expect(salida.corte?.categoria).toBe('derechos_rgpd');
    // Acusa recibo sin prometer plazos que no dependen de nosotros: quien
    // resuelve es la clínica.
    expect(salida.respuesta).toContain('registrado');
    expect(salida.respuesta).toContain('clínica');
    expect(salida.respuesta).not.toMatch(/\b(48|un mes|30 dias)\b/i);
  });

  it('queda registrada con las cuatro fechas del contrato de encargo', async () => {
    await enviar('quiero que borreis mis datos');

    const [solicitud] = await solicitudes();
    expect(solicitud?.kind).toBe('supresion');
    expect(solicitud?.recibida).toEqual(AHORA);
    // El traslado sale en los efectos de esta misma respuesta: devolverlo ES
    // trasladarlo, así que consta hecho y dentro de plazo.
    expect(solicitud?.trasladada).toEqual(AHORA);
    expect(solicitud?.state).toBe('trasladada');
    expect(solicitud?.cierre).toBeNull();

    // 48 horas para el traslado, un mes para la respuesta.
    expect(solicitud!.plazoTraslado.getTime() - AHORA.getTime()).toBe(48 * 3_600_000);
    expect(solicitud!.plazoRespuesta.getTime() - AHORA.getTime()).toBe(30 * 86_400_000);
  });

  it('el escalado lleva su propio motivo, para que no acabe en recepción', async () => {
    const salida = await enviar('quiero ejercer mis derechos rgpd');

    // La severidad no basta para enrutar: severidad 2 son cosas que van a
    // personas distintas. Sin el motivo, esto acabaría con las quejas.
    expect(salida.efectos).toContainEqual(
      expect.objectContaining({ tipo: 'escalar_a_humano', motivo: 'derechos_rgpd' }),
    );

    const filas = await admin`
      select reason from motor.escalations where client_id = ${CLINICA}
    `;
    expect(filas.map((f) => String(f['reason']))).toEqual(['derechos_rgpd']);
  });

  it('sin decir qué derecho, se registra «sin determinar» y no se adivina', async () => {
    await enviar('quiero ejercer mis derechos, proteccion de datos');

    // Adivinarlo sería decidir por el responsable del tratamiento.
    expect((await solicitudes())[0]?.kind).toBe('sin_determinar');
  });

  it('NO se le da de baja de la lista: son cosas distintas', async () => {
    await enviar('quiero que borreis mis datos');

    const bajas = await admin`
      select count(*)::int as n from motor.suppression where client_id = ${CLINICA}
    `;
    // La supresión la resuelve la clínica; meterle en la lista de bajas sería
    // dar por tramitado un derecho que nadie ha tramitado.
    expect(bajas[0]?.['n']).toBe(0);
  });

  it('la oposición comercial SÍ se ejecuta al momento: ésa es la excepción', async () => {
    const salida = await enviar('no me mandeis mas mensajes');

    expect(salida.corte?.categoria).toBe('baja');
    const bajas = await admin`
      select count(*)::int as n from motor.suppression where client_id = ${CLINICA}
    `;
    expect(bajas[0]?.['n']).toBe(1);
    // Y no abre expediente de derechos: hay instrucción permanente en el
    // contrato, así que no hay nada que trasladar ni plazo que contar.
    expect(await solicitudes()).toEqual([]);
  });
});

describe('con una supresión en curso no se agenda nada nuevo', () => {
  it('pedir cita después de pedir la supresión no crea huecos', async () => {
    await enviar('quiero que borreis mis datos');

    const salida = await enviar('bueno, pues queria pedir cita de axilas');

    // Seguir dándole hora mientras pide que dejemos de tratar sus datos es
    // contradecirse. El tratamiento queda limitado hasta que resuelva la clínica.
    expect(await huecos()).toBe(0);
    expect(salida.respuesta).not.toBeNull();
    expect(salida.respuesta).toContain('no te agendo nada nuevo');

    const acciones = await admin`select action from motor.audit_log where client_id = ${CLINICA}`;
    expect(acciones.map((f) => String(f['action']))).toContain(
      'agendado_bloqueado_por_derecho_en_curso',
    );
  });

  it('pero una cita que ya tenía NO se cancela', async () => {
    await enviar('quiero cita de laser de axilas');
    const eleccion = await enviar('la primera');
    expect(eleccion.holdId).toBeDefined();

    await enviar('quiero que borreis mis datos');

    // Ejercer un derecho no deshace un acuerdo anterior.
    const filas = await admin`select state from motor.holds where id = ${eleccion.holdId!}`;
    expect(['retenida', 'pendiente_recepcion']).toContain(String(filas[0]?.['state']));
  });

  it('un derecho de ACCESO no bloquea nada: pedir una copia no suspende la relación', async () => {
    await enviar('quiero una copia de mis datos');
    expect((await solicitudes())[0]?.kind).toBe('acceso');

    await enviar('y ademas queria pedir cita de axilas');

    expect(await huecos()).toBeGreaterThan(0);
  });

  it('y NO recibe oleadas comerciales mientras la solicitud está viva', async () => {
    await enviar('quiero que borreis mis datos');
    const pacientes = await admin`select id from motor.patients where client_id = ${CLINICA}`;
    const paciente = String(pacientes[0]?.['id']);

    const oleadas = await admin`
      insert into motor.waves (client_id, name, segment, template_ref, state, approved_at, approved_by)
      values (${CLINICA}, 'Reactivación', '{"mesesSinVisita": 6}'::jsonb,
              'Hola, hace tiempo que no nos vemos.', 'ejecutando',
              ${AHORA.toISOString()}, 'Dirección de la clínica')
      returning id
    `;
    const oleada = String(oleadas[0]?.['id']);
    await admin`
      insert into motor.wave_recipients (client_id, wave_id, patient_id, state)
      values (${CLINICA}, ${oleada}, ${paciente}, 'pendiente')
    `;

    const salida = await ejecutarOleada(dependenciasDePrueba({ core, agenda, reloj: () => AHORA }), {
      idempotencyKey: 'oleada-derechos',
      clientId: CLINICA,
      waveId: oleada,
    });

    // Alguien con una supresión en curso recibiendo publicidad nuestra es
    // exactamente lo que el contrato de encargo dice que no pasa.
    expect(salida.destinatarios).toEqual([]);
    expect(salida.suprimidos).toBe(1);

    const estado = await admin`
      select state from motor.wave_recipients where client_id = ${CLINICA}
    `;
    expect(String(estado[0]?.['state'])).toBe('suprimido');
  });

  it('al cerrarse la solicitud, se le vuelve a poder agendar', async () => {
    await enviar('quiero que borreis mis datos');
    await admin`
      update motor.rights_requests set state = 'cerrada', closed_at = now()
       where client_id = ${CLINICA}
    `;

    await enviar('ya esta resuelto, quiero cita de axilas');

    expect(await huecos()).toBeGreaterThan(0);
  });
});
