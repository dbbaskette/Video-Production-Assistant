import { Navigate, useParams, useSearchParams } from 'react-router-dom';

/**
 * Legacy `/project/:projectId/scene/:sceneId` route — now a redirect into
 * the new master-detail storyboard. Preserves the optional ?tab= query
 * (used by Quality Review's click-to-jump and any old bookmarks).
 */
export function SceneRedirect() {
  const { projectId, sceneId } = useParams<{ projectId: string; sceneId: string }>();
  const [search] = useSearchParams();
  const next = new URLSearchParams();
  if (sceneId) next.set('scene', sceneId);
  const tab = search.get('tab');
  if (tab) next.set('tab', tab);
  return <Navigate to={`/project/${projectId}/storyboard?${next.toString()}`} replace />;
}
