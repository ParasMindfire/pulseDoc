const express = require('express');
const multer = require('multer');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// ---------------------------------------------------------------------------
// Configuration (from Application Settings)
// ---------------------------------------------------------------------------
const LOGIC_APP_URL = process.env.LOGIC_APP_URL;

function getPool() {
  return new Pool({
    host: process.env.DB_HOST,
    database: process.env.DB_NAME || 'clinicworks',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    port: parseInt(process.env.DB_PORT || '5432', 10),
    // Azure Database for PostgreSQL Flexible Server requires SSL by default.
    ssl: { rejectUnauthorized: false },
  });
}

app.use(express.json());

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------
app.post('/api/upload', upload.single('document'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const fileB64 = req.file.buffer.toString('base64');
    const payload = { file_base64: fileB64, processed_by: 'user' };

    const logicRes = await fetch(LOGIC_APP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await logicRes.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/documents', async (req, res) => {
  const pool = getPool();
  try {
    const result = await pool.query(
      `SELECT document_id, document_type, measure_extracted, measure_date,
              date_processed, processed_by, processing_status, confidence_score
       FROM processed_documents ORDER BY document_id DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await pool.end();
  }
});

app.post('/api/retry/:id', async (req, res) => {
  const pool = getPool();
  try {
    const { id } = req.params;
    const result = await pool.query(
      'SELECT original_file_base64, processed_by FROM processed_documents WHERE document_id=$1',
      [id]
    );
    if (result.rows.length === 0 || !result.rows[0].original_file_base64) {
      return res.status(404).json({ error: 'Original file not found for retry.' });
    }
    const { original_file_base64, processed_by } = result.rows[0];
    const payload = { file_base64: original_file_base64, processed_by, document_id: parseInt(id, 10) };

    const logicRes = await fetch(LOGIC_APP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await logicRes.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await pool.end();
  }
});

// ---------------------------------------------------------------------------
// Serve the built React app (run `npm run build` inside client/ first)
// ---------------------------------------------------------------------------
const clientDist = path.join(__dirname, 'client', 'dist');
app.use(express.static(clientDist));
app.get('*', (req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log(`ClinicWorks server running on port ${PORT}`));
