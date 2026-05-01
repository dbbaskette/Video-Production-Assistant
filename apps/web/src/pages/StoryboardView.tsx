import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { storyboardApi } from '../lib/api.js';
import type { Scene } from '@vpa/shared';

const typeBadgeColors: Record<string, string> = {
  desktop: '#7aa2f7',
  terminal: '#5e8a3a',
  browser: '#f4a83a',
  slide: '#c25d5d',
};

function SceneCard({
  scene,
  index,
  total,
  projectId,
  onMoveUp,
  onMoveDown,
}: {
  scene: Scene;
  index: number;
  total: number;
  projectId: string;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(scene.name);
  const [description, setDescription] = useState(scene.description);

  const updateMutation = useMutation({
    mutationFn: (patch: Partial<Scene>) =>
      storyboardApi.updateScene(projectId, scene.id, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] });
      setEditing(false);
    },
  });

  const removeMutation = useMutation({
    mutationFn: () => storyboardApi.removeScene(projectId, scene.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] });
    },
  });

  const hasRecording = !!scene.recording;
  const hasNarration = !!scene.narration;
  const hasLowerThirds = (scene.lower_thirds?.length ?? 0) > 0;

  return (
    <div
      style={{
        background: 'var(--bg-elev)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: '16px 20px',
      }}
    >
      {editing ? (
        <div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ width: '100%', marginBottom: 8, fontWeight: 600 }}
            placeholder="Scene name"
          />
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            style={{ width: '100%', resize: 'vertical', minHeight: 60 }}
            placeholder="Scene description"
            rows={3}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button
              className="primary"
              onClick={() => updateMutation.mutate({ name, description })}
              disabled={updateMutation.isPending}
            >
              {updateMutation.isPending ? 'Saving…' : 'Save'}
            </button>
            <button onClick={() => { setEditing(false); setName(scene.name); setDescription(scene.description); }}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 14, color: 'var(--fg-muted)', fontWeight: 600, minWidth: 24 }}>
                {index + 1}
              </span>
              <span
                style={{
                  fontSize: 10,
                  padding: '2px 6px',
                  borderRadius: 4,
                  background: typeBadgeColors[scene.type] ?? '#666',
                  color: '#fff',
                  fontWeight: 600,
                  textTransform: 'uppercase',
                }}
              >
                {scene.type}
              </span>
              <span style={{ fontWeight: 600, fontSize: 15 }}>{scene.name}</span>
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              <button
                onClick={onMoveUp}
                disabled={index === 0}
                style={{ padding: '4px 8px', fontSize: 12, opacity: index === 0 ? 0.3 : 1 }}
                title="Move up"
              >
                ↑
              </button>
              <button
                onClick={onMoveDown}
                disabled={index === total - 1}
                style={{ padding: '4px 8px', fontSize: 12, opacity: index === total - 1 ? 0.3 : 1 }}
                title="Move down"
              >
                ↓
              </button>
              <button onClick={() => setEditing(true)} style={{ padding: '4px 8px', fontSize: 12 }} title="Edit">
                ✏️
              </button>
              <button
                onClick={() => { if (confirm(`Remove "${scene.name}"?`)) removeMutation.mutate(); }}
                style={{ padding: '4px 8px', fontSize: 12, color: 'var(--danger)' }}
                title="Remove"
              >
                ✕
              </button>
            </div>
          </div>

          <p style={{ color: 'var(--fg-muted)', margin: '8px 0 0 34px', fontSize: 13, lineHeight: 1.5 }}>
            {scene.description}
          </p>

          {/* Status indicators */}
          <div style={{ display: 'flex', gap: 12, marginTop: 10, marginLeft: 34 }}>
            <StatusBadge label="Recording" done={hasRecording} />
            <StatusBadge label="Narration" done={hasNarration} />
            <StatusBadge label="Lower Thirds" done={hasLowerThirds} />
          </div>
        </>
      )}
    </div>
  );
}

function StatusBadge({ label, done }: { label: string; done: boolean }) {
  return (
    <span
      style={{
        fontSize: 11,
        padding: '2px 8px',
        borderRadius: 10,
        background: done ? 'rgba(94,138,58,0.2)' : 'rgba(255,255,255,0.05)',
        color: done ? 'var(--success)' : 'var(--fg-muted)',
        border: `1px solid ${done ? 'var(--success)' : 'var(--border)'}`,
      }}
    >
      {done ? '✓' : '○'} {label}
    </span>
  );
}

export function StoryboardView() {
  const { projectId } = useParams<{ projectId: string }>();
  const queryClient = useQueryClient();

  const { data: storyboard, isLoading, error } = useQuery({
    queryKey: ['storyboard', projectId],
    queryFn: () => storyboardApi.get(projectId!),
    enabled: !!projectId,
  });

  const reorderMutation = useMutation({
    mutationFn: (orderedIds: string[]) =>
      storyboardApi.reorderScenes(projectId!, orderedIds),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] });
    },
  });

  if (isLoading) {
    return <div style={{ padding: 40, color: 'var(--fg-muted)' }}>Loading storyboard…</div>;
  }

  if (error) {
    return (
      <div style={{ padding: 40, color: 'var(--danger)' }}>
        Failed to load storyboard: {error instanceof Error ? error.message : 'unknown'}
      </div>
    );
  }

  if (!storyboard) {
    return (
      <div style={{ padding: '60px 48px', textAlign: 'center' }}>
        <div style={{ fontSize: 40, marginBottom: 16 }}>📋</div>
        <h2 style={{ margin: 0 }}>No storyboard yet</h2>
        <p style={{ color: 'var(--fg-muted)', marginTop: 8, maxWidth: 400, margin: '8px auto 0' }}>
          Start an ideation session to build your storyboard with AI assistance.
        </p>
        <Link
          to={`/project/${projectId}/ideation`}
          style={{
            display: 'inline-block',
            marginTop: 24,
            padding: '12px 24px',
            background: 'var(--accent-bg)',
            border: '1px solid var(--accent)',
            borderRadius: 8,
            color: 'var(--fg)',
            textDecoration: 'none',
            fontWeight: 600,
          }}
        >
          Start Ideation
        </Link>
      </div>
    );
  }

  const scenes = storyboard.scenes;

  const moveScene = (fromIndex: number, toIndex: number) => {
    const ids = scenes.map((s) => s.id);
    const [moved] = ids.splice(fromIndex, 1);
    ids.splice(toIndex, 0, moved!);
    reorderMutation.mutate(ids);
  };

  return (
    <div style={{ padding: '32px 48px', maxWidth: 900 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22 }}>Storyboard</h1>
          <p style={{ color: 'var(--fg-muted)', margin: '4px 0 0', fontSize: 13 }}>
            {scenes.length} {scenes.length === 1 ? 'scene' : 'scenes'}
            {storyboard.project.objective && ` · ${storyboard.project.objective}`}
          </p>
        </div>
        <Link
          to={`/project/${projectId}/ideation`}
          style={{
            padding: '8px 16px',
            background: 'var(--bg-elev)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            color: 'var(--fg)',
            textDecoration: 'none',
            fontSize: 13,
          }}
        >
          Refine in Ideation
        </Link>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {scenes.map((scene, idx) => (
          <SceneCard
            key={scene.id}
            scene={scene}
            index={idx}
            total={scenes.length}
            projectId={projectId!}
            onMoveUp={() => moveScene(idx, idx - 1)}
            onMoveDown={() => moveScene(idx, idx + 1)}
          />
        ))}
      </div>
    </div>
  );
}
