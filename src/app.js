// src/app.js
// Factory de la app Express con el montaje real de producción.
// server.js queda como bootstrap puro; los tests montan la app real vía
// createApp() en vez de duplicar el montaje a mano (design D1).
//
// IMPORTANTE: lee las env al llamarla (no al requerirla) para que los tests
// puedan controlar la configuración por instancia.

'use strict';

const express = require('express');
const cors = require('cors');
const apiRoutes = require('./routes/api.routes');
const { createHealthHandler } = require('./controllers/health.controller');
const { buildCorsAllowlist } = require('./lib/helpers');

const createApp = () => {
  const app = express();

  // Seguridad de headers (W11): no revelar el motor de la app.
  app.disable('x-powered-by');

  // C1 (trust proxy): Render es exactamente 1 hop. Express toma la entrada
  // rightmost de X-Forwarded-For como IP efectiva (la que agrega el proxy), así
  // req.ip y los buckets del rate limit usan la IP real del cliente, y el
  // spoofing de XFF no engaña. DEBE ir antes de cors y de los limiters.
  app.set('trust proxy', 1);

  // CORS con allowlist (W10, D2): FRONTEND_URLS coma-separada → fallback
  // FRONTEND_URL (deprecated) → default localhost:5173. Los orígenes fuera de
  // la allowlist reciben 403 SIN Access-Control-Allow-Origin (el browser
  // bloquea igual; acá cortamos temprano con log de intento denegado).
  const allowedOrigins = buildCorsAllowlist();
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.includes(origin)) {
      console.warn(`🚫 Origen CORS denegado: ${origin}`);
      return res.status(403).json({ error: 'Origen no permitido' });
    }
    next();
  });
  app.use(
    cors({
      origin: (origin, callback) => callback(null, !origin || allowedOrigins.includes(origin)),
      maxAge: 86400,
    })
  );

  app.use(express.json({ limit: '50kb' }));

  // Rutas principales de la API
  app.use('/api', apiRoutes);

  // Health check (D3: ruta directa, fuera del router de negocio). Se monta con
  // la factory (no el handler crudo): Express 5 llama (req, res, next) y un
  // 3er parámetro colable recibiría `next` como timeout → 503 falso (FR-AH-1).
  app.get('/api/health', createHealthHandler());

  // Error handler global (W13): payloads que exceden el límite → 413 en español.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'El payload es demasiado grande (máximo 50kb)' });
    }
    next(err);
  });

  return app;
};

module.exports = { createApp };