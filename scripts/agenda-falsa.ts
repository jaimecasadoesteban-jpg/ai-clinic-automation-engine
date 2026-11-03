import { createServer } from 'node:http';

/**
 * Una agenda de mentira para probar a mano, en lugar de n8n.
 *
 * Expone los dos webhooks que el núcleo consulta —`disponibilidad` y
 * `hueco-libre`— y **sólo esos dos**: sólo lectura y sólo ocupado/libre, igual
 * que la de verdad (regla 3).
 *
 *     npm run agenda:falsa
 *
 * Marcar un hueco como ocupado, para probar la colisión del paso 6:
 *
 *     curl -X POST http://127.0.0.1:5099/ocupar \
 *       -H 'content-type: application/json' \
 *       -d '{"inicio":"2026-10-01T08:00:00.000Z"}'
 */

const PUERTO = Number(process.env['PUERTO_AGENDA_FALSA'] ?? 5099);
const ocupados = new Set<string>();

/** Tres huecos, a partir de dentro de una semana, a las 10:00, 11:00 y 12:00 de Madrid. */
function huecos(desde: Date): Array<{ inicio: string; fin: string }> {
  const base = new Date(desde.getTime() + 7 * 86_400_000);
  base.setUTCHours(8, 0, 0, 0); // 10:00 en Madrid (horario de verano)
  return [0, 1, 2].map((i) => {
    const inicio = new Date(base.getTime() + i * 3_600_000);
    return {
      inicio: inicio.toISOString(),
      fin: new Date(inicio.getTime() + 30 * 60_000).toISOString(),
    };
  }).filter((h) => !ocupados.has(h.inicio));
}

async function leer(peticion: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  const trozos: Buffer[] = [];
  for await (const trozo of peticion) trozos.push(trozo as Buffer);
  const crudo = Buffer.concat(trozos).toString('utf8');
  return crudo.length === 0 ? {} : (JSON.parse(crudo) as Record<string, unknown>);
}

const servidor = createServer((peticion, respuesta) => {
  void (async () => {
    const ruta = (peticion.url ?? '').replace(/^\/agenda\//, '/');
    const cuerpo = await leer(peticion);
    respuesta.setHeader('content-type', 'application/json');

    if (ruta === '/disponibilidad') {
      const desde = typeof cuerpo['desde'] === 'string' ? new Date(cuerpo['desde']) : new Date();
      respuesta.end(JSON.stringify({ huecos: huecos(desde) }));
      return;
    }

    if (ruta === '/hueco-libre') {
      const inicio = String(cuerpo['inicio'] ?? '');
      respuesta.end(JSON.stringify({ libre: !ocupados.has(inicio) }));
      return;
    }

    if (ruta === '/ocupar') {
      const inicio = String(cuerpo['inicio'] ?? '');
      ocupados.add(inicio);
      console.log(`hueco ocupado por «la clínica»: ${inicio}`);
      respuesta.end(JSON.stringify({ ocupados: [...ocupados] }));
      return;
    }

    respuesta.statusCode = 404;
    respuesta.end(JSON.stringify({ error: 'ruta desconocida', ruta }));
  })();
});

servidor.listen(PUERTO, '127.0.0.1', () => {
  console.log(`Agenda de mentira escuchando en http://127.0.0.1:${PUERTO}/agenda/`);
  console.log('  POST /agenda/disponibilidad · POST /agenda/hueco-libre · POST /ocupar');
});
