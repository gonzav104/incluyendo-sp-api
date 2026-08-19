-- =============================================================================
-- schema.sql — Incluyendo SP API
-- Esquema MySQL para el BFF (Backend For Frontend)
--
-- Decisión de diseño: los campos anidados del frontend (specialties, address,
-- contact, coverage, etc.) se guardan como JSON nativo de MySQL en lugar de
-- normalizar en tablas adicionales, dado el timeframe del MVP.
-- El frontend consume exactamente esta estructura sin transformaciones.
-- =============================================================================

-- Aseguramos charset utf8mb4: necesario para acentos, emojis y caracteres
-- especiales del español (Nº, ñ, etc.)
CREATE DATABASE IF NOT EXISTS incluyendo_sp
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE incluyendo_sp;

-- -----------------------------------------------------------------------------
-- Tabla principal: institutions
-- -----------------------------------------------------------------------------
-- Espeja el JSON de src/data/institutions.json del frontend.
-- id es un slug legible (ej: "escuela-especial-501-hena-yanzon"), no un
-- AUTO_INCREMENT, para que coincida con los ids usados por el frontend.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS institutions (
  id VARCHAR(100) NOT NULL,
  name VARCHAR(255) NOT NULL,
  type VARCHAR(100) NULL,
  specialties JSON NULL,
  age_range JSON NULL,
  address JSON NULL,
  contact JSON NULL,
  coverage JSON NULL,
  accessibility JSON NULL,
  services JSON NULL,
  verification JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_institutions_name (name),
  INDEX idx_institutions_type (type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- Tabla: community_suggestions
-- -----------------------------------------------------------------------------
-- Sugerencias de instituciones enviadas por la comunidad desde el header
-- ("Sugerir institución"). Campos en texto plano, sin JSON.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS community_suggestions (
  id INT AUTO_INCREMENT NOT NULL,
  institution_name VARCHAR(255) NOT NULL,
  specialty VARCHAR(255) NULL,
  contact_info VARCHAR(255) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;