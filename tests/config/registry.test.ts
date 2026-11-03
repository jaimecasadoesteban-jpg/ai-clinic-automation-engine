import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clienteConfigSchema } from '../../src/config/cliente.js';
import { finDeJornadaDe, politicaDe, textosDe } from '../../src/config/derivar.js';
import { cargarConfiguracion, RegistroDeConfiguracion } from '../../src/config/registry.js';
import { configDePrueba } from '../support/fakes.js';

const YAML_VALIDO = `
slug: prueba
nombre: Clínica de Prueba
zonaHoraria: Europe/Madrid
canal: { tipo: whatsapp, remitenteId: '123' }
horario:
  - { dia: lunes, abre: '09:00', cierra: '20:00' }
  - { dia: martes, abre: '09:00', cierra: '14:00' }
agenda: { nivel: A, calendarioId: 'pruebas@group.calendar.google.com' }
servicios:
  - { codigo: laser, nombre: Láser, precio: 39.90, duracionMinutos: 20 }
escalado:
  recepcion:
    - { nombre: Recepción, canal: whatsapp, destino: '+34600000000' }
  contactos:
    - { nombre: Recepción, canal: whatsapp, destino: '+34600000000' }
  proteccionDeDatos:
    - { nombre: DPD, canal: email, destino: 'lopd@clinica.example' }
`;

let directorio: string;

beforeEach(() => {
  directorio = mkdtempSync(join(tmpdir(), 'motor-config-'));
});

afterEach(() => {
  rmSync(directorio, { recursive: true, force: true });
});

function escribir(nombre: string, contenido: string): void {
  writeFileSync(join(directorio, nombre), contenido, 'utf8');
}

describe('carga de configuración', () => {
  it('carga un YAML válido y le asigna versión', () => {
    escribir('prueba.yaml', YAML_VALIDO);
    const registro = cargarConfiguracion(directorio);

    const { config, version } = registro.obtener('prueba');
    expect(config.nombre).toBe('Clínica de Prueba');
    expect(version).toMatch(/^[0-9a-f]{12}$/);
  });

  it('el fichero de ejemplo del repositorio es válido', () => {
    // Si el ejemplo no valida, la documentación de alta miente.
    const registro = cargarConfiguracion('config/clientes');
    expect(registro.slugs()).toContain('ejemplo');
  });

  it('un YAML inválido revienta al cargar, no a mitad de una conversación', () => {
    escribir('prueba.yaml', YAML_VALIDO);
    escribir('rota.yaml', YAML_VALIDO.replace('servicios:', 'servicios: []\nignorado:'));

    expect(() => cargarConfiguracion(directorio)).toThrow(/Configuración inválida/);
  });

  it('si una clínica falla, NO se carga ninguna: nada de quedarse a medias', () => {
    escribir('prueba.yaml', YAML_VALIDO);
    escribir('rota.yaml', 'slug: rota\nnombre: Rota\n');

    const registro = new RegistroDeConfiguracion(directorio);
    expect(() => registro.cargarTodo()).toThrow();
    expect(registro.slugs()).toEqual([]);
  });

  /**
   * **Una clave que sobra impide arrancar.** Antes se descartaba en silencio, y
   * eso convertía una errata en un fallo invisible: `remitenteld` por
   * `remitenteId` dejaba el valor bueno sin poner, el servicio arrancaba tan
   * contento, y el síntoma aparecía días después como un 404 sin pista —pasó— o
   * como un texto de cara al paciente que nadie había escrito.
   *
   * Es el mismo criterio que en el borde HTTP, donde un campo de más ya daba 400.
   * Que no arranque se ve en el primer despliegue, con el fichero y la clave
   * delante. Lo caro es lo otro: enterarse por un paciente.
   */
  describe('una clave que sobra no se descarta: no arranca', () => {
    it('la errata que nos costó una ronda: remitenteld por remitenteId', () => {
      escribir(
        'rota.yaml',
        YAML_VALIDO.replace(
          "canal: { tipo: whatsapp, remitenteId: '123' }",
          "canal: { tipo: whatsapp, remitenteId: '123', remitenteld: '456' }",
        ),
      );

      expect(() => cargarConfiguracion(directorio)).toThrow(/remitenteld/);
    });

    /**
     * En todos los niveles, no sólo en la raíz: una errata en
     * `vencimientos.propuestaMinuots` es exactamente igual de silenciosa, y
     * encima tiene valor por defecto, así que nada la delataría.
     */
    it.each([
      ['la raíz', '\nnomrbe: X\n', /nomrbe/],
      ['un objeto con valor por defecto', '\nvencimientos: { propuestaMinuots: 100 }\n', /propuestaMinuots/],
      ['los textos', '\ntextos: { retenidoDiferio: hola }\n', /retenidoDiferio/],
      ['el cortafuegos', '\ncortafuegos: { ventanaMensages: 5 }\n', /ventanaMensages/],
      ['los envíos', '\nenvios: { horaMinma: "09:00" }\n', /horaMinma/],
      ['la reactivación', '\nreactivacion: { mesesSinVisit: 6 }\n', /mesesSinVisit/],
    ])('%s', (_donde, extra, esperado) => {
      escribir('rota.yaml', YAML_VALIDO + extra);

      expect(() => cargarConfiguracion(directorio)).toThrow(esperado);
    });

    it('dentro de las listas también', () => {
      escribir(
        'rota.yaml',
        YAML_VALIDO.replace(
          "  - { dia: lunes, abre: '09:00', cierra: '20:00' }",
          "  - { dia: lunes, abre: '09:00', cierra: '20:00', abr: '09:00' }",
        ),
      );

      expect(() => cargarConfiguracion(directorio)).toThrow(/horario\.0[\s\S]*abr/);
    });

    /**
     * `canal.numero` es el caso concreto que se preguntó: no existe, y ponerlo
     * «por si acaso» tiene que decirlo en vez de tragárselo.
     */
    it('un campo que suena razonable pero no existe tampoco pasa', () => {
      escribir(
        'rota.yaml',
        YAML_VALIDO.replace(
          "canal: { tipo: whatsapp, remitenteId: '123' }",
          "canal: { tipo: whatsapp, remitenteId: '123', numero: '+34600000000' }",
        ),
      );

      expect(() => cargarConfiguracion(directorio)).toThrow(/canal[\s\S]*numero/);
    });

    it('y el ejemplo del repositorio sigue cargando', () => {
      expect(cargarConfiguracion('config/clientes').slugs()).toContain('ejemplo');
    });
  });

  it('el error dice qué campo falla y en qué fichero', () => {
    escribir('rota.yaml', YAML_VALIDO.replace("zonaHoraria: Europe/Madrid", 'zonaHoraria: Marte/Olimpo'));

    expect(() => cargarConfiguracion(directorio)).toThrow(/rota\.yaml[\s\S]*zonaHoraria/);
  });

  it('dos ficheros con el mismo slug se rechazan', () => {
    escribir('a.yaml', YAML_VALIDO);
    escribir('b.yaml', YAML_VALIDO);

    expect(() => cargarConfiguracion(directorio)).toThrow(/repetido/);
  });

  it('preguntar por una clínica que no está cargada falla explícitamente', () => {
    escribir('prueba.yaml', YAML_VALIDO);
    const registro = cargarConfiguracion(directorio);

    expect(() => registro.obtener('inexistente')).toThrow(/inexistente/);
  });
});

describe('recarga', () => {
  it('recargar cambia la versión y el contenido', () => {
    escribir('prueba.yaml', YAML_VALIDO);
    const registro = cargarConfiguracion(directorio);
    const antes = registro.obtener('prueba');

    escribir('prueba.yaml', YAML_VALIDO.replace('39.90', '44.00'));
    const despues = registro.recargar('prueba');

    expect(despues.version).not.toBe(antes.version);
    expect(despues.config.servicios[0]?.precio).toBe(44);
  });

  it('una recarga fallida deja la configuración anterior intacta', () => {
    escribir('prueba.yaml', YAML_VALIDO);
    const registro = cargarConfiguracion(directorio);
    const antes = registro.obtener('prueba');

    escribir('prueba.yaml', 'slug: prueba\nnombre: sin nada mas\n');
    expect(() => registro.recargar('prueba')).toThrow();

    // Nunca se queda una clínica sin configuración por un error de edición.
    const despues = registro.obtener('prueba');
    expect(despues.version).toBe(antes.version);
    expect(despues.config.servicios[0]?.precio).toBe(39.9);
  });
});

describe('qué es obligatorio y qué tiene valor por defecto', () => {
  const base = clienteConfigSchema.parse({
    slug: 'x',
    nombre: 'X',
    zonaHoraria: 'Europe/Madrid',
    canal: { tipo: 'whatsapp', remitenteId: '1' },
    horario: [{ dia: 'lunes', abre: '09:00', cierra: '20:00' }],
    agenda: { nivel: 'A', calendarioId: 'pruebas@group.calendar.google.com' },
    servicios: [{ codigo: 'a', nombre: 'A', precio: 10, duracionMinutos: 30 }],
    escalado: {
      recepcion: [{ nombre: 'Recepción', canal: 'whatsapp', destino: '+34600111111' }],
      contactos: [{ nombre: 'R', canal: 'whatsapp', destino: '+34600000000' }],
      proteccionDeDatos: [
        { nombre: 'DPD', canal: 'email', destino: 'datos@clinica.example' },
      ],
    },
  });

  it('lo peligroso ausente es obligatorio', () => {
    // Cada uno de éstos, si faltara, causaría un daño concreto: precios
    // inventados, citas desplazadas una hora, vencimientos sin sentido o
    // escalados que no llegan a nadie.
    for (const campo of ['servicios', 'zonaHoraria', 'horario', 'escalado', 'canal'] as const) {
      const sinCampo: Record<string, unknown> = { ...base };
      delete sinCampo[campo];
      expect(clienteConfigSchema.safeParse(sinCampo).success, campo).toBe(false);
    }
  });

  it('un catálogo vacío no es una clínica', () => {
    expect(clienteConfigSchema.safeParse({ ...base, servicios: [] }).success).toBe(false);
  });

  it('sin contactos de escalado no se puede cumplir la regla 4', () => {
    expect(
      clienteConfigSchema.safeParse({ ...base, escalado: {
      recepcion: [{ nombre: 'Recepción', canal: 'whatsapp', destino: '+34600111111' }],
      contactos: [],
      proteccionDeDatos: [
        { nombre: 'DPD', canal: 'email', destino: 'datos@clinica.example' },
      ],
    } }).success,
    ).toBe(false);
  });

  it('lo cosmético tiene valor por defecto', () => {
    // El tono admite la forma corta de siempre y se normaliza al estilo
    // completo: los YAML que ya existen siguen valiendo (regla 7).
    expect(base.tono.registro).toBe('cercano');
    expect(base.tono.frasesMaximas).toBe(2);
    expect(base.tono.emojisMaximos).toBe(1);
    expect(base.tono.permiteListas).toBe(false);
    expect(base.vencimientos.propuestaMinutos).toBe(360);
    expect(base.vencimientos.retenidaMinutos).toBe(30);
    expect(base.cortafuegos.ventanaSegundos).toBe(180);
    expect(base.cortafuegos.patronesAdicionales).toEqual([]);
    expect(base.reactivacion.mesesSinVisitaMinimo).toBe(6);
  });

  it('una zona horaria inventada se rechaza', () => {
    expect(clienteConfigSchema.safeParse({ ...base, zonaHoraria: 'Nope/Nope' }).success).toBe(
      false,
    );
  });
});

describe('lo que se deriva de la configuración', () => {
  const config = clienteConfigSchema.parse({
    slug: 'x',
    nombre: 'X',
    zonaHoraria: 'Europe/Madrid',
    canal: { tipo: 'whatsapp', remitenteId: '1' },
    horario: [
      { dia: 'lunes', abre: '09:00', cierra: '20:00' },
      { dia: 'martes', abre: '09:00', cierra: '14:00' },
    ],
    agenda: { nivel: 'A', calendarioId: 'pruebas@group.calendar.google.com' },
    servicios: [{ codigo: 'a', nombre: 'A', precio: 10, duracionMinutos: 30 }],
    escalado: {
      recepcion: [{ nombre: 'Recepción', canal: 'whatsapp', destino: '+34600111111' }],
      contactos: [{ nombre: 'R', canal: 'whatsapp', destino: '+34600000000' }],
      proteccionDeDatos: [
        { nombre: 'DPD', canal: 'email', destino: 'datos@clinica.example' },
      ],
    },
    textos: { urgencia: 'Llama al 900 000 000.' },
  });

  it('el fin de jornada sale del horario de la clínica, en su zona', () => {
    // Lunes 7 de septiembre de 2026, 10:00 en Madrid.
    const fin = finDeJornadaDe(config)(new Date('2026-09-07T08:00:00.000Z'));

    // Cierra a las 20:00 de Madrid = 18:00 UTC en horario de verano.
    expect(fin.toISOString()).toBe('2026-09-07T18:00:00.000Z');
  });

  it('si la clínica está cerrada ese día, se va al siguiente que abra', () => {
    // Miércoles: esta clínica no abre. El siguiente día con horario es el lunes.
    const fin = finDeJornadaDe(config)(new Date('2026-09-09T08:00:00.000Z'));

    expect(fin.toISOString()).toBe('2026-09-14T18:00:00.000Z');
  });

  it('los vencimientos de la política salen del YAML', () => {
    const politica = politicaDe(config);
    expect(politica.propuestaMinutos).toBe(360);
    expect(politica.retenidaMinutos).toBe(30);
  });

  it('el texto de la clínica manda, pero siempre hay respaldo', () => {
    const textos = textosDe(config);

    expect(textos.corte('urgencia_clinica')).toBe('Llama al 900 000 000.');
    // No definió el de baja: se usa el de código, para que nunca haya silencio.
    expect(textos.corte('baja').length).toBeGreaterThan(0);
    expect(textos.enPausa().length).toBeGreaterThan(0);
  });
});

describe('alias de servicio', () => {
  it('son opcionales: un catálogo sin ellos sigue cargando', () => {
    expect(configDePrueba().servicios.every((s) => Array.isArray(s.alias))).toBe(true);
  });

  it('una errata en la clave no carga, como cualquier otra', () => {
    expect(() =>
      configDePrueba({
        servicios: [{ codigo: 'x', nombre: 'X', precio: 10, duracionMinutos: 10, alais: ['y'] }],
      }),
    ).toThrow();
  });
});

describe('datos de ejemplo', () => {
  const CON_EJEMPLO = YAML_VALIDO.replace(
    '  - { codigo: laser, nombre: Láser, precio: 39.90, duracionMinutos: 20 }',
    `  - codigo: laser
    nombre: Láser
    precio: 39.90
    duracionMinutos: 20
    preparacion: !ejemplo Ven con la zona rasurada.
informacion:
  direccion: !ejemplo >-
    Calle Inventada 1.
  aparcamiento: Aparcamiento propio en la puerta.`,
  );

  it('un valor marcado carga como una cadena normal: el esquema no se entera', () => {
    escribir('prueba.yaml', CON_EJEMPLO);
    const { config } = cargarConfiguracion(directorio).obtener('prueba');
    expect(config.informacion.direccion).toBe('Calle Inventada 1.');
    expect(config.servicios[0]?.preparacion).toBe('Ven con la zona rasurada.');
  });

  it('se sabe qué clínica los tiene y en qué campos, y sólo los marcados', () => {
    escribir('prueba.yaml', CON_EJEMPLO);
    expect(cargarConfiguracion(directorio).conDatosDeEjemplo()).toEqual([
      { slug: 'prueba', campos: ['servicios[0].preparacion', 'informacion.direccion'] },
    ]);
  });

  it('una clínica sin marcas no aparece', () => {
    escribir('prueba.yaml', YAML_VALIDO);
    expect(cargarConfiguracion(directorio).conDatosDeEjemplo()).toEqual([]);
  });

  it('una errata en la etiqueta no carga: dejaría el dato inventado sin avisar', () => {
    escribir('prueba.yaml', CON_EJEMPLO.replace('direccion: !ejemplo', 'direccion: !ejmplo'));
    expect(() => cargarConfiguracion(directorio)).toThrow(/ejmplo/);
  });

  it('la plantilla del repositorio declara como inventado todo lo que se le dice tal cual al paciente', () => {
    const [ejemplo] = cargarConfiguracion('config/clientes').conDatosDeEjemplo();
    const { config } = cargarConfiguracion('config/clientes').obtener('ejemplo');
    const tieneTexto = (v: unknown) => typeof v === 'string' && v.length > 0;
    const esperados = [
      ...Object.entries(config.informacion)
        .filter(([, v]) => tieneTexto(v))
        .map(([k]) => `informacion.${k}`),
      ...config.servicios.flatMap((s, i) =>
        tieneTexto(s.preparacion) ? [`servicios[${i}].preparacion`] : [],
      ),
    ];
    expect(esperados.length).toBeGreaterThan(0);
    expect([...(ejemplo?.campos ?? [])].sort()).toEqual(esperados.sort());
  });
});

describe('plantillas de WhatsApp en el YAML', () => {
  const base = () => JSON.parse(JSON.stringify(configDePrueba())) as Record<string, unknown>;

  it('un uso que no existe, un nombre que Meta no aceptaría o una variable inventada no arrancan', () => {
    for (const plantillas of [
      { recordatorios: { nombre: 'recordatorio_cita', idioma: 'es', variables: ['nombre'] } },
      { recordatorio: { nombre: 'Recordatorio Cita', idioma: 'es', variables: ['nombre'] } },
      { recordatorio: { nombre: 'recordatorio_cita', idioma: 'es', variables: ['telefono'] } },
    ]) {
      expect(clienteConfigSchema.safeParse({ ...base(), plantillas }).success).toBe(false);
    }
  });

  it('bien escrita, entra; y sin la sección, ninguna (todo lo de fuera de las 24 h avisará al operador)', () => {
    const r = clienteConfigSchema.safeParse({
      ...base(),
      plantillas: { recordatorio: { nombre: 'recordatorio_cita', idioma: 'es', variables: ['nombre', 'servicio', 'cuando', 'clinica'] } },
    });
    expect(r.success).toBe(true);
    expect(clienteConfigSchema.parse(base()).plantillas).toEqual({});
  });
});
