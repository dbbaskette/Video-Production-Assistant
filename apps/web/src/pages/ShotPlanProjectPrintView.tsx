import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { storyboardApi } from '../lib/api.js';

export function ShotPlanProjectPrintView() {
  const { projectId } = useParams<{ projectId: string }>();
  const { data: storyboard } = useQuery({
    queryKey: ['storyboard', projectId],
    queryFn: () => storyboardApi.get(projectId!),
    enabled: !!projectId,
  });

  useEffect(() => {
    document.title = 'Shot Plans — Runbook';
  }, []);

  const scenes = (storyboard?.scenes ?? []).filter((s) => (s.shot_plan?.length ?? 0) > 0);

  return (
    <div style={{ padding: 32, maxWidth: 720, margin: '0 auto', fontFamily: 'system-ui, sans-serif' }}>
      <style>{`@media print { body { background: white; } @page { margin: 18mm; } .scene { page-break-inside: avoid; } }`}</style>
      <h1 style={{ fontSize: 24, marginBottom: 4 }}>{storyboard?.project.name ?? 'Project'} — Runbook</h1>
      <div style={{ color: '#666', fontSize: 13, marginBottom: 24 }}>
        {scenes.length} scene{scenes.length === 1 ? '' : 's'} planned.
      </div>
      {scenes.length === 0 && <div style={{ color: '#999' }}>No scenes have a shot plan yet.</div>}
      {scenes.map((scene, idx) => (
        <section className="scene" key={scene.id} style={{ marginBottom: 28 }}>
          <h2 style={{ fontSize: 18, marginBottom: 4 }}>
            {idx + 1}. {scene.name}
          </h2>
          <div style={{ color: '#666', fontSize: 13, marginBottom: 10 }}>{scene.description}</div>
          <ol style={{ paddingLeft: 22, lineHeight: 1.7, margin: 0 }}>
            {scene.shot_plan!.map((s) => (
              <li key={s.index} style={{ marginBottom: 6 }}>
                <div style={{ fontSize: 14 }}>{s.action}</div>
                {s.note && <div style={{ color: '#666', fontSize: 12 }}>{s.note}</div>}
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
