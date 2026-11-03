import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from './schema.js';

type Db = PostgresJsDatabase<typeof schema>;

/** Handle de base de datos con el contexto de una clínica ya establecido. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface Core {
  /**
   * Único acceso a datos del sistema. Abre una transacción, fija el contexto de
   * cliente y se lo pasa a `fn`.
   *
   * Regla 1: no se exporta ningún handle suelto. Si tu función no recibe un
   * `clientId`, no tiene con qué abrir una transacción — el aislamiento deja de
   * depender de que alguien se acuerde de filtrar.
   */
  withClient: <T>(clientId: string, fn: (tx: Tx) => Promise<T>) => Promise<T>;
  /**
   * ¿Se puede hablar con la base? La consulta más barata que existe.
   *
   * No abre transacción ni fija contexto de cliente a propósito: sólo comprueba
   * que hay conexión. Sirve para `/listo`, no para trabajar.
   *
   * **Con tiempo límite propio y corto.** Con la base caída, `select 1` no falla:
   * se queda esperando a que el cliente agote sus reintentos, y una comprobación
   * de preparación que no responde es tan inútil como una que miente — el
   * balanceador se queda colgado en vez de sacar el contenedor de rotación.
   */
  alcanzable: (limiteMs?: number) => Promise<boolean>;
  /**
   * El UUID de una clínica a partir de su slug. `undefined` si no existe o está
   * inactiva.
   *
   * **Es la única lectura del sistema sin contexto de cliente**, y va aquí como
   * método acotado y no como un ejecutor libre: la regla 1 dice que no se
   * exporta ningún handle suelto, y abrir uno «sólo para esto» es cómo se abren
   * todos. Por debajo llama a `motor.id_de_clinica`, que devuelve el id y nada
   * más — ni nombre, ni configuración, ni un solo dato de paciente.
   */
  idDeClinicaPorSlug: (slug: string) => Promise<string | undefined>;
  /**
   * **La guarda de aislamiento, contra la base de verdad.** Devuelve lo que
   * falla; vacío es que no se ha encontrado nada roto.
   *
   * Los tests de aislamiento prueban las migraciones contra el Docker local con
   * el rol de pruebas. Lo que no pueden ver es con qué rol se conecta
   * producción, y ése es el fallo del que no se vuelve: con el rol propietario
   * RLS no aplica, todos los tests siguen en verde y el aislamiento es cero. Una
   * variable de entorno mal copiada en la plataforma de despliegue basta. Así que el arranque lo
   * comprueba contra la base a la que se va a conectar, y no arranca si falla.
   *
   * Sólo metadatos y una lectura con un contexto que no existe: ni un dato de
   * paciente sale de aquí.
   */
  comprobarAislamiento: () => Promise<string[]>;
  close: () => Promise<void>;
}

export function createCore(databaseUrl: string): Core {
  const client = postgres(databaseUrl, {
    max: 10,
    // El pooler de transacciones de Supabase no admite sentencias preparadas.
    prepare: false,
  });
  const db = drizzle(client, { schema });

  return {
    withClient: async <T>(clientId: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
      db.transaction(async (tx) => {
        // `true` = LOCAL a la transacción. Si fuese de sesión, con el pooler la
        // siguiente transacción sobre la misma conexión física heredaría este
        // client_id: exactamente la fuga entre clínicas de la regla 1.
        await tx.execute(sql`select set_config('app.client_id', ${clientId}, true)`);
        return fn(tx);
      }),
    alcanzable: async (limiteMs = 2_000): Promise<boolean> => {
      let temporizador: NodeJS.Timeout | undefined;
      const conLimite = new Promise<false>((resolver) => {
        temporizador = setTimeout(() => resolver(false), limiteMs);
        // `unref` para que un temporizador pendiente no impida que el proceso
        // termine cuando le mandan SIGTERM.
        temporizador.unref();
      });

      try {
        return await Promise.race([
          client`select 1`.then(() => true),
          conLimite,
        ]);
      } catch {
        return false;
      } finally {
        if (temporizador !== undefined) clearTimeout(temporizador);
      }
    },
    idDeClinicaPorSlug: async (slug: string): Promise<string | undefined> => {
      const filas = await client<{ id: string | null }[]>`
        select motor.id_de_clinica(${slug}) as id
      `;
      return filas[0]?.id ?? undefined;
    },
    comprobarAislamiento: async (): Promise<string[]> => {
      const fallos: string[] = [];

      const [rol] = await client<{ usuario: string; rolsuper: boolean; rolbypassrls: boolean }[]>`
        select current_user as usuario, rolsuper, rolbypassrls from pg_roles where rolname = current_user
      `;
      if (rol?.rolsuper === true) fallos.push(`el rol «${rol.usuario}» es superusuario: RLS no le aplica`);
      if (rol?.rolbypassrls === true) fallos.push(`el rol «${rol.usuario}» tiene BYPASSRLS`);

      const tablas = await client<
        { tabla: string; propia: boolean; rls: boolean; forzada: boolean; politicas: number; borra: boolean }[]
      >`
        select c.relname as tabla,
               pg_get_userbyid(c.relowner) = current_user as propia,
               c.relrowsecurity as rls,
               c.relforcerowsecurity as forzada,
               (select count(*)::int from pg_policy p where p.polrelid = c.oid) as politicas,
               has_table_privilege(current_user, c.oid, 'DELETE') as borra
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'motor' and c.relkind = 'r'
      `;
      if (tablas.length === 0) fallos.push('no hay ninguna tabla en el esquema motor: ¿base equivocada?');
      for (const t of tablas) {
        if (t.propia) fallos.push(`el rol es propietario de motor.${t.tabla}: con él RLS no aplica`);
        if (!t.rls || !t.forzada) fallos.push(`motor.${t.tabla} no tiene RLS activo y forzado`);
        if (t.politicas === 0) fallos.push(`motor.${t.tabla} no tiene ninguna política`);
        if (t.borra) fallos.push(`el rol puede borrar en motor.${t.tabla}, y no debe tener DELETE`);
      }

      // Sin contexto, una consulta tiene que FALLAR con 42501, no devolver cero
      // filas: cero filas se parece demasiado a «esta clínica no tiene pacientes».
      try {
        await client.begin(async (tx) => tx`select 1 from motor.patients limit 1`);
        fallos.push('sin contexto de clínica, una consulta a motor.patients no falla');
      } catch (error: unknown) {
        const codigo = (error as { code?: string }).code;
        if (codigo !== '42501') fallos.push(`sin contexto de clínica, motor.patients falla con ${codigo ?? '?'} y no con 42501`);
      }

      // Con el contexto de una clínica que no existe no se ve ninguna fila de
      // ninguna. Si RLS no filtrara, aquí saldrían las de todas.
      const ajeno = '00000000-0000-4000-8000-000000000000';
      const visibles = await client.begin(async (tx) => {
        await tx`select set_config('app.client_id', ${ajeno}, true)`;
        const [fila] = await tx<{ n: number }[]>`
          select ((select count(*) from motor.patients) + (select count(*) from motor.conversations)
                + (select count(*) from motor.messages))::int as n
        `;
        return fila?.n ?? 0;
      });
      if (visibles > 0) fallos.push(`con el contexto de una clínica inexistente se ven ${visibles} filas de otras`);

      return fallos;
    },
    close: async () => {
      await client.end();
    },
  };
}
