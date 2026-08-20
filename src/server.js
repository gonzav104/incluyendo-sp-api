// src/server.js
// Bootstrap puro del BFF para Incluyendo SP.
// Todo el montaje de la app (middlewares, rutas, health) vive en app.js
// (createApp); acá solo se configura el entorno, se levanta el listener y
// se integran los handlers de ciclo de vida (T-08).

'use strict';

require('dotenv').config();
const { createApp } = require('./app');
const pool = require('./config/db'); // Inicializa y testea la conexión (boot check, FR-DB-3)
const { registerProcessHandlers } = require('./lib/lifecycle');

const app = createApp();
const PORT = process.env.PORT || 3000;

// Guardamos la referencia del server para el graceful shutdown.
const server = app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
  console.log(`📋 Health check: http://localhost:${PORT}/api/health`);
});

// Ciclo de vida (FR-SL-1/3/4): SIGTERM/SIGINT drenan y salen con 0;
// unhandledRejection drena y sale con 1; uncaughtException sale con 1.
registerProcessHandlers({ server, pool });