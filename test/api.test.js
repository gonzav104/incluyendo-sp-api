// test/api.test.js
// Tests unitarios de los endpoints del BFF.
// No requieren MySQL: mockeamos el pool (require.cache) y el fetch a n8n.
//
// Ejecutar: npm test

'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

// ---------------------------------------------------------------------------
// Mock del pool de MySQL ANTES de requerir el controller.
// db.js intenta conectar y hace process.exit(1) si falla — por eso NUNCA
// requerimos el módulo real: reemplazamos su entrada en require.cache.
// ---------------------------------------------------------------------------
const mockPool = {
  query: async () => [
    [
      {
        id: 'consultorios-emij',
        name: 'Consultorios EMIJ',
        type: 'centro-educativo-terapeutico',
        specialties: '["tea","fonoaudiologia"]', // string JSON realista
        age_range: '{"min":0,"max":12}',
        address:
          '{"street":"Almafuerte 530","city":"San Pedro","postal_code":"2930","coordinates":{"lat":-33.6785792,"lng":-59.6613711}}',
        contact: '{"phone":"+54 3329 56-0912"}',
        coverage: '{"cud":"yes","accepted_plans":["IOMA"]}',
        accessibility: '{"wheelchair_ramp":false}',
        services: null,
        verification: '{"status":"verified"}',
      },
    ],
    [],
  ],
};

const dbPath = require.resolve('../src/config/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockPool };

const apiRoutes = require('../src/routes/api.routes');

// App de prueba: mismo montaje que server.js
const app = express();
app.use(express.json());
app.use('/api', apiRoutes);

// Guardamos el fetch original para restaurarlo después de cada test
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// Espera a que la cola de microtasks/I/O se drene (para los fetch fire-and-forget)
const flush = () => new Promise((resolve) => setImmediate(resolve));

// ---------------------------------------------------------------------------
// GET /api/institutions
// ---------------------------------------------------------------------------
test('GET /api/institutions responde 200 con array de instituciones', async () => {
  const supertest = require('supertest');
  const response = await supertest(app).get('/api/institutions');
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body));
  assert.equal(response.body.length, 1);
});

test('GET /api/institutions normaliza las columnas JSON a objetos', async () => {
  const supertest = require('supertest');
  const response = await supertest(app).get('/api/institutions');
  const inst = response.body[0];
  assert.ok(Array.isArray(inst.specialties), 'specialties debe ser array');
  assert.equal(inst.specialties[0], 'tea');
  assert.equal(typeof inst.address, 'object');
  assert.equal(inst.address.street, 'Almafuerte 530');
  assert.equal(inst.address.coordinates.lat, -33.6785792);
  assert.equal(inst.coverage.cud, 'yes');
  assert.equal(inst.verification.status, 'verified');
});

test('GET /api/institutions responde 500 si el pool falla', async () => {
  const supertest = require('supertest');
  // Reemplazamos query con un stub que tira error
  const originalQuery = mockPool.query;
  mockPool.query = async () => {
    throw new Error('connection lost');
  };
  try {
    const response = await supertest(app).get('/api/institutions');
    assert.equal(response.status, 500);
    assert.equal(response.body.error, 'No se pudieron obtener las instituciones');
  } finally {
    mockPool.query = originalQuery;
  }
});

// ---------------------------------------------------------------------------
// POST /api/suggestions
// ---------------------------------------------------------------------------
test('POST /api/suggestions rechaza sin institution_name (400)', async () => {
  const supertest = require('supertest');
  const response = await supertest(app).post('/api/suggestions').send({ specialty: 'fono' });
  assert.equal(response.status, 400);
  assert.equal(response.body.error, 'institution_name es obligatorio');
});

test('POST /api/suggestions acepta institution_name vacío como 400', async () => {
  const supertest = require('supertest');
  const response = await supertest(app).post('/api/suggestions').send({ institution_name: '   ' });
  assert.equal(response.status, 400);
});

test('POST /api/suggestions válido responde 201 y guarda en el pool', async () => {
  const supertest = require('supertest');
  const calls = [];
  const originalQuery = mockPool.query;
  mockPool.query = async (sql, params) => {
    calls.push({ sql, params });
    return [{ affectedRows: 1 }, []];
  };
  try {
    const response = await supertest(app)
      .post('/api/suggestions')
      .send({ institution_name: '  Jardín Nº 903  ', specialty: 'estimulacion temprana', contact_info: '03329 42-0000' });
    assert.equal(response.status, 201);
    assert.equal(response.body.message, 'Sugerencia recibida, ¡gracias por colaborar!');
    assert.equal(calls.length, 1);
    // Verificamos que el nombre llegue trimmeado
    assert.equal(calls[0].params[0], 'Jardín Nº 903');
    assert.equal(calls[0].params[1], 'estimulacion temprana');
  } finally {
    mockPool.query = originalQuery;
  }
});

test('POST /api/suggestions responde 500 si el pool falla', async () => {
  const supertest = require('supertest');
  const originalQuery = mockPool.query;
  mockPool.query = async () => {
    throw new Error('insert failed');
  };
  try {
    const response = await supertest(app).post('/api/suggestions').send({ institution_name: 'X' });
    assert.equal(response.status, 500);
    assert.equal(response.body.error, 'No se pudo guardar la sugerencia');
  } finally {
    mockPool.query = originalQuery;
  }
});

test('POST /api/suggestions notifica a n8n tras el INSERT (fire-and-forget)', async () => {
  const supertest = require('supertest');
  process.env.N8N_SUGGESTIONS_WEBHOOK_URL = 'https://n8n.test/suggestions-webhook';
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { ok: true };
  };
  try {
    const response = await supertest(app)
      .post('/api/suggestions')
      .send({ institution_name: '  Jardín Nº 903  ', specialty: 'fonoaudiologia', contact_info: '03329 42-0000' });
    assert.equal(response.status, 201);
    await flush();
    assert.equal(calls.length, 1, 'fetch a n8n debe llamarse una vez');
    assert.equal(calls[0].url, 'https://n8n.test/suggestions-webhook');
    // Solo los 4 campos permitidos
    assert.deepEqual(
      Object.keys(calls[0].body).sort(),
      ['contact_info', 'created_at', 'institution_name', 'specialty']
    );
    assert.equal(calls[0].body.institution_name, 'Jardín Nº 903');
    assert.ok(!Number.isNaN(Date.parse(calls[0].body.created_at)), 'created_at debe ser fecha válida');
  } finally {
    delete process.env.N8N_SUGGESTIONS_WEBHOOK_URL;
  }
});

test('POST /api/suggestions responde 201 aunque n8n tire error de red', async () => {
  const supertest = require('supertest');
  process.env.N8N_SUGGESTIONS_WEBHOOK_URL = 'https://n8n.test/suggestions-webhook';
  globalThis.fetch = async () => {
    throw new Error('n8n down');
  };
  try {
    const response = await supertest(app)
      .post('/api/suggestions')
      .send({ institution_name: 'Jardín Nº 903' });
    assert.equal(response.status, 201, 'el error de n8n NO puede cambiar el status');
    assert.equal(response.body.message, 'Sugerencia recibida, ¡gracias por colaborar!');
  } finally {
    delete process.env.N8N_SUGGESTIONS_WEBHOOK_URL;
  }
});

test('POST /api/suggestions responde 201 aunque n8n responda con error HTTP', async () => {
  const supertest = require('supertest');
  process.env.N8N_SUGGESTIONS_WEBHOOK_URL = 'https://n8n.test/suggestions-webhook';
  globalThis.fetch = async () => ({ ok: false, status: 500 });
  try {
    const response = await supertest(app)
      .post('/api/suggestions')
      .send({ institution_name: 'Jardín Nº 903' });
    assert.equal(response.status, 201, 'el error de n8n NO puede cambiar el status');
    assert.equal(response.body.message, 'Sugerencia recibida, ¡gracias por colaborar!');
  } finally {
    delete process.env.N8N_SUGGESTIONS_WEBHOOK_URL;
  }
});

test('POST /api/suggestions no llama a n8n si N8N_SUGGESTIONS_WEBHOOK_URL no está', async () => {
  const supertest = require('supertest');
  delete process.env.N8N_SUGGESTIONS_WEBHOOK_URL;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return { ok: true };
  };
  try {
    const response = await supertest(app)
      .post('/api/suggestions')
      .send({ institution_name: 'Jardín Nº 903' });
    assert.equal(response.status, 201);
    await flush();
    assert.equal(fetchCalled, false, 'sin webhook configurado no debe llamar a n8n');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// POST /api/assistant
// ---------------------------------------------------------------------------
test('POST /api/assistant rechaza sin prompt (400)', async () => {
  const supertest = require('supertest');
  const response = await supertest(app).post('/api/assistant').send({});
  assert.equal(response.status, 400);
  assert.equal(response.body.error, 'prompt es obligatorio');
});

test('POST /api/assistant responde 500 si falta N8N_WEBHOOK_URL', async () => {
  const supertest = require('supertest');
  const original = process.env.N8N_WEBHOOK_URL;
  delete process.env.N8N_WEBHOOK_URL;
  try {
    const response = await supertest(app).post('/api/assistant').send({ prompt: 'hola' });
    assert.equal(response.status, 500);
    assert.equal(response.body.error, 'N8N_WEBHOOK_URL no está configurado en .env');
  } finally {
    if (original !== undefined) process.env.N8N_WEBHOOK_URL = original;
  }
});

test('POST /api/assistant responde 502 si n8n falla', async () => {
  const supertest = require('supertest');
  process.env.N8N_WEBHOOK_URL = 'https://n8n.test/webhook/x';
  globalThis.fetch = async () => ({ ok: false, status: 503 });
  try {
    const response = await supertest(app).post('/api/assistant').send({ prompt: 'hola' });
    assert.equal(response.status, 502);
    assert.equal(response.body.error, 'El asistente falló en n8n');
  } finally {
    delete process.env.N8N_WEBHOOK_URL;
  }
});

test('POST /api/assistant responde 200 con la respuesta de n8n (JSON)', async () => {
  const supertest = require('supertest');
  process.env.N8N_WEBHOOK_URL = 'https://n8n.test/webhook/x';
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ response: 'El CUD se tramita en el hospital...' }),
  });
  try {
    const response = await supertest(app).post('/api/assistant').send({ prompt: '¿CUD?' });
    assert.equal(response.status, 200);
    assert.equal(response.body.response, 'El CUD se tramita en el hospital...');
  } finally {
    delete process.env.N8N_WEBHOOK_URL;
  }
});

test('POST /api/assistant envuelve texto crudo de n8n en { output }', async () => {
  const supertest = require('supertest');
  process.env.N8N_WEBHOOK_URL = 'https://n8n.test/webhook/x';
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => 'Respuesta en texto plano sin JSON',
  });
  try {
    const response = await supertest(app).post('/api/assistant').send({ prompt: 'hola' });
    assert.equal(response.status, 200);
    assert.equal(response.body.output, 'Respuesta en texto plano sin JSON');
  } finally {
    delete process.env.N8N_WEBHOOK_URL;
  }
});