import { Routes, Route, Navigate } from 'react-router-dom';
import { Dashboard } from './pages/Dashboard.js';
import BrandNew from './pages/BrandNew.js';
import BrandDetail from './pages/BrandDetail.js';
import { ProjectWorkspace } from './pages/ProjectWorkspace.js';
import { ProjectOverview } from './pages/ProjectOverview.js';
import { StoryboardView } from './pages/StoryboardView.js';
import { Ideation } from './pages/Ideation.js';
import { ScenePage } from './pages/ScenePage.js';
import { ReviewPage } from './pages/ReviewPage.js';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/brands/new" element={<BrandNew />} />
      <Route path="/brands/:slug" element={<BrandDetail />} />
      <Route path="/project/:projectId" element={<ProjectWorkspace />}>
        <Route index element={<ProjectOverview />} />
        <Route path="storyboard" element={<StoryboardView />} />
        <Route path="ideation" element={<Ideation />} />
        <Route path="scene/:sceneId" element={<ScenePage />} />
        <Route path="review" element={<ReviewPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
