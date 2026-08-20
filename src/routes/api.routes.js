// src/routes/api.routes.js
// Rutas principales de la API - BFF para Incluyendo SP

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const { getInstitutions, createSuggestion, askAssistant } = require('../controllers/api.controller');

// Límite de peticiones SOLO para el asistente: el webhook de n8n tiene costo
// asociado, así que protegemos el endpoint con 20 requests / 15 min por IP
// real (req.ip ya resuelve la rightmost de X-Forwarded-For gracias a
// `trust proxy: 1` en app.js).
const assistantLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // ventana de 15 minutos
  limit: 20, // máximo 20 requests por IP en la ventana
  standardHeaders: true, // responde con headers RateLimit-* (estándar)
  legacyHeaders: false, // no emitir los headers X-RateLimit-* deprecados
  message: { error: 'Demasiadas solicitudes al asistente. Esperá unos minutos y probá de nuevo.' },
});

// Límite liviano para sugerencias: también disparan una ejecución de n8n (mail),
// así que protegemos con 10 requests / 15 min por IP real.
const suggestionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas sugerencias. Esperá unos minutos y probá de nuevo.' },
});

// Rutas de la API (se montan en /api desde app.js — createApp)
router.get('/institutions', getInstitutions);
router.post('/suggestions', suggestionLimiter, createSuggestion);
router.post('/assistant', assistantLimiter, askAssistant);

module.exports = router;