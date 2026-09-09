import { useEffect, useState } from 'react';
import { Routes, Route, NavLink } from 'react-router-dom';
import UploadPage from './pages/UploadPage.jsx';
import DocumentsPage from './pages/DocumentsPage.jsx';
import { ToastProvider } from './ToastContext.jsx';

function getInitialTheme() {
  try {
    const stored = localStorage.getItem('pulsedoc-theme');
    if (stored === 'light' || stored === 'dark') return stored;
  } catch (_) {
    // localStorage unavailable - fall through to system preference
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export default function App() {
  const [theme, setTheme] = useState(getInitialTheme);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('pulsedoc-theme', theme);
    } catch (_) {
      // per-viewer convenience only - safe to ignore if storage is blocked
    }
  }, [theme]);

  return (
    <ToastProvider>
      <div className="app">
        <header className="header">
          <h1>PulseDoc</h1>
          <div className="header-right">
            <nav>
              <NavLink to="/" end className={({ isActive }) => (isActive ? 'active' : '')}>
                Upload
              </NavLink>
              <NavLink to="/documents" className={({ isActive }) => (isActive ? 'active' : '')}>
                Processed Documents
              </NavLink>
            </nav>
            <button
              type="button"
              className="theme-toggle"
              onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
              aria-label="Toggle dark mode"
              title="Toggle dark mode"
            >
              {theme === 'dark' ? '☀️' : '🌙'}
            </button>
          </div>
        </header>
        <main>
          <Routes>
            <Route path="/" element={<UploadPage />} />
            <Route path="/documents" element={<DocumentsPage />} />
          </Routes>
        </main>
      </div>
    </ToastProvider>
  );
}
