import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { shotPlanApi, storyboardApi } from '../lib/api.js';

export function ShotPlanPrintView() {
  const { projectId, sceneId } = useParams<{ projectId: string; sceneId: string }>();
  const { data: plan } = useQuery({
    queryKey: ['shot-plan', projectId, sceneId],
    queryFn: () => shotPlanApi.get(projectId!, sceneId!),
    enabled: !!projectId && !!sceneId,
  });
  const { data: storyboard } = useQuery({
    queryKey: ['storyboard', projectId],
    queryFn: () => storyboardApi.get(projectId!),
    enabled: !!projectId,
  });

  useEffect(() => {
    document.title = 'Shot Plan';
  }, []);

  const scene = storyboard?.scenes.find((s) => s.id === sceneId);
  const steps = plan?.savedPlan ?? [];

  return (
    <div style={{ padding: 32, maxWidth: 720, margin: '0 auto', fontFamily: 'system-ui, sans-serif' }}>
      <style>{printCss}</style>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>{scene?.name ?? 'Scene'}</h1>
      <div style={{ color: '#666', fontSize: 13, marginBottom: 24 }}>
        {scene?.description}
      </div>
      {steps.length === 0 ? (
        <div style={{ color: '#999' }}>No shot plan yet.</div>
      ) : (
        <ol style={{ paddingLeft: 24, lineHeight: 1.7 }}>
          {steps.map((s) => (
            <li key={s.index} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 15 }}>{s.action}</div>
              {s.note && <div style={{ color: '#666', fontSize: 13, marginTop: 2 }}>{s.note}</div>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

const printCss = `
  @media print {
    body { background: white; }
    @page { margin: 18mm; }
  }
`;
