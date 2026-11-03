import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createCore } from '../../src/db/client.js';
import { ADMIN_URL, APP_URL, conexionAdmin, prepararBaseDeDatos } from '../support/db.js';

/**
 * La guarda que se ejecuta al arrancar contra la base de verdad.
 *
 * Estos tests de aislamiento prueban las migraciones con el rol de pruebas. Lo
 * que no pueden ver es con qué rol se conecta producción: con el propietario,
 * RLS no aplica, todo funciona y el aislamiento es cero. Basta una variable de
 * entorno mal copiada. Por eso el núcleo lo comprueba él mismo al arrancar, y no
 * arranca si algo falla.
 */

const admin = conexionAdmin();

beforeAll(async () => {
  await prepararBaseDeDatos(admin);
}, 60_000);

afterAll(async () => {
  await admin.end();
});

describe('la guarda de arranque', () => {
  it('con motor_app y RLS como debe, no encuentra nada', async () => {
    const core = createCore(APP_URL);
    try {
      expect(await core.comprobarAislamiento()).toEqual([]);
    } finally {
      await core.close();
    }
  });

  it('conectado con el rol que manda —el error de la variable mal copiada— no deja arrancar', async () => {
    const core = createCore(ADMIN_URL);
    try {
      const fallos = await core.comprobarAislamiento();
      // Cada motivo por separado: un rol que no fuera superusuario pero sí
      // propietario dejaría RLS igual de inerte.
      expect(fallos.some((f) => /superusuario/.test(f))).toBe(true);
      expect(fallos.some((f) => /BYPASSRLS/.test(f))).toBe(true);
      expect(fallos.some((f) => /propietario de motor\.patients/.test(f))).toBe(true);
      expect(fallos.some((f) => /puede borrar en motor\.patients/.test(f))).toBe(true);
    } finally {
      await core.close();
    }
  });

  it('una tabla sin RLS forzado se detecta aunque el rol sea el bueno', async () => {
    await admin`alter table motor.patients no force row level security`;
    const core = createCore(APP_URL);
    try {
      expect(await core.comprobarAislamiento()).toContainEqual('motor.patients no tiene RLS activo y forzado');
    } finally {
      await core.close();
      await admin`alter table motor.patients force row level security`;
    }
  });

  it('un DELETE concedido por descuido se detecta', async () => {
    await admin`grant delete on motor.messages to motor_app`;
    const core = createCore(APP_URL);
    try {
      expect(await core.comprobarAislamiento()).toContainEqual(
        'el rol puede borrar en motor.messages, y no debe tener DELETE',
      );
    } finally {
      await core.close();
      await admin`revoke delete on motor.messages from motor_app`;
    }
  });
});
