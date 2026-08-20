// test/institutions.test.js
// GET /api/institutions (Fase 4): contrato intacto sin params (array plano +
// headers aditivos), paginación opcional, clamp, errores 400 y offset extremo.
// El mock del pool discrimina por SQL (COUNT vs SELECT con LIMIT/OFFSET) como
// lo haría MySQL.

'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');

const TOTAL = 42;

// Fila realista: espeja el shape de db/schema.sql con columnas JSON como strings.
const makeRow = (i) => ({
  id: `inst-${i}`,
  name: `Institución ${i}`,
  type: 'centro-educativo-terapeutico',
  specialties: '["tea","fonoaudiologia"]',
  age_range: '{"min":0,"max":12}',
  address: `{"street":"Calle ${i}","city":"San Pedro","postal_code":"2930","coordinates":{"lat":-33.67,"lng":-59.66}}`,
  contact: `{"phone":"+54 3329 42-${String(i).padStart(4, '0')}"}`,
  coverage: '{"cud":"yes","accepted_plans":["IOMA"]}',
  accessibility: '{"wheelchair_ramp":false}',
  services: '["estimulacion"]',
  verification: '{"status":"verified"}',
  created_at: '2026-08-18 12:00:00',
  updated_at: '2026-08-18 12:00:00',
});

const mockPool = {
  queries: [],
  async query(sql, params) {
    this.queries.push({ sql: String(sql), params });
    const s = String(sql);
    if (s.includes('COUNT')) return [[{ total: TOTAL }], []];
    if (s.includes('LIMIT')) {
      // mysql2 interpola los placeholders en el driver; el mock simula eso:
      // LIMIT ? OFFSET ? → params[0] = limit, params[1] = offset
      const limit = Number(params[0]);
      const offset = params.length > 1 ? Number(params[1]) : 0;
      const remaining = Math.max(0, TOTAL - offset);
      const n = Math.min(limit, remaining);
      return [Array.from({ length: n }, (_, i) => makeRow(offset + i)), []];
    }
    // Sin LIMIT: SELECT * completo (contrato sin params)
    return [Array.from({ length: TOTAL }, (_, i) => makeRow(i)), []];
  },
};

const dbPath = require.resolve('../src/config/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockPool };

const { createApp } = require('../src/app');
const app = createApp();

// Silenciar logs del SUT (pipe IPC, nodejs/node#56802).
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

beforeEach(() => {
  console.log = () => {};
  console.error = () => {};
  mockPool.queries.length = 0;
});

afterEach(() => {
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
});

// ---------------------------------------------------------------------------
// FR-IN-1: contrato intacto sin params + headers aditivos
// ---------------------------------------------------------------------------
test('sin params: array plano idéntico + X-Total-Count + Cache-Control', async () => {
  const response = await supertest(app).get('/api/institutions');

  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body), 'el body debe seguir siendo un array plano');
  assert.equal(response.body.length, TOTAL);

  // Shape preservado: columnas JSON normalizadas a objetos
  const inst = response.body[0];
  assert.equal(inst.id, 'inst-0');
  assert.ok(Array.isArray(inst.specialties), 'specialties normalizada a array');
  assert.equal(inst.specialties[0], 'tea');
  assert.equal(typeof inst.address, 'object');
  assert.equal(inst.address.street, 'Calle 0');
  assert.equal(inst.coverage.cud, 'yes');
  assert.equal(inst.verification.status, 'verified');

  // Headers aditivos
  assert.equal(response.headers['x-total-count'], String(TOTAL));
  assert.equal(response.headers['cache-control'], 'public, max-age=300');

  // SELECT * conservado (contrato con el frontend)
  assert.ok(mockPool.queries[0].sql.includes('SELECT * FROM institutions'), 'sin params debe usar SELECT *');
});

// ---------------------------------------------------------------------------
// FR-IN-2 / FR-IN-3: paginación opcional
// ---------------------------------------------------------------------------
test('?limit=10&offset=20 devuelve 10 instituciones desde la posición 21', async () => {
  const response = await supertest(app).get('/api/institutions?limit=10&offset=20');

  assert.equal(response.status, 200);
  assert.equal(response.body.length, 10);
  assert.equal(response.body[0].id, 'inst-20', 'debe empezar en la posición 21 (offset 20)');
  assert.equal(response.body[9].id, 'inst-29');
  assert.equal(response.headers['x-total-count'], String(TOTAL), 'X-Total-Count es el total sin paginar');
  assert.equal(response.headers['cache-control'], 'public, max-age=300');
});

test('?limit=2000 se clamp a 1000 en el SQL', async () => {
  const response = await supertest(app).get('/api/institutions?limit=2000');

  assert.equal(response.status, 200);
  const sqlConLimite = mockPool.queries.find((q) => q.sql.includes('LIMIT'));
  assert.ok(sqlConLimite, 'debe ejecutarse una query con LIMIT');
  assert.equal(sqlConLimite.params[0], 1000, `el clamp debe aplicar limit 1000, params reales: ${sqlConLimite.params}`);
  assert.equal(response.headers['x-total-count'], String(TOTAL));
});

test('?limit=abc devuelve 400 con error en español', async () => {
  const response = await supertest(app).get('/api/institutions?limit=abc');
  assert.equal(response.status, 400);
  assert.ok(response.body.error, 'debe responder con error en español');
});

test('?limit=2.5 (float) devuelve 400', async () => {
  const response = await supertest(app).get('/api/institutions?limit=2.5');
  assert.equal(response.status, 400);
  assert.ok(response.body.error);
});

test('?offset=-5 devuelve 400 con error en español', async () => {
  const response = await supertest(app).get('/api/institutions?offset=-5');
  assert.equal(response.status, 400);
  assert.ok(response.body.error, 'debe responder con error en español');
});

test('?offset=999999 (más allá del total) devuelve 200 con array vacío', async () => {
  const response = await supertest(app).get('/api/institutions?offset=999999');

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, [], 'offset más allá del total → array vacío, sin error');
  assert.equal(response.headers['x-total-count'], String(TOTAL));
});