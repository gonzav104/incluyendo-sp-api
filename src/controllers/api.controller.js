const pool = require('../config/db');

// GET /api/institutions
const getInstitutions = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM institutions');
    res.status(200).json(rows);
  } catch (error) {
    console.error('❌ Error en getInstitutions:', error.message);
    res.status(500).json({ error: 'No se pudieron obtener las instituciones' });
  }
};

// POST /api/suggestions
const createSuggestion = async (req, res) => {
  const { institution_name, specialty, contact_info } = req.body;

  if (!institution_name || !institution_name.trim()) {
    return res.status(400).json({ error: 'institution_name es obligatorio' });
  }

  try {
    await pool.query(
      'INSERT INTO community_suggestions (institution_name, specialty, contact_info) VALUES (?, ?, ?)',
      [institution_name.trim(), specialty || null, contact_info || null]
    );
    res.status(201).json({ message: 'Sugerencia recibida, ¡gracias por colaborar!' });
  } catch (error) {
    console.error('❌ Error en createSuggestion:', error.message);
    res.status(500).json({ error: 'No se pudo guardar la sugerencia' });
  }
};

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

  // 1) Contexto RAG: Inyectar DB
  let enrichedPrompt = prompt;
  try {
    const [institutions] = await pool.query('SELECT * FROM institutions LIMIT 50');
    enrichedPrompt = 'Contexto oficial de San Pedro: ' + JSON.stringify(institutions) + '\n\nConsulta del usuario: ' + prompt;
    console.log(`📚 Contexto inyectado: ${institutions.length} instituciones`);
  } catch (dbError) {
    console.error('⚠️ No se pudo obtener contexto de la DB:', dbError.message);
  }

  // 2) Mandar a n8n y atrapar la respuesta
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: enrichedPrompt }),
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

    res.status(200).json(data);

  } catch (error) {
    console.error('❌ Error en askAssistant:', error.message);
    res.status(502).json({ error: 'No se pudo leer la respuesta del asistente' });
  }
};

module.exports = { getInstitutions, createSuggestion, askAssistant };