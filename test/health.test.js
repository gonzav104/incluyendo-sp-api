// test/health.test.js
// Health check DB-aware (Fase 3): 200 con SELECT 1 OK, 503 degraded con DB
// caída o timeout. El default de producción es 3s; los tests inyectan 50ms vía
// createHealthHandler({ timeoutMs }) en una ruta de prueba para no esperar en CI.

'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');

// ---------------------------------------------------------------------------
// Mock del pool: SELECT 1 responde ok por default.
// ---------------------------------------------------------------------------
const mockPool = {
  query: async () => [[{ 1: 1 }], []],
};
const dbPath = require.resolve('../src/config/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockPool };

const { createApp } = require('../src/app');
const { createHealthHandler } = require('../src/controllers/health.controller');

const app = createApp();
// Ruta de prueba con timeout inyectado (DI de D7): el default de 3s cumpliría
// la spec pero haría los tests lentos con un query que nunca resuelve.
app.get('/api/health/fast', createHealthHandler({ timeoutMs: 50 }));

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

// ---------------------------------------------------------------------------
// FR-AH-1: DB sana → 200 { status: "ok" }
// ---------------------------------------------------------------------------
test('GET /api/health responde 200 con status ok cuando SELECT 1 responde', async () => {
  const response = await supertest(app).get('/api/health');

  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'ok');
  assert.equal(response.body.service, 'incluyendo-sp-api');
  assert.ok(response.body.timestamp, 'timestamp debe estar presente');
  assert.equal(typeof response.body.uptime, 'number');
  assert.ok(response.body.environment, 'environment debe estar presente');
});

// ---------------------------------------------------------------------------
// FR-AH-2: DB caída o timeout → 503 degraded, nunca 500 ni crash
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// FR-AH-1 REGRESIÓN: el DEFAULT real (3s) debe ganar contra una query lenta
// PERO sana. El test viejo pasaba por race de microtasks (mock 0ms vs timer
// espurio de ~1ms cuando Express 5 le pasa `next` como timeoutMs). Acá el mock
// tarda 100ms << 3000ms: si el handler recibiera `next` como timeout, el timer
// espurio dispararía a ~1ms → 503 falso. Con el fix → 200 legítimo.
// ---------------------------------------------------------------------------
test('GET /api/health: el default real (3s) responde 200 con query lenta pero sana (100ms)', async () => {
  const originalQuery = mockPool.query;
  mockPool.query = () =>
    new Promise((resolve) => setTimeout(() => resolve([[{ 1: 1 }], []]), 100));
  try {
    const response = await supertest(app).get('/api/health');

    assert.equal(response.status, 200, 'query de 100ms debe ser OK con el default de 3000ms');
    assert.equal(response.body.status, 'ok');
  } finally {
    mockPool.query = originalQuery;
  }
});

test('GET /api/health responde 503 degraded si el SELECT 1 nunca resuelve (timeout)', async () => {
  const originalQuery = mockPool.query;
  mockPool.query = () => new Promise(() => {}); // nunca resuelve
  try {
    const response = await supertest(app).get('/api/health/fast');

    assert.equal(response.status, 503);
    assert.equal(response.body.status, 'degraded');
    assert.equal(response.body.service, 'incluyendo-sp-api');
  } finally {
    mockPool.query = originalQuery;
  }
});

test('GET /api/health responde 503 degraded si el SELECT 1 rechaza (DB caída)', async () => {
  const originalQuery = mockPool.query;
  mockPool.query = async () => {
    throw new Error('DB unreachable');
  };
  try {
    const response = await supertest(app).get('/api/health/fast');

    assert.equal(response.status, 503);
    assert.equal(response.body.status, 'degraded');
  } finally {
    mockPool.query = originalQuery;
  }
});