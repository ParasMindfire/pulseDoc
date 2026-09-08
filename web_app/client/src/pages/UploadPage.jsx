import { useState } from 'react';

export default function UploadPage() {
  const [file, setFile] = useState(null);
  const [status, setStatus] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!file) {
      setStatus({ type: 'error', message: 'Please choose a PDF file first.' });
      return;
    }
    setSubmitting(true);
    setStatus(null);

    const formData = new FormData();
    formData.append('document', file);

    try {
      const res = await fetch('/api/upload', { method: 'POST', body: formData });
      const data = await res.json();
      if (res.ok) {
        setStatus({
          type: 'success',
          message: `Submitted (document #${data.document_id ?? '?'}). Status: ${data.status ?? 'processing'}. Check the Processed Documents page for details.`,
        });
        setFile(null);
        e.target.reset();
      } else {
        setStatus({ type: 'error', message: data.error || 'Upload failed.' });
      }
    } catch (err) {
      setStatus({ type: 'error', message: err.message });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="card">
      <h2>Upload a Clinical Document</h2>
      <p className="muted">Submit a PDF containing a Blood Pressure or HbA1c result for processing.</p>
      <form onSubmit={handleSubmit}>
        <input
          type="file"
          accept="application/pdf"
          onChange={(e) => setFile(e.target.files[0])}
        />
        <button type="submit" disabled={submitting}>
          {submitting ? 'Submitting…' : 'Submit for Processing'}
        </button>
      </form>
      {status && (
        <p className={status.type === 'error' ? 'flash flash-error' : 'flash flash-success'}>
          {status.message}
        </p>
      )}
    </section>
  );
}
