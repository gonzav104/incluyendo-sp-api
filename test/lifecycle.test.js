// test/lifecycle.test.js
// Ciclo de vida del proceso (Fase 2): graceful shutdown con timeout de drenado
// y handlers globales de errores. Usa DI de `exit` (D7): los tests emiten
// señales sintéticas con process.emit y verifican el código de salida con un
// stub, sin matar el proceso real.

'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { shutdown, createProcessHandlers, registerProcessHandlers } = require('../src/lib/lifecycle');

// Silenciar logs del SUT (pipe IPC, nodejs/node#56802).
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

beforeEach(() => {
  console.log = () => {};
  console.error = () => {};
});

afterEach(() => {
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
});

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// FR-SL-1 / FR-SL-2: shutdown con drenado y timeout
// ---------------------------------------------------------------------------
test('shutdown drena: cierra el server, cierra el pool y sale con exit 0', async () => {
  let closed = false;
  let ended = false;
  let exitCode = null;
  const server = {
    close: (cb) => {
      closed = true;
      cb();
    },
  };
  const pool = {
    end: async () => {
      ended = true;
    },
  };
  const exit = (code) => {
    exitCode = code;
  };

  await shutdown({ server, pool, timeoutMs: 5000, exitCode: 0, exit });

  assert.equal(closed, true, 'server.close debe llamarse');
  assert.equal(ended, true, 'pool.end debe llamarse');
  assert.equal(exitCode, 0, 'salida limpia con exit 0');
});

test('shutdown con drenado colgado: tras el timeout fuerza exit 1', async () => {
  let exitCode = null;
  const server = {
    close: () => {
      /* nunca llama el callback: request en vuelo que no termina */
    },
  };
  const exit = (code) => {
    exitCode = code;
  };

  // El timer de drenado va con .unref() (no debe mantener vivo el proceso en
  // producción), así que el test mantiene el event loop con un tick ref'd
  // mientras el timer unref'd de 30ms dispara.
  const pending = shutdown({ server, pool: {}, timeoutMs: 30, exitCode: 0, exit });
  await tick(60);
  await pending;

  assert.equal(exitCode, 1, 'el timeout de drenado debe forzar exit 1');
});

// ---------------------------------------------------------------------------
// FR-SL-1: SIGTERM/SIGINT
// ---------------------------------------------------------------------------
test('SIGTERM dispara drenado y exit 0', async () => {
  let exitCode = null;
  const server = { close: (cb) => cb() };
  const exit = (code) => {
    exitCode = code;
  };
  const cleanup = registerProcessHandlers({ server, pool: {}, timeoutMs: 1000, exit });
  try {
    process.emit('SIGTERM');
    await tick();
    assert.equal(exitCode, 0, 'SIGTERM debe salir con 0');
  } finally {
    cleanup();
  }
});

test('SIGINT (Ctrl+C) dispara drenado y exit 0', async () => {
  let exitCode = null;
  const server = { close: (cb) => cb() };
  const exit = (code) => {
    exitCode = code;
  };
  const cleanup = registerProcessHandlers({ server, pool: {}, timeoutMs: 1000, exit });
  try {
    process.emit('SIGINT');
    await tick();
    assert.equal(exitCode, 0, 'SIGINT debe salir con 0');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// FR-SL-3 / FR-SL-4: unhandledRejection / uncaughtException
// Nota: node:test NO permite emular estos eventos con process.emit (el runner
// los captura y falla el test en curso), así que la política se testea
// llamando directamente a los handlers de createProcessHandlers().
// ---------------------------------------------------------------------------
test('unhandledRejection: log + drenado + exit 1', async () => {
  let exitCode = null;
  const server = { close: (cb) => cb() };
  const exit = (code) => {
    exitCode = code;
  };
  const { handleRejection } = createProcessHandlers({ server, pool: {}, timeoutMs: 1000, exit });

  handleRejection(new Error('promesa huérfana'));
  await tick();

  assert.equal(exitCode, 1, 'una promesa rechazada sin handler debe salir con 1');
});

test('uncaughtException: log + exit 1 inmediato, sin drenar', async () => {
  let exitCode = null;
  let closed = false;
  const server = {
    close: (cb) => {
      closed = true;
      cb();
    },
  };
  const exit = (code) => {
    exitCode = code;
  };
  const { handleException } = createProcessHandlers({ server, pool: {}, timeoutMs: 1000, exit });

  handleException(new Error('excepción síncrona'));
  await tick();

  assert.equal(exitCode, 1, 'una excepción no capturada debe salir con 1');
  assert.equal(closed, false, 'uncaughtException sale inmediato, sin drenar');
});