import { useEffect, useState, useCallback } from 'react';

function formatDate(value) {
  if (!value) return '-';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value).substring(0, 10) : d.toLocaleString();
}

export default function DocumentsPage() {
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [retryingId, setRetryingId] = useState(null);

  const loadDocs = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/documents');
      const data = await res.json();
      setDocs(Array.isArray(data) ? data : []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDocs();
  }, [loadDocs]);

  async function handleRetry(id) {
    setRetryingId(id);
    try {
      await fetch(`/api/retry/${id}`, { method: 'POST' });
      await loadDocs();
    } finally {
      setRetryingId(null);
    }
  }

  return (
    <section className="card">
      <div className="card-header">
        <h2>Processed Documents</h2>
        <button className="secondary" onClick={loadDocs} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Type</th>
              <th>Measure</th>
              <th>Measure Date</th>
              <th>Date Processed</th>
              <th>Processed By</th>
              <th>Status</th>
              <th>Confidence</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {docs.length === 0 && !loading && (
              <tr>
                <td colSpan="9" className="muted">No documents processed yet.</td>
              </tr>
            )}
            {docs.map((d) => (
              <tr key={d.document_id}>
                <td>{d.document_id}</td>
                <td>{d.document_type || '-'}</td>
                <td>{d.measure_extracted || '-'}</td>
                <td>{formatDate(d.measure_date)}</td>
                <td>{formatDate(d.date_processed)}</td>
                <td>{d.processed_by || '-'}</td>
                <td>
                  <span className={`badge badge-${(d.processing_status || '').toLowerCase().replace(/\s+/g, '-')}`}>
                    {d.processing_status || '-'}
                  </span>
                </td>
                <td>{d.confidence_score ?? '-'}</td>
                <td>
                  <button
                    className="secondary"
                    onClick={() => handleRetry(d.document_id)}
                    disabled={retryingId === d.document_id}
                  >
                    {retryingId === d.document_id ? 'Retrying…' : 'Retry'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
