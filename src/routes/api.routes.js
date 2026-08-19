// src/routes/api.routes.js
// Rutas principales de la API - BFF para Incluyendo SP

const express = require('express');
const router = express.Router();

const { getInstitutions, createSuggestion, askAssistant } = require('../controllers/api.controller');

// Rutas de la API (se montan en /api desde server.js)
router.get('/institutions', getInstitutions);
router.post('/suggestions', createSuggestion);
router.post('/assistant', askAssistant);

module.exports = router;