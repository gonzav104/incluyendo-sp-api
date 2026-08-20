// test/rate-limit.test.js
// Verifica que el rate limiter del POST /api/assistant rechace el request 21.
// Corre en proceso propio: el limiter arranca en 0 consumidos.
// No requiere MySQL ni n8n: la validación de prompt corta antes del fetch.

'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// Mock del pool ANTES de requerir el controller (db.js haría process.exit si MySQL no conecta)
const mockPool = {
  query: async () => [[], []],
};
const dbPath = require.resolve('../src/config/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockPool };

// App real de producción vía factory (mismo montaje que server.js).
const { createApp } = require('../src/app');
const app = createApp();

// Silenciar logs de producción del SUT: evita corromper el pipe IPC del test
// runner (nodejs/node#56802) cuando el código loguea a stdout.
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

test('POST /api/assistant: request 21 es rechazado por rate limit (429)', async () => {
  const supertest = require('supertest');
  const results = [];

  // 21 requests con body vacío (sin prompt → el handler devolvería 400,
  // pero el request 21 ni siquiera llega al handler: el limiter lo corta)
  for (let i = 1; i <= 21; i += 1) {
    const response = await supertest(app).post('/api/assistant').send({});
    results.push(response.status);
  }

  // Primeros 20: pasan el limiter (400 = validación de prompt)
  const first20 = results.slice(0, 20);
  assert.ok(first20.every((status) => status === 400), `esperado 400 en los 20 primeros, obtuve: ${first20.join(',')}`);

  // Request 21: bloqueado por rate limit
  assert.equal(results[20], 429, `request 21 debía dar 429, obtuve: ${results[20]}`);
});

test('headers de rate limit presentes en respuesta', async () => {
  const supertest = require('supertest');
  const response = await supertest(app).post('/api/assistant').send({});
  // Da igual si responde 400 o 429 (el limiter ya consumió requests del window):
  // el header RateLimit-Limit debe existir siempre.
  assert.ok(response.headers['ratelimit-limit'], 'falta header RateLimit-Limit');
  assert.equal(response.headers['ratelimit-limit'], '20');
});

test('POST /api/suggestions: request 11 es rechazado por rate limit (429)', async () => {
  const supertest = require('supertest');
  const results = [];

  // El limiter de suggestions es independiente del de assistant (instancias
  // separadas), así que arranca en 0 aunque el archivo ya haya consumido los
  // del asistente.
  for (let i = 1; i <= 11; i += 1) {
    const response = await supertest(app).post('/api/suggestions').send({});
    results.push(response.status);
  }

  // Primeros 10: pasan el limiter (400 = validación de institution_name)
  const first10 = results.slice(0, 10);
  assert.ok(
    first10.every((status) => status === 400),
    `esperado 400 en los 10 primeros, obtuve: ${first10.join(',')}`
  );

  // Request 11: bloqueado por rate limit
  assert.equal(results[10], 429, `request 11 debía dar 429, obtuve: ${results[10]}`);
});