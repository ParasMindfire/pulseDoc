-- Run this once against your PostgreSQL database (via DBeaver) before testing anything else.

CREATE TABLE IF NOT EXISTS processed_documents (
    document_id           SERIAL PRIMARY KEY,
    document_type         TEXT,              -- 'BP' or 'A1C'
    measure_extracted     TEXT,              -- e.g. '138/88' or '7.4 (Prediabetes)'
    measure_date          DATE,
    date_processed         TIMESTAMP DEFAULT now(),
    processed_by           TEXT,
    processing_status      TEXT,              -- 'Success' | 'Failed' | 'Needs Review'
    error_message           TEXT,
    confidence_score        NUMERIC,           -- 0-100, our own composite score
    original_file_base64    TEXT               -- stored so the Retry button can resend the same file
);
