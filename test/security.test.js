// test/security.test.js
// Hardening de seguridad (Fase 1): CORS allowlist, x-powered-by, 413, trust proxy.
// No requiere MySQL ni n8n: pool mockeado vía require.cache (db.js real haría
// process.exit si no conecta) y app real vía createApp().

'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');

// ---------------------------------------------------------------------------
// Mock del pool ANTES de requerir la app (mismo patrón que api.test.js).
// ---------------------------------------------------------------------------
const mockPool = {
  query: async () => [[], []],
};
const dbPath = require.resolve('../src/config/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockPool };

const { createApp } = require('../src/app');

// createApp() lee las env al llamarla: cada test setea su entorno y arma su app.
// Limpiamos las env de CORS entre tests para evitar contaminación.
beforeEach(() => {
  delete process.env.FRONTEND_URLS;
  delete process.env.FRONTEND_URL;
});

// Silenciar logs del SUT (console.log/error/warn): evita corromper el pipe IPC
// de node --test (nodejs/node#56802). El path de CORS denegado emite warn.
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

beforeEach(() => {
  console.log = () => {};
  console.error = () => {};
  console.warn = () => {};
});

afterEach(() => {
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
  console.warn = originalConsoleWarn;
});

// ---------------------------------------------------------------------------
// FR-SS-4: CORS multi-origen por allowlist
// ---------------------------------------------------------------------------
test('CORS: multi-origen refleja ACAO exacto para orígenes permitidos', async () => {
  process.env.FRONTEND_URLS = 'https://app.incluyendosp.com.ar,https://admin.incluyendosp.com.ar';
  const app = createApp();

  const response = await supertest(app)
    .get('/api/institutions')
    .set('Origin', 'https://app.incluyendosp.com.ar');

  assert.equal(response.status, 200);
  assert.equal(response.headers['access-control-allow-origin'], 'https://app.incluyendosp.com.ar');
});

test('CORS: origen fuera de la allowlist → 403 SIN Access-Control-Allow-Origin', async () => {
  process.env.FRONTEND_URLS = 'https://app.incluyendosp.com.ar,https://admin.incluyendosp.com.ar';
  const app = createApp();

  const response = await supertest(app)
    .get('/api/institutions')
    .set('Origin', 'https://evil.example.com');

  assert.equal(response.status, 403);
  assert.equal(response.headers['access-control-allow-origin'], undefined, 'no debe haber ACAO para orígenes denegados');
  assert.ok(response.body.error, 'debe responder con error en español');
});

test('CORS: fallback retrocompatible con FRONTEND_URL', async () => {
  process.env.FRONTEND_URL = 'https://app.incluyendosp.com.ar';
  const app = createApp();

  const response = await supertest(app)
    .get('/api/institutions')
    .set('Origin', 'https://app.incluyendosp.com.ar');

  assert.equal(response.headers['access-control-allow-origin'], 'https://app.incluyendosp.com.ar');
});

test('CORS: default de desarrollo localhost:5173 + preflight con maxAge 86400', async () => {
  const app = createApp(); // sin envs de CORS

  const preflight = await supertest(app)
    .options('/api/institutions')
    .set('Origin', 'http://localhost:5173')
    .set('Access-Control-Request-Method', 'GET');

  assert.equal(preflight.headers['access-control-allow-origin'], 'http://localhost:5173');
  assert.equal(preflight.headers['access-control-max-age'], '86400');
});

// ---------------------------------------------------------------------------
// FR-SS-2: sin X-Powered-By
// ---------------------------------------------------------------------------
test('X-Powered-By ausente en las respuestas', async () => {
  const app = createApp();
  const response = await supertest(app).get('/api/institutions');
  assert.equal(response.headers['x-powered-by'], undefined);
});

// ---------------------------------------------------------------------------
// FR-SS-3: límite de body JSON 50kb
// ---------------------------------------------------------------------------
test('413: payload mayor a 50kb es rechazado con error en español', async () => {
  const app = createApp();
  const response = await supertest(app)
    .post('/api/suggestions')
    .send({ institution_name: 'x'.repeat(60000) }); // ~60kb > 50kb

  assert.equal(response.status, 413);
  assert.ok(response.body.error, 'debe responder con error en español');
});

test('payload de hasta 50kb se procesa normal (sin 413)', async () => {
  const app = createApp();
  const response = await supertest(app)
    .post('/api/suggestions')
    .send({ specialty: 'y'.repeat(40000) }); // ~40kb ≤ 50kb, sin institution_name

  // El JSON se parseó bien: llega a validación de negocio (400) y no a 413.
  assert.equal(response.status, 400);
  assert.equal(response.body.error, 'institution_name es obligatorio');
});

// ---------------------------------------------------------------------------
// FR-SS-1: trust proxy 1 hop → IP real rightmost + rate limit por IP real
// ---------------------------------------------------------------------------
test('rate limit por IP real tras proxy: buckets separados y rightmost gana', async () => {
  const app = createApp();

  // 1) Consumimos el bucket de la IP real 203.0.113.5 (20 requests pasan el limiter)
  const results = [];
  for (let i = 1; i <= 20; i += 1) {
    const response = await supertest(app)
      .post('/api/assistant')
      .set('X-Forwarded-For', '203.0.113.5')
      .send({});
    results.push(response.status);
  }
  assert.ok(results.every((s) => s === 400), `los 20 primeros debían pasar (400), obtuve: ${results.join(',')}`);

  // 2) El request 21 con la MISMA IP real → 429 (bucket lleno)
  const blocked = await supertest(app)
    .post('/api/assistant')
    .set('X-Forwarded-For', '203.0.113.5')
    .send({});
  assert.equal(blocked.status, 429, 'request 21 de la misma IP debe dar 429');

  // 3) Una IP real DISTINTA → bucket propio: no recibe 429 por culpa de la otra
  const otherIp = await supertest(app)
    .post('/api/assistant')
    .set('X-Forwarded-For', '198.51.100.7')
    .send({});
  assert.equal(otherIp.status, 400, 'IP distinta no debe heredar el bucket ajeno');

  // 4) Spoofing: XFF "6.6.6.6, 203.0.113.5" (spoof + proxy). La efectiva es la
  //    rightmost (203.0.113.5, bucket ya lleno) → 429. Si usara la leftmost
  //    (6.6.6.6, bucket fresco) → 400. Esto prueba que el spoof no engaña.
  const spoofed = await supertest(app)
    .post('/api/assistant')
    .set('X-Forwarded-For', '6.6.6.6, 203.0.113.5')
    .send({});
  assert.equal(spoofed.status, 429, 'el valor spoofeado (leftmost) no debe crear bucket propio');
});