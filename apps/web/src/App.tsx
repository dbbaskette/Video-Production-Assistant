import { Routes, Route, Navigate } from 'react-router-dom';
import { NavBar } from './components/NavBar.js';
import { Dashboard } from './pages/Dashboard.js';
import BrandNew from './pages/BrandNew.js';
import BrandDetail from './pages/BrandDetail.js';
import { BrandsList } from './pages/BrandsList.js';
import { VoicesList } from './pages/VoicesList.js';
import { VoiceNew } from './pages/VoiceNew.js';
import { VoiceDetail } from './pages/VoiceDetail.js';
import { ProjectWorkspace } from './pages/ProjectWorkspace.js';
import { ProjectOverview } from './pages/ProjectOverview.js';
import { StoryboardView } from './pages/StoryboardView.js';
import { Ideation } from './pages/Ideation.js';
import { ScenePage } from './pages/ScenePage.js';
import { ReviewPage } from './pages/ReviewPage.js';
import { RecordingsPage } from './pages/RecordingsPage.js';
import { Settings } from './pages/Settings.js';

export function App() {
  return (
    <>
      <NavBar />
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/brands" element={<BrandsList />} />
        <Route path="/brands/new" element={<BrandNew />} />
        <Route path="/brands/:slug" element={<BrandDetail />} />
        <Route path="/voices" element={<VoicesList />} />
        <Route path="/voices/new" element={<VoiceNew />} />
        <Route path="/voices/:id" element={<VoiceDetail />} />
        <Route path="/project/:projectId" element={<ProjectWorkspace />}>
          <Route index element={<ProjectOverview />} />
          <Route path="storyboard" element={<StoryboardView />} />
          <Route path="ideation" element={<Ideation />} />
          <Route path="scene/:sceneId" element={<ScenePage />} />
          <Route path="recordings" element={<RecordingsPage />} />
          <Route path="review" element={<ReviewPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
