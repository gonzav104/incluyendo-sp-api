// src/config/db.js
// Pool de conexiones MySQL usando mysql2/promise
// Lee variables de entorno desde .env y hace test de conexión al iniciar

'use strict';

require('dotenv').config();
const mysql = require('mysql2/promise');
const { parseBoolEnv } = require('../lib/helpers');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  // Aiven y otros hosts remotos usan puertos no estándar (ej: 24509).
  // Sin DB_PORT asumimos 3306 (MySQL local).
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'incluyendo_sp',
  // Aiven exige TLS. rejectUnauthorized: false es lo habitual sin bajar el CA
  // (aceptable para el MVP; en producción seria, descargar el CA de Aiven).
  // DB_SSL se parsea case-insensitive (true/1/yes/on) — FR-DB-2.
  ssl: parseBoolEnv(process.env.DB_SSL) ? { rejectUnauthorized: false } : undefined,
  waitForConnections: true,
  // D8/FR-DB-1: default 5 (Render free 512MB: cada conexión consume memoria y
  // sockets; el pico real del BFF — 1 frontend, directorio local — no justifica
  // 10). La cola finita (50) absorbe ráfagas sin thundering herd y deja
  // headroom al heap de Node. OJO (verify-report): mysql2 3.23.3 IGNORA
  // acquireTimeout (warning en cada arranque) → NO pasarla; el acotamiento de
  // la espera queda en queueLimit + los timeouts de request (ver README).
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT) || 5,
  queueLimit: 50,
  namedPlaceholders: true,
});

// Test de conexión al iniciar (FR-DB-3: preservado — si la DB no conecta al
// boot, log + exit(1); el BFF no arranca sin DB).
(async () => {
  try {
    const connection = await pool.getConnection();
    console.log(`🔥 Conectado exitosamente a MySQL: ${process.env.DB_NAME || 'incluyendo_sp'}`);
    connection.release();
  } catch (error) {
    console.error('❌ Error conectando a MySQL:', error.message);
    console.error('   Verificá que MySQL esté corriendo y las credenciales en .env sean correctas');
    process.exit(1);
  }
})();

module.exports = pool;