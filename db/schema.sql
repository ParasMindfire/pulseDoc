-- Run this once against your PostgreSQL database (via pgAdmin/DBeaver) before testing anything else.
-- If you already have a live database from before the extensibility columns were
-- added (confidence_breakdown / audit_trail / raw_extraction), run
-- db/migration_002_extensibility.sql against it instead of re-running this file.

CREATE TABLE IF NOT EXISTS processed_documents (
    document_id           SERIAL PRIMARY KEY,
    document_type         TEXT,              -- 'BP', 'A1C', or 'LDL'
    measure_extracted     TEXT,              -- e.g. '138/88', '7.4 (Prediabetes)', '142 mg/dL (Near Optimal)'
    measure_date          DATE,
    date_processed         TIMESTAMP DEFAULT now(),
    processed_by           TEXT,
    processing_status      TEXT,              -- 'Success' | 'Failed' | 'Needs Review'
    error_message           TEXT,
    confidence_score        NUMERIC,           -- 0-100, our own composite score
    confidence_breakdown     JSONB,             -- { extraction, fields, format, businessRule } - why the score is what it is
    audit_trail              JSONB,             -- ordered list of human-readable rule decisions (inclusions/exclusions/selection)
    raw_extraction            JSONB,             -- Gemini's raw parsed extraction, kept for debugging/demo purposes
    original_file_base64    TEXT               -- stored so the Retry button can resend the same file
);
