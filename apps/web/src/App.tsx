import { Routes, Route, Navigate } from 'react-router-dom';
import { Dashboard } from './pages/Dashboard.js';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
