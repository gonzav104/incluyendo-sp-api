// test/db-config.test.js
// Configuración del pool (Fase 7): defaults 5/5000/50 con override por env,
// TLS condicional por parseBoolEnv(DB_SSL) y parseBoolEnv puro (unit).
// NO se requiere el mysql2 real ni dotenv: se mockean en require.cache para
// capturar las opciones que db.js le pasa a createPool.

'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { parseBoolEnv } = require('../src/lib/helpers');

// ---------------------------------------------------------------------------
// Mocks: mysql2/promise (captura createPool) + dotenv (el .env local no debe
// interferir con las envs controladas por los tests).
// ---------------------------------------------------------------------------
let capturedOptions = null;
const fakePool = {
  async getConnection() {
    return { release() {} };
  },
  async end() {},
};

const mysqlPath = require.resolve('mysql2/promise');
require.cache[mysqlPath] = {
  id: mysqlPath,
  filename: mysqlPath,
  loaded: true,
  exports: {
    createPool: (options) => {
      capturedOptions = options;
      return fakePool;
    },
  },
};

const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath,
  filename: dotenvPath,
  loaded: true,
  exports: { config: () => ({}) },
};

const dbPath = require.resolve('../src/config/db');

// Carga db.js fresco (borrando su entrada en require.cache) y devuelve las
// opciones capturadas por createPool. El IIFE de boot check corre contra
// fakePool → getConnection resuelve → sin process.exit.
const loadDb = () => {
  delete require.cache[dbPath];
  require(dbPath);
  return capturedOptions;
};

// Silenciar logs del SUT (pipe IPC, nodejs/node#56802).
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

beforeEach(() => {
  console.log = () => {};
  console.error = () => {};
  delete process.env.DB_CONNECTION_LIMIT;
  delete process.env.DB_SSL;
});

afterEach(() => {
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
  delete process.env.DB_CONNECTION_LIMIT;
  delete process.env.DB_SSL;
});

// ---------------------------------------------------------------------------
// FR-DB-1: opciones del pool
// NOTA (verify-report): mysql2 3.23.3 IGNORA acquireTimeout (0 matches en
// node_modules/mysql2/lib; warning en cada arranque). No se pasa la opción:
// la cola se acota con queueLimit 50 + los timeouts de request (ver README,
// deuda técnica). El assert de undefined documenta que no la reintroduzcamos.
// ---------------------------------------------------------------------------
test('pool por default: connectionLimit 5, queueLimit 50, SIN acquireTimeout', () => {
  const options = loadDb();

  assert.equal(options.connectionLimit, 5, 'default de conexiones = 5 (Render free 512MB)');
  assert.equal(options.queueLimit, 50, 'cola finita de 50');
  assert.equal(
    options.acquireTimeout,
    undefined,
    'mysql2 3.23.3 ignora acquireTimeout: no pasarla (evita warning de arranque)'
  );
});

test('pool con DB_CONNECTION_LIMIT=8: connectionLimit 8, resto de defaults intactos', () => {
  process.env.DB_CONNECTION_LIMIT = '8';
  const options = loadDb();

  assert.equal(options.connectionLimit, 8);
  assert.equal(options.queueLimit, 50);
  assert.equal(options.acquireTimeout, undefined);
});

// ---------------------------------------------------------------------------
// FR-DB-2: DB_SSL normalizado
// ---------------------------------------------------------------------------
test('DB_SSL=TRUE activa TLS con rejectUnauthorized: false', () => {
  process.env.DB_SSL = 'TRUE';
  const options = loadDb();

  assert.deepEqual(options.ssl, { rejectUnauthorized: false });
});

test('DB_SSL=false (o ausente) deja ssl en undefined', () => {
  process.env.DB_SSL = 'false';
  const options = loadDb();

  assert.equal(options.ssl, undefined);
});

// ---------------------------------------------------------------------------
// FR-DB-2: parseBoolEnv puro (true/1/yes/on, case-insensitive)
// ---------------------------------------------------------------------------
test('parseBoolEnv: TRUE/1/yes/on → true', () => {
  assert.equal(parseBoolEnv('TRUE'), true);
  assert.equal(parseBoolEnv('1'), true);
  assert.equal(parseBoolEnv('yes'), true);
  assert.equal(parseBoolEnv('on'), true);
  assert.equal(parseBoolEnv('On'), true, 'case-insensitive');
});

test('parseBoolEnv: false/0/off/banana/undefined → false', () => {
  assert.equal(parseBoolEnv('false'), false);
  assert.equal(parseBoolEnv('0'), false);
  assert.equal(parseBoolEnv('OFF'), false);
  assert.equal(parseBoolEnv('banana'), false);
  assert.equal(parseBoolEnv(undefined), false);
});