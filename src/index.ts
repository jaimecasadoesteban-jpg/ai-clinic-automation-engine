import { AgenteAnthropic, crearCliente } from './agent/anthropic.js';
import { buildServer } from './api/server.js';
import { ConfigurationError, exigirEscritorDeAgenda, loadEnv } from './config/env.js';
import { AislamientoRotoError } from './db/aislamiento.js';
import { cargarConfiguracion } from './config/registry.js';
import { createCore } from './db/client.js';
import { crearAgendaN8n } from './service/agenda-n8n.js';
import { crearCorreoSmtp } from './service/correo.js';
import { ejecutarSalida } from './service/ejecutor.js';
import { procesarBandeja } from './service/bandeja.js';
import { pasarPlanificador } from './service/planificador.js';
import { crearWhatsAppMeta } from './service/whatsapp/meta.js';
import { crearChatwoot } from './service/chatwoot/api.js';
import { crearAgendaGoogle, crearEscritorGoogle } from './service/google/calendar.js';
import type { Dependencias } from './service/pipeline.js';

async function main(): Promise<void> {
  const env = loadEnv();

  // Si el YAML de una sola clínica es inválido, el proceso NO arranca. Un error
  // de configuración descubierto a mitad de una conversación deja a un paciente
  // esperando y a nadie mirando.
  const configuracion = cargarConfiguracion();

  const google =
    env.GOOGLE_CLIENT_ID !== undefined && env.GOOGLE_CLIENT_SECRET !== undefined && env.GOOGLE_REFRESH_TOKEN !== undefined
      ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, refreshToken: env.GOOGLE_REFRESH_TOKEN }
      : undefined;
  const automaticas = configuracion.enModoAutomatico();
  exigirEscritorDeAgenda(automaticas, google !== undefined);

  const core = createCore(env.DATABASE_URL);

  // Regla 1, contra la base de verdad y no sólo en los tests. Conectar con el
  // rol propietario deja RLS sin efecto y todo sigue funcionando: es el fallo
  // del que no se vuelve, porque no avisa. Si algo falla, no se arranca: un
  // despliegue que no levanta se ve en un minuto; una fuga entre clínicas, no.
  const fallosDeAislamiento = await core.comprobarAislamiento();
  if (fallosDeAislamiento.length > 0) {
    await core.close();
    throw new AislamientoRotoError(fallosDeAislamiento);
  }
  const deps: Dependencias = {
    core,
    configuracion,
    agente: new AgenteAnthropic(crearCliente(env.ANTHROPIC_API_KEY)),
    agenda:
      google !== undefined
        ? crearAgendaGoogle(google)
        : crearAgendaN8n({ baseUrl: env.N8N_AGENDA_URL ?? '', token: env.NUCLEO_API_TOKEN }),
    pimienta: env.SUPPRESSION_PEPPER,
    reloj: () => new Date(),
  };

  /**
   * WhatsApp sin n8n: sólo si están las tres variables (el esquema exige las
   * tres o ninguna). Sin ellas, `/whatsapp` no existe y todo sigue por n8n.
   */
  const whatsappActivo =
    env.WHATSAPP_TOKEN !== undefined && env.WHATSAPP_APP_SECRET !== undefined && env.WHATSAPP_VERIFY_TOKEN !== undefined;
  const whatsapp = whatsappActivo
    ? crearWhatsAppMeta({ token: env.WHATSAPP_TOKEN ?? '', versionGraph: env.WHATSAPP_GRAPH_VERSION })
    : undefined;
  /** Chatwoot (coexistencia): las dos variables o ninguna. */
  const chatwootActivo = env.CHATWOOT_API_TOKEN !== undefined && env.CHATWOOT_WEBHOOK_SECRET !== undefined;
  const chatwoot = chatwootActivo ? crearChatwoot({ url: env.CHATWOOT_URL, token: env.CHATWOOT_API_TOKEN ?? '' }) : undefined;
  const bandejaActiva = whatsappActivo || chatwootActivo;
  const escritor = google === undefined ? undefined : crearEscritorGoogle(google);
  /** Lo sustituye el procesador de la bandeja en cuanto existe; antes, nada. */
  let despertarBandeja = (): void => {};

  const app = await buildServer({
    logLevel: env.LOG_LEVEL,
    token: env.NUCLEO_API_TOKEN,
    deps,
    ...(whatsappActivo
      ? {
          whatsapp: {
            appSecret: env.WHATSAPP_APP_SECRET ?? '',
            verifyToken: env.WHATSAPP_VERIFY_TOKEN ?? '',
            alRecibir: () => despertarBandeja(),
          },
        }
      : {}),
    ...(chatwootActivo
      ? { chatwoot: { secreto: env.CHATWOOT_WEBHOOK_SECRET ?? '', alRecibir: () => despertarBandeja() } }
      : {}),
    ...(env.PANEL_USUARIO !== undefined && env.PANEL_CLAVE_HASH !== undefined && env.PANEL_SECRETO !== undefined
      ? { panel: { usuario: env.PANEL_USUARIO, claveHash: env.PANEL_CLAVE_HASH, secreto: env.PANEL_SECRETO } }
      : {}),
  });
  app.log.info(
    { clinicas: configuracion.slugs(), agenda: google !== undefined ? 'google' : env.N8N_AGENDA_URL, automaticas },
    'núcleo listo',
  );

  // Un aviso, no un fallo: probar la composición con la plantilla es legítimo.
  // Lo que no puede es que una dirección inventada llegue a un paciente sin que
  // nadie lo haya visto en el log del despliegue.
  for (const { slug, campos } of configuracion.conDatosDeEjemplo()) {
    app.log.warn(
      { clinica: slug, campos },
      'la clínica tiene datos de EJEMPLO, inventados: se le dirían tal cual a sus pacientes',
    );
  }

  /**
   * El ejecutor de la tabla de salida: cada 30 s, por clínica, envía lo que los
   * turnos ya confirmaron. Nunca desde dentro de un turno (regla 3).
   *
   * Que el SMTP no responda al arrancar **avisa, no impide arrancar**: el núcleo
   * atiende a pacientes sin correo; lo que no puede es hacerlo sin que se vea.
   * Lo que no se envíe se queda en la tabla y sale cuando vuelva.
   */
  const correo = crearCorreoSmtp({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
  });
  if (await correo.comprobar()) {
    app.log.info({ operador: env.OPERADOR_CORREO }, 'correo al operador: conexión SMTP correcta');
  } else {
    app.log.error({ smtp: env.SMTP_HOST, usuario: env.SMTP_USER }, 'correo al operador: el SMTP NO responde o rechaza las credenciales');
  }

  let ejecutando = false;
  const pasada = async (): Promise<void> => {
    if (ejecutando) return;
    ejecutando = true;
    try {
      for (const slug of configuracion.slugs()) {
        const clientId = await core.idDeClinicaPorSlug(slug);
        if (clientId === undefined) continue;
        const r = await ejecutarSalida(core, clientId, {
          correo,
          operador: env.OPERADOR_CORREO,
          ...(whatsapp === undefined ? {} : { whatsapp }),
          ...(chatwoot === undefined ? {} : { chatwoot }),
          ...(escritor === undefined ? {} : { agenda: { escritor, deps } }),
          ahora: new Date(),
        });
        if (r.enviados > 0 || r.reintentos > 0) app.log.info({ clinica: slug, ...r }, 'tabla de salida');
        for (const f of r.fallidos) {
          app.log.error({ clinica: slug, id: f.id, error: f.error }, 'tabla de salida: envío NO entregado (rechazo permanente o reintentos agotados)');
        }
      }
    } catch (error: unknown) {
      app.log.error({ err: error }, 'tabla de salida: la pasada ha fallado');
    } finally {
      ejecutando = false;
    }
  };
  // Cada 5 s si WhatsApp va por el núcleo: la respuesta al paciente sale por aquí
  // y no puede esperar medio minuto. Con sólo correo al operador, 30 s bastan.
  const temporizador = setInterval(() => void pasada(), bandejaActiva ? 5_000 : 30_000);
  temporizador.unref();

  /**
   * El procesador de la bandeja: lo despierta el webhook al guardar un mensaje,
   * y además pasa cada 10 s por si algo se quedó (un reintento, un reinicio).
   * Al terminar, dispara la tabla de salida: la respuesta sale en el momento.
   */
  let procesando = false;
  let otraVez = false;
  const pasadaBandeja = async (): Promise<void> => {
    if (procesando) {
      otraVez = true;
      return;
    }
    procesando = true;
    try {
      do {
        otraVez = false;
        for (const slug of configuracion.slugs()) {
          const clientId = await core.idDeClinicaPorSlug(slug);
          if (clientId === undefined) continue;
          const r = await procesarBandeja(deps, clientId, { ahora: new Date() });
          if (r.procesados > 0 || r.reintentos > 0) app.log.info({ clinica: slug, ...r }, 'bandeja de entrada');
          for (const f of r.fallidos) {
            app.log.error({ clinica: slug, id: f.id, error: f.error }, 'bandeja: mensaje NO atendido tras los reintentos');
          }
        }
        await pasada();
        // Dos veces: si la primera creó un evento de agenda, lo que encoló —la
        // confirmación al paciente— sale ahora y no en el siguiente ciclo.
        await pasada();
      } while (otraVez);
    } catch (error: unknown) {
      app.log.error({ err: error }, 'bandeja: la pasada ha fallado');
    } finally {
      procesando = false;
    }
  };
  let temporizadorBandeja: NodeJS.Timeout | undefined;
  if (bandejaActiva) {
    despertarBandeja = () => void pasadaBandeja();
    temporizadorBandeja = setInterval(() => void pasadaBandeja(), 10_000);
    temporizadorBandeja.unref();
  }
  app.log.info(
    whatsappActivo
      ? 'WhatsApp por Meta: /whatsapp montado'
      : 'WhatsApp por Meta: no (faltan WHATSAPP_TOKEN, WHATSAPP_APP_SECRET y WHATSAPP_VERIFY_TOKEN)',
  );
  app.log.info(
    chatwootActivo
      ? { chatwoot: env.CHATWOOT_URL }
      : {},
    chatwootActivo ? 'WhatsApp por Chatwoot: /chatwoot montado' : 'WhatsApp por Chatwoot: no (faltan CHATWOOT_API_TOKEN y CHATWOOT_WEBHOOK_SECRET)',
  );

  /**
   * El planificador: los crons, sin n8n. Cada minuto mira qué toca en cada
   * clínica (`service/planificador.ts`) y, si algo encoló, lo manda ya. Que
   * falle un trabajo no para los demás ni el resto de clínicas; queda en el
   * log y, si deja de correr, lo destapa el latido con el tráfico de pacientes.
   */
  let planificando = false;
  const pasadaPlanificador = async (): Promise<void> => {
    if (planificando) return;
    planificando = true;
    try {
      for (const slug of configuracion.slugs()) {
        const clientId = await core.idDeClinicaPorSlug(slug);
        if (clientId === undefined) continue;
        const { hechos, fallos } = await pasarPlanificador(deps, clientId, configuracion.obtener(slug).config.zonaHoraria);
        for (const h of hechos) {
          if (h.trabajo !== 'caducar-retenciones' || h.resumen['aplicados'] !== 0) {
            app.log.info({ clinica: slug, trabajo: h.trabajo, ...h.resumen }, 'planificador');
          }
        }
        for (const f of fallos) app.log.error({ clinica: slug, trabajo: f.trabajo, error: f.error }, 'planificador: el trabajo ha fallado');
      }
      await pasada();
    } catch (error: unknown) {
      app.log.error({ err: error }, 'planificador: la pasada ha fallado');
    } finally {
      planificando = false;
    }
  };
  const temporizadorPlanificador = setInterval(() => void pasadaPlanificador(), 60_000);
  temporizadorPlanificador.unref();
  void pasadaPlanificador();
  app.log.info('planificador activo: caducar (1 min), verificar (30 min), derechos (09:05 local), consolidar (día 1, 02:00 UTC)');

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      app.log.info({ signal }, 'cerrando el núcleo');
      clearInterval(temporizador);
      clearInterval(temporizadorPlanificador);
      if (temporizadorBandeja !== undefined) clearInterval(temporizadorBandeja);
      correo.cerrar();
      void app
        .close()
        .then(() => core.close())
        .then(
          () => process.exit(0),
          () => process.exit(1),
        );
    });
  }

  await app.listen({ host: env.HOST, port: env.PORT });
}

main().catch((error: unknown) => {
  if (error instanceof ConfigurationError) {
    console.error(error.message);
  } else if (error instanceof AislamientoRotoError) {
    // Lo primero que tiene que leer quien mire el log del despliegue.
    console.error(error.message);
  } else if (error instanceof Error && error.name === 'ConfiguracionDeClienteInvalida') {
    console.error(error.message);
  } else {
    console.error('El núcleo no ha podido arrancar:', error);
  }
  process.exit(1);
});
