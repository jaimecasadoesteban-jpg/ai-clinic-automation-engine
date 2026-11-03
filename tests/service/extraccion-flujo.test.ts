import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Extraccion } from '../../src/agent/extraccion.js';
import { createCore, type Core } from '../../src/db/client.js';
import { procesarMensajeEntrante, type SalidaDeMensaje } from '../../src/service/pipeline.js';
import type { FabricaDeAgente } from '../../src/service/ports.js';
import {
  AgendaFalsa,
  AgenteFalso,
  ClasificadorFalso,
  dependenciasDePrueba,
  huecosDesde,
  RedactorFalso,
} from '../support/fakes.js';
import { APP_URL, conexionAdmin, prepararBaseDeDatos } from '../support/db.js';

/**
 * La regla 4 bis, de extremo a extremo: **nada se propone sobre una
 * suposición**, y el mensaje que recibe el paciente se corresponde con lo que
 * el sistema ha hecho de verdad.
 *
 * Verificado por sabotaje: si la extracción devuelve siempre el primer servicio
 * del catálogo —que es exactamente el bug que apareció probando a mano— estos
 * tests fallan.
 */

const CLINICA = 'aaaa9999-aaaa-4aaa-8aaa-aaaa99990000';
const TELEFONO = '+34600555444';
const AHORA = new Date('2026-09-14T10:00:00.000Z');

const admin = conexionAdmin();
let core: Core;
let agenda: AgendaFalsa;
let contador = 0;

/** Fábrica que guioniza la extracción, para probar cada rama sin depender del texto. */
function agenteGuionado(extracciones: readonly Extraccion[]): FabricaDeAgente {
  return new AgenteFalso(new ClasificadorFalso(extracciones), new RedactorFalso());
}

function extraccion(extra: Partial<Extraccion> = {}): Extraccion {
  return {
    intencion: 'agendar',
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

async function enviar(
  texto: string,
  opciones: { agente?: FabricaDeAgente } = {},
): Promise<SalidaDeMensaje> {
  contador += 1;
  const deps = dependenciasDePrueba({ core, agenda, reloj: () => AHORA });
  const { cuerpo } = await procesarMensajeEntrante(
    opciones.agente === undefined ? deps : { ...deps, agente: opciones.agente },
    {
      idempotencyKey: `extraccion-${contador}`,
      clientId: CLINICA,
      telefono: TELEFONO,
      nombre: 'Sara',
      texto,
    },
  );
  return cuerpo;
}

async function huecos(): Promise<Array<{ state: string; service_code: string }>> {
  const filas = await admin`
    select state, service_code from motor.holds
    where client_id = ${CLINICA} order by created_at, rank
  `;
  return filas.map((f) => ({ state: String(f['state']), service_code: String(f['service_code']) }));
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
    values (${CLINICA}, 'clinica-de-pruebas', 'Clínica Extracción', '{}'::jsonb, 'test')
  `;
  agenda = new AgendaFalsa(huecosDesde(new Date('2026-09-24T09:00:00.000Z'), 3));
});

describe('nada se propone sobre una suposición', () => {
  it('sin servicio determinado NO se crea ni un hueco', async () => {
    const salida = await enviar('quiero pedir cita', {
      agente: agenteGuionado([extraccion({ servicio: null })]),
    });

    // Éste es el bug que apareció probando a mano: el paciente leía «¿qué zona
    // quieres?» mientras la base de datos ya tenía tres huecos de láser de axilas.
    expect(await huecos()).toEqual([]);
    expect(salida.respuesta).not.toBeNull();
  });

  it('con servicio determinado sí se proponen, y del servicio correcto', async () => {
    await enviar('quiero cita de piernas', {
      agente: agenteGuionado([extraccion({ servicio: 'laser-piernas' })]),
    });

    const filas = await huecos();
    expect(filas).toHaveLength(3);
    expect(filas.every((f) => f.service_code === 'laser-piernas')).toBe(true);
  });

  it('«lo de siempre» en una conversación nueva no propone nada', async () => {
    // Aunque el paciente tenga historial de otras conversaciones, el sistema no
    // adivina cuál es «lo de siempre»: pregunta. Adivinar es dar una cita mal.
    // (Dentro de una MISMA conversación sí se arrastra el servicio ya
    // determinado; eso es estado de conversación, no adivinar.)
    await enviar('ponme lo de siempre', {
      agente: agenteGuionado([extraccion({ servicio: null })]),
    });

    const vivos = (await huecos()).filter((f) => f.state === 'propuesta');
    expect(vivos).toEqual([]);
  });

  it('un servicio que no está en el catálogo no crea huecos', async () => {
    // El clasificador real ya lo convierte en null; aquí se comprueba que la
    // rama del pipeline hace lo correcto con ese null.
    await enviar('quiero un masaje tailandes', {
      agente: agenteGuionado([extraccion({ servicio: null })]),
    });

    expect(await huecos()).toEqual([]);
  });
});

describe('cambio de servicio a media conversación', () => {
  it('los huecos del servicio anterior mueren, y quedan sólo los nuevos', async () => {
    await enviar('quiero cita de axilas', {
      agente: agenteGuionado([extraccion({ servicio: 'laser-axilas' })]),
    });
    expect((await huecos()).filter((f) => f.state === 'propuesta')).toHaveLength(3);

    await enviar('mejor las piernas', {
      agente: agenteGuionado([extraccion({ servicio: 'laser-piernas' })]),
    });

    const filas = await huecos();
    const vivos = filas.filter((f) => f.state === 'propuesta');
    const muertos = filas.filter((f) => f.state === 'caducada');

    // Los tres de axilas caducados, tres nuevos de piernas. Nada de basura viva
    // que nadie limpia, y el estado se corresponde con lo que se le ha dicho.
    expect(muertos).toHaveLength(3);
    expect(muertos.every((f) => f.service_code === 'laser-axilas')).toBe(true);
    expect(vivos).toHaveLength(3);
    expect(vivos.every((f) => f.service_code === 'laser-piernas')).toBe(true);
  });

  it('queda anotado en la auditoría', async () => {
    await enviar('axilas', { agente: agenteGuionado([extraccion({ servicio: 'laser-axilas' })]) });
    await enviar('mejor piernas', {
      agente: agenteGuionado([extraccion({ servicio: 'laser-piernas' })]),
    });

    const acciones = await admin`
      select action from motor.audit_log where client_id = ${CLINICA}
    `;
    expect(acciones.map((f) => String(f['action']))).toContain('cambio_de_servicio:laser-piernas');
  });

  /**
   * Volver a pedir cita SIN tener hora cogida vuelve a mirar la agenda: los
   * huecos propuestos envejecen y la clínica puede haber llenado uno en su
   * agenda sin que nos enteremos, porque no escribimos en ella.
   *
   * Lo que no puede pasar es que se acumulen. Con hora ya cogida es al revés y
   * no se toca nada: eso lo cubre `gracias.test.ts`.
   */
  it('reproponer sustituye a la propuesta anterior, aunque sea el mismo servicio', async () => {
    await enviar('axilas', { agente: agenteGuionado([extraccion({ servicio: 'laser-axilas' })]) });
    await enviar('sí, axilas', {
      agente: agenteGuionado([extraccion({ servicio: 'laser-axilas' })]),
    });

    // Nunca puede haber más huecos vivos que los que el mensaje enseña: si se
    // acumularan, la base diría seis y el paciente habría leído tres.
    const filas = await huecos();
    expect(filas.filter((f) => f.state === 'propuesta')).toHaveLength(3);
    expect(filas.filter((f) => f.state === 'caducada')).toHaveLength(3);
  });
});

describe('si la extracción falla, se pregunta', () => {
  it('el clasificador caído deja el servicio en null y no se propone nada', async () => {
    // La extracción de reserva tiene servicio null a propósito.
    await enviar('quiero cita', {
      agente: agenteGuionado([extraccion({ intencion: 'otro', servicio: null })]),
    });

    expect(await huecos()).toEqual([]);
  });
});

describe('señal de escalado no clínica', () => {
  it('pedir hablar con una persona escala y pausa la conversación', async () => {
    const salida = await enviar('quiero hablar con una persona', {
      agente: agenteGuionado([extraccion({ intencion: 'otro', escalar: 'pide_persona' })]),
    });

    expect(salida.estadoConversacion).toBe('pausada');
    expect(salida.efectos.some((e) => e.tipo === 'escalar_a_humano')).toBe(true);

    const escalados = await admin`select reason from motor.escalations where client_id = ${CLINICA}`;
    expect(escalados.map((f) => String(f['reason']))).toEqual(['pide_persona']);
  });

  it('si se le dice que le escribe una persona, el agente se calla de verdad', async () => {
    await enviar('esto es una vergüenza', {
      agente: agenteGuionado([extraccion({ intencion: 'otro', escalar: 'queja' })]),
    });

    // Regla 4 bis: mensaje y estado coinciden. No sigue conversando después de
    // haberle dicho que le atiende una persona.
    const despues = await enviar('bueno, pues quiero cita de axilas', {
      agente: agenteGuionado([extraccion({ servicio: 'laser-axilas' })]),
    });

    expect(despues.estadoConversacion).toBe('pausada');
    expect(await huecos()).toEqual([]);
  });

  it('sin señal, la conversación sigue con normalidad', async () => {
    const salida = await enviar('quiero cita de axilas', {
      agente: agenteGuionado([extraccion({ servicio: 'laser-axilas', escalar: null })]),
    });

    expect(salida.estadoConversacion).toBe('abierta');
    expect((await huecos()).filter((f) => f.state === 'propuesta')).toHaveLength(3);
  });
});

describe('preferencia de día y hora', () => {
  it('se filtran los huecos por la franja pedida', async () => {
    // La agenda falsa da tres huecos consecutivos desde las 11:00 de Madrid.
    await enviar('quiero cita de axilas por la mañana', {
      agente: agenteGuionado([
        extraccion({
          servicio: 'laser-axilas',
          preferencia: {
            dias: [],
            diasExcluidos: [],
            franjas: ['manana'],
            desde: null,
            horaExacta: null,
            cuantoAntes: false,
          },
        }),
      ]),
    });

    const filas = await admin`
      select slot_start from motor.holds where client_id = ${CLINICA} order by rank
    `;
    // Todos los propuestos caen por la mañana en hora de Madrid.
    for (const fila of filas) {
      const hora = new Intl.DateTimeFormat('es-ES', {
        timeZone: 'Europe/Madrid',
        hour: '2-digit',
        hour12: false,
      }).format(new Date(String(fila['slot_start'])));
      expect(Number(hora)).toBeLessThan(13);
    }
  });
});
