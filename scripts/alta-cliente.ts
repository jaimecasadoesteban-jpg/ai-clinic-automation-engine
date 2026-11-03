import { existsSync } from 'node:fs';

import postgres from 'postgres';

import { cargarConfiguracion } from '../src/config/registry.js';

/**
 * Da de alta (o actualiza) una clínica en la base de datos a partir de su YAML.
 *
 *     npm run cliente:alta -- <slug> [uuid]
 *
 * El YAML manda en tiempo de ejecución; esta copia en `clients.config` existe
 * para poder reconstruir con qué configuración se respondió, sin depender de
 * qué fichero había en el servidor aquel día.
 *
 * Usa DIRECT_URL (conexión directa, no el pooler): esto es administración, no
 * tráfico. Se salta RLS por ser superusuario, que es lo correcto aquí — es el
 * único punto del sistema que crea clínicas.
 */

if (existsSync('.env')) process.loadEnvFile('.env');

const slug = process.argv[2];
const idPedido = process.argv[3];

if (slug === undefined) {
  console.error('Uso: npm run cliente:alta -- <slug> [uuid]');
  console.error('  El <slug> debe coincidir con el de config/clientes/<slug>.yaml');
  process.exit(1);
}

const url = process.env['DIRECT_URL'];
if (url === undefined || url === '') {
  console.error('Falta DIRECT_URL. Copia .env.example a .env y rellénalo.');
  process.exit(1);
}

const registro = cargarConfiguracion();
const { config, version } = registro.obtener(slug);

const sql = postgres(url, { max: 1, onnotice: () => {} });

try {
  const filas = await sql`
    insert into motor.clients (id, slug, name, timezone, config, config_version)
    values (
      ${idPedido ?? sql`gen_random_uuid()`},
      ${config.slug},
      ${config.nombre},
      ${config.zonaHoraria},
      ${sql.json(config)},
      ${version}
    )
    on conflict (slug) do update
      set name = excluded.name,
          timezone = excluded.timezone,
          config = excluded.config,
          config_version = excluded.config_version,
          active = true
    returning id, slug, config_version
  `;

  const fila = filas[0];
  console.log(`Clínica «${config.nombre}» lista.`);
  console.log(`  clientId: ${String(fila?.['id'])}`);
  console.log(`  slug:     ${String(fila?.['slug'])}`);
  console.log(`  versión:  ${String(fila?.['config_version'])}`);
  console.log(`  servicios: ${config.servicios.length} · contactos de escalado: ${config.escalado.contactos.length}`);
} finally {
  await sql.end();
}
