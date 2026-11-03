import { createRequire } from 'node:module';

const requireFromHere = createRequire(import.meta.url);

// `src/config/` en desarrollo y `dist/config/` en producción cuelgan ambos
// dos niveles por debajo de la raíz del repo, así que la ruta es la misma.
const pkg: unknown = requireFromHere('../../package.json');

function readVersion(value: unknown): string {
  if (typeof value === 'object' && value !== null && 'version' in value) {
    const { version } = value as { version: unknown };
    if (typeof version === 'string' && version.length > 0) return version;
  }
  return '0.0.0';
}

export const APP_VERSION = readVersion(pkg);
export const APP_NAME = 'motor-de-citas' as const;
