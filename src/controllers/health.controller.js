// src/controllers/health.controller.js
// Health check del BFF (FR-AH-1/2): verifica la DB con SELECT 1 y timeout
// propio. 200 ok / 503 degraded — NUNCA 500 ni exit (Render reinicia
// instancias unhealthy; el 503 permite diagnóstico sin crash-loop).
//
// DI vía factory (fix del verify-report): el handler devuelto tiene firma
// (req, res) SIN parámetro colable — Express 5 llama (req, res, next) y un
// 3er parámetro habría recibido la función `next` como timeout (bug FR-AH-1:
// setTimeout(cb, next) coacciona a ~1ms → 503 falso casi siempre). Acá el
// timeout queda capturado en el closure y la clase de bug no puede reintroducirse.

'use strict';

const pool = require('../config/db');
const { withTimeout } = require('../lib/helpers');

const HEALTH_TIMEOUT_MS = 3000;

// createHealthHandler({ timeoutMs = 3000 }) → async (req, res) => void
// timeoutMs inyectable por DI para tests: el default de 3s cumple la spec.
const createHealthHandler = ({ timeoutMs = HEALTH_TIMEOUT_MS } = {}) => {
  return async (req, res) => {
    const base = {
      service: 'incluyendo-sp-api',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: process.env.NODE_ENV || 'development',
    };

    try {
      await withTimeout(pool.query('SELECT 1'), timeoutMs);
      return res.status(200).json({ status: 'ok', ...base });
    } catch (error) {
      console.error('❌ Health check: la DB no responde:', error.message);
      return res.status(503).json({ status: 'degraded', ...base });
    }
  };
};

module.exports = { createHealthHandler };