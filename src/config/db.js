// src/config/db.js
// Pool de conexiones MySQL usando mysql2/promise
// Lee variables de entorno desde .env y hace test de conexión al iniciar

require('dotenv').config();
const mysql = require('mysql2/promise');

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
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  namedPlaceholders: true,
});

// Test de conexión al iniciar
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