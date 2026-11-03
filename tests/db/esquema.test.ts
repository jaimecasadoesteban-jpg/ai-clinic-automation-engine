import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { conexionAdmin, prepararBaseDeDatos } from '../support/db.js';

/**
 * Lo que la migración promete y no se puede comprobar leyendo el esquema:
 * la restricción que impide la doble reserva y los plazos de retención.
 *
 * Corre como administrador (se salta RLS) a propósito: aquí no se prueba el
 * aislamiento — eso es `tests/aislamiento/` — sino que índices y triggers
 * hacen lo que dicen.
 */

const CLINICA = '33333333-3333-4333-8333-333333333333';
const PACIENTE = '44444444-4444-4444-8444-444444444444';
const CONVERSACION = '55555555-5555-4555-8555-555555555555';
const HUECO = '2026-09-01T09:00:00.000Z';

const admin = conexionAdmin();

async function crearHueco(estado: string, inicio = HUECO): Promise<void> {
  await admin`
    insert into motor.holds (client_id, patient_id, conversation_id, slot_start, slot_end, service_code, state)
    values (${CLINICA}, ${PACIENTE}, ${CONVERSACION}, ${inicio}, ${inicio}, 'limpieza', ${estado}::motor.hold_state)
  `;
}

/** Una clínica con una conversación y un mensaje de hace más de 24 meses. */
async function sembrarConversacionAntigua(
  clinica: string,
  slug: string,
): Promise<{ conversacion: string; periodo: string }> {
  await admin`
    insert into motor.clients (id, slug, name, config, config_version)
    values (${clinica}, ${slug}, ${slug}, '{}'::jsonb, 'test')
  `;
  const pacientes = await admin`
    insert into motor.patients (client_id, given_name, phone_e164)
    values (${clinica}, 'Antigua', ${'+3460000' + slug.length.toString().padStart(4, '0')})
    returning id
  `;
  const antiguedad = "now() - interval '30 months'";
  const conversaciones = await admin.unsafe(
    `insert into motor.conversations (client_id, patient_id, created_at)
     values ($1, $2, ${antiguedad})
     returning id, to_char(created_at, 'YYYY-MM') as periodo`,
    [clinica, String(pacientes[0]?.['id'])],
  );
  const conversacion = String(conversaciones[0]?.['id']);
  await admin`
    insert into motor.messages (client_id, conversation_id, direction, body)
    values (${clinica}, ${conversacion}, 'entrante', 'hola')
  `;

  return { conversacion, periodo: String(conversaciones[0]?.['periodo']) };
}

beforeAll(async () => {
  await prepararBaseDeDatos(admin);

  await admin`
    insert into motor.clients (id, slug, name, config, config_version)
    values (${CLINICA}, 'clinica-c', 'Clínica C', '{}'::jsonb, 'test')
  `;
  await admin`
    insert into motor.patients (id, client_id, given_name, phone_e164)
    values (${PACIENTE}, ${CLINICA}, 'Carmen', '+34600000009')
  `;
  await admin`
    insert into motor.conversations (id, client_id, patient_id)
    values (${CONVERSACION}, ${CLINICA}, ${PACIENTE})
  `;
}, 60_000);

afterAll(async () => {
  await admin.end();
});

describe('holds_slot_unico: la doble reserva la impide Postgres, no un if', () => {
  it('dos huecos retenidos a la misma hora: el segundo falla', async () => {
    await crearHueco('retenida');

    // La segunda ejecución concurrente falla aquí, en la base de datos, y el
    // código de arriba lo captura y propone otro hueco.
    await expect(crearHueco('pendiente_recepcion')).rejects.toMatchObject({ code: '23505' });
    await expect(crearHueco('confirmada')).rejects.toMatchObject({ code: '23505' });
  });

  it('varias propuestas a la misma hora SÍ conviven', async () => {
    const otraHora = '2026-09-01T10:00:00.000Z';
    await crearHueco('propuesta', otraHora);
    await crearHueco('propuesta', otraHora);

    // `propuesta` no bloquea a propósito: proponer 3 huecos a 5 personas no
    // puede bloquear 15 huecos de una clínica que tiene 20 al día.
    const filas = await admin`
      select count(*)::int as n from motor.holds
      where client_id = ${CLINICA} and slot_start = ${otraHora}
    `;
    expect(filas[0]?.['n']).toBe(2);
  });

  it('al caducar o colisionar, el hueco vuelve a estar libre', async () => {
    const otraHora = '2026-09-01T11:00:00.000Z';
    await crearHueco('retenida', otraHora);
    await admin`
      update motor.holds set state = 'caducada'
      where client_id = ${CLINICA} and slot_start = ${otraHora}
    `;

    await expect(crearHueco('retenida', otraHora)).resolves.not.toThrow();
  });

  it('la misma hora en otra clínica no colisiona', async () => {
    const otraClinica = '66666666-6666-4666-8666-666666666666';
    await admin`
      insert into motor.clients (id, slug, name, config, config_version)
      values (${otraClinica}, 'clinica-d', 'Clínica D', '{}'::jsonb, 'test')
    `;
    const paciente = '77777777-7777-4777-8777-777777777777';
    const conversacion = '88888888-8888-4888-8888-888888888888';
    await admin`
      insert into motor.patients (id, client_id, given_name, phone_e164)
      values (${paciente}, ${otraClinica}, 'Diana', '+34600000010')
    `;
    await admin`
      insert into motor.conversations (id, client_id, patient_id)
      values (${conversacion}, ${otraClinica}, ${paciente})
    `;

    const insercion = admin`
      insert into motor.holds (client_id, patient_id, conversation_id, slot_start, slot_end, service_code, state)
      values (${otraClinica}, ${paciente}, ${conversacion}, ${HUECO}, ${HUECO}, 'limpieza', 'retenida')
    `;

    await expect(insercion).resolves.not.toThrow();
  });
});

describe('liberada: la salida de confirmada que faltaba', () => {
  it('un hueco liberado sale del índice y vuelve a poder retenerse', async () => {
    const hora = '2026-09-02T09:00:00.000Z';
    await crearHueco('confirmada', hora);

    // Sin `liberada`, un hueco confirmado se quedaba dentro del índice parcial
    // para siempre: también en el camino feliz, no sólo al cancelar.
    await admin`
      update motor.holds
         set state = 'liberada', released_at = now(), release_reason = 'ciclo_cerrado'
       where client_id = ${CLINICA} and slot_start = ${hora}
    `;

    await expect(crearHueco('retenida', hora)).resolves.not.toThrow();
  });

  it('un hueco liberado por cancelación queda en la cola del relleno con su motivo', async () => {
    const hora = '2026-09-03T09:00:00.000Z';
    await crearHueco('confirmada', hora);
    await admin`
      update motor.holds
         set state = 'liberada', released_at = now(), release_reason = 'cancelacion'
       where client_id = ${CLINICA} and slot_start = ${hora}
    `;

    const filas = await admin`
      select release_reason, released_at is not null as tiene_marca
      from motor.holds
      where client_id = ${CLINICA} and slot_start = ${hora} and state = 'liberada'
    `;

    expect(filas[0]?.['release_reason']).toBe('cancelacion');
    expect(filas[0]?.['tiene_marca']).toBe(true);
  });
});

describe('la numeración de pacientes es por clínica', () => {
  it('cada clínica empieza por pac_1 y no comparte contador', async () => {
    const clinicaE = '99999999-9999-4999-8999-999999999999';
    await admin`
      insert into motor.clients (id, slug, name, config, config_version)
      values (${clinicaE}, 'clinica-e', 'Clínica E', '{}'::jsonb, 'test')
    `;
    await admin`
      insert into motor.patients (client_id, given_name, phone_e164)
      values (${clinicaE}, 'Elena', '+34600000020'), (${clinicaE}, 'Eva', '+34600000021')
    `;

    const filas = await admin`
      select public_ref from motor.patients
      where client_id = ${clinicaE} order by seq
    `;

    // La magnitud del identificador no revela el volumen total del sistema.
    expect(filas.map((f) => f['public_ref'])).toEqual(['pac_1', 'pac_2']);
  });
});

describe('retención: los plazos los pone la base de datos', () => {
  async function insertarMensaje(clinico: boolean, cuerpo: string): Promise<string> {
    const filas = await admin`
      insert into motor.messages (client_id, conversation_id, direction, body, is_clinical)
      values (${CLINICA}, ${CONVERSACION}, 'entrante', ${cuerpo}, ${clinico})
      returning id, purge_at, created_at
    `;
    return String(filas[0]?.['id']);
  }

  it('un mensaje clínico caduca a los 90 días', async () => {
    const id = await insertarMensaje(true, 'me ha salido un bulto');
    const filas = await admin`
      select (purge_at = created_at + interval '90 days') as coincide
      from motor.messages where id = ${id}
    `;

    expect(filas[0]?.['coincide']).toBe(true);
  });

  it('un mensaje no clínico caduca a los 12 meses', async () => {
    const id = await insertarMensaje(false, '¿a qué hora abrís?');
    const filas = await admin`
      select (purge_at = created_at + interval '12 months') as coincide
      from motor.messages where id = ${id}
    `;

    expect(filas[0]?.['coincide']).toBe(true);
  });

  it('reclasificar un mensaje como clínico acorta su plazo, nunca lo alarga', async () => {
    const id = await insertarMensaje(false, 'una duda');
    await admin`update motor.messages set is_clinical = true where id = ${id}`;

    const filas = await admin`
      select (purge_at = created_at + interval '90 days') as coincide
      from motor.messages where id = ${id}
    `;
    expect(filas[0]?.['coincide']).toBe(true);
  });

  it('las claves de idempotencia caducan a los 30 días', async () => {
    const filas = await admin`
      insert into motor.idempotency_keys (client_id, key, endpoint, request_hash, status_code, response)
      values (${CLINICA}, 'k-1', '/mensaje-entrante', 'abc', 200, '{}'::jsonb)
      returning (purge_at = created_at + interval '30 days') as coincide
    `;

    expect(filas[0]?.['coincide']).toBe(true);
  });
});

describe('la purga redacta el contenido y conserva el rastro', () => {
  it('un mensaje clínico vencido pierde el cuerpo pero mantiene su telemetría', async () => {
    const filas = await admin`
      insert into motor.messages
        (client_id, conversation_id, direction, body, is_clinical, model, prompt_tokens, latency_ms)
      values (${CLINICA}, ${CONVERSACION}, 'saliente', 'contenido clínico', true, 'modelo-x', 1200, 350)
      returning id
    `;
    const id = String(filas[0]?.['id']);
    // Se fuerza el vencimiento en vez de esperar 90 días.
    await admin`update motor.messages set purge_at = now() - interval '1 day' where id = ${id}`;

    await admin`select * from motor.purge_expired()`;

    const tras = await admin`
      select body, prompt, redacted_at, model, prompt_tokens, latency_ms, direction, created_at
      from motor.messages where id = ${id}
    `;
    const fila = tras[0];

    expect(fila?.['body']).toBeNull();
    expect(fila?.['prompt']).toBeNull();
    expect(fila?.['redacted_at']).not.toBeNull();
    // El rastro que exige la regla 6 sigue ahí.
    expect(fila?.['model']).toBe('modelo-x');
    expect(fila?.['prompt_tokens']).toBe(1200);
    expect(fila?.['latency_ms']).toBe(350);
    expect(fila?.['direction']).toBe('saliente');
  });

  it('el registro de bajas NO se purga nunca', async () => {
    await admin`
      insert into motor.suppression (client_id, phone_hash, reason)
      values (${CLINICA}, 'hash-de-prueba', 'baja_solicitada')
    `;

    await admin`select * from motor.purge_expired()`;

    const filas = await admin`
      select count(*)::int as n from motor.suppression where client_id = ${CLINICA}
    `;
    expect(filas[0]?.['n']).toBe(1);
  });

  it('a los 24 meses NO se borra el detalle de un periodo sin consolidar', async () => {
    const clinica = 'aaaa1111-aaaa-4aaa-8aaa-aaaa11110000';
    const { conversacion } = await sembrarConversacionAntigua(clinica, 'clinica-vieja-1');

    const salida = await admin`select * from motor.purge_expired()`;
    const sinConsolidar = salida.find((f) => f['paso'] === 'detalle_vencido_sin_consolidar');

    expect(Number(sinConsolidar?.['filas'])).toBeGreaterThan(0);
    const quedan = await admin`
      select count(*)::int as n from motor.conversations where id = ${conversacion}
    `;
    // Borrar esto sería destruir la base de una factura ya emitida.
    expect(quedan[0]?.['n']).toBe(1);
  });

  it('a los 24 meses sí se borra el detalle de un periodo consolidado, y el agregado sobrevive', async () => {
    const clinica = 'aaaa2222-aaaa-4aaa-8aaa-aaaa22220000';
    const { conversacion, periodo } = await sembrarConversacionAntigua(clinica, 'clinica-vieja-2');

    await admin`
      insert into motor.period_metrics (client_id, period, citas_generadas, consolidated_at)
      values (${clinica}, ${periodo}, 7, now())
    `;

    await admin`select * from motor.purge_expired()`;

    const conversaciones = await admin`
      select count(*)::int as n from motor.conversations where id = ${conversacion}
    `;
    const mensajes = await admin`
      select count(*)::int as n from motor.messages where conversation_id = ${conversacion}
    `;
    const agregado = await admin`
      select citas_generadas from motor.period_metrics where client_id = ${clinica}
    `;

    expect(conversaciones[0]?.['n']).toBe(0);
    expect(mensajes[0]?.['n']).toBe(0);
    // Lo que sobrevive es agregado y no lleva patient_id.
    expect(agregado[0]?.['citas_generadas']).toBe(7);
  });

  it('el protocolo de salida borra el detalle y conserva bajas y agregados', async () => {
    const clinica = 'aaaa3333-aaaa-4aaa-8aaa-aaaa33330000';
    const { conversacion, periodo } = await sembrarConversacionAntigua(clinica, 'clinica-saliente');
    await admin`
      insert into motor.period_metrics (client_id, period, citas_generadas, consolidated_at)
      values (${clinica}, ${periodo}, 3, now())
    `;
    await admin`
      insert into motor.suppression (client_id, phone_hash, reason)
      values (${clinica}, 'hash-de-una-baja', 'baja_solicitada')
    `;
    await admin`
      insert into motor.outbox (client_id, kind, dedupe_key, payload, next_attempt_at, created_at)
      values (${clinica}, 'correo_operador', 'escalado:1', '{"asunto":"a","cuerpo":"b"}'::jsonb, now(), now())
    `;
    await admin`
      insert into motor.inbox (client_id, provider_message_id, payload, next_attempt_at, created_at)
      values (${clinica}, 'wamid.1', '{"telefono":"+34600000000","nombre":"x","tipo":"texto","texto":"hola"}'::jsonb, now(), now())
    `;

    await admin`select * from motor.offboard_client(${clinica})`;

    const detalle = await admin`
      select
        (select count(*) from motor.conversations where id = ${conversacion}) as conversaciones,
        (select count(*) from motor.patients where client_id = ${clinica}) as pacientes,
        (select count(*) from motor.suppression where client_id = ${clinica}) as bajas,
        (select count(*) from motor.period_metrics where client_id = ${clinica}) as agregados,
        (select count(*) from motor.outbox where client_id = ${clinica}) as salida,
        (select count(*) from motor.inbox where client_id = ${clinica}) as bandeja,
        (select active from motor.clients where id = ${clinica}) as activa
    `;
    const fila = detalle[0];

    expect(Number(fila?.['conversaciones'])).toBe(0);
    expect(Number(fila?.['pacientes'])).toBe(0);
    // Quien pidió no recibir más mensajes sigue teniendo derecho a que lo respetemos.
    expect(Number(fila?.['bajas'])).toBe(1);
    expect(Number(fila?.['agregados'])).toBe(1);
    // Los avisos encolados de la clínica también se van.
    expect(Number(fila?.['salida'])).toBe(0);
    expect(Number(fila?.['bandeja'])).toBe(0);
    expect(fila?.['activa']).toBe(false);
  });

  it('la purga borra lo enviado hace más de 30 días, y no toca lo pendiente', async () => {
    const clinica = 'aaaa4444-aaaa-4aaa-8aaa-aaaa44440000';
    await admin`delete from motor.clients where id = ${clinica}`;
    await admin`
      insert into motor.clients (id, slug, name, config, config_version)
      values (${clinica}, 'clinica-salida', 'Salida', '{}'::jsonb, 'test')
    `;
    await admin`
      insert into motor.outbox (client_id, kind, dedupe_key, payload, state, next_attempt_at, created_at)
      values (${clinica}, 'correo_operador', 'viejo', '{"asunto":"a","cuerpo":"b"}'::jsonb, 'enviado', now(), now() - interval '31 days'),
             (${clinica}, 'correo_operador', 'reciente', '{"asunto":"a","cuerpo":"b"}'::jsonb, 'enviado', now(), now() - interval '2 days'),
             (${clinica}, 'correo_operador', 'atascado', '{"asunto":"a","cuerpo":"b"}'::jsonb, 'pendiente', now(), now() - interval '40 days')
    `;

    await admin`select * from motor.purge_expired()`;

    const quedan = await admin`select dedupe_key from motor.outbox where client_id = ${clinica} order by dedupe_key`;
    // Lo pendiente no se borra nunca por viejo: sería perder un aviso en silencio.
    expect(quedan.map((f) => f['dedupe_key'])).toEqual(['atascado', 'reciente']);
  });

  it('la bandeja guarda el texto del paciente lo justo: lo procesado se va al día, lo pendiente nunca', async () => {
    const clinica = 'aaaa5555-aaaa-4aaa-8aaa-aaaa55550000';
    await admin`delete from motor.clients where id = ${clinica}`;
    await admin`
      insert into motor.clients (id, slug, name, config, config_version)
      values (${clinica}, 'clinica-bandeja', 'Bandeja', '{}'::jsonb, 'test')
    `;
    const p = '{"telefono":"+34600000000","nombre":"x","tipo":"texto","texto":"hola"}';
    await admin`
      insert into motor.inbox (client_id, provider_message_id, payload, state, next_attempt_at, created_at)
      values (${clinica}, 'procesado-viejo', ${p}::jsonb, 'procesado', now(), now() - interval '2 days'),
             (${clinica}, 'procesado-hoy', ${p}::jsonb, 'procesado', now(), now() - interval '2 hours'),
             (${clinica}, 'fallido-reciente', ${p}::jsonb, 'fallido', now(), now() - interval '5 days'),
             (${clinica}, 'pendiente-viejo', ${p}::jsonb, 'pendiente', now(), now() - interval '40 days')
    `;

    await admin`select * from motor.purge_expired()`;

    const quedan = await admin`select provider_message_id from motor.inbox where client_id = ${clinica} order by 1`;
    expect(quedan.map((f) => f['provider_message_id'])).toEqual(['fallido-reciente', 'pendiente-viejo', 'procesado-hoy']);
  });

  it('suppression no tiene columna purge_at: no hay forma de caducarla por descuido', async () => {
    const filas = await admin`
      select 1 from information_schema.columns
      where table_schema = 'motor' and table_name = 'suppression' and column_name = 'purge_at'
    `;

    expect(filas).toHaveLength(0);
  });
});
