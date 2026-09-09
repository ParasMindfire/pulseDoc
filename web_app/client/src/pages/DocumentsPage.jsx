import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useToast } from '../ToastContext.jsx';

function formatDate(value) {
  if (!value) return '-';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value).substring(0, 10) : d.toLocaleString();
}

function toDateInputValue(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

function errorIcon(msg) {
  if (!msg) return '';
  const lower = msg.toLowerCase();
  if (lower.includes('under 18')) return '🎂';
  if (lower.includes('goal') || lower.includes('target')) return '🎯';
  return '⚠️';
}

const COLUMNS = [
  { key: 'document_id', label: 'ID', numeric: true },
  { key: 'document_type', label: 'Type' },
  { key: 'measure_extracted', label: 'Measure' },
  { key: 'measure_date', label: 'Measure Date' },
  { key: 'date_processed', label: 'Date Processed' },
  { key: 'processed_by', label: 'Processed By' },
  { key: 'processing_status', label: 'Status' },
  { key: 'confidence_score', label: 'Confidence', numeric: true },
];

function compareValues(a, b, key, numeric) {
  const av = a[key];
  const bv = b[key];
  if (av == null && bv == null) return 0;
  if (av == null) return -1;
  if (bv == null) return 1;
  if (numeric) return Number(av) - Number(bv);
  if (key.includes('date')) return new Date(av) - new Date(bv);
  return String(av).localeCompare(String(bv));
}

function toCsv(rows) {
  const header = ['ID', 'Type', 'Measure', 'Measure Date', 'Date Processed', 'Processed By', 'Status', 'Confidence', 'Error Message'];
  const escape = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.map(escape).join(',')];
  for (const d of rows) {
    lines.push(
      [
        d.document_id,
        d.document_type,
        d.measure_extracted,
        d.measure_date,
        d.date_processed,
        d.processed_by,
        d.processing_status,
        d.confidence_score,
        d.error_message,
      ]
        .map(escape)
        .join(',')
    );
  }
  return lines.join('\n');
}

function ConfidenceBreakdownMini({ breakdown }) {
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

export default function DocumentsPage() {
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [retryingId, setRetryingId] = useState(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [sort, setSort] = useState({ key: 'document_id', dir: 'desc' });
  const [expandedIds, setExpandedIds] = useState(() => new Set());
  const { addToast } = useToast();

  const loadDocs = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/documents');
      const data = await res.json();
      setDocs(Array.isArray(data) ? data : []);
    } catch (err) {
      addToast({ type: 'error', message: `Failed to load documents: ${err.message}` });
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    loadDocs();
  }, [loadDocs]);

  async function handleRetry(id) {
    setRetryingId(id);
    try {
      const res = await fetch(`/api/retry/${id}`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        addToast({ type: 'success', message: `Document #${id} reprocessed — ${data.status ?? 'done'}.` });
      } else {
        addToast({ type: 'error', message: data.error || `Retry failed for document #${id}.` });
      }
      await loadDocs();
    } catch (err) {
      addToast({ type: 'error', message: err.message });
    } finally {
      setRetryingId(null);
    }
  }

  function toggleExpanded(id) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSort(key) {
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));
  }

  const stats = useMemo(() => {
    const today = new Date().toDateString();
    const processedToday = docs.filter((d) => d.date_processed && new Date(d.date_processed).toDateString() === today).length;
    const needsReview = docs.filter((d) => d.processing_status === 'Needs Review').length;
    const failed = docs.filter((d) => d.processing_status === 'Failed').length;
    const withConfidence = docs.filter((d) => d.confidence_score != null);
    const avgConfidence = withConfidence.length
      ? Math.round(withConfidence.reduce((sum, d) => sum + Number(d.confidence_score), 0) / withConfidence.length)
      : null;
    return { total: docs.length, processedToday, needsReview, failed, avgConfidence };
  }, [docs]);

  const types = useMemo(() => {
    const set = new Set(docs.map((d) => d.document_type).filter(Boolean));
    return Array.from(set).sort();
  }, [docs]);

  const filteredDocs = useMemo(() => {
    const q = search.trim().toLowerCase();
    let rows = docs.filter((d) => {
      if (statusFilter !== 'all' && d.processing_status !== statusFilter) return false;
      if (typeFilter !== 'all' && d.document_type !== typeFilter) return false;
      if (dateFrom && (!d.date_processed || toDateInputValue(d.date_processed) < dateFrom)) return false;
      if (dateTo && (!d.date_processed || toDateInputValue(d.date_processed) > dateTo)) return false;
      if (q) {
        const haystack = [d.document_id, d.document_type, d.measure_extracted, d.processed_by, d.error_message]
          .map((v) => String(v ?? '').toLowerCase())
          .join(' ');
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
    const col = COLUMNS.find((c) => c.key === sort.key);
    rows = [...rows].sort((a, b) => compareValues(a, b, sort.key, col?.numeric));
    if (sort.dir === 'desc') rows.reverse();
    return rows;
  }, [docs, search, statusFilter, typeFilter, dateFrom, dateTo, sort]);

  function handleExport() {
    const csv = toCsv(filteredDocs);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pulsedoc-documents-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  const hasActiveFilters = search || statusFilter !== 'all' || typeFilter !== 'all' || dateFrom || dateTo;

  return (
    <section className="card">
      <div className="card-header">
        <h2>Processed Documents</h2>
        <div className="card-header-actions">
          <button className="secondary" onClick={handleExport} disabled={filteredDocs.length === 0}>
            Export CSV
          </button>
          <button className="secondary" onClick={loadDocs} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="stats-row">
        <div className="stat-card">
          <div className="stat-value">{stats.total}</div>
          <div className="stat-label">Total documents</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{stats.processedToday}</div>
          <div className="stat-label">Processed today</div>
        </div>
        <div className="stat-card stat-warning">
          <div className="stat-value">{stats.needsReview}</div>
          <div className="stat-label">Need review</div>
        </div>
        <div className="stat-card stat-danger">
          <div className="stat-value">{stats.failed}</div>
          <div className="stat-label">Failed</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{stats.avgConfidence != null ? `${stats.avgConfidence}%` : '-'}</div>
          <div className="stat-label">Avg. confidence</div>
        </div>
      </div>

      <div className="filter-bar">
        <input
          type="search"
          placeholder="Search ID, type, measure, processed by…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="filter-search"
        />
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="all">All statuses</option>
          <option value="Success">Success</option>
          <option value="Needs Review">Needs Review</option>
          <option value="Failed">Failed</option>
        </select>
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="all">All types</option>
          {types.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <label className="filter-date-label muted">
          From
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
        </label>
        <label className="filter-date-label muted">
          To
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
        </label>
        {hasActiveFilters && (
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setSearch('');
              setStatusFilter('all');
              setTypeFilter('all');
              setDateFrom('');
              setDateTo('');
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {COLUMNS.map((c) => (
                <th key={c.key} className="sortable-th" onClick={() => toggleSort(c.key)}>
                  {c.label}
                  {sort.key === c.key && <span className="sort-arrow">{sort.dir === 'asc' ? ' ▲' : ' ▼'}</span>}
                </th>
              ))}
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {docs.length === 0 && !loading && (
              <tr>
                <td colSpan={COLUMNS.length + 1}>
                  <div className="empty-state">
                    <span className="empty-state-icon">🗂️</span>
                    <p>No documents processed yet.</p>
                    <p className="muted">Upload your first PDF from the Upload page to see it here.</p>
                  </div>
                </td>
              </tr>
            )}
            {docs.length > 0 && filteredDocs.length === 0 && !loading && (
              <tr>
                <td colSpan={COLUMNS.length + 1}>
                  <div className="empty-state">
                    <span className="empty-state-icon">🔍</span>
                    <p>No documents match your filters.</p>
                  </div>
                </td>
              </tr>
            )}
            {filteredDocs.map((d) => {
              const statusClass = (d.processing_status || '').toLowerCase().replace(/\s+/g, '-');
              const isExpanded = expandedIds.has(d.document_id);
              return (
                <Fragment key={d.document_id}>
                  <tr
                    className="doc-row"
                    onClick={() => toggleExpanded(d.document_id)}
                  >
                    <td>{d.document_id}</td>
                    <td>{d.document_type || '-'}</td>
                    <td>{d.measure_extracted || '-'}</td>
                    <td>{formatDate(d.measure_date)}</td>
                    <td>{formatDate(d.date_processed)}</td>
                    <td>{d.processed_by || '-'}</td>
                    <td>
                      <span className={`badge badge-${statusClass}`}>{d.processing_status || '-'}</span>
                      {d.error_message && (
                        <div className="badge-subtitle muted" title={d.error_message}>
                          {errorIcon(d.error_message)} {d.error_message.length > 40 ? `${d.error_message.slice(0, 40)}…` : d.error_message}
                        </div>
                      )}
                    </td>
                    <td>{d.confidence_score ?? '-'}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <button
                        className="secondary"
                        onClick={() => handleRetry(d.document_id)}
                        disabled={retryingId === d.document_id}
                      >
                        {retryingId === d.document_id ? 'Retrying…' : 'Retry'}
                      </button>
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr className="expanded-row">
                      <td colSpan={COLUMNS.length + 1}>
                        <div className="expanded-panel">
                          {d.confidence_breakdown && (
                            <div className="expanded-block">
                              <h4>Confidence breakdown</h4>
                              <ConfidenceBreakdownMini breakdown={d.confidence_breakdown} />
                            </div>
                          )}
                          {Array.isArray(d.audit_trail) && d.audit_trail.length > 0 && (
                            <div className="expanded-block">
                              <h4>Audit trail</h4>
                              <ul className="audit-list">
                                {d.audit_trail.map((line, i) => (
                                  <li key={i}>{line}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {d.error_message && (
                            <div className="expanded-block">
                              <h4>Error message</h4>
                              <p className="muted">{d.error_message}</p>
                            </div>
                          )}
                          {d.raw_extraction && (
                            <div className="expanded-block">
                              <h4>Raw Gemini extraction</h4>
                              <pre className="raw-json">{JSON.stringify(d.raw_extraction, null, 2)}</pre>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
