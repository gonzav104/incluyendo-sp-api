# Incluyendo SP API

Backend For Frontend (BFF) de **Incluyendo SP** — mini-aplicación web para familias de San Pedro, Buenos Aires, que centraliza un directorio verificado de instituciones y una guía de trámites (foco: TEA y discapacidad motriz, 0-12 años).

## ¿Qué hace esta API?

Es la capa intermedia entre el frontend React y los datos/servicios externos:

1. **Expone el directorio de instituciones** guardado en MySQL (`GET /api/institutions`).
2. **Recibe sugerencias de la comunidad** (`POST /api/suggestions`): las guarda SIEMPRE en MySQL y, recién después, notifica por mail vía un webhook de n8n (el mail nunca condiciona la respuesta).
3. **Hace de proxy + enriquecedor de contexto hacia un asistente IA** en n8n (`POST /api/assistant`): arma un payload estructurado `{ systemPrompt, context, userMessage }` con el contexto real de las instituciones (columnas de mínimo privilegio, acotado a `CONTEXT_LIMIT`), de modo que la IA responda con datos reales y no alucine. El input del usuario viaja en un campo propio, aislado del contexto y del system prompt (anti prompt-injection).

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

Verificá que arrancó: `http://localhost:3000/api/health` → `{ "status": "ok", ... }` (o `503` con `"status": "degraded"` si la DB no responde).

### Variables de entorno (`.env`)

| Variable | Descripción | Default |
|---|---|---|
| `PORT` | Puerto del servidor | `3000` |
| `DB_HOST` | Host de MySQL | `localhost` |
| `DB_PORT` | Puerto de MySQL (Aiven usa puertos no estándar) | `3306` |
| `DB_USER` | Usuario de MySQL | `root` |
| `DB_PASSWORD` | Contraseña de MySQL | — |
| `DB_NAME` | Nombre de la base | `incluyendo_sp` |
| `DB_SSL` | TLS para hosts remotos (Aiven). `true/1/yes/on` (case-insensitive) → activa; cualquier otro valor → desactiva | `false` |
| `DB_CONNECTION_LIMIT` | Máximo de conexiones simultáneas del pool | `5` |
| `N8N_WEBHOOK_URL` | Webhook de n8n del asistente (recibe el payload `{ systemPrompt, context, userMessage }`) | — |
| `N8N_SUGGESTIONS_WEBHOOK_URL` | Webhook de n8n del mail de aviso de sugerencias (opcional) | — |
| `N8N_TIMEOUT_MS` | Timeout del fetch al asistente (excedido → `504`) | `20000` |
| `FRONTEND_URLS` | Orígenes CORS permitidos, coma-separada (fuente de verdad) | `http://localhost:5173` |
| `FRONTEND_URL` | **DEPRECATED** — fallback de CORS si `FRONTEND_URLS` no está seteada | — |
| `CONTEXT_LIMIT` | Máximo de instituciones inyectadas como contexto al asistente (técnica LIMIT+1 con warning de truncamiento) | `50` |
| `NODE_ENV` | `development` \| `production` | `development` |

> **CORS:** agregar un consumidor nuevo = tocar `FRONTEND_URLS`, sin redeploy de código. Prohibido `origin: true`, regex o suffix matching (permiten subdominios atacantes). Los orígenes fuera de la allowlist reciben `403` sin `Access-Control-Allow-Origin`.

## Endpoints

Todas las rutas se montan bajo `/api`. CORS habilitado para los orígenes de `FRONTEND_URLS`.

> **Trust proxy (1 hop):** Render termina TLS y reenvía a Express agregando la IP real del cliente al final de `X-Forwarded-For`. La app confía en **exactamente 1 hop** (`trust proxy: 1`), así `req.ip` —y por lo tanto el rate limit— usa la entrada **rightmost** de `X-Forwarded-For` (la que agrega el proxy). Un cliente que spoofee `X-Forwarded-For: 6.6.6.6, 203.0.113.5` NO puede crear buckets propios ni evadir el rate limit: la efectiva es `203.0.113.5`. Si en el futuro se agrega un CDN delante de Render, revisar los hops.

---

### `GET /api/institutions`

Devuelve el directorio completo de instituciones verificadas desde MySQL. Las columnas JSON (`specialties`, `address`, `coverage`, etc.) llegan como objetos, listas para consumir.

**Sin parámetros** responde el array plano exacto de siempre (contrato con el frontend — prohibido cambiar a envelope `{ data, pagination }`), más headers aditivos:
- `X-Total-Count`: cantidad total de instituciones.
- `Cache-Control: public, max-age=300`.

**Paginación opcional** (solo se activa con params):
- `limit`: default `500`, máximo `1000` (se clamp, no error). Enteros positivos.
- `offset`: default `0`. Entero positivo; más allá del total → `200` con `[]`.
- Params no numéricos, negativos o floats → `400` con error en español.

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

> **Rate limit:** máximo **10 requests cada 15 minutos por IP real** (tras proxy, la rightmost de `X-Forwarded-For`). Al superarlo responde `429`.

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

Endpoint del asistente IA. El BFF consulta la DB con **columnas explícitas de mínimo privilegio** (`id, name, type, specialties, age_range, address, coverage, services` — sin `contact`, `verification` ni metadata; verificado contra `db/schema.sql`), acota el contexto a `CONTEXT_LIMIT` (técnica `LIMIT+1`: si hay más, trunca y loguea warning — nunca truncamiento silencioso) y arma el payload estructurado que envía al webhook de n8n.

> **Rate limit:** máximo **20 requests cada 15 minutos por IP real** (protege el webhook de n8n, que tiene costo por uso). Al superarlo responde `429`.

**Request** (igual que siempre, el cambio de payload es hacia n8n, no hacia el frontend):

```json
{ "prompt": "¿Dónde puedo tramitar el CUD en San Pedro?" }
```

**Payload hacia n8n (contrato nuevo — D5 anti prompt-injection):**

```json
{
  "systemPrompt": "Sos el asistente de Incluyendo SP... (anclado, no modificable por el usuario)",
  "context": {
    "count": 50,
    "truncated": false,
    "institutions": [ { "id": "consultorios-emij", "name": "...", "type": "...", "specialties": [], "age_range": {}, "address": {}, "coverage": {}, "services": null } ]
  },
  "userMessage": "¿Dónde puedo tramitar el CUD en San Pedro?"
}
```

El input del usuario viaja **solo** en `userMessage`, nunca concatenado al contexto ni al system prompt (aislamiento estructural: un delimitador en string se puede cerrar; un campo propio no).

> **⚠️ Migración del workflow n8n (T-18 — decisión: corte directo):** el BFF ya NO envía el campo `prompt` con el texto concatenado. El workflow del asistente en n8n **DEBE migrar a leer `systemPrompt`, `context.institutions` y `userMessage` ANTES del deploy** (coordinarlo con el dueño de n8n). Si se deploya sin migrar, el asistente rompe (no encuentra `prompt`). No hay fase de transición: se eligió corte directo porque la fase de transición (enviar `prompt` legacy + campos nuevos) dejaría viva la concatenación vulnerable, que es exactamente lo que D5 elimina.

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

**Response `504`** (n8n colgado: superó `N8N_TIMEOUT_MS`, default 20s — el fetch se aborta de verdad):

```json
{ "error": "El asistente tardó demasiado en responder" }
```

**Response `500`** (sin webhook configurado):

```json
{ "error": "N8N_WEBHOOK_URL no está configurado en .env" }
```

---

### `GET /api/health` — health check honesto

Verifica la conexión real a MySQL ejecutando `SELECT 1` contra el pool con **timeout propio de 3s**. No miente:

- DB responde → `200` con `{ "status": "ok", ... }`
- DB caída o timeout > 3s → `503` con `{ "status": "degraded", ... }` — **nunca** `500` y nunca mata el proceso.

```json
{
  "status": "ok",
  "service": "incluyendo-sp-api",
  "timestamp": "2026-08-19T02:31:26.726Z",
  "uptime": 3.99,
  "environment": "development"
}
```

Render reinicia las instancias unhealthy: el `503` (en vez de exit) permite diagnóstico sin crash-loop.

## Ciclo de vida del proceso

- `SIGTERM`/`SIGINT` (deploy en Render / Ctrl+C): deja de aceptar conexiones, espera que completen las requests en vuelo, drena el pool y sale con `exit(0)`.
- Si el drenado supera los **10s**, fuerza `exit(1)`.
- `unhandledRejection`: log + drenado + `exit(1)` (estado indefinido; no resumir, pero tampoco matar en caliente).
- `uncaughtException`: log + `exit(1)` inmediato, sin drenar.
- Los paths fire-and-forget (notificación de sugerencias) llevan `.catch` propio: los handlers globales solo disparan ante bugs reales, no ante fallos operativos esperados.

## Tests

Cobertura de los 4 endpoints + seguridad + ciclo de vida + config de DB, **sin necesidad de MySQL ni n8n** (el pool de conexiones y el fetch al webhook se mockean):

```bash
npm test
```

- `test/api.test.js` — endpoints (institutions, suggestions con fire-and-forget, assistant), payload D5 a n8n, FR-SG-1 (webhook que falla → INSERT gana, sin unhandledRejection).
- `test/rate-limit.test.js` — request 21 a `/api/assistant` → `429`; request 11 a `/api/suggestions` → `429`; headers `RateLimit-Limit`.
- `test/security.test.js` — CORS allowlist (multi-origen, 403 sin ACAO, fallback, preflight maxAge 86400), sin `X-Powered-By`, `413` > 50kb, trust proxy (buckets por IP real + spoof rightmost).
- `test/health.test.js` — `200 ok` / `503 degraded` con timeout inyectado por DI.
- `test/institutions.test.js` — contrato sin params (array plano + `X-Total-Count` + `Cache-Control`), slicing, clamp, `400`, offset extremo.
- `test/assistant.test.js` — `504` timeout, `502` red caída, SQL de contexto (8 columnas, sin `SELECT *`, `LIMIT+1`), truncamiento con warning, anti-injection.
- `test/lifecycle.test.js` — shutdown con drenado, timeout de drenado → `exit(1)`, handlers de proceso.
- `test/db-config.test.js` — pool (connectionLimit 5/override + queueLimit 50, sin `acquireTimeout` — mysql2 lo ignora), `DB_SSL` normalizado, `parseBoolEnv`.

> **Ojo:** los tests silencian `console.log`/`console.error`/`console.warn` del código de producción. `node --test` corre cada archivo en un proceso hijo y comunica resultados por IPC con serialización V8: si el hijo escribe texto crudo a stdout, corrompe el pipe y el archivo falla intermitentemente con "Unable to deserialize cloned data..." ([nodejs/node#56802](https://github.com/nodejs/node/issues/56802)). No quites ese silenciamiento sin antes probar el CI en Node 22.

**CI:** GitHub Action (`.github/workflows/ci.yml`) corre `npm test` en Node 20 y 22 en cada push a `main` y en cada pull request.

## Deuda técnica post-MVP (documentada)

- **Validación con zod/joi**: se introduce al llegar el 5º endpoint con body complejo (decisión 7 del proposal).
- **pino (logging estructurado)**: single instance + logs efímeros en Render free no justifican la migración; el formato de errores ya está estandarizado y la migración es mecánica (decisión 8).
- **rate-limit-redis**: prerequisito de multi-instancia; hoy 1 instancia → store en memoria correcto (decisión 9).
- **`query_timeout` de MySQL**: el wrapper de timeout no cancela queries en vuelo (la conexión queda ocupada); la espera ya está acotada por `queueLimit` (50) + los timeouts de request (health 3s, n8n 20s/5s). Si se escala, evaluar `max_execution_time`/`query_timeout` (decisión 4 del design).
- **Timeout de adquisición de conexión**: mysql2 3.23.3 **ignora `acquireTimeout`** (emite warning en cada arranque); por eso `db.js` NO la pasa. Evaluamos un `withTimeout` sobre `pool.getConnection()` y lo descartamos para el tamaño actual: el timeout no cancela la adquisición pendiente (la petición queda en la cola interna y se resuelve tarde igual) y `queueLimit 50` ya hace fallar `getConnection()` de inmediato si la cola se llena. Si el BFF escala a varios frontends, revisitar con un pool por tenant o `mysql2` con soporte real de adquisición.
- **Envelope de paginación `{ data, pagination }`**: postergado — rompe el frontend. Los headers aditivos (`X-Total-Count`) son el camino actual.

## Frontend consumidor

Este BFF es consumido por el frontend **IncluyendoSP** (React + Vite, repositorio hermano en `../IncluyendoSP`):

- `src/hooks/useInstitutions.js` → `GET /api/institutions` (con fallback al JSON local si la API no responde)
- `src/hooks/useAssistant.js` → `POST /api/assistant`
- `src/components/SuggestionModal.jsx` → `POST /api/suggestions`

El frontend apunta a la API mediante la variable `VITE_API_URL` (default en desarrollo: `http://localhost:3000`).