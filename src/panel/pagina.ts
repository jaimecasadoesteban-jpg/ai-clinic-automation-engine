/**
 * La página del panel: HTML, CSS y JS sin dependencias ni paso de compilación,
 * servidos por el propio núcleo. Con `script-src 'self'` y `style-src 'self'`
 * en la CSP: el JS va en su propio fichero, y los estilos que se calculan
 * (posiciones del calendario, colores de avatar) se ponen por el CSSOM
 * (`style.cssText`), que la CSP permite, y nunca como atributo `style`.
 *
 * **Todo lo que llega de un paciente se pinta con `textContent`, nunca como
 * HTML**: el texto de un WhatsApp lo escribe cualquiera que tenga el número.
 * Los únicos `innerHTML` son los iconos, que son constantes de este fichero.
 */

export const HTML = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Motor de Citas · Panel</title>
<link rel="stylesheet" href="/panel/app.css">
</head>
<body>
<div id="entrar" class="oculto">
  <form id="form-entrar" class="tarjeta-entrar">
    <div class="marca-grande"><span class="logo"></span><div><strong>Motor de Citas</strong><small>Panel del operador</small></div></div>
    <label>Usuario <input name="usuario" autocomplete="username" required></label>
    <label>Contraseña <input name="clave" type="password" autocomplete="current-password" required></label>
    <button type="submit" class="primario">Entrar</button>
    <p id="error-entrar" class="error"></p>
  </form>
</div>
<div id="app" class="oculto">
  <aside class="menu">
    <div class="marca"><span class="logo"></span><strong>Motor de Citas</strong></div>
    <nav id="nav"></nav>
    <span class="hueco"></span>
    <div class="pie-menu">
      <button id="tema" class="icono-boton" title="Cambiar tema"></button>
      <span id="usuario" class="tenue"></span>
      <button id="salir" class="enlace">Salir</button>
    </div>
  </aside>
  <main id="principal"></main>
</div>
<div id="avisos" aria-live="polite"></div>
<script src="/panel/app.js"></script>
</body>
</html>`;

export const CSS = `
:root, :root[data-theme="light"] {
  --fondo: #f4f5f8; --superficie: #ffffff; --superficie-2: #f8f9fb; --borde: #e4e7ec; --texto: #1b2230; --tenue: #667085;
  --acento: #3b5bdb; --acento-suave: #e8edff; --paciente: #f0f2f5; --agente: #e5ebff; --persona: #def7e8; --sistema: #f7f1df;
  --peligro: #d9480f; --aviso: #e8a400; --ok: #2b8a3e; --sombra: 0 1px 2px rgba(16,24,40,.06), 0 1px 3px rgba(16,24,40,.08);
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --fondo: #0d1117; --superficie: #161b22; --superficie-2: #1b212b; --borde: #2a313c; --texto: #e6e8ec; --tenue: #9aa4b2;
    --acento: #7c96ff; --acento-suave: #1f2a4d; --paciente: #212833; --agente: #1e2a4f; --persona: #173a28; --sistema: #2f2a1b;
    --peligro: #ff8a50; --aviso: #fcc419; --ok: #51cf66; --sombra: 0 1px 2px rgba(0,0,0,.4);
    color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --fondo: #0d1117; --superficie: #161b22; --superficie-2: #1b212b; --borde: #2a313c; --texto: #e6e8ec; --tenue: #9aa4b2;
  --acento: #7c96ff; --acento-suave: #1f2a4d; --paciente: #212833; --agente: #1e2a4f; --persona: #173a28; --sistema: #2f2a1b;
  --peligro: #ff8a50; --aviso: #fcc419; --ok: #51cf66; --sombra: 0 1px 2px rgba(0,0,0,.4);
  color-scheme: dark;
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body { background: var(--fondo); color: var(--texto); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; -webkit-font-smoothing: antialiased; }
button { font: inherit; cursor: pointer; border: 1px solid var(--borde); background: var(--superficie); color: var(--texto); border-radius: 8px; padding: 7px 12px; transition: background .12s, border-color .12s, transform .05s; }
button:hover:not(:disabled) { border-color: var(--acento); }
button:active:not(:disabled) { transform: translateY(1px); }
button:disabled { opacity: .5; cursor: default; }
button.primario { background: var(--acento); border-color: var(--acento); color: #fff; }
button.exito { background: var(--ok); border-color: var(--ok); color: #fff; }
button.chico { padding: 4px 10px; font-size: 13px; }
input, textarea { font: inherit; color: var(--texto); background: var(--superficie); border: 1px solid var(--borde); border-radius: 8px; padding: 9px 11px; width: 100%; outline: none; }
input:focus, textarea:focus { border-color: var(--acento); box-shadow: 0 0 0 3px var(--acento-suave); }
svg { width: 18px; height: 18px; stroke: currentColor; fill: none; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; flex: none; }
.oculto { display: none !important; }
.tenue { color: var(--tenue); }
.error { color: var(--peligro); min-height: 1.2em; margin: 0; }
.enlace { border: 0; background: none; color: var(--acento); padding: 4px; }
.icono-boton { border: 0; background: none; color: var(--tenue); padding: 6px; border-radius: 8px; display: inline-flex; }
.icono-boton:hover { background: var(--superficie-2); color: var(--texto); }
.hueco { flex: 1; }
.logo { width: 28px; height: 28px; border-radius: 8px; background: linear-gradient(135deg, var(--acento), #9775fa); display: inline-block; flex: none; position: relative; }
.logo::after { content: ''; position: absolute; inset: 8px 7px 7px 8px; border: 2px solid #fff; border-radius: 3px; border-top-width: 4px; }

#entrar { display: flex; height: 100%; align-items: center; justify-content: center; padding: 16px; }
.tarjeta-entrar { background: var(--superficie); border: 1px solid var(--borde); border-radius: 14px; padding: 28px; width: 100%; max-width: 360px; display: grid; gap: 14px; box-shadow: var(--sombra); }
.tarjeta-entrar label { display: grid; gap: 5px; font-weight: 500; }
.marca-grande { display: flex; gap: 12px; align-items: center; margin-bottom: 6px; }
.marca-grande strong { display: block; font-size: 17px; }
.marca-grande small { color: var(--tenue); }

#app { display: flex; height: 100%; }
.menu { width: 228px; background: var(--superficie); border-right: 1px solid var(--borde); display: flex; flex-direction: column; padding: 14px 10px; gap: 6px; flex: none; }
.marca { display: flex; gap: 10px; align-items: center; padding: 4px 8px 14px; }
#nav { display: grid; gap: 2px; }
#nav button { display: flex; gap: 10px; align-items: center; border: 0; background: none; padding: 9px 10px; border-radius: 8px; color: var(--tenue); text-align: left; width: 100%; }
#nav button:hover { background: var(--superficie-2); color: var(--texto); }
#nav button.activa { background: var(--acento-suave); color: var(--acento); font-weight: 600; }
#nav .etiqueta-nav { flex: 1; }
.contador { background: var(--peligro); color: #fff; border-radius: 999px; padding: 0 7px; font-size: 11px; font-weight: 700; line-height: 18px; min-width: 18px; text-align: center; }
.contador.aviso { background: var(--aviso); color: #1b1b1b; }
.pie-menu { display: flex; align-items: center; gap: 6px; padding: 8px; border-top: 1px solid var(--borde); }
.pie-menu #usuario { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#principal { flex: 1; min-width: 0; overflow: auto; }
.pagina { padding: 22px 26px 40px; max-width: 1280px; margin: 0 auto; }
.cabecera-pagina { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; flex-wrap: wrap; }
.cabecera-pagina h1 { font-size: 22px; margin: 0; letter-spacing: -.01em; }
.cabecera-pagina .sub { color: var(--tenue); }

.kpis { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 12px; margin-bottom: 18px; }
.kpi { background: var(--superficie); border: 1px solid var(--borde); border-radius: 12px; padding: 14px 16px; text-align: left; display: grid; gap: 4px; box-shadow: var(--sombra); }
.kpi:hover { border-color: var(--acento); }
.kpi .cifra { font-size: 28px; font-weight: 700; letter-spacing: -.02em; }
.kpi .nombre { color: var(--tenue); font-size: 13px; display: flex; align-items: center; gap: 6px; }
.kpi.alerta .cifra { color: var(--peligro); }
.kpi.atento .cifra { color: var(--aviso); }
.columnas { display: grid; grid-template-columns: 3fr 2fr; gap: 16px; }
.tarjeta { background: var(--superficie); border: 1px solid var(--borde); border-radius: 12px; box-shadow: var(--sombra); overflow: hidden; }
.tarjeta > h2 { font-size: 15px; margin: 0; padding: 14px 16px; border-bottom: 1px solid var(--borde); display: flex; align-items: center; gap: 8px; }
.tarjeta > h2 .hueco { flex: 1; }
.vacia { padding: 26px 16px; text-align: center; color: var(--tenue); }
.fila-lista { display: flex; gap: 12px; align-items: center; padding: 11px 16px; border-top: 1px solid var(--borde); cursor: pointer; }
.fila-lista:first-of-type { border-top: 0; }
.fila-lista:hover { background: var(--superficie-2); }
.fila-lista .principal { flex: 1; min-width: 0; }
.fila-lista .principal strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fila-lista .principal span { color: var(--tenue); font-size: 13px; }
.hora-grande { font-variant-numeric: tabular-nums; font-weight: 700; width: 52px; flex: none; }
.franja-estado { width: 4px; align-self: stretch; border-radius: 4px; background: var(--c, var(--tenue)); flex: none; }
.chip { font-size: 12px; border-radius: 999px; padding: 2px 9px; background: color-mix(in srgb, var(--c, var(--tenue)) 15%, transparent); color: var(--c, var(--tenue)); font-weight: 600; white-space: nowrap; }
.que-hacer { color: var(--acento) !important; font-weight: 600; }
.fila-lista.escalado { align-items: flex-start; }
.fila-lista.escalado .principal > span { display: block; margin-top: 2px; }
.seccion > h3 { font-size: 13px; color: var(--tenue); margin: 0 0 8px; font-weight: 600; }
.seccion { margin-bottom: 16px; }
.chip.estado-retenida, .chip.estado-pendiente_recepcion { --c: var(--aviso); }
.chip.estado-confirmada { --c: var(--acento); }
.chip.estado-asistida { --c: var(--ok); }
.chip.estado-no_asistida { --c: var(--peligro); }
.botones { display: flex; gap: 6px; flex-wrap: wrap; }

.vista-conversaciones { display: flex; height: 100%; }
.lista { width: 340px; flex: none; border-right: 1px solid var(--borde); display: flex; flex-direction: column; background: var(--superficie); }
.lista .buscar { padding: 12px 12px 8px; }
.filtros { display: flex; gap: 6px; padding: 0 12px 10px; flex-wrap: wrap; }
.filtros button { border-radius: 999px; padding: 3px 11px; font-size: 13px; }
.filtros button.activa { background: var(--acento); border-color: var(--acento); color: #fff; }
#conversaciones { list-style: none; margin: 0; padding: 0; overflow-y: auto; flex: 1; }
#conversaciones li { display: flex; gap: 10px; padding: 11px 12px; border-top: 1px solid var(--borde); cursor: pointer; align-items: flex-start; }
#conversaciones li:hover { background: var(--superficie-2); }
#conversaciones li.elegida { background: var(--acento-suave); }
.avatar { width: 38px; height: 38px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-weight: 700; font-size: 14px; color: #fff; flex: none; background: var(--c); }
.avatar.grande { width: 46px; height: 46px; font-size: 16px; }
.item-texto { flex: 1; min-width: 0; display: grid; gap: 2px; }
.fila { display: flex; gap: 8px; align-items: baseline; }
.fila .nombre { font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.extracto { color: var(--tenue); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.punto { width: 8px; height: 8px; border-radius: 50%; background: var(--acento); flex: none; align-self: center; }
.marcas { display: flex; gap: 5px; flex-wrap: wrap; }
.marca-chica { font-size: 11px; border-radius: 4px; padding: 0 6px; border: 1px solid currentColor; }
.marca-chica.parado { color: var(--peligro); }
.marca-chica.escalado { color: var(--aviso); }

.chat { flex: 1; display: flex; flex-direction: column; min-width: 0; background: var(--fondo); }
.chat-vacio { flex: 1; display: grid; place-items: center; color: var(--tenue); text-align: center; padding: 20px; }
.chat-vacio svg { width: 40px; height: 40px; opacity: .5; margin-bottom: 8px; }
.cabecera-chat { padding: 12px 16px; border-bottom: 1px solid var(--borde); background: var(--superficie); display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.cabecera-chat .quien { flex: 1; min-width: 180px; }
.cabecera-chat .quien strong { font-size: 16px; display: block; }
.interruptor { display: flex; align-items: center; gap: 8px; border: 0; background: none; padding: 4px; font-weight: 600; }
.interruptor .pista { width: 40px; height: 22px; border-radius: 999px; background: var(--peligro); position: relative; transition: background .15s; }
.interruptor .pista::after { content: ''; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: left .15s; }
.interruptor.activo .pista { background: var(--ok); }
.interruptor.activo .pista::after { left: 21px; }
.cuerpo-chat { flex: 1; display: flex; min-height: 0; }
.columna-hilo { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.hilo { flex: 1; overflow-y: auto; padding: 18px 20px; display: flex; flex-direction: column; gap: 6px; }
.separador-dia { align-self: center; font-size: 12px; color: var(--tenue); background: var(--superficie); border: 1px solid var(--borde); border-radius: 999px; padding: 2px 10px; margin: 10px 0 4px; }
.burbuja { max-width: 70%; padding: 8px 12px; border-radius: 14px; white-space: pre-wrap; word-wrap: break-word; box-shadow: var(--sombra); }
.burbuja .meta { font-size: 11px; color: var(--tenue); margin-top: 3px; text-align: right; }
.burbuja.paciente { background: var(--superficie); align-self: flex-start; border-bottom-left-radius: 4px; }
.burbuja.agente { background: var(--agente); align-self: flex-end; border-bottom-right-radius: 4px; }
.burbuja.persona, .burbuja.equipo { background: var(--persona); align-self: flex-end; border-bottom-right-radius: 4px; }
.burbuja.sistema { background: var(--sistema); align-self: flex-end; border-bottom-right-radius: 4px; }
.burbuja .nota { font-size: 12px; color: var(--peligro); margin-top: 4px; font-weight: 600; }
.ficha { width: 300px; border-left: 1px solid var(--borde); padding: 14px; overflow-y: auto; background: var(--superficie); display: grid; align-content: start; gap: 10px; }
.ficha h3 { margin: 6px 0 0; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: var(--tenue); }
.ficha-cabeza { display: flex; gap: 10px; align-items: center; }
.dato { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 13px; }
.dato span:first-child { color: var(--tenue); }
.caja { border: 1px solid var(--borde); border-radius: 10px; padding: 9px 11px; display: grid; gap: 5px; background: var(--superficie-2); }
.redactar { border-top: 1px solid var(--borde); padding: 10px 12px; background: var(--superficie); display: grid; gap: 6px; }
.redactar .fila-redactar { display: flex; gap: 8px; align-items: flex-end; }
.redactar textarea { resize: none; min-height: 42px; max-height: 160px; }
.redactar .ayuda { font-size: 12px; color: var(--tenue); }
.volver { display: none; }
.solo-movil { display: none !important; }

.cal-barra { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
.cal-leyenda { display: flex; gap: 12px; flex-wrap: wrap; font-size: 12px; color: var(--tenue); margin-left: auto; }
.cal-leyenda span::before { content: ''; display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 5px; vertical-align: -1px; background: var(--c); }
/* Un solo scroll: el del calendario, con su propio alto. Dentro de otra página con scroll,
   el navegador dudaba qué mover y la rueda se atascaba un instante. */
.pagina-calendario { display: flex; flex-direction: column; height: 100%; padding-bottom: 16px; }
.pagina-calendario > div:last-child { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.cal { display: grid; grid-template-columns: 54px repeat(7, minmax(110px, 1fr)); grid-template-rows: auto 1fr; border: 1px solid var(--borde); border-radius: 12px; background: var(--superficie); overflow: auto; overscroll-behavior: contain; box-shadow: var(--sombra); flex: 1; min-height: 0; }
.cal-cab { padding: 10px 8px; font-weight: 600; text-align: center; border-bottom: 1px solid var(--borde); border-left: 1px solid var(--borde); position: sticky; top: 0; background: var(--superficie); z-index: 3; }
.cal-cab.hoy { color: var(--acento); }
.cal-horas, .cal-dia { position: relative; border-left: 1px solid var(--borde); }
.cal-horas { border-left: 0; }
.cal-hora { position: absolute; right: 6px; font-size: 11px; color: var(--tenue); transform: translateY(-50%); font-variant-numeric: tabular-nums; }
.cal-linea { position: absolute; left: 0; right: 0; border-top: 1px dashed var(--borde); }
.cal-cerrado { position: absolute; left: 0; right: 0; background: repeating-linear-gradient(45deg, transparent 0 6px, var(--superficie-2) 6px 12px); }
.cal-dia.hoy { background: color-mix(in srgb, var(--acento) 4%, transparent); }
.cal-ahora { position: absolute; left: 0; right: 0; border-top: 2px solid var(--peligro); z-index: 2; }
.cal-ahora::before { content: ''; position: absolute; left: -5px; top: -6px; width: 10px; height: 10px; border-radius: 50%; background: var(--peligro); }
.cal-cita { position: absolute; left: 3px; right: 3px; border-radius: 7px; padding: 4px 7px; font-size: 12px; line-height: 1.25; overflow: hidden; cursor: pointer; background: color-mix(in srgb, var(--c) 18%, var(--superficie)); border-left: 3px solid var(--c); z-index: 1; transition: transform .08s, box-shadow .08s; }
.cal-cita strong { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cal-cita:hover { transform: scale(1.02); box-shadow: var(--sombra); z-index: 4; }

.grupo-dia { margin-bottom: 16px; }
.grupo-dia > h3 { font-size: 13px; color: var(--tenue); text-transform: capitalize; margin: 0 0 8px; }

#avisos { position: fixed; right: 18px; bottom: 18px; display: grid; gap: 8px; z-index: 50; max-width: min(380px, calc(100vw - 36px)); }
.aviso { background: var(--texto); color: var(--fondo); border-radius: 10px; padding: 10px 14px; box-shadow: 0 6px 20px rgba(0,0,0,.25); animation: entra .18s ease-out; }
.aviso.error { background: var(--peligro); color: #fff; }
.aviso.exito { background: var(--ok); color: #fff; }
@keyframes entra { from { transform: translateY(8px); opacity: 0; } to { transform: none; opacity: 1; } }

@media (max-width: 1100px) { .ficha { display: none; } .columnas { grid-template-columns: 1fr; } }
@media (max-width: 760px) {
  #app { flex-direction: column-reverse; height: 100dvh; }
  .menu { width: 100%; flex-direction: row; padding: 4px 2px calc(4px + env(safe-area-inset-bottom)); border-right: 0; border-top: 1px solid var(--borde); gap: 0; }
  .marca, .menu > .hueco, .pie-menu { display: none; }
  .solo-movil { display: inline-flex !important; }
  #nav { display: flex; flex: 1; justify-content: space-around; }
  #nav button { flex-direction: column; gap: 2px; font-size: 10px; padding: 6px 4px; position: relative; justify-content: center; }
  #nav .contador { position: absolute; top: 0; right: 4px; }
  .pagina { padding: 16px; }
  .lista { width: 100%; }
  .vista-conversaciones.con-chat .lista { display: none; }
  .vista-conversaciones:not(.con-chat) .chat { display: none; }
  .volver { display: inline-flex; }
  .burbuja { max-width: 86%; }
  .kpi .cifra { font-size: 24px; }
  /* Las filas con etiqueta y botón no caben en una línea: el nombre primero, lo demás debajo. */
  .fila-lista { flex-wrap: wrap; }
  .fila-lista .principal { min-width: 150px; }
}
`;

export const JS = String.raw`
'use strict';
const $ = (s) => document.querySelector(s);

/* ── Iconos: constantes de este fichero, lo único que entra como innerHTML ── */
const ICONOS = {
  inicio: '<svg viewBox="0 0 24 24"><path d="M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z"/></svg>',
  conversaciones: '<svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>',
  calendario: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
  citas: '<svg viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/></svg>',
  asistencia: '<svg viewBox="0 0 24 24"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="9"/></svg>',
  escalados: '<svg viewBox="0 0 24 24"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
  sol: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  luna: '<svg viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  volver: '<svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>',
  copiar: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  enviar: '<svg viewBox="0 0 24 24"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/></svg>',
};
const icono = (n) => { const s = document.createElement('span'); s.innerHTML = ICONOS[n] || ''; s.style.display = 'inline-flex'; return s; };

const VISTAS = [
  ['inicio', 'Inicio'], ['conversaciones', 'Conversaciones'], ['calendario', 'Calendario'],
  ['citas', 'Citas'], ['asistencia', 'Asistencia'], ['escalados', 'Escalados'],
];
const ESTADOS = { retenida: 'Retenida', pendiente_recepcion: 'Pendiente de meter', confirmada: 'Confirmada', asistida: 'Asistió', no_asistida: 'No vino' };
const COLOR_ESTADO = { retenida: 'var(--aviso)', pendiente_recepcion: 'var(--aviso)', confirmada: 'var(--acento)', asistida: 'var(--ok)', no_asistida: 'var(--peligro)' };
const MOTIVOS = {
  baja: 'Baja', urgencia_clinica: 'Urgencia clínica', contenido_clinico: 'Contenido clínico', menor_de_edad: 'Menor de edad',
  queja: 'Queja', pide_persona: 'Pide una persona', agente_atascado: 'Agente atascado', derechos_rgpd: 'Derechos RGPD',
  peticion_paciente: 'Petición del paciente', validacion_fallida: 'Validación fallida', proveedor_caido: 'Proveedor caído',
  historial_falso: 'Historial falso', agenda_no_escrita: 'Agenda no escrita', agenda_no_disponible: 'Agenda no disponible',
  latido_perdido: 'Latido perdido', sin_respuesta_recepcion: 'Recepción no responde', colision: 'Colisión',
};
/**
 * Cada escalado, explicado: qué ha pasado y qué hay que hacer. Los técnicos son
 * para el operador (algo del sistema), no para la clínica.
 */
const ESCALADOS = {
  urgencia_clinica: ['Posible urgencia clínica', 'Ha contado algo que puede ser una complicación (dolor, rojez, sangrado…). Recibió el texto de urgencia aprobado y el agente ya no le habla.', 'Que lo vea ya el responsable clínico y le llame.'],
  contenido_clinico: ['Pregunta clínica', 'Ha preguntado algo médico que el agente no contesta.', 'Que le responda alguien con criterio clínico.'],
  menor_de_edad: ['Posible menor de edad', 'Parece que escribe un menor, o sobre un menor. El agente se ha parado.', 'Comprobarlo y hablar con su madre, padre o tutor.'],
  queja: ['Queja', 'El paciente está molesto o se queja de algo.', 'Que le escriba o le llame una persona.'],
  pide_persona: ['Quiere hablar con una persona', 'Ha pedido que le atienda alguien del equipo.', 'Escribirle desde este chat o llamarle.'],
  agente_atascado: ['El agente no avanza', 'La conversación da vueltas sin resolverse.', 'Leer el chat y tomar el relevo.'],
  validacion_fallida: ['El agente no supo responder bien', 'Su respuesta no pasó los controles dos veces (un precio, una hora o una promesa que no podía hacer). Al paciente le llegó «te escribe alguien del equipo».', 'Contestarle tú desde el chat.'],
  proveedor_caido: ['La IA no respondió', 'El servicio de IA falló o tardó demasiado. El paciente recibió un texto de espera.', 'Contestarle tú desde el chat.'],
  historial_falso: ['Se le dijo algo que no era verdad', 'Un mensaje anterior del agente afirmaba algo falso; el detalle está abajo.', 'Aclarárselo al paciente.'],
  derechos_rgpd: ['Solicitud de protección de datos', 'Ha pedido ejercer un derecho sobre sus datos (acceso, supresión…). Plazo legal: un mes.', 'Pasárselo a quien lleve protección de datos en la clínica.'],
  peticion_paciente: ['Volvió a escribir tras darse de baja', 'Se dio de baja de las comunicaciones y ha vuelto a escribir. El agente le atiende, y sigue fuera de las campañas.', 'Sólo informativo.'],
  sin_respuesta_recepcion: ['Cita sin meter en la agenda', 'Recepción no ha confirmado una cita en su plazo.', 'Meterla en la agenda y pulsar «Ya la he metido».'],
  agenda_no_escrita: ['La cita no se pudo escribir en la agenda', 'En modo automático, Google no confirmó el evento y la cita pasó a confirmación manual.', 'Mirar el calendario: si está, pulsar «Ya la he metido»; si no, meterla.'],
  agenda_no_disponible: ['No se pudo consultar la agenda', 'Google Calendar no respondió. El paciente recibió «escríbeme en un rato».', 'Lo revisa el operador (la conexión con Google). Si ya funciona, márcalo como atendido.', true],
  latido_perdido: ['Un proceso automático dejó de funcionar', 'Una tarea programada (caducar propuestas, verificar citas…) llevaba tiempo sin correr.', 'Lo revisa el operador. Si ya funciona, márcalo como atendido.', true],
};
const describir = (motivo) => {
  const d = ESCALADOS[motivo];
  return d ? { titulo: d[0], que: d[1], hacer: d[2], tecnico: d[3] === true } : { titulo: MOTIVOS[motivo] || motivo, que: '', hacer: '', tecnico: false };
};

const AUTORES = { paciente: 'Paciente', agente: 'Agente', sistema: 'Sistema', persona: 'Tú, desde el panel', equipo: 'Equipo (móvil o Chatwoot)' };

let estado = { vista: 'inicio', conversaciones: [], filtro: 'todas', buscar: '', abierta: null, huella: null, semana: 0, contadores: {}, huellas: {} };

/* ── Utilidades ── */
function el(tag, props, ...hijos) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') n.className = v;
    // Por el CSSOM y no como atributo: la CSP (style-src 'self') bloquea los atributos style.
    else if (k === 'style') n.style.cssText = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const h of hijos.flat()) if (h !== null && h !== undefined && h !== false) n.append(h instanceof Node ? h : document.createTextNode(String(h)));
  return n;
}

async function api(ruta, opciones) {
  const o = opciones || {};
  // Un POST con content-type JSON y sin cuerpo lo rechaza el servidor: va con {}.
  const cuerpoPorDefecto = o.method === 'POST' && o.body === undefined ? { body: '{}' } : {};
  const r = await fetch(ruta, {
    credentials: 'same-origin', ...o, ...cuerpoPorDefecto,
    headers: { 'content-type': 'application/json', 'x-panel': '1', ...(o.headers || {}) },
  });
  if (r.status === 401 && ruta.startsWith('/panel/api/')) { mostrarEntrar(); throw new Error('Sesión caducada'); }
  const cuerpo = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(cuerpo.mensaje || ('Error ' + r.status));
  return cuerpo;
}

function aviso(texto, tipo) {
  const n = el('div', { class: 'aviso ' + (tipo || '') }, texto);
  $('#avisos').append(n);
  setTimeout(() => n.remove(), 4500);
}

/** Una acción con su botón: lo desactiva mientras corre, avisa del resultado y refresca. */
async function accion(boton, fn, exito) {
  if (boton) boton.disabled = true;
  try {
    const r = await fn();
    const texto = typeof exito === 'function' ? exito(r) : exito;
    if (texto) aviso(texto, 'exito');
  } catch (err) { aviso(err.message, 'error'); }
  if (boton) boton.disabled = false;
  estado.huellas = {};
  await refrescar(true);
}

function hora(iso, zona, larga) {
  if (!iso) return '';
  const f = new Date(iso);
  const mismoDia = f.toLocaleDateString('es-ES', { timeZone: zona }) === new Date().toLocaleDateString('es-ES', { timeZone: zona });
  const op = larga || !mismoDia
    ? { timeZone: zona, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }
    : { timeZone: zona, hour: '2-digit', minute: '2-digit' };
  return f.toLocaleString('es-ES', op);
}
const horaCorta = (iso, zona) => new Date(iso).toLocaleTimeString('es-ES', { timeZone: zona, hour: '2-digit', minute: '2-digit' });
const diaLargo = (iso, zona) => new Date(iso).toLocaleDateString('es-ES', { timeZone: zona, weekday: 'long', day: 'numeric', month: 'long' });

function diaRelativo(iso, zona) {
  const clave = (d) => d.toLocaleDateString('en-CA', { timeZone: zona });
  const d = clave(new Date(iso));
  const hoy = new Date();
  if (d === clave(hoy)) return 'Hoy';
  if (d === clave(new Date(hoy.getTime() - 86400000))) return 'Ayer';
  if (d === clave(new Date(hoy.getTime() + 86400000))) return 'Mañana';
  return diaLargo(iso, zona);
}

function avatar(nombre, grande) {
  const texto = (nombre || '?').trim();
  const iniciales = texto.replace(/^\+/, '').split(/\s+/).slice(0, 2).map((p) => p[0] || '').join('').toUpperCase() || '?';
  let h = 0;
  for (const c of texto) h = (h * 31 + c.charCodeAt(0)) % 360;
  return el('span', { class: 'avatar' + (grande ? ' grande' : ''), style: '--c: hsl(' + h + ' 55% 48%)' }, iniciales);
}

const chipEstado = (e) => el('span', { class: 'chip estado-' + e }, ESTADOS[e] || e);
const lugar = (zona) => 'hora de ' + zona.split('/').pop().replace('_', ' ');

/* ── Sesión y tema ── */
function mostrarEntrar() { $('#app').classList.add('oculto'); $('#entrar').classList.remove('oculto'); }
async function mostrarApp() {
  const yo = await api('/panel/api/yo');
  $('#usuario').textContent = yo.usuario;
  $('#entrar').classList.add('oculto');
  $('#app').classList.remove('oculto');
  irDesdeDireccion();
}

$('#form-entrar').addEventListener('submit', async (e) => {
  e.preventDefault();
  const datos = new FormData(e.target);
  $('#error-entrar').textContent = '';
  try {
    await api('/panel/entrar', { method: 'POST', body: JSON.stringify({ usuario: datos.get('usuario'), clave: datos.get('clave') }) });
    e.target.reset();
    await mostrarApp();
  } catch (err) { $('#error-entrar').textContent = err.message; }
});
$('#salir').addEventListener('click', async () => { await api('/panel/salir', { method: 'POST' }).catch(() => {}); mostrarEntrar(); });

function leerTema() { try { return localStorage.getItem('tema'); } catch { return null; } }
function esOscuro() {
  const t = document.documentElement.getAttribute('data-theme');
  return t === 'dark' || (!t && matchMedia('(prefers-color-scheme: dark)').matches);
}
function ponerTema(t) {
  if (t) document.documentElement.setAttribute('data-theme', t); else document.documentElement.removeAttribute('data-theme');
  try { if (t) localStorage.setItem('tema', t); } catch { /* sin almacenamiento: el tema vuelve al del sistema */ }
  $('#tema').replaceChildren(icono(esOscuro() ? 'sol' : 'luna'));
}
$('#tema').addEventListener('click', () => ponerTema(esOscuro() ? 'light' : 'dark'));
ponerTema(leerTema());

/* ── Navegación: #/vista o #/conversaciones/clinica/id. El «atrás» del navegador funciona. ── */
function ir(ruta) { if (location.hash !== '#/' + ruta) location.hash = '#/' + ruta; else irDesdeDireccion(); }
function irA(clientId, conversacionId) { ir('conversaciones/' + clientId + '/' + conversacionId); }
window.addEventListener('hashchange', () => irDesdeDireccion());
function irDesdeDireccion() {
  const partes = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const vista = VISTAS.some(([v]) => v === partes[0]) ? partes[0] : 'inicio';
  const antes = estado.vista;
  estado.vista = vista;
  if (vista === 'conversaciones' && partes[1] && partes[2]) {
    if (!estado.abierta || estado.abierta.id !== partes[2]) { estado.abierta = { clientId: partes[1], id: partes[2] }; estado.huella = null; }
  } else if (vista === 'conversaciones') {
    estado.abierta = null; estado.huella = null;
  }
  pintarMenu();
  // La vista de conversaciones se monta una vez: abrir otro chat no rehace la lista (ni su scroll ni el buscador).
  if (antes !== vista || vista !== 'conversaciones' || !document.querySelector('.vista-conversaciones')) montarVista();
  else document.querySelector('.vista-conversaciones').classList.toggle('con-chat', !!estado.abierta);
  if (vista === 'conversaciones' && !estado.abierta) $('#chat').replaceChildren(chatVacio());
  refrescar(true);
}

function pintarMenu() {
  $('#nav').replaceChildren(...VISTAS.map(([v, nombre]) => {
    const n = estado.contadores[v] || 0;
    return el('button', { class: estado.vista === v ? 'activa' : '', onclick: () => ir(v), title: nombre },
      icono(v), el('span', { class: 'etiqueta-nav' }, nombre),
      n > 0 ? el('span', { class: 'contador' + (v === 'asistencia' ? ' aviso' : '') }, String(n)) : null);
  }));
}

/* ── Esqueleto de cada vista (se monta una vez; el refresco sólo cambia el contenido) ── */
function montarVista() {
  const p = $('#principal');
  if (estado.vista === 'conversaciones') {
    // La vista se monta de cero, con el chat vacío: hay que volver a pintarlo
    // aunque sea el mismo de antes. Sin esto, volver al chat que se tenía
    // abierto lo dejaba en blanco para siempre.
    estado.huella = null;
    const vista = el('div', { class: 'vista-conversaciones' + (estado.abierta ? ' con-chat' : '') });
    const buscar = el('input', { type: 'search', placeholder: 'Buscar por nombre o teléfono  ( / )', value: estado.buscar,
      oninput: (e) => { estado.buscar = e.target.value.toLowerCase(); pintarLista(); } });
    const filtros = el('div', { class: 'filtros' }, [['todas', 'Todas'], ['esperando', 'Esperando'], ['parado', 'Agente parado'], ['escalado', 'Con escalado']].map(([f, t]) =>
      el('button', { class: estado.filtro === f ? 'activa' : '', onclick: (e) => {
        estado.filtro = f;
        e.target.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('activa', b === e.target));
        pintarLista();
      } }, t)));
    vista.append(el('div', { class: 'lista' }, el('div', { class: 'buscar' }, buscar), filtros, el('ul', { id: 'conversaciones' })),
      el('section', { class: 'chat', id: 'chat' }, chatVacio()));
    p.replaceChildren(vista);
    return;
  }
  estado.huellas = {};
  p.replaceChildren(el('div', { class: 'pagina' + (estado.vista === 'calendario' ? ' pagina-calendario' : ''), id: 'contenido' }, el('div', { class: 'vacia' }, 'Cargando…')));
}

function chatVacio() {
  return el('div', { class: 'chat-vacio' }, el('div', {}, icono('conversaciones'), el('p', {}, 'Elige una conversación para verla y contestar.')));
}

/* ── Inicio ── */
function pintarInicio(datos) {
  if (estado.vista !== 'inicio' || sinCambios('inicio', [datos, estado.conversaciones.filter((x) => x.esperando).length])) return;
  const suma = (k) => datos.reduce((t, c) => t + Number(c.cifras[k] || 0), 0);
  const deHoy = datos.flatMap((c) => c.deHoy.map((x) => ({ ...x, clientId: c.clientId, zona: c.zonaHoraria })));
  const zona = datos[0] ? datos[0].zonaHoraria : 'Europe/Madrid';
  const horaLocal = Number(new Date().toLocaleTimeString('en-GB', { timeZone: zona, hour: '2-digit', hourCycle: 'h23' }).slice(0, 2));
  const saludo = horaLocal < 13 ? 'Buenos días' : horaLocal < 20 ? 'Buenas tardes' : 'Buenas noches';
  const kpi = (cifra, nombre, destino, clase) => el('button', { class: 'kpi ' + (clase || ''), onclick: () => ir(destino) },
    el('span', { class: 'cifra' }, String(cifra)), el('span', { class: 'nombre' }, nombre));
  const pendientes = suma('pendientes_recepcion');
  const escalados = suma('escalados');
  const asistencia = suma('asistencia');
  const esperando = estado.conversaciones.filter((x) => x.esperando).length;

  const hoy = el('div', { class: 'tarjeta' }, el('h2', {}, icono('calendario'), 'Hoy en la clínica', el('span', { class: 'hueco' }),
    el('button', { class: 'chico', onclick: () => ir('calendario') }, 'Ver semana')));
  if (deHoy.length === 0) hoy.append(el('div', { class: 'vacia' }, 'Hoy no hay citas.'));
  for (const c of deHoy) {
    hoy.append(el('div', { class: 'fila-lista', onclick: () => irA(c.clientId, c.conversacionId) },
      el('span', { class: 'hora-grande' }, horaCorta(c.inicio, c.zona)),
      el('span', { class: 'franja-estado', style: '--c:' + (COLOR_ESTADO[c.estado] || 'var(--tenue)') }),
      el('div', { class: 'principal' }, el('strong', {}, c.nombre || '—'), el('span', {}, c.servicio)),
      chipEstado(c.estado),
      c.estado === 'pendiente_recepcion' ? botonMetida(c.clientId, c.id) : null));
  }

  const atencion = el('div', { class: 'tarjeta' }, el('h2', {}, icono('escalados'), 'Necesita atención'));
  const filas = [];
  if (escalados > 0) filas.push(['Escalados abiertos', escalados, 'escalados', 'var(--peligro)']);
  if (pendientes > 0) filas.push(['Citas por meter en la agenda', pendientes, 'citas', 'var(--aviso)']);
  if (asistencia > 0) filas.push(['Asistencias por anotar', asistencia, 'asistencia', 'var(--aviso)']);
  if (esperando > 0) filas.push(['Chats esperando respuesta', esperando, 'conversaciones', 'var(--acento)']);
  if (filas.length === 0) atencion.append(el('div', { class: 'vacia' }, 'Todo al día.'));
  for (const [t, n, v, c] of filas) {
    atencion.append(el('div', { class: 'fila-lista', onclick: () => ir(v) },
      el('span', { class: 'franja-estado', style: '--c:' + c }),
      el('div', { class: 'principal' }, el('strong', {}, t)),
      el('span', { class: 'chip', style: '--c:' + c }, String(n))));
  }

  $('#contenido').replaceChildren(
    el('div', { class: 'cabecera-pagina' }, el('div', {}, el('h1', {}, saludo), el('span', { class: 'sub' }, diaLargo(new Date(), zona) + ' · ' + lugar(zona))),
      // En el móvil, la barra de abajo sólo tiene sitio para las vistas: tema y salir van aquí.
      el('span', { class: 'hueco' }),
      el('button', { class: 'icono-boton solo-movil', title: 'Cambiar tema', onclick: () => { ponerTema(esOscuro() ? 'light' : 'dark'); } }, icono(esOscuro() ? 'sol' : 'luna')),
      el('button', { class: 'enlace solo-movil', onclick: () => $('#salir').click() }, 'Salir')),
    el('div', { class: 'kpis' },
      kpi(deHoy.filter((c) => c.estado !== 'no_asistida').length, 'Citas hoy', 'calendario'),
      kpi(suma('semana'), 'Próximos 7 días', 'citas'),
      kpi(suma('chats_hoy'), 'Chats activos hoy', 'conversaciones'),
      kpi(escalados, 'Escalados abiertos', 'escalados', escalados > 0 ? 'alerta' : ''),
      kpi(asistencia, 'Asistencias por anotar', 'asistencia', asistencia > 0 ? 'atento' : ''),
      kpi(suma('citas_mes'), 'Citas generadas este mes', 'calendario')),
    el('div', { class: 'columnas' }, hoy, atencion));
}

function botonMetida(clientId, holdId) {
  return el('button', { class: 'chico exito', title: 'La has metido en el programa de la clínica: se relee la agenda y se confirma al paciente',
    onclick: (e) => { e.stopPropagation(); accion(e.target, () => api('/panel/api/huecos/' + clientId + '/' + holdId + '/metida', { method: 'POST' }), (r) => r.mensaje); } },
  'Ya la he metido');
}

/* ── Conversaciones ── */
function pintarLista() {
  const ul = $('#conversaciones');
  if (!ul) return;
  const variasClinicas = new Set(estado.conversaciones.map((c) => c.clientId)).size > 1;
  const lista = estado.conversaciones.filter((c) =>
    (!estado.buscar || c.nombre.toLowerCase().includes(estado.buscar) || c.telefono.includes(estado.buscar)) &&
    (estado.filtro === 'todas' || (estado.filtro === 'esperando' && c.esperando) || (estado.filtro === 'parado' && c.agenteParado) || (estado.filtro === 'escalado' && c.escalados > 0)));
  ul.replaceChildren(...lista.map((c) => el('li', { class: estado.abierta && estado.abierta.id === c.id ? 'elegida' : '', onclick: () => irA(c.clientId, c.id) },
    avatar(c.nombre || c.telefono),
    el('div', { class: 'item-texto' },
      el('div', { class: 'fila' }, el('span', { class: 'nombre' }, c.nombre || c.telefono), el('span', { class: 'tenue' }, hora(c.ultimoEn, c.zonaHoraria))),
      el('div', { class: 'extracto' }, (c.ultimoSentido === 'saliente' ? '↳ ' : '') + (c.ultimo || '')),
      el('div', { class: 'marcas' },
        variasClinicas ? el('span', { class: 'tenue' }, c.clinica) : null,
        c.agenteParado ? el('span', { class: 'marca-chica parado' }, 'Agente parado') : null,
        c.escalados > 0 ? el('span', { class: 'marca-chica escalado' }, c.escalados + ' escalado' + (c.escalados > 1 ? 's' : '')) : null)),
    c.esperando ? el('span', { class: 'punto', title: 'Escribió y nadie le ha contestado' }) : null)));
  if (lista.length === 0) ul.replaceChildren(el('li', { class: 'vacia' }, 'No hay conversaciones con ese filtro.'));
}

function refrescarChat(chat) {
  if (!chat || !estado.abierta || estado.abierta.id !== chat.id) return;
  // Si no ha cambiado nada, no se repinta: repintar mientras se lee devolvía el hilo al principio.
  const huella = JSON.stringify(chat);
  if (huella === estado.huella) return;
  const primeraVez = estado.huella === null;
  estado.huella = huella;
  const hiloViejo = document.querySelector('.hilo');
  const estabaAbajo = !hiloViejo || hiloViejo.scrollHeight - hiloViejo.scrollTop - hiloViejo.clientHeight < 40;
  const posicion = hiloViejo ? hiloViejo.scrollTop : 0;
  const borrador = document.querySelector('.redactar textarea');
  const texto = borrador ? borrador.value : '';
  const tieneFoco = borrador && document.activeElement === borrador;
  pintarChat(chat);
  const nuevo = document.querySelector('.redactar textarea');
  if (nuevo) { nuevo.value = texto; ajustarAlto(nuevo); if (tieneFoco) nuevo.focus(); }
  const hilo = document.querySelector('.hilo');
  // Abajo si se acaba de abrir o ya estaba abajo; si estaba leyendo más arriba, se queda donde estaba.
  if (hilo) hilo.scrollTop = primeraVez || estabaAbajo ? hilo.scrollHeight : posicion;
}

function ajustarAlto(t) { t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 160) + 'px'; }

function pintarChat(c) {
  const zona = c.zonaHoraria;
  const interruptor = el('button', {
    class: 'interruptor ' + (c.agenteParado ? 'parado' : 'activo'),
    title: c.agenteParado ? 'El agente no contesta a esta persona. Pulsa para reactivarlo.' : 'El agente contesta. Pulsa para pararlo y llevar tú la conversación.',
    onclick: (e) => accion(e.currentTarget, () => api('/panel/api/pacientes/' + c.clientId + '/' + c.pacienteId + '/agente', { method: 'POST', body: JSON.stringify({ parado: !c.agenteParado }) }),
      c.agenteParado ? 'Agente reactivado: vuelve a contestar.' : 'Agente parado: ahora llevas tú la conversación.'),
  }, el('span', { class: 'pista' }), c.agenteParado ? 'Agente parado' : 'Agente activo');

  const hilo = el('div', { class: 'hilo' });
  let diaAnterior = '';
  for (const m of c.mensajes) {
    const dia = diaRelativo(m.en, zona);
    if (dia !== diaAnterior) { hilo.append(el('div', { class: 'separador-dia' }, dia)); diaAnterior = dia; }
    hilo.append(el('div', { class: 'burbuja ' + m.autor },
      m.redactado ? el('em', { class: 'tenue' }, '[contenido borrado por el plazo de retención]') : (m.texto || ''),
      m.corte ? el('div', { class: 'nota' }, 'Cortafuegos: ' + (MOTIVOS[m.corte] || m.corte)) : null,
      m.desmentido ? el('div', { class: 'nota' }, 'Desmentido: ' + m.desmentido) : null,
      el('div', { class: 'meta' }, AUTORES[m.autor] + ' · ' + horaCorta(m.en, zona))));
  }
  if (c.mensajes.length === 0) hilo.append(el('div', { class: 'chat-vacio' }, 'Sin mensajes.'));

  const puede = c.puedeResponder && c.ventanaAbierta;
  const ayuda = !c.puedeResponder
    ? 'Esta conversación no ha entrado por Chatwoot: no se le puede escribir desde aquí.'
    : !c.ventanaAbierta
      ? 'Han pasado más de 24 h desde su último mensaje: WhatsApp no entrega texto libre hasta que vuelva a escribir.'
      : 'Enter para enviar · Mayúsculas+Enter, salto de línea · Texto libre hasta ' + hora(c.ventanaCierra, zona, true) + '.';
  const caja = el('textarea', { rows: 1, placeholder: puede ? 'Escribe a ' + (c.nombre || 'el paciente') + '…' : 'No se puede escribir ahora', disabled: !puede,
    oninput: (e) => ajustarAlto(e.target) });
  const enviar = el('button', { class: 'primario', disabled: !puede, title: 'Enviar', onclick: async () => {
    const texto = caja.value.trim();
    if (!texto) return;
    enviar.disabled = true;
    try {
      await api('/panel/api/conversaciones/' + c.clientId + '/' + c.id + '/responder', { method: 'POST', body: JSON.stringify({ texto }) });
      caja.value = ''; ajustarAlto(caja);
      estado.huella = null;
      await refrescar(true);
    } catch (err) { aviso(err.message, 'error'); }
    enviar.disabled = false;
  } }, icono('enviar'));
  caja.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); enviar.click(); } });

  const ficha = el('aside', { class: 'ficha' },
    el('div', { class: 'ficha-cabeza' }, avatar(c.nombre || c.telefono, true),
      el('div', {}, el('strong', {}, c.nombre || c.telefono), el('div', { class: 'tenue' }, c.clinica))),
    el('div', { class: 'dato' }, el('span', {}, 'Teléfono'), el('span', {}, c.telefono, ' ',
      el('button', { class: 'icono-boton', title: 'Copiar', onclick: () => { navigator.clipboard.writeText(c.telefono).then(() => aviso('Teléfono copiado'), () => aviso('No se ha podido copiar', 'error')); } }, icono('copiar')))),
    el('div', { class: 'dato' }, el('span', {}, 'Última visita'), el('span', {}, c.ultimaVisita ? diaLargo(c.ultimaVisita, zona) : '—')),
    el('div', { class: 'dato' }, el('span', {}, 'Paciente desde'), el('span', {}, c.pacienteDesde ? diaLargo(c.pacienteDesde, zona) : '—')),
    el('h3', {}, 'Citas'),
    c.citas.length === 0 ? el('p', { class: 'tenue' }, 'Ninguna viva.') : c.citas.map((h) => el('div', { class: 'caja' },
      el('div', { class: 'fila' }, el('strong', { class: 'nombre' }, h.servicio), chipEstado(h.estado)),
      el('span', {}, hora(h.inicio, zona, true)),
      h.estado === 'pendiente_recepcion' ? botonMetida(c.clientId, h.id) : null)),
    c.porConfirmar.length === 0 ? null : el('h3', {}, '¿Vino?'),
    c.porConfirmar.map((a) => el('div', { class: 'caja' }, el('strong', {}, a.servicio), el('span', {}, hora(a.inicio, zona, true)), botonesDeAsistencia(a))),
    el('h3', {}, 'Escalados abiertos'),
    c.escalados.length === 0 ? el('p', { class: 'tenue' }, 'Ninguno.') : c.escalados.map(cajaEscalado));

  $('#chat').replaceChildren(
    el('div', { class: 'cabecera-chat' },
      el('button', { class: 'icono-boton volver', title: 'Volver', onclick: () => ir('conversaciones') }, icono('volver')),
      avatar(c.nombre || c.telefono),
      el('div', { class: 'quien' }, el('strong', {}, c.nombre || c.telefono), el('span', { class: 'tenue' }, c.telefono + ' · ' + lugar(zona))),
      interruptor),
    el('div', { class: 'cuerpo-chat' },
      el('div', { class: 'columna-hilo' }, hilo,
        el('div', { class: 'redactar' }, el('div', { class: 'fila-redactar' }, caja, enviar), el('div', { class: 'ayuda' }, ayuda))),
      ficha));
}

function botonesDeAsistencia(a) {
  const anotar = (resultado) => (ev) => {
    ev.stopPropagation();
    accion(ev.target, () => api('/panel/api/citas/' + a.clientId + '/' + a.id + '/asistencia', { method: 'POST', body: JSON.stringify({ resultado }) }),
      resultado === 'asistida' ? 'Anotado: asistió.' : 'Anotado: no vino.');
  };
  return el('div', { class: 'botones' },
    el('button', { class: 'chico exito', onclick: anotar('asistida') }, 'Asistió'),
    el('button', { class: 'chico', onclick: anotar('no_asistida') }, 'No vino'));
}

function cajaEscalado(e) {
  const d = describir(e.motivo);
  return el('div', { class: 'caja' },
    el('div', { class: 'fila' }, el('strong', { class: 'nombre' }, d.titulo), etiquetaGravedad(e.severidad)),
    el('span', { class: 'tenue' }, hora(e.en, e.zonaHoraria, true)),
    d.que ? el('span', {}, d.que) : null,
    d.hacer ? el('span', { class: 'que-hacer' }, '→ ' + d.hacer) : null,
    e.detalle ? el('span', { class: 'tenue' }, e.detalle) : null,
    el('button', { class: 'chico', onclick: (ev) => { ev.stopPropagation(); accion(ev.target, () => api('/panel/api/escalados/' + e.clientId + '/' + e.id + '/atendido', { method: 'POST' }), 'Escalado atendido.'); } }, 'Marcar atendido'));
}

/** «Urgente» / «Importante» / «Aviso»: la gravedad en palabras, no en un número. */
function etiquetaGravedad(sev) {
  const [texto, color] = sev >= 3 ? ['Urgente', 'var(--peligro)'] : sev === 2 ? ['Importante', 'var(--aviso)'] : ['Aviso', 'var(--tenue)'];
  return el('span', { class: 'chip', style: '--c:' + color }, texto);
}

/**
 * ¿Cambia algo desde el último pintado de esta vista? El refresco es cada 5 s:
 * repintar una vista entera sin que haya cambiado nada atasca el scroll (lo hacía
 * el calendario) y pierde la posición.
 */
function sinCambios(vista, datos) {
  const huella = JSON.stringify(datos);
  if (estado.huellas[vista] === huella) return true;
  estado.huellas[vista] = huella;
  return false;
}

/* ── Calendario ── */
const minutosDe = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

function pintarCalendario(datos) {
  // La semana y el minuto entran en la huella: cambiar de semana repinta, y la línea de «ahora» avanza.
  if (estado.vista !== 'calendario' || sinCambios('calendario', [datos, estado.semana, new Date().getMinutes()])) return;
  const pxMin = 1.6;
  const barra = el('div', { class: 'cal-barra' },
    el('button', { onclick: () => { estado.semana -= 1; refrescar(true); } }, '‹ Anterior'),
    el('button', { class: estado.semana === 0 ? 'primario' : '', onclick: () => { estado.semana = 0; refrescar(true); } }, 'Esta semana'),
    el('button', { onclick: () => { estado.semana += 1; refrescar(true); } }, 'Siguiente ›'),
    el('span', { class: 'cal-leyenda' }, ['retenida', 'confirmada', 'asistida', 'no_asistida'].map((e) => el('span', { style: '--c: ' + COLOR_ESTADO[e] }, ESTADOS[e]))));
  const bloques = datos.clinicas.map((c) => {
    const tramos = c.dias.flatMap((d) => d.abierto);
    const minimo = Math.min(...tramos.map((t) => minutosDe(t.abre)), ...c.citas.map((x) => x.inicioMin), 8 * 60);
    const maximo = Math.max(...tramos.map((t) => minutosDe(t.cierra)), ...c.citas.map((x) => x.finMin), 21 * 60);
    const desde = Math.floor(minimo / 60) * 60;
    const hasta = Math.ceil(maximo / 60) * 60;
    const alto = (hasta - desde) * pxMin;
    const y = (min) => (min - desde) * pxMin;
    const horas = el('div', { class: 'cal-horas', style: 'height:' + alto + 'px' });
    for (let m = desde; m <= hasta; m += 60) {
      // La primera, hacia abajo: centrada en su línea quedaría cortada bajo la cabecera.
      horas.append(el('span', { class: 'cal-hora', style: 'top:' + y(m) + 'px' + (m === desde ? ';transform:none' : '') }, String(m / 60).padStart(2, '0') + ':00'));
    }
    const [hh, mm] = new Date().toLocaleTimeString('en-GB', { timeZone: c.zonaHoraria, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).split(':').map(Number);
    const ahoraLocal = hh * 60 + mm;
    const columnas = c.dias.map((d, i) => {
      const col = el('div', { class: 'cal-dia' + (d.esHoy ? ' hoy' : ''), style: 'height:' + alto + 'px' });
      for (let m = desde; m <= hasta; m += 60) col.append(el('div', { class: 'cal-linea', style: 'top:' + y(m) + 'px' }));
      const abiertos = d.abierto.map((t) => [minutosDe(t.abre), minutosDe(t.cierra)]).sort((a, b) => a[0] - b[0]);
      let cursor = desde;
      for (const [a, b] of abiertos) {
        if (a > cursor) col.append(el('div', { class: 'cal-cerrado', style: 'top:' + y(cursor) + 'px;height:' + (a - cursor) * pxMin + 'px' }));
        cursor = Math.max(cursor, b);
      }
      if (cursor < hasta) col.append(el('div', { class: 'cal-cerrado', style: 'top:' + y(cursor) + 'px;height:' + (hasta - cursor) * pxMin + 'px' }));
      if (d.esHoy && ahoraLocal >= desde && ahoraLocal <= hasta) col.append(el('div', { class: 'cal-ahora', style: 'top:' + y(ahoraLocal) + 'px', title: 'Ahora' }));
      for (const cita of c.citas.filter((x) => x.dia === i)) {
        col.append(el('div', {
          class: 'cal-cita',
          style: '--c:' + (COLOR_ESTADO[cita.estado] || 'var(--tenue)') + ';top:' + y(cita.inicioMin) + 'px;height:' + Math.max(30, (cita.finMin - cita.inicioMin) * pxMin - 2) + 'px',
          title: cita.servicio + ' · ' + cita.nombre + ' · ' + hora(cita.inicio, c.zonaHoraria, true) + ' · ' + (ESTADOS[cita.estado] || cita.estado),
          onclick: () => irA(c.clientId, cita.conversacionId),
        }, el('strong', {}, horaCorta(cita.inicio, c.zonaHoraria) + ' ' + cita.servicio), cita.nombre));
      }
      return col;
    });
    return el('div', {},
      datos.clinicas.length > 1 ? el('h2', {}, c.clinica) : null,
      el('div', { class: 'cal' },
        el('div', { class: 'cal-cab' }, ''),
        c.dias.map((d) => el('div', { class: 'cal-cab' + (d.esHoy ? ' hoy' : '') }, d.etiqueta)),
        horas, columnas));
  });
  const primera = datos.clinicas[0];
  $('#contenido').replaceChildren(
    el('div', { class: 'cabecera-pagina' }, el('div', {}, el('h1', {}, 'Calendario'),
      el('span', { class: 'sub' }, primera ? primera.dias[0].etiqueta + ' – ' + primera.dias[6].etiqueta + ' · ' + lugar(primera.zonaHoraria) : ''))),
    barra, ...bloques);
}

/* ── Citas, asistencia y escalados ── */
function agrupadoPorDia(lista, fecha, zona, fila) {
  const grupos = new Map();
  for (const x of lista) {
    const clave = diaRelativo(fecha(x), zona(x));
    if (!grupos.has(clave)) grupos.set(clave, []);
    grupos.get(clave).push(x);
  }
  return [...grupos].map(([dia, xs]) => el('div', { class: 'grupo-dia' }, el('h3', {}, dia), el('div', { class: 'tarjeta' }, xs.map(fila))));
}

function pintarCitas(citas) {
  if (estado.vista !== 'citas' || sinCambios('citas', citas)) return;
  const contenido = citas.length === 0 ? [el('div', { class: 'tarjeta' }, el('div', { class: 'vacia' }, 'No hay citas próximas.'))] :
    agrupadoPorDia(citas, (h) => h.inicio, (h) => h.zonaHoraria, (h) => el('div', { class: 'fila-lista', onclick: () => irA(h.clientId, h.conversacionId) },
      el('span', { class: 'hora-grande' }, horaCorta(h.inicio, h.zonaHoraria)),
      el('span', { class: 'franja-estado', style: '--c:' + (COLOR_ESTADO[h.estado] || 'var(--tenue)') }),
      avatar(h.nombre),
      el('div', { class: 'principal' }, el('strong', {}, h.nombre || '—'), el('span', {}, h.servicio + ' · ' + h.telefono)),
      chipEstado(h.estado),
      h.estado === 'pendiente_recepcion' ? botonMetida(h.clientId, h.id) : null));
  $('#contenido').replaceChildren(el('div', { class: 'cabecera-pagina' }, el('h1', {}, 'Próximas citas'), el('span', { class: 'sub' }, citas.length + ' en total')), ...contenido);
}

function pintarAsistencia(lista) {
  if (estado.vista !== 'asistencia' || sinCambios('asistencia', lista)) return;
  const contenido = lista.length === 0 ? [el('div', { class: 'tarjeta' }, el('div', { class: 'vacia' }, 'No hay citas pasadas sin anotar.'))] :
    agrupadoPorDia(lista, (a) => a.inicio, (a) => a.zonaHoraria, (a) => el('div', { class: 'fila-lista', onclick: () => irA(a.clientId, a.conversacionId) },
      el('span', { class: 'hora-grande' }, horaCorta(a.inicio, a.zonaHoraria)),
      avatar(a.nombre),
      el('div', { class: 'principal' }, el('strong', {}, a.nombre || '—'), el('span', {}, a.servicio + (a.pedidaEn ? ' · en la relación del ' + diaLargo(a.pedidaEn, a.zonaHoraria) : ''))),
      botonesDeAsistencia(a)));
  $('#contenido').replaceChildren(
    el('div', { class: 'cabecera-pagina' }, el('div', {}, el('h1', {}, 'Asistencia'),
      el('span', { class: 'sub' }, 'Citas que ya han pasado. Lo que no se marque en 7 días desde la relación semanal se dará por asistido.'))),
    ...contenido);
}

function pintarEscalados(escalados) {
  if (estado.vista !== 'escalados' || sinCambios('escalados', escalados)) return;
  const fila = (e) => {
    const d = describir(e.motivo);
    const color = e.severidad >= 3 ? 'var(--peligro)' : e.severidad === 2 ? 'var(--aviso)' : 'var(--tenue)';
    return el('div', { class: 'fila-lista escalado', onclick: () => e.conversacionId && irA(e.clientId, e.conversacionId) },
      el('span', { class: 'franja-estado', style: '--c:' + color }),
      d.tecnico ? null : avatar(e.nombre || '?'),
      el('div', { class: 'principal' },
        el('strong', {}, d.titulo + (e.nombre && !d.tecnico ? ' · ' + e.nombre : '')),
        el('span', { class: 'explicacion' }, d.que),
        d.hacer ? el('span', { class: 'que-hacer' }, '→ ' + d.hacer) : null,
        el('span', {}, hora(e.en, e.zonaHoraria, true) + (e.detalle ? ' · ' + e.detalle : ''))),
      etiquetaGravedad(e.severidad),
      el('button', { class: 'chico', onclick: (ev) => { ev.stopPropagation(); accion(ev.target, () => api('/panel/api/escalados/' + e.clientId + '/' + e.id + '/atendido', { method: 'POST' }), 'Escalado atendido.'); } }, 'Marcar atendido'));
  };
  const deLaClinica = escalados.filter((e) => !describir(e.motivo).tecnico);
  const tecnicos = escalados.filter((e) => describir(e.motivo).tecnico);
  const seccion = (titulo, sub, xs, vacio) => el('div', { class: 'seccion' },
    el('h3', {}, titulo, el('span', { class: 'tenue' }, ' · ' + sub)),
    el('div', { class: 'tarjeta' }, xs.length === 0 ? el('div', { class: 'vacia' }, vacio) : xs.map(fila)));
  $('#contenido').replaceChildren(
    el('div', { class: 'cabecera-pagina' }, el('div', {}, el('h1', {}, 'Escalados'), el('span', { class: 'sub' }, 'Lo que necesita a una persona, lo más grave primero. Pulsa uno para abrir su conversación.'))),
    seccion('Necesitan a alguien de la clínica', 'pacientes', deLaClinica, 'Nada pendiente.'),
    seccion('Avisos técnicos', 'para el operador, no tocan a ningún paciente', tecnicos, 'Ninguno.'));
}

/* ── Refresco ── */
// Los datos de la vista se piden a la vez que los contadores, no después: cada
// petición cruza el Atlántico, y en fila eran dos viajes por pantalla.
function rutaDeVista() {
  if (estado.vista === 'inicio') return '/panel/api/resumen';
  if (estado.vista === 'calendario') return '/panel/api/calendario?semana=' + estado.semana;
  if (estado.vista === 'citas') return '/panel/api/citas';
  if (estado.vista === 'conversaciones' && estado.abierta) return '/panel/api/conversaciones/' + estado.abierta.clientId + '/' + estado.abierta.id;
  return null; // asistencia y escalados ya vienen con los contadores
}

// Un refresco a la vez. El automático, si hay otro en curso, sobra; el que
// pide una persona (cambiar de vista, tras una acción) no se tira: se repite
// en cuanto acaba el que estaba en marcha. Tirarlo dejaba la vista nueva vacía
// hasta el siguiente ciclo de 5 s.
let refrescando = null;
let otraVez = false;
function refrescar(pedido) {
  if ($('#app').classList.contains('oculto')) return Promise.resolve();
  if (refrescando) { if (pedido) otraVez = true; return refrescando; }
  refrescando = (async () => {
    do {
      otraVez = false;
      const vista = estado.vista;
      const ruta = rutaDeVista();
      try {
        const [convs, esc, asis, datos] = await Promise.all([api('/panel/api/conversaciones'), api('/panel/api/escalados'), api('/panel/api/asistencia'), ruta ? api(ruta) : null]);
        estado.conversaciones = convs;
        // Los contadores del menú, siempre: lo que necesita atención se ve desde cualquier vista.
        estado.contadores = { escalados: esc.length, asistencia: asis.length, conversaciones: convs.filter((c) => c.esperando).length };
        pintarMenu();
        // Si mientras tanto ha cambiado la vista (o la semana, o el chat), estos datos ya no son los suyos.
        if (otraVez || estado.vista !== vista || rutaDeVista() !== ruta) { otraVez = true; continue; }
        if (vista === 'conversaciones') { pintarLista(); refrescarChat(datos); }
        else if (vista === 'inicio') pintarInicio(datos);
        else if (vista === 'calendario') pintarCalendario(datos);
        else if (vista === 'citas') pintarCitas(datos);
        else if (vista === 'asistencia') pintarAsistencia(asis);
        else pintarEscalados(esc);
      } catch (err) { console.error(err); }
    } while (otraVez);
  })().finally(() => { refrescando = null; });
  return refrescando;
}

document.addEventListener('keydown', (e) => {
  const escribiendo = ['INPUT', 'TEXTAREA'].includes(document.activeElement && document.activeElement.tagName);
  if (e.key === '/' && !escribiendo) {
    e.preventDefault();
    if (estado.vista !== 'conversaciones') ir('conversaciones');
    setTimeout(() => { const b = document.querySelector('.lista input'); if (b) b.focus(); }, 60);
  }
  if (e.key === 'Escape' && estado.vista === 'conversaciones' && estado.abierta && !escribiendo) ir('conversaciones');
});

setInterval(() => { if (!document.hidden) refrescar(); }, 5000);
mostrarApp().catch(() => mostrarEntrar());
`;
