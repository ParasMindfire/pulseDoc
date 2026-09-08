import { Routes, Route, NavLink } from 'react-router-dom';
import UploadPage from './pages/UploadPage.jsx';
import DocumentsPage from './pages/DocumentsPage.jsx';

export default function App() {
  return (
    <div className="app">
      <header className="header">
        <h1>ClinicWorks</h1>
        <nav>
          <NavLink to="/" end className={({ isActive }) => (isActive ? 'active' : '')}>
            Upload
          </NavLink>
          <NavLink to="/documents" className={({ isActive }) => (isActive ? 'active' : '')}>
            Processed Documents
          </NavLink>
        </nav>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<UploadPage />} />
          <Route path="/documents" element={<DocumentsPage />} />
        </Routes>
      </main>
    </div>
  );
}
