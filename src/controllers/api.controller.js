const pool = require('../config/db');
const { CONTEXT_COLUMNS, SYSTEM_PROMPT } = require('../lib/helpers');

// Las columnas JSON de la tabla institutions: Aiven/schema actual las define
// como JSON nativo (mysql2 las devuelve como objetos), mientras que una versión
// local intermedia las tuvo como longtext + CHECK(json_valid) (strings).
// parseInstitution es compatible con ambos: typeof string → parse; objeto → pasa.
const JSON_COLUMNS = [
  'specialties',
  'age_range',
  'address',
  'contact',
  'coverage',
  'accessibility',
  'services',
  'verification',
];

const parseInstitution = (row) => {
  const parsed = { ...row };
  for (const col of JSON_COLUMNS) {
    if (typeof parsed[col] === 'string') {
      try {
        parsed[col] = JSON.parse(parsed[col]);
      } catch (error) {
        // W8: nunca null silencioso — logueamos con contexto para poder debuggear
        console.error(`⚠️ Columna JSON inválida en institución ${parsed.id} (${col}): ${error.message}`);
        parsed[col] = null;
      }
    }
  }
  return parsed;
};

// W14/FR-IN-2: parseo estricto de paginación. Enteros positivos solamente;
// limit default 500 con clamp a 1000; offset default 0. NaN/negativo/float → 400.
const parsePagination = (query) => {
  let limit = 500;
  let offset = 0;

  if (query.limit !== undefined) {
    if (!/^\d+$/.test(query.limit)) {
      return { error: 'limit debe ser un entero positivo' };
    }
    limit = Number(query.limit);
    if (limit <= 0) return { error: 'limit debe ser un entero positivo' };
    if (limit > 1000) limit = 1000;
  }

  if (query.offset !== undefined) {
    if (!/^\d+$/.test(query.offset)) {
      return { error: 'offset debe ser un entero positivo' };
    }
    offset = Number(query.offset);
  }

  return { limit, offset };
};

// GET /api/institutions
// FR-IN-1: sin params devuelve el array plano exacto de siempre (SELECT *
// conservado: es contrato con el frontend) + X-Total-Count + Cache-Control.
// FR-IN-2/3: con params → COUNT (total real sin paginar) + SELECT con LIMIT/OFFSET.
const getInstitutions = async (req, res) => {
  try {
    // Cache aditivo: aplica siempre, con y sin params (D6).
    res.set('Cache-Control', 'public, max-age=300');

    const hasParams = req.query.limit !== undefined || req.query.offset !== undefined;
    if (!hasParams) {
      const [rows] = await pool.query('SELECT * FROM institutions');
      res.set('X-Total-Count', String(rows.length));
      return res.status(200).json(rows.map(parseInstitution));
    }

    const pagination = parsePagination(req.query);
    if (pagination.error) {
      return res.status(400).json({ error: pagination.error });
    }

    const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM institutions');
    const [rows] = await pool.query('SELECT * FROM institutions LIMIT ? OFFSET ?', [
      pagination.limit,
      pagination.offset,
    ]);

    res.set('X-Total-Count', String(total));
    return res.status(200).json(rows.map(parseInstitution));
  } catch (error) {
    console.error('❌ Error en getInstitutions:', error.message);
    return res.status(500).json({ error: 'No se pudieron obtener las instituciones' });
  }
};

// POST /api/suggestions
const createSuggestion = async (req, res) => {
  const { institution_name, specialty, contact_info } = req.body;

  if (!institution_name || !institution_name.trim()) {
    return res.status(400).json({ error: 'institution_name es obligatorio' });
  }

  // 1) El INSERT es lo único que determina la respuesta al usuario.
  try {
    await pool.query(
      'INSERT INTO community_suggestions (institution_name, specialty, contact_info) VALUES (?, ?, ?)',
      [institution_name.trim(), specialty || null, contact_info || null]
    );
  } catch (error) {
    console.error('❌ Error en createSuggestion:', error.message);
    return res.status(500).json({ error: 'No se pudo guardar la sugerencia' });
  }

  // 2) Recién después del INSERT exitoso, notificamos por mail vía n8n.
  //    Fire-and-forget: nunca cambia el status code ni el mensaje de la
  //    respuesta al frontend. Si n8n falla, solo logueamos — la sugerencia
  //    ya quedó guardada en MySQL.
  const webhookUrl = process.env.N8N_SUGGESTIONS_WEBHOOK_URL;
  if (webhookUrl) {
    notifySuggestionWebhook(webhookUrl, {
      institution_name: institution_name.trim(),
      specialty: specialty || null,
      contact_info: contact_info || null,
      created_at: new Date().toISOString(),
    });
  }

  res.status(201).json({ message: 'Sugerencia recibida, ¡gracias por colaborar!' });
};

// Notificación de sugerencia a n8n (dispara el mail de aviso). Fire-and-forget:
// se ejecuta en background, con timeout de 5s, y solo loguea errores.
const notifySuggestionWebhook = (webhookUrl, payload) => {
  fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000),
  })
    .then(async (response) => {
      if (!response.ok) {
        console.error('❌ n8n (sugerencias) respondió con estado:', response.status);
        return;
      }
      console.log('📧 Sugerencia notificada a n8n (mail)');
    })
    .catch((error) => {
      console.error('❌ No se pudo notificar la sugerencia a n8n:', error.message);
    });
};

// D5 (anti-injection): el payload a n8n viaja con campos separados. El input
// del usuario NUNCA se concatena al contexto ni al system prompt: aislamiento
// estructural (un delimitador en string se puede cerrar; un campo propio no).
const buildAssistantPayload = (userMessage, institutions, truncated) => ({
  systemPrompt: SYSTEM_PROMPT,
  context: {
    count: institutions.length,
    truncated,
    institutions,
  },
  userMessage,
});

// POST /api/assistant
const askAssistant = async (req, res) => {
  const { prompt } = req.body;

  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ error: 'prompt es obligatorio' });
  }

  const webhookUrl = process.env.N8N_WEBHOOK_URL;
  if (!webhookUrl) {
    return res.status(500).json({ error: 'N8N_WEBHOOK_URL no está configurado en .env' });
  }

  // 1) Contexto RAG: SELECT con columnas explícitas (W9, mínimo privilegio) y
  //    CONTEXT_LIMIT con técnica LIMIT+1 (FR-AA-3): si hay más resultados, se
  //    truncan y se loguea — nunca truncamiento silencioso.
  let institutions = [];
  let truncated = false;
  try {
    const contextLimit = Number(process.env.CONTEXT_LIMIT) || 50;
    const [rows] = await pool.query(
      `SELECT ${CONTEXT_COLUMNS.join(', ')} FROM institutions LIMIT ?`,
      [contextLimit + 1]
    );
    if (rows.length > contextLimit) {
      truncated = true;
      console.warn(`⚠️ Contexto truncado a ${contextLimit} instituciones`);
      institutions = rows.slice(0, contextLimit).map(parseInstitution);
    } else {
      institutions = rows.map(parseInstitution);
    }
    console.log(`📚 Contexto inyectado: ${institutions.length} instituciones`);
  } catch (dbError) {
    console.error('⚠️ No se pudo obtener contexto de la DB:', dbError.message);
  }

  // 2) Mandar a n8n y atrapar la respuesta
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildAssistantPayload(prompt, institutions, truncated)),
      // C2/FR-AA-1: timeout real que cancela el fetch (N8N_TIMEOUT_MS, default 20s)
      signal: AbortSignal.timeout(Number(process.env.N8N_TIMEOUT_MS) || 20000),
    });

    if (!response.ok) {
      console.error('❌ n8n respondió con estado:', response.status);
      return res.status(502).json({ error: 'El asistente falló en n8n' });
    }

    // Leemos la respuesta de n8n
    const rawText = await response.text();
    console.log('📦 Respuesta de n8n:', rawText.substring(0, 50) + '...'); // Mostramos solo el principio para no saturar

    if (!rawText || rawText.trim() === '') {
        throw new Error('n8n devolvió un texto vacío.');
    }

    // EL PARSER INDESTRUCTIBLE:
    let data;
    try {
      // Intentamos leerlo como JSON
      data = JSON.parse(rawText);
    } catch (e) {
      // Si falla, significa que n8n mandó texto crudo, así que lo convertimos a JSON nosotros
      data = { output: rawText };
    }

    return res.status(200).json(data);

  } catch (error) {
    // AbortError (mock) o TimeoutError (AbortSignal.timeout real) → 504.
    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
      console.error('⏱️ Timeout del asistente n8n:', error.message);
      return res.status(504).json({ error: 'El asistente tardó demasiado en responder' });
    }
    console.error('❌ Error en askAssistant:', error.message);
    return res.status(502).json({ error: 'No se pudo leer la respuesta del asistente' });
  }
};

module.exports = { getInstitutions, createSuggestion, askAssistant };