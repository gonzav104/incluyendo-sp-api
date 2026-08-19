// src/config/db.js
// Pool de conexiones MySQL usando mysql2/promise
// Lee variables de entorno desde .env y hace test de conexión al iniciar

require('dotenv').config();
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'incluyendo_sp',
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