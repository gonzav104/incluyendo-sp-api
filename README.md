# Incluyendo SP API

Backend For Frontend (BFF) de **Incluyendo SP** — mini-aplicación web para familias de San Pedro, Buenos Aires, que centraliza un directorio verificado de instituciones y una guía de trámites (foco: TEA y discapacidad motriz, 0-12 años).

## ¿Qué hace esta API?

Es la capa intermedia entre el frontend React y los datos/servicios externos:

1. **Expone el directorio de instituciones** guardado en MySQL (`GET /api/institutions`).
2. **Recibe sugerencias de la comunidad** (`POST /api/suggestions`): las guarda SIEMPRE en MySQL y, recién después, notifica por mail vía un webhook de n8n (el mail nunca condiciona la respuesta).
3. **Hace de proxy + enriquecedor de contexto hacia un asistente IA** en n8n (`POST /api/assistant`): inyecta el contexto de las instituciones de la base en el prompt antes de reenviarlo al webhook, para que la IA responda con datos reales y no alucine.

## Stack

| Capa | Tecnología |
|---|---|
| Servidor | [Express](https://expressjs.com/) 5 |
| Base de datos | [MySQL](https://www.mysql.com/) con [mysql2](https://github.com/sidorares/node-mysql2) (pool de conexiones) |
| Asistente IA | [n8n](https://n8n.io/) vía webhook (flujo externo) |
| CORS / entorno | `cors` + `dotenv` |
| Tests | [node:test](https://nodejs.org/api/test.html) (built-in) + [supertest](https://github.com/ladjs/supertest) |

## Instalación

Requisitos: **Node.js 18+** y **MySQL** corriendo localmente.

```bash
# 1) Instalar dependencias
npm install

# 2) Crear el archivo de entorno
cp .env.example .env
#    → completá DB_USER, DB_PASSWORD y N8N_WEBHOOK_URL con tus valores reales

# 3) Crear la base y las tablas (incluyendo_sp)
mysql -u tu_usuario -p < db/schema.sql

# 4) Cargar las instituciones iniciales (idempotente: actualiza por id, no duplica)
npm run seed

# 5) Levantar el servidor en modo desarrollo
npm run dev
```

Verificá que arrancó: `http://localhost:3000/api/health` → `{ "status": "ok", ... }`

### Variables de entorno (`.env`)

| Variable | Descripción |
|---|---|
| `PORT` | Puerto del servidor (default: `3000`) |
| `DB_HOST` | Host de MySQL (default: `localhost`) |
| `DB_USER` | Usuario de MySQL |
| `DB_PASSWORD` | Contraseña de MySQL |
| `DB_NAME` | Nombre de la base (default: `incluyendo_sp`) |
| `N8N_WEBHOOK_URL` | URL del webhook de n8n que recibe el prompt enriquecido |
| `N8N_SUGGESTIONS_WEBHOOK_URL` | URL del webhook de n8n que dispara el mail de aviso de sugerencias (opcional: si no está, la sugerencia igual se guarda en MySQL) |
| `NODE_ENV` | `development` \| `production` |

## Endpoints

Todas las rutas se montan bajo `/api`. CORS habilitado para el frontend en desarrollo.

---

### `GET /api/institutions`

Devuelve el directorio completo de instituciones verificadas desde MySQL. Las columnas JSON (`specialties`, `address`, `coverage`, etc.) llegan como objetos, listas para consumir.

**Response `200`** (array de instituciones):

```json
[
  {
    "id": "consultorios-emij",
    "name": "Consultorios EMIJ",
    "type": "centro-educativo-terapeutico",
    "specialties": ["tea", "discapacidad-motriz", "fonoaudiologia", "psicopedagogia"],
    "age_range": { "min": 0, "max": 12 },
    "address": {
      "street": "Almafuerte 530",
      "neighborhood": null,
      "city": "San Pedro",
      "postal_code": "2930",
      "coordinates": { "lat": -33.6785792, "lng": -59.6613711 }
    },
    "contact": { "phone": "+54 3329 56-0912", "email": "consultoriosemij@hotmail.com" },
    "coverage": { "cud": "yes", "accepted_plans": ["IOMA", "OSDE", "Galeno"] },
    "accessibility": { "wheelchair_ramp": false, "adapted_bathroom": false, "elevator": false, "signage_simplified": false },
    "verification": { "status": "verified", "verified_at": "2026-08-18", "source": "Relevamiento local" }
  }
]
```

**Response `500`**:

```json
{ "error": "No se pudieron obtener las instituciones" }
```

---

### `POST /api/suggestions`

Guarda una sugerencia de institución enviada por la comunidad (formulario "Sugerir institución" del frontend). Solo `institution_name` es obligatorio.

**Flujo híbrido:**
1. El BFF inserta la sugerencia en `community_suggestions` (MySQL).
2. **Recién después** del insert exitoso, notifica al webhook `N8N_SUGGESTIONS_WEBHOOK_URL` (n8n dispara un mail de aviso). Esta llamada es *fire-and-forget*: si n8n falla, solo se loguea el error — **la respuesta al usuario depende únicamente del INSERT**.

> **Rate limit:** máximo **10 requests cada 15 minutos por IP**. Al superarlo responde `429`.

**Request:**

```json
{
  "institution_name": "Jardín de Infantes Nº 903",
  "specialty": "estimulación temprana",
  "contact_info": "03329 42-0000"
}
```

**Response `201`** (éxito — el INSERT se realizó):

```json
{ "message": "Sugerencia recibida, ¡gracias por colaborar!" }
```

**Response `400`** (falta `institution_name`):

```json
{ "error": "institution_name es obligatorio" }
```

**Response `429`** (rate limit superado):

```json
{ "error": "Demasiadas sugerencias. Esperá unos minutos y probá de nuevo." }
```

**Response `500`** (error de base):

```json
{ "error": "No se pudo guardar la sugerencia" }
```

---

### `POST /api/assistant`

Endpoint del asistente IA. El BFF arma un prompt enriquecido con el contexto real de las instituciones (`SELECT * FROM institutions LIMIT 50`), lo envía al webhook de n8n y devuelve la respuesta del flujo.

> **Rate limit:** máximo **20 requests cada 15 minutos por IP** (protege el webhook de n8n, que tiene costo por uso). Al superarlo responde `429`.

**Request:**

```json
{ "prompt": "¿Dónde puedo tramitar el CUD en San Pedro?" }
```

**Response `200`** (lo que responda el flujo de n8n — se reenvía tal cual; si n8n manda texto crudo, se envuelve en `output`):

```json
{ "output": "El CUD se tramita en el Hospital Subzonal General San Pedro (25 de Mayo 1901)..." }
```

**Response `400`** (falta `prompt`):

```json
{ "error": "prompt es obligatorio" }
```

**Response `429`** (rate limit superado):

```json
{ "error": "Demasiadas solicitudes al asistente. Esperá unos minutos y probá de nuevo." }
```

**Response `502`** (n8n no disponible o respondió con error):

```json
{ "error": "El asistente falló en n8n" }
```

**Response `500`** (sin webhook configurado):

```json
{ "error": "N8N_WEBHOOK_URL no está configurado en .env" }
```

---

### `GET /api/health` (bonus)

Health check simple para verificar que el servicio y la conexión a MySQL están vivos:

```json
{
  "status": "ok",
  "service": "incluyendo-sp-api",
  "timestamp": "2026-08-19T02:31:26.726Z",
  "uptime": 3.99,
  "environment": "development"
}
```

## Tests

Cobertura de los 3 endpoints + rate limit, **sin necesidad de MySQL ni n8n** (el pool de conexiones y el fetch al webhook se mockean):

```bash
npm test
```

- `test/api.test.js` — GET /api/institutions (200 + normalización JSON, 500), POST /api/suggestions (400, 201, 500, notificación a n8n con los 4 campos, 201 aunque n8n falle, sin webhook no llama), POST /api/assistant (400, 500 sin webhook, 502, 200, texto crudo).
- `test/rate-limit.test.js` — el request 21 a `/api/assistant` responde `429`; el request 11 a `/api/suggestions` responde `429`; verifica los headers `RateLimit-Limit`.

> **Ojo:** los tests silencian `console.log`/`console.error` del código de producción. `node --test` corre cada archivo en un proceso hijo y comunica resultados por IPC con serialización V8: si el hijo escribe texto crudo a stdout, corrompe el pipe y el archivo falla intermitentemente con "Unable to deserialize cloned data..." ([nodejs/node#56802](https://github.com/nodejs/node/issues/56802)). No quites ese silenciamiento sin antes probar el CI en Node 22.

**CI:** GitHub Action (`.github/workflows/ci.yml`) corre `npm test` en Node 20 y 22 en cada push a `main` y en cada pull request.

## Frontend consumidor

Este BFF es consumido por el frontend **IncluyendoSP** (React + Vite, repositorio hermano en `../IncluyendoSP`):

- `src/hooks/useInstitutions.js` → `GET /api/institutions` (con fallback al JSON local si la API no responde)
- `src/hooks/useAssistant.js` → `POST /api/assistant`
- `src/components/SuggestionModal.jsx` → `POST /api/suggestions`

El frontend apunta a la API mediante la variable `VITE_API_URL` (default en desarrollo: `http://localhost:3000`).