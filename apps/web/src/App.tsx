import { Routes, Route, Navigate } from 'react-router-dom';
import { Dashboard } from './pages/Dashboard.js';
import BrandNew from './pages/BrandNew.js';
import BrandDetail from './pages/BrandDetail.js';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/brands/new" element={<BrandNew />} />
      <Route path="/brands/:slug" element={<BrandDetail />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
