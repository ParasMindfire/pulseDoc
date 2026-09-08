const { app } = require('@azure/functions');
const { Pool } = require('pg');
const { GoogleGenAI } = require('@google/genai');

// ---------------------------------------------------------------------------
// Configuration (all pulled from Application Settings - never hardcode these)
// ---------------------------------------------------------------------------
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = 'gemini-3.6-flash'; // free tier, natively reads PDFs (text or scanned)

function getPool() {
  return new Pool({
    host: process.env.DB_HOST,
    database: process.env.DB_NAME || 'clinicworks',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    port: parseInt(process.env.DB_PORT || '5432', 10),
    // Azure Database for PostgreSQL Flexible Server requires SSL by default.
    // rejectUnauthorized: false skips CA chain validation for simplicity here -
    // fine for this assignment, though a production setup would supply Azure's
    // actual CA certificate instead.
    ssl: { rejectUnauthorized: false },
  });
}

// ---------------------------------------------------------------------------
// Gemini call - PDF is sent directly, no local text-extraction or OCR needed.
// Gemini's native document understanding reads both selectable-text and
// scanned/image PDFs in the same call.
// ---------------------------------------------------------------------------
const EXTRACTION_INSTRUCTIONS = `You are extracting clinical data from a document (Blood Pressure and/or HbA1c results). The document may be a scanned image or a normal text PDF - read it either way.

Return ONLY valid JSON, no other text, in this exact shape:
{
  "patient_age": <number or null>,
  "readings": [
    {
      "type": "BP" or "A1C",
      "value": "138/88" (for BP) or "7.4" (for A1C, number only, no % sign),
      "date": "YYYY-MM-DD" or null if no date is associated,
      "is_goal_or_target_or_past": true or false,
      "raw_context": "short quote of the surrounding text"
    }
  ]
}

Rules for you to follow while extracting (do NOT filter results out - list everything, we filter later):
- Include every BP and HbA1c value mentioned, even if it looks like a goal, target, past, or reference-range value.
  Just set "is_goal_or_target_or_past": true for those so we can exclude them downstream.
- Do not invent a value that isn't in the document. If age is not stated, patient_age is null.
- If you cannot find any BP or HbA1c readings, return an empty "readings" list.`;

async function extractWithGemini(pdfBase64) {
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [
      { text: EXTRACTION_INSTRUCTIONS },
      { inlineData: { mimeType: 'application/pdf', data: pdfBase64 } },
    ],
    config: {
      responseMimeType: 'application/json',
    },
  });
  return JSON.parse(response.text);
}

// ---------------------------------------------------------------------------
// Business rules (centralized here so new measure types can be added later
// without touching the Web App or Logic App)
// ---------------------------------------------------------------------------
function applyBpRules(readings, age) {
  if (age != null && age < 18) {
    return { result: null, error: 'Excluded: patient under 18' };
  }

  const candidates = readings.filter((r) => r.type === 'BP' && !r.is_goal_or_target_or_past);

  const valid = [];
  for (const r of candidates) {
    const m = /^\s*(\d{2,3})\s*\/\s*(\d{2,3})\s*$/.exec(String(r.value ?? ''));
    if (m) {
      r._systolic = parseInt(m[1], 10);
      r._diastolic = parseInt(m[2], 10);
      valid.push(r);
    }
  }

  if (valid.length === 0) {
    return { result: null, error: 'No valid current BP reading with both systolic and diastolic found' };
  }

  const dated = valid.filter((r) => r.date);
  if (dated.length > 0) {
    dated.sort((a, b) => (a.date < b.date ? 1 : -1));
    return { result: dated[0], error: null };
  }

  valid.sort((a, b) => a._systolic + a._diastolic - (b._systolic + b._diastolic));
  return { result: valid[0], error: null };
}

function classifyA1c(value) {
  if (value > 5.9) return 'Diabetes';
  if (value > 5.7) return 'Prediabetes';
  return null;
}

function applyA1cRules(readings) {
  const candidates = readings.filter((r) => r.type === 'A1C' && !r.is_goal_or_target_or_past);

  const valid = [];
  for (const r of candidates) {
    const val = parseFloat(String(r.value ?? '').replace('%', '').trim());
    if (!Number.isNaN(val)) {
      r._value = val;
      valid.push(r);
    }
  }

  if (valid.length === 0) {
    return { result: null, error: 'No valid current HbA1c reading found' };
  }

  valid.sort((a, b) => a._value - b._value);
  return { result: valid[0], error: null };
}

function computeConfidence(extractionOk, fieldsComplete, formatValid, businessRuleValid) {
  let score = 0;
  if (extractionOk) score += 25;
  if (fieldsComplete) score += 25;
  if (formatValid) score += 25;
  if (businessRuleValid) score += 25;
  return score;
}

// ---------------------------------------------------------------------------
// HTTP entry point - the Logic App calls this
// ---------------------------------------------------------------------------
app.http('process-document', {
  methods: ['POST'],
  authLevel: 'function',
  handler: async (request, context) => {
    let body;
    const pool = getPool();
    try {
      body = await request.json();
      const fileB64 = body.file_base64;
      const processedBy = body.processed_by || 'user';
      let documentId = body.document_id || null;

      // Gemini reads the PDF directly - no local text extraction, no OCR
      // library, no page-rendering needed. Handles selectable-text and
      // scanned PDFs in the same call.
      const extraction = await extractWithGemini(fileB64);

      const extractionOk = Array.isArray(extraction.readings);
      const age = extraction.patient_age ?? null;
      const readings = extraction.readings || [];

      const bp = applyBpRules(readings, age);
      const a1c = applyA1cRules(readings);

      let docType = null;
      let measure = null;
      let measureDate = null;
      let status;
      let errorMessage = null;
      let fieldsComplete = false;
      let formatValid = false;
      let businessRuleValid = false;

      if (bp.result) {
        docType = 'BP';
        measure = `${bp.result._systolic}/${bp.result._diastolic}`;
        measureDate = bp.result.date || null;
        status = 'Success';
        fieldsComplete = formatValid = businessRuleValid = true;
      } else if (a1c.result) {
        docType = 'A1C';
        const cls = classifyA1c(a1c.result._value);
        measure = cls ? `${a1c.result._value} (${cls})` : `${a1c.result._value}`;
        measureDate = a1c.result.date || null;
        status = 'Success';
        fieldsComplete = formatValid = businessRuleValid = true;
      } else {
        status = 'Needs Review';
        errorMessage = bp.error || a1c.error || 'Could not reliably identify a measure';
      }

      const confidence = computeConfidence(extractionOk, fieldsComplete, formatValid, businessRuleValid);
      if (confidence < 50 && status === 'Success') status = 'Needs Review';

      if (documentId) {
        await pool.query(
          `UPDATE processed_documents SET
             document_type=$1, measure_extracted=$2, measure_date=$3,
             date_processed=now(), processed_by=$4, processing_status=$5,
             error_message=$6, confidence_score=$7
           WHERE document_id=$8`,
          [docType, measure, measureDate, processedBy, status, errorMessage, confidence, documentId]
        );
      } else {
        const insertResult = await pool.query(
          `INSERT INTO processed_documents
             (document_type, measure_extracted, measure_date, processed_by,
              processing_status, error_message, confidence_score, original_file_base64)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING document_id`,
          [docType, measure, measureDate, processedBy, status, errorMessage, confidence, fileB64]
        );
        documentId = insertResult.rows[0].document_id;
      }

      await pool.end();

      return {
        status: 200,
        jsonBody: {
          document_id: documentId,
          document_type: docType,
          measure,
          status,
          confidence,
          error_message: errorMessage,
        },
      };
    } catch (err) {
      context.error('processing failed', err);
      let documentId = null;
      try {
        const insertResult = await pool.query(
          `INSERT INTO processed_documents (processing_status, error_message, processed_by, original_file_base64)
           VALUES ($1,$2,$3,$4) RETURNING document_id`,
          ['Failed', String(err.message || err), body?.processed_by || 'user', body?.file_base64 || null]
        );
        documentId = insertResult.rows[0].document_id;
      } catch (logErr) {
        context.error('also failed to log the failure to the database', logErr);
      }
      try {
        await pool.end();
      } catch (_) {
        // pool already closed or never opened successfully - safe to ignore
      }
      return {
        status: 500,
        jsonBody: { status: 'Failed', error: String(err.message || err), document_id: documentId },
      };
    }
  },
});
