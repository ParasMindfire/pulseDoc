-- Run this once against your EXISTING live database (pgAdmin/DBeaver -> Query Tool)
-- if it was created before confidence_breakdown / audit_trail / raw_extraction existed.
-- Safe to re-run; every column add is guarded with IF NOT EXISTS.

ALTER TABLE processed_documents
    ADD COLUMN IF NOT EXISTS confidence_breakdown JSONB,
    ADD COLUMN IF NOT EXISTS audit_trail JSONB,
    ADD COLUMN IF NOT EXISTS raw_extraction JSONB;
