import { useRef, useState } from 'react';
import { useToast } from '../ToastContext.jsx';

const STAGES = [
  { key: 'uploading', label: 'Uploading file…' },
  { key: 'analyzing', label: 'Analyzing document…' },
  { key: 'saving', label: 'Saving result…' },
];

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function Stepper({ stage }) {
  const activeIndex = STAGES.findIndex((s) => s.key === stage);
  return (
    <div className="stepper">
      {STAGES.map((s, i) => {
        const state = i < activeIndex ? 'done' : i === activeIndex ? 'active' : 'pending';
        return (
          <div key={s.key} className={`step step-${state}`}>
            <span className="step-dot">{state === 'done' ? '✓' : i + 1}</span>
            <span className="step-label">{s.label}</span>
            {i < STAGES.length - 1 && <span className="step-line" />}
          </div>
        );
      })}
    </div>
  );
}

function ConfidenceBreakdown({ breakdown }) {
  if (!breakdown) return null;
  const items = [
    ['extraction', 'Extraction'],
    ['fields', 'Fields'],
    ['format', 'Format'],
    ['businessRule', 'Business Rule'],
  ];
  return (
    <div className="confidence-breakdown">
      {items.map(([key, label]) => (
        <span key={key} className={`confidence-chip ${breakdown[key] ? 'chip-pass' : 'chip-fail'}`}>
          {breakdown[key] ? '✓' : '✗'} {label}
        </span>
      ))}
    </div>
  );
}

export default function UploadPage() {
  const [file, setFile] = useState(null);
  const [dragActive, setDragActive] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [stage, setStage] = useState(null);
  const [result, setResult] = useState(null);
  const [auditOpen, setAuditOpen] = useState(false);
  const inputRef = useRef(null);
  const { addToast } = useToast();

  function pickFile(candidate) {
    if (!candidate) return;
    if (candidate.type !== 'application/pdf') {
      addToast({ type: 'error', message: 'Only PDF files are supported.' });
      return;
    }
    setFile(candidate);
    setResult(null);
  }

  function handleDragOver(e) {
    e.preventDefault();
    setDragActive(true);
  }

  function handleDragLeave(e) {
    e.preventDefault();
    setDragActive(false);
  }

  function handleDrop(e) {
    e.preventDefault();
    setDragActive(false);
    pickFile(e.dataTransfer.files?.[0]);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!file) {
      addToast({ type: 'error', message: 'Please choose a PDF file first.' });
      return;
    }
    setSubmitting(true);
    setResult(null);
    setStage('uploading');

    // Real processing is a single request/response through the Logic App and
    // Function App - there's no server-sent progress. This timer just moves
    // the stepper to "Analyzing" after the upload would plausibly be done, so
    // the wait reads as informative rather than dead air; the fetch below is
    // what the button is actually waiting on.
    const analyzeTimer = setTimeout(() => setStage('analyzing'), 700);

    const formData = new FormData();
    formData.append('document', file);

    try {
      const res = await fetch('/api/upload', { method: 'POST', body: formData });
      clearTimeout(analyzeTimer);
      setStage('saving');
      const data = await res.json();
      await new Promise((r) => setTimeout(r, 350));

      if (res.ok) {
        setResult({ type: 'success', data });
        addToast({
          type: data.status === 'Success' ? 'success' : 'info',
          message: `Document #${data.document_id ?? '?'} processed — ${data.status ?? 'processing'}.`,
        });
        setFile(null);
        if (inputRef.current) inputRef.current.value = '';
      } else {
        setResult({ type: 'error', message: data.error || 'Upload failed.' });
        addToast({ type: 'error', message: data.error || 'Upload failed.' });
      }
    } catch (err) {
      clearTimeout(analyzeTimer);
      setResult({ type: 'error', message: err.message });
      addToast({ type: 'error', message: err.message });
    } finally {
      setSubmitting(false);
      setStage(null);
    }
  }

  return (
    <section className="card">
      <h2>Upload a Clinical Document</h2>
      <p className="muted">Submit a PDF containing a Blood Pressure, HbA1c, or LDL Cholesterol result for processing.</p>

      <form onSubmit={handleSubmit}>
        <div
          className={`dropzone ${dragActive ? 'dropzone-active' : ''} ${file ? 'dropzone-has-file' : ''}`}
          onDragOver={handleDragOver}
          onDragEnter={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => inputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && inputRef.current?.click()}
        >
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf"
            className="dropzone-input"
            onChange={(e) => pickFile(e.target.files[0])}
          />
          {!file ? (
            <div className="dropzone-empty">
              <span className="dropzone-icon">📄</span>
              <p>
                <strong>Drag & drop</strong> a PDF here, or click to browse
              </p>
            </div>
          ) : (
            <div className="file-preview" onClick={(e) => e.stopPropagation()}>
              <span className="file-preview-icon">📎</span>
              <div className="file-preview-meta">
                <div className="file-preview-name">{file.name}</div>
                <div className="file-preview-size muted">{formatBytes(file.size)}</div>
              </div>
              <button
                type="button"
                className="secondary file-preview-remove"
                onClick={() => {
                  setFile(null);
                  if (inputRef.current) inputRef.current.value = '';
                }}
              >
                Remove
              </button>
            </div>
          )}
        </div>

        <button type="submit" disabled={submitting || !file} className="submit-button">
          {submitting && <span className="spinner" aria-hidden="true" />}
          {submitting ? 'Submitting…' : 'Submit for Processing'}
        </button>

        {submitting && stage && <Stepper stage={stage} />}
      </form>

      {result?.type === 'error' && (
        <p className="flash flash-error">{result.message}</p>
      )}

      {result?.type === 'success' && (
        <div className="result-card">
          <div className="result-header">
            <span
              className={`badge badge-${(result.data.status || '').toLowerCase().replace(/\s+/g, '-')}`}
            >
              {result.data.status || 'Unknown'}
            </span>
            <span className="result-title">
              Document #{result.data.document_id} {result.data.document_type ? `— ${result.data.document_type}` : ''}
            </span>
          </div>

          {result.data.measure && (
            <div className="result-measure">{result.data.measure}</div>
          )}

          {result.data.error_message && (
            <p className="result-error-message muted">{result.data.error_message}</p>
          )}

          <div className="result-confidence">
            <span className="muted">Confidence: {result.data.confidence ?? '-'}%</span>
            <ConfidenceBreakdown breakdown={result.data.confidence_breakdown} />
          </div>

          {result.data.audit_trail?.length > 0 && (
            <div className="audit-section">
              <button
                type="button"
                className="link-button"
                onClick={() => setAuditOpen((v) => !v)}
              >
                {auditOpen ? 'Hide' : 'Show'} how this was decided ({result.data.audit_trail.length})
              </button>
              {auditOpen && (
                <ul className="audit-list">
                  {result.data.audit_trail.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <p className="muted result-footnote">
            See the <strong>Processed Documents</strong> page for the full history.
          </p>
        </div>
      )}
    </section>
  );
}
