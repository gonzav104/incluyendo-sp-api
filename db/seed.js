// db/seed.js
// Seed de la tabla `institutions` con los datos del JSON del frontend.
//
// Requisito: ejecutar primero db/schema.sql (mysql -u root -p < db/schema.sql)
//
// Uso: npm run seed
//
// Idempotente: usa INSERT ... ON DUPLICATE KEY UPDATE por id, así que
// se puede correr N veces sin duplicar filas. En cada corrida loguea
// cuántas filas se insertaron y cuántas se actualizaron.

require('dotenv').config();
const pool = require('../src/config/db');
const seedData = require('./seed-data.json');

const institutions = seedData.institutions;

// Columnas que espejan el esquema de db/schema.sql.
// Nota: `services` no está en los datos actuales del frontend, va NULL.
const INSERT_SQL = `
  INSERT INTO institutions (
    id, name, type, specialties, age_range, address, contact,
    coverage, accessibility, services, verification
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON DUPLICATE KEY UPDATE
    name = VALUES(name),
    type = VALUES(type),
    specialties = VALUES(specialties),
    age_range = VALUES(age_range),
    address = VALUES(address),
    contact = VALUES(contact),
    coverage = VALUES(coverage),
    accessibility = VALUES(accessibility),
    services = VALUES(services),
    verification = VALUES(verification)
`;

(async () => {
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;

  try {
    for (const institution of institutions) {
      const values = [
        institution.id,
        institution.name,
        institution.type ?? null,
        JSON.stringify(institution.specialties ?? []),
        JSON.stringify(institution.age_range ?? {}),
        JSON.stringify(institution.address ?? {}),
        JSON.stringify(institution.contact ?? {}),
        JSON.stringify(institution.coverage ?? {}),
        JSON.stringify(institution.accessibility ?? {}),
        null, // services — no presente en los datos del frontend
        JSON.stringify(institution.verification ?? {}),
      ];

      const [result] = await pool.query(INSERT_SQL, values);

      // MySQL: affectedRows === 1 → insert nuevo; === 2 → update con cambios;
      // === 0 → la fila ya existía con datos idénticos (ON DUPLICATE KEY no tocó nada)
      if (result.affectedRows === 1) {
        inserted += 1;
      } else if (result.affectedRows === 2) {
        updated += 1;
      } else {
        unchanged += 1;
      }
    }

    console.log(
      `✅ Seed completado: ${inserted} insertadas, ${updated} actualizadas, ${unchanged} sin cambios (total ${institutions.length})`
    );
  } catch (error) {
    console.error('❌ Error ejecutando el seed:', error.message);
    console.error('   ¿Ejecutaste primero db/schema.sql?');
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();