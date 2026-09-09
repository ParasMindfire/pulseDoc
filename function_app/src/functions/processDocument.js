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
    database: process.env.DB_NAME || 'pulsedoc',
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
const EXTRACTION_INSTRUCTIONS = `You are extracting clinical data from a document (Blood Pressure, HbA1c, and/or LDL Cholesterol results). The document may be a scanned image or a normal text PDF - read it either way.

Return ONLY valid JSON, no other text, in this exact shape:
{
  "patient_age": <number or null>,
  "readings": [
    {
      "type": "BP" or "A1C" or "LDL",
      "value": "138/88" (for BP) or "7.4" (for A1C, number only, no % sign) or "142" (for LDL, mg/dL number only),
      "date": "YYYY-MM-DD" or null if no date is associated,
      "is_goal_or_target_or_past": true or false,
      "raw_context": "short quote of the surrounding text"
    }
  ]
}

Rules for you to follow while extracting (do NOT filter results out - list everything, we filter later):
- Include every BP, HbA1c, and LDL Cholesterol value mentioned, even if it looks like a goal, target, past, or reference-range value.
  Just set "is_goal_or_target_or_past": true for those so we can exclude them downstream.
- Do not invent a value that isn't in the document. If age is not stated, patient_age is null.
- If you cannot find any BP, HbA1c, or LDL readings, return an empty "readings" list.`;

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
// without touching the Web App or Logic App). Each rule function returns
// { result, error, audit } - `audit` is a human-readable trail of what was
// included/excluded and why, surfaced later in the UI for transparency.
// ---------------------------------------------------------------------------
function applyBpRules(readings, age) {
  const audit = [];

  if (age != null && age < 18) {
    audit.push(`Patient age ${age} is under 18 - BP readings excluded by age rule.`);
    return { result: null, error: 'Excluded: patient under 18', audit };
  }

  const bpReadings = readings.filter((r) => r.type === 'BP');
  const goalExcluded = bpReadings.filter((r) => r.is_goal_or_target_or_past);
  const candidates = bpReadings.filter((r) => !r.is_goal_or_target_or_past);
  if (goalExcluded.length > 0) {
    audit.push(`Excluded ${goalExcluded.length} BP reading(s) flagged as goal/target/past value.`);
  }

  const valid = [];
  const malformed = [];
  for (const r of candidates) {
    const m = /^\s*(\d{2,3})\s*\/\s*(\d{2,3})\s*$/.exec(String(r.value ?? ''));
    if (m) {
      r._systolic = parseInt(m[1], 10);
      r._diastolic = parseInt(m[2], 10);
      valid.push(r);
    } else {
      malformed.push(r);
    }
  }
  if (malformed.length > 0) {
    audit.push(`Excluded ${malformed.length} BP reading(s) with an unparseable systolic/diastolic format.`);
  }

  if (valid.length === 0) {
    return { result: null, error: 'No valid current BP reading with both systolic and diastolic found', audit };
  }

  const dated = valid.filter((r) => r.date);
  if (dated.length > 0) {
    dated.sort((a, b) => (a.date < b.date ? 1 : -1));
    audit.push(
      dated.length > 1
        ? `${dated.length} dated BP readings found - selected the most recent (${dated[0].date}).`
        : `Selected the single dated BP reading (${dated[0].date}).`
    );
    return { result: dated[0], error: null, audit };
  }

  valid.sort((a, b) => a._systolic + a._diastolic - (b._systolic + b._diastolic));
  audit.push(`No dated BP readings - selected the lowest-value reading among ${valid.length} undated candidate(s).`);
  return { result: valid[0], error: null, audit };
}

function classifyA1c(value) {
  if (value > 5.9) return 'Diabetes';
  if (value > 5.7) return 'Prediabetes';
  return null;
}

function applyA1cRules(readings) {
  const audit = [];

  const a1cReadings = readings.filter((r) => r.type === 'A1C');
  const goalExcluded = a1cReadings.filter((r) => r.is_goal_or_target_or_past);
  const candidates = a1cReadings.filter((r) => !r.is_goal_or_target_or_past);
  if (goalExcluded.length > 0) {
    audit.push(`Excluded ${goalExcluded.length} HbA1c reading(s) flagged as goal/target/past value.`);
  }

  const valid = [];
  const malformed = [];
  for (const r of candidates) {
    const val = parseFloat(String(r.value ?? '').replace('%', '').trim());
    if (!Number.isNaN(val)) {
      r._value = val;
      valid.push(r);
    } else {
      malformed.push(r);
    }
  }
  if (malformed.length > 0) {
    audit.push(`Excluded ${malformed.length} HbA1c reading(s) with an unparseable numeric value.`);
  }

  if (valid.length === 0) {
    return { result: null, error: 'No valid current HbA1c reading found', audit };
  }

  valid.sort((a, b) => a._value - b._value);
  audit.push(
    valid.length > 1
      ? `${valid.length} valid HbA1c readings found - selected the lowest value (${valid[0]._value}).`
      : `Selected the single valid HbA1c reading (${valid[0]._value}).`
  );
  return { result: valid[0], error: null, audit };
}

// LDL Cholesterol - added as a demonstration of the "centralize logic so
// additional measures can be added later" design goal. This is a brand new
// case: it required no changes to the Web App, Logic App, or database
// contract beyond the generic columns that already existed for BP/A1C.
function classifyLdl(value) {
  if (value >= 190) return 'Very High';
  if (value >= 160) return 'High';
  if (value >= 130) return 'Borderline High';
  if (value >= 100) return 'Near Optimal';
  return 'Optimal';
}

function applyLdlRules(readings) {
  const audit = [];

  const ldlReadings = readings.filter((r) => r.type === 'LDL');
  const goalExcluded = ldlReadings.filter((r) => r.is_goal_or_target_or_past);
  const candidates = ldlReadings.filter((r) => !r.is_goal_or_target_or_past);
  if (goalExcluded.length > 0) {
    audit.push(`Excluded ${goalExcluded.length} LDL reading(s) flagged as goal/target/past value.`);
  }

  const valid = [];
  const malformed = [];
  for (const r of candidates) {
    const val = parseFloat(String(r.value ?? '').replace(/mg\/dl/i, '').trim());
    if (!Number.isNaN(val)) {
      r._value = val;
      valid.push(r);
    } else {
      malformed.push(r);
    }
  }
  if (malformed.length > 0) {
    audit.push(`Excluded ${malformed.length} LDL reading(s) with an unparseable numeric value.`);
  }

  if (valid.length === 0) {
    return { result: null, error: 'No valid current LDL cholesterol reading found', audit };
  }

  const dated = valid.filter((r) => r.date);
  if (dated.length > 0) {
    dated.sort((a, b) => (a.date < b.date ? 1 : -1));
    audit.push(
      dated.length > 1
        ? `${dated.length} dated LDL readings found - selected the most recent (${dated[0].date}).`
        : `Selected the single dated LDL reading (${dated[0].date}).`
    );
    return { result: dated[0], error: null, audit };
  }

  valid.sort((a, b) => a._value - b._value);
  audit.push(`No dated LDL readings - selected the lowest-value reading among ${valid.length} undated candidate(s).`);
  return { result: valid[0], error: null, audit };
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
    let rawExtraction = null;
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
      rawExtraction = extraction;

      const extractionOk = Array.isArray(extraction.readings);
      const age = extraction.patient_age ?? null;
      const readings = extraction.readings || [];

      const bp = applyBpRules(readings, age);
      const a1c = applyA1cRules(readings);
      const ldl = applyLdlRules(readings);

      let docType = null;
      let measure = null;
      let measureDate = null;
      let status;
      let errorMessage = null;
      let fieldsComplete = false;
      let formatValid = false;
      let businessRuleValid = false;
      let ruleAudit = [];

      if (bp.result) {
        docType = 'BP';
        measure = `${bp.result._systolic}/${bp.result._diastolic}`;
        measureDate = bp.result.date || null;
        status = 'Success';
        fieldsComplete = formatValid = businessRuleValid = true;
        ruleAudit = bp.audit;
      } else if (a1c.result) {
        docType = 'A1C';
        const cls = classifyA1c(a1c.result._value);
        measure = cls ? `${a1c.result._value} (${cls})` : `${a1c.result._value}`;
        measureDate = a1c.result.date || null;
        status = 'Success';
        fieldsComplete = formatValid = businessRuleValid = true;
        ruleAudit = a1c.audit;
      } else if (ldl.result) {
        docType = 'LDL';
        const cls = classifyLdl(ldl.result._value);
        measure = `${ldl.result._value} mg/dL (${cls})`;
        measureDate = ldl.result.date || null;
        status = 'Success';
        fieldsComplete = formatValid = businessRuleValid = true;
        ruleAudit = ldl.audit;
      } else {
        status = 'Needs Review';
        errorMessage = bp.error || a1c.error || ldl.error || 'Could not reliably identify a measure';
        ruleAudit = [...bp.audit, ...a1c.audit, ...ldl.audit];
      }

      const confidenceBreakdown = {
        extraction: extractionOk,
        fields: fieldsComplete,
        format: formatValid,
        businessRule: businessRuleValid,
      };
      const confidence = computeConfidence(extractionOk, fieldsComplete, formatValid, businessRuleValid);
      if (confidence < 50 && status === 'Success') status = 'Needs Review';

      const auditTrail = [
        `Gemini extracted ${readings.length} reading(s) from the document (patient age: ${age ?? 'not stated'}).`,
        ...ruleAudit,
      ];

      if (documentId) {
        await pool.query(
          `UPDATE processed_documents SET
             document_type=$1, measure_extracted=$2, measure_date=$3,
             date_processed=now(), processed_by=$4, processing_status=$5,
             error_message=$6, confidence_score=$7, confidence_breakdown=$8,
             audit_trail=$9, raw_extraction=$10
           WHERE document_id=$11`,
          [
            docType, measure, measureDate, processedBy, status, errorMessage, confidence,
            JSON.stringify(confidenceBreakdown), JSON.stringify(auditTrail), JSON.stringify(rawExtraction),
            documentId,
          ]
        );
      } else {
        const insertResult = await pool.query(
          `INSERT INTO processed_documents
             (document_type, measure_extracted, measure_date, processed_by,
              processing_status, error_message, confidence_score, original_file_base64,
              confidence_breakdown, audit_trail, raw_extraction)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING document_id`,
          [
            docType, measure, measureDate, processedBy, status, errorMessage, confidence, fileB64,
            JSON.stringify(confidenceBreakdown), JSON.stringify(auditTrail), JSON.stringify(rawExtraction),
          ]
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
          measure_date: measureDate,
          status,
          confidence,
          confidence_breakdown: confidenceBreakdown,
          audit_trail: auditTrail,
          error_message: errorMessage,
        },
      };
    } catch (err) {
      context.error('processing failed', err);
      let documentId = null;
      try {
        const insertResult = await pool.query(
          `INSERT INTO processed_documents
             (processing_status, error_message, processed_by, original_file_base64, audit_trail, raw_extraction)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING document_id`,
          [
            'Failed', String(err.message || err), body?.processed_by || 'user', body?.file_base64 || null,
            JSON.stringify([`Processing failed before rules could run: ${String(err.message || err)}`]),
            rawExtraction ? JSON.stringify(rawExtraction) : null,
          ]
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
