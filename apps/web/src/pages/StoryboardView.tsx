/**
 * Storyboard — master-detail layout. Left rail: a compact scene list with
 * per-scene status (recording / script / narration / lower thirds). Right
 * rail: the full ScenePage editor for the selected scene, embedded inline.
 *
 * URL pattern: /project/:projectId/storyboard?scene=<sceneId>
 * The ?scene query param drives selection; ?tab= can additionally pin a
 * specific tab inside the embedded editor (used by Quality Review's
 * click-to-jump).
 *
 * When no ?scene is in the URL, we auto-select the first scene to avoid
 * an empty right pane.
 */

import { useState, useEffect } from 'react';
import { useParams, useSearchParams, useOutletContext, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { storyboardApi } from '../lib/api.js';
import { useUi } from '../components/ui/UiProvider.js';
import { ScenePage } from './ScenePage.js';
import type { Scene, ProjectTrackerEntry } from '@vpa/shared';

interface WorkspaceContext {
  project: ProjectTrackerEntry;
}

const typeBadgeColors: Record<string, string> = {
  desktop: '#7aa2f7',
  terminal: '#5e8a3a',
  browser: '#f4a83a',
  slide: '#c25d5d',
};

export function StoryboardView() {
  const { projectId } = useParams<{ projectId: string }>();
  const { project } = useOutletContext<WorkspaceContext>();
  const [searchParams, setSearchParams] = useSearchParams();
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

  const scenes = storyboard?.scenes ?? [];
  const selectedSceneId = searchParams.get('scene') ?? scenes[0]?.id ?? null;

  // When the URL doesn't carry ?scene yet but scenes are loaded, normalise
  // so the URL reflects the displayed selection (makes deep-linking + the
  // SaveIndicator's tab-survives-refresh behavior consistent).
  useEffect(() => {
    if (!searchParams.get('scene') && scenes.length > 0) {
      const next = new URLSearchParams(searchParams);
      next.set('scene', scenes[0]!.id);
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenes.length]);

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

  if (!storyboard) return <EmptyStoryboard projectId={projectId!} />;

  const moveScene = (fromIndex: number, toIndex: number) => {
    const ids = scenes.map((s) => s.id);
    const [moved] = ids.splice(fromIndex, 1);
    ids.splice(toIndex, 0, moved!);
    reorderMutation.mutate(ids);
  };

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '320px 1fr',
        height: '100%',
        minHeight: 'calc(100vh - 56px)', // navbar + breathing room
      }}
    >
      {/* ── Left rail: scene list ────────────────────────────── */}
      <aside
        style={{
          borderRight: '1px solid var(--border)',
          background: 'var(--bg-elev)',
          overflowY: 'auto',
          padding: 16,
        }}
      >
        <header style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>Storyboard</h2>
          <p style={{ color: 'var(--fg-muted)', margin: '4px 0 0', fontSize: 12 }}>
            {scenes.length} {scenes.length === 1 ? 'scene' : 'scenes'}
          </p>
        </header>

        {storyboard.project.objective && (
          <p
            style={{
              fontSize: 11,
              color: 'var(--fg-muted)',
              margin: '0 0 16px',
              padding: '8px 10px',
              background: 'var(--bg)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              fontStyle: 'italic',
            }}
            title={storyboard.project.objective}
          >
            {storyboard.project.objective.slice(0, 140)}
            {storyboard.project.objective.length > 140 && '…'}
          </p>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {scenes.map((scene, idx) => (
            <SceneRow
              key={scene.id}
              scene={scene}
              index={idx}
              total={scenes.length}
              projectId={projectId!}
              selected={scene.id === selectedSceneId}
              onSelect={() => {
                const next = new URLSearchParams(searchParams);
                next.set('scene', scene.id);
                next.delete('tab'); // reset tab when switching scenes
                setSearchParams(next);
              }}
              onMoveUp={() => moveScene(idx, idx - 1)}
              onMoveDown={() => moveScene(idx, idx + 1)}
            />
          ))}
        </div>

        <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
          <Link
            to={`/project/${projectId}/ideation`}
            style={{
              display: 'block',
              padding: '8px 12px',
              fontSize: 12,
              color: 'var(--fg-muted)',
              textDecoration: 'none',
              border: '1px solid var(--border)',
              borderRadius: 6,
              textAlign: 'center',
            }}
          >
            ✨ Refine in Ideation
          </Link>
        </div>
      </aside>

      {/* ── Right rail: embedded scene editor ────────────────── */}
      <section style={{ overflowY: 'auto', padding: '24px 32px' }}>
        {selectedSceneId ? (
          // Key forces a fresh mount when switching scenes so per-scene
          // local state in ScenePage (active tab, dirty editors, etc.)
          // doesn't leak across selections.
          <ScenePage
            key={selectedSceneId}
            projectId={projectId}
            sceneId={selectedSceneId}
            project={project}
            embedded
          />
        ) : (
          <div style={{ padding: 60, textAlign: 'center', color: 'var(--fg-muted)' }}>
            Select a scene from the left to start editing.
          </div>
        )}
      </section>
    </div>
  );
}

// ── Left-rail scene row ─────────────────────────────────────────────

function SceneRow({
  scene,
  index,
  total,
  projectId,
  selected,
  onSelect,
  onMoveUp,
  onMoveDown,
}: {
  scene: Scene;
  index: number;
  total: number;
  projectId: string;
  selected: boolean;
  onSelect: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const queryClient = useQueryClient();
  const ui = useUi();
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

  // Per-stage status derived from the scene record. Stays cheap — no
  // separate fetches just for badges.
  const hasRecording = !!scene.recording;
  const chunks = scene.narration?.chunks ?? [];
  const narratedChunks = chunks.filter((c) => !!c.audio).length;
  const totalChunks = chunks.length;
  const hasScript = !!scene.narration?.script;
  const hasLowerThirds = (scene.lower_thirds?.length ?? 0) > 0;

  if (editing) {
    return (
      <div
        style={{
          background: 'var(--bg)',
          border: '1px solid var(--accent)',
          borderRadius: 6,
          padding: 8,
        }}
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ width: '100%', marginBottom: 6, fontSize: 13, fontWeight: 600 }}
          placeholder="Scene name"
        />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          style={{ width: '100%', resize: 'vertical', minHeight: 50, fontSize: 12 }}
          placeholder="Scene description"
          rows={3}
        />
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          <button
            className="primary"
            onClick={() => updateMutation.mutate({ name, description })}
            disabled={updateMutation.isPending}
            style={{ padding: '4px 10px', fontSize: 12 }}
          >
            {updateMutation.isPending ? 'Saving…' : 'Save'}
          </button>
          <button
            onClick={() => {
              setEditing(false);
              setName(scene.name);
              setDescription(scene.description);
            }}
            style={{ padding: '4px 10px', fontSize: 12 }}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <button
      onClick={onSelect}
      style={{
        display: 'block',
        textAlign: 'left',
        background: selected ? 'var(--accent-bg)' : 'var(--bg)',
        border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
        borderRadius: 6,
        padding: '10px 12px',
        cursor: 'pointer',
        color: 'var(--fg)',
        width: '100%',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 11, color: 'var(--fg-muted)', fontWeight: 600, minWidth: 16 }}>
          {index + 1}
        </span>
        <span
          style={{
            fontSize: 9,
            padding: '1px 6px',
            borderRadius: 3,
            background: typeBadgeColors[scene.type] ?? '#666',
            color: '#fff',
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
          }}
        >
          {scene.type}
        </span>
        <span
          style={{
            fontWeight: 600,
            fontSize: 13,
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={scene.name}
        >
          {scene.name}
        </span>
        {/* Hover-only controls — render always but de-emphasise to keep layout stable */}
        <RowControls
          index={index}
          total={total}
          onMoveUp={(e) => {
            e.stopPropagation();
            onMoveUp();
          }}
          onMoveDown={(e) => {
            e.stopPropagation();
            onMoveDown();
          }}
          onEdit={(e) => {
            e.stopPropagation();
            setEditing(true);
          }}
          onRemove={async (e) => {
            e.stopPropagation();
            const ok = await ui.confirm({
              title: `Remove "${scene.name}"?`,
              body: 'The scene and any associated metadata will be removed from the storyboard. This action cannot be undone.',
              confirmLabel: 'Remove',
              destructive: true,
            });
            if (ok) removeMutation.mutate();
          }}
        />
      </div>

      {/* Status badges row */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <Badge ok={hasRecording} label="📹 Rec" />
        <Badge ok={hasScript} label="📝 Script" />
        <Badge
          ok={totalChunks > 0 && narratedChunks === totalChunks}
          partial={narratedChunks > 0 && narratedChunks < totalChunks}
          label={totalChunks > 0 ? `🔊 ${narratedChunks}/${totalChunks}` : '🔊'}
        />
        <Badge ok={hasLowerThirds} label="🏷️" />
      </div>
    </button>
  );
}

function RowControls({
  index,
  total,
  onMoveUp,
  onMoveDown,
  onEdit,
  onRemove,
}: {
  index: number;
  total: number;
  onMoveUp: (e: React.MouseEvent) => void;
  onMoveDown: (e: React.MouseEvent) => void;
  onEdit: (e: React.MouseEvent) => void;
  onRemove: (e: React.MouseEvent) => void;
}) {
  return (
    <span style={{ display: 'inline-flex', gap: 2, opacity: 0.6 }}>
      <button
        onClick={onMoveUp}
        disabled={index === 0}
        title="Move up"
        style={miniBtnStyle(index === 0)}
      >
        ↑
      </button>
      <button
        onClick={onMoveDown}
        disabled={index === total - 1}
        title="Move down"
        style={miniBtnStyle(index === total - 1)}
      >
        ↓
      </button>
      <button onClick={onEdit} title="Rename" style={miniBtnStyle(false)}>
        ✏️
      </button>
      <button
        onClick={onRemove}
        title="Remove"
        style={{ ...miniBtnStyle(false), color: 'var(--danger)' }}
      >
        ✕
      </button>
    </span>
  );
}

function miniBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: '2px 4px',
    fontSize: 10,
    background: 'transparent',
    border: 'none',
    color: 'inherit',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.3 : 1,
    lineHeight: 1,
  };
}

function Badge({ ok, partial, label }: { ok: boolean; partial?: boolean; label: string }) {
  const tone =
    ok ? { color: 'var(--success)', border: 'var(--success)', bg: 'rgba(94,138,58,0.15)' } :
    partial ? { color: 'var(--warn)', border: 'var(--warn)', bg: 'rgba(244,168,58,0.12)' } :
    { color: 'var(--fg-muted)', border: 'var(--border)', bg: 'transparent' };
  return (
    <span
      style={{
        fontSize: 10,
        padding: '1px 6px',
        borderRadius: 8,
        border: `1px solid ${tone.border}`,
        background: tone.bg,
        color: tone.color,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  );
}

function EmptyStoryboard({ projectId }: { projectId: string }) {
  return (
    <div style={{ padding: '60px 48px', textAlign: 'center' }}>
      <div style={{ fontSize: 40, marginBottom: 16 }}>📋</div>
      <h2 style={{ margin: 0 }}>No storyboard yet</h2>
      <p style={{ color: 'var(--fg-muted)', marginTop: 8, maxWidth: 400, margin: '8px auto 0' }}>
        Start an ideation session to build your storyboard with AI assistance.
      </p>
      <Link
        to={`/project/${projectId}/ideation`}
        className="primary"
        style={{
          display: 'inline-block',
          marginTop: 24,
          padding: '12px 24px',
          borderRadius: 8,
          textDecoration: 'none',
        }}
      >
        Start Ideation
      </Link>
    </div>
  );
}
