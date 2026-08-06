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

import { useState, useEffect, useCallback } from 'react';
import { useParams, useSearchParams, useOutletContext, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { presentationsApi, storyboardApi } from '../lib/api.js';
import { useUi } from '../components/ui/UiProvider.js';
import { ScenePage } from './ScenePage.js';
import { SCENE_TYPE_COLOR } from '../lib/palette.js';
import { Video, FileText, Volume2, Tag, Clapperboard } from 'lucide-react';
import type { PresentationJob, Scene, Storyboard, ProjectTrackerEntry } from '@vpa/shared';
import type { LucideIcon } from 'lucide-react';
import { PresentationImportDialog } from '../components/PresentationImportDialog.js';
import { PresentationProgress } from '../components/PresentationProgress.js';
import {
  PresentationImports,
  type PresentationRemovalContext,
} from '../components/PresentationImports.js';

interface WorkspaceContext {
  project: ProjectTrackerEntry;
}

const typeBadgeColors: Record<string, string> = SCENE_TYPE_COLOR;

export function StoryboardView() {
  const { projectId } = useParams<{ projectId: string }>();
  const { project } = useOutletContext<WorkspaceContext>();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [importOpen, setImportOpen] = useState(false);
  const [activePresentation, setActivePresentation] = useState<PresentationJob | null>(null);
  const presentationId = searchParams.get('presentation');
  const hasPresentationId = presentationId !== null;
  const presentationIdValid = presentationId !== null && isValidPresentationId(presentationId);

  const { data: storyboard, isLoading, error } = useQuery({
    queryKey: ['storyboard', projectId],
    queryFn: () => storyboardApi.get(projectId!),
    enabled: !!projectId,
  });

  const presentationQuery = useQuery({
    queryKey: ['presentation', projectId, presentationId],
    queryFn: () => presentationsApi.get(projectId!, presentationId!),
    enabled: !!projectId
      && presentationIdValid
      && activePresentation?.id !== presentationId,
    retry: false,
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

  const normalizeAfterRemoval = useCallback((
    previousScenes: readonly { id: string }[],
    nextScenes: readonly { id: string }[],
  ) => {
    setSearchParams(
      (current) => normalizeStoryboardAfterRemoval(current, previousScenes, nextScenes),
      { replace: true },
    );
  }, [setSearchParams]);

  const handlePresentationRemoved = useCallback((context: PresentationRemovalContext) => {
    const latest = queryClient.getQueryData<Storyboard | null>(['storyboard', projectId]);
    normalizeAfterRemoval(context.previousScenes, latest?.scenes ?? []);
  }, [normalizeAfterRemoval, projectId, queryClient]);

  useEffect(() => {
    if (!hasPresentationId || !presentationIdValid) {
      if (hasPresentationId) setActivePresentation(null);
      return;
    }
    setActivePresentation((current) => current?.id === presentationId ? current : null);
  }, [hasPresentationId, presentationId, presentationIdValid]);

  useEffect(() => {
    if (presentationQuery.data?.id === presentationId) {
      setActivePresentation(presentationQuery.data);
    }
  }, [presentationId, presentationQuery.data]);

  // When the URL doesn't carry ?scene yet but scenes are loaded, normalise
  // so the URL reflects the displayed selection (makes deep-linking + the
  // SaveIndicator's tab-survives-refresh behavior consistent).
  useEffect(() => {
    const next = normalizeStoryboardSearch(searchParams, scenes[0]?.id ?? null);
    if (next) setSearchParams(next, { replace: true });
  }, [scenes, searchParams, setSearchParams]);

  const closePresentation = useCallback(() => {
    setActivePresentation(null);
    setSearchParams((current) => removePresentationSearch(current), { replace: true });
  }, [setSearchParams]);

  const handleTerminal = useCallback((job: PresentationJob) => {
    setActivePresentation(job);
    setSearchParams((current) => removePresentationSearch(current), { replace: true });
  }, [setSearchParams]);

  const acceptPresentation = useCallback((job: PresentationJob) => {
    setActivePresentation(job);
    setImportOpen(false);
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.set('presentation', job.id);
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const ownedPresentation = activePresentation
    && (activePresentation.id === presentationId || presentationId === null)
    ? activePresentation
    : null;
  const presentationSurface = ownedPresentation ? (
    <PresentationProgress
      key={ownedPresentation.id}
      projectId={projectId!}
      initialJob={ownedPresentation}
      onClose={closePresentation}
      onTerminal={handleTerminal}
    />
  ) : presentationIdValid && presentationQuery.isPending ? (
    <section className="presentation-progress" aria-live="polite">
      <div className="presentation-progress__heading-row">
        <div>
          <h3>Loading presentation progress…</h3>
          <p>Checking the latest slide import status.</p>
        </div>
        <button type="button" onClick={closePresentation}>Close</button>
      </div>
    </section>
  ) : hasPresentationId && (!presentationIdValid || presentationQuery.isError) ? (
    <section className="presentation-progress presentation-progress--error" role="alert">
      <div className="presentation-progress__heading-row">
        <div>
          <h3>Presentation progress unavailable</h3>
          <p>Close this update and add the PDF again if you still need these slides.</p>
        </div>
        <button type="button" onClick={closePresentation}>Close</button>
      </div>
    </section>
  ) : null;

  const importDialog = importOpen ? (
    <PresentationImportDialog
      projectId={projectId!}
      open
      onAccepted={acceptPresentation}
      onClose={() => setImportOpen(false)}
    />
  ) : null;

  const moveScene = (fromIndex: number, toIndex: number) => {
    const ids = scenes.map((s) => s.id);
    const [moved] = ids.splice(fromIndex, 1);
    ids.splice(toIndex, 0, moved!);
    reorderMutation.mutate(ids);
  };

  const storyboardBody = isLoading ? (
    <div style={{ padding: 40, color: 'var(--fg-muted)' }}>Loading storyboard…</div>
  ) : error ? (
    <div style={{ padding: 40, color: 'var(--danger)' }}>
      Failed to load storyboard: {error instanceof Error ? error.message : 'unknown'}
    </div>
  ) : (
    <div
      className="storyboard-layout"
      style={{
        height: '100%',
        minHeight: 'calc(100vh - 56px)', // navbar + breathing room
      }}
    >

      {/* ── Left rail: scene list ────────────────────────────── */}
      <aside
        className="storyboard-rail"
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
          <button
            type="button"
            className="storyboard-add-presentation"
            onClick={() => setImportOpen(true)}
          >
            Add presentation
          </button>
        </header>

        {storyboard?.project.objective && (
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
                // Preserve ?tab= when switching scenes — the typical
                // workflow is reviewing the same tab (Narration chunks,
                // Lower Thirds, etc.) across multiple scenes. Resetting
                // to Recording on each click made multi-scene review
                // tedious.
                const next = new URLSearchParams(searchParams);
                next.set('scene', scene.id);
                setSearchParams(next);
              }}
              onMoveUp={() => moveScene(idx, idx - 1)}
              onMoveDown={() => moveScene(idx, idx + 1)}
              onRemoved={(nextScenes) => normalizeAfterRemoval(scenes, nextScenes)}
            />
          ))}
        </div>

        <PresentationImports
          projectId={projectId!}
          scenes={scenes}
          onRemoved={handlePresentationRemoved}
        />

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
      <section className="storyboard-detail" style={{ overflowY: 'auto', padding: '24px 32px' }}>
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
          <EmptyStoryboard projectId={projectId!} onAddPresentation={() => setImportOpen(true)} />
        )}
      </section>
    </div>
  );

  return (
    <div className="storyboard-view">
      <div className="storyboard-presentation-owner">{presentationSurface}</div>
      {storyboardBody}
      {importDialog}
    </div>
  );
}

export function removePresentationSearch(search: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(search);
  next.delete('presentation');
  return next;
}

export function normalizeStoryboardSearch(
  search: URLSearchParams,
  firstSceneId: string | null,
): URLSearchParams | null {
  if (!firstSceneId || search.has('scene')) return null;
  const next = new URLSearchParams(search);
  next.set('scene', firstSceneId);
  return next;
}

export function normalizeStoryboardAfterRemoval(
  search: URLSearchParams,
  previousScenes: readonly { id: string }[],
  nextScenes: readonly { id: string }[],
): URLSearchParams {
  const next = new URLSearchParams(search);
  const selectedId = search.get('scene');
  if (selectedId && nextScenes.some((scene) => scene.id === selectedId)) return next;

  const previousIndex = selectedId
    ? previousScenes.findIndex((scene) => scene.id === selectedId)
    : 0;
  const safeIndex = previousIndex >= 0 ? previousIndex : 0;
  const selected = nextScenes[safeIndex]
    ?? nextScenes[safeIndex - 1]
    ?? nextScenes[0]
    ?? null;
  if (selected) next.set('scene', selected.id);
  else next.delete('scene');
  return next;
}

function isValidPresentationId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
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
  onRemoved,
}: {
  scene: Scene;
  index: number;
  total: number;
  projectId: string;
  selected: boolean;
  onSelect: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemoved: (nextScenes: Scene[]) => void;
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
    onSuccess: async (nextStoryboard) => {
      queryClient.setQueryData(['storyboard', projectId], nextStoryboard);
      const invalidations: Promise<unknown>[] = [
        queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] }),
      ];
      if (scene.presentation_source) {
        invalidations.push(queryClient.invalidateQueries({ queryKey: ['presentations', projectId] }));
      }
      await Promise.all(invalidations);
      const latest = queryClient.getQueryData<Storyboard | null>(['storyboard', projectId]);
      onRemoved(latest?.scenes ?? nextStoryboard.scenes);
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
    const cancel = () => {
      setEditing(false);
      setName(scene.name);
      setDescription(scene.description);
    };
    const submit = () => {
      if (!updateMutation.isPending) updateMutation.mutate({ name, description });
    };
    const onKeyDown: React.KeyboardEventHandler<HTMLInputElement | HTMLTextAreaElement> = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        submit();
      }
    };
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
          onKeyDown={onKeyDown}
          autoFocus
          style={{ width: '100%', marginBottom: 6, fontSize: 13, fontWeight: 600 }}
          placeholder="Scene name"
        />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={onKeyDown}
          style={{ width: '100%', resize: 'vertical', minHeight: 50, fontSize: 12 }}
          placeholder="Scene description"
          rows={3}
        />
        <div style={{ display: 'flex', gap: 6, marginTop: 6, alignItems: 'center' }}>
          <button
            className="primary"
            onClick={submit}
            disabled={updateMutation.isPending}
            style={{ padding: '4px 10px', fontSize: 12 }}
          >
            {updateMutation.isPending ? 'Saving…' : 'Save'}
          </button>
          <button onClick={cancel} style={{ padding: '4px 10px', fontSize: 12 }}>
            Cancel
          </button>
          <span style={{ fontSize: 10, color: 'var(--fg-muted)', marginLeft: 'auto' }}>
            ⌘↵ save · esc cancel
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      className="scene-row"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        background: selected ? 'var(--accent-bg)' : 'var(--bg)',
        border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
        borderRadius: 6,
        color: 'var(--fg)',
        width: '100%',
      }}
    >
      <button
        type="button"
        className="scene-row__select"
        aria-label={`Select scene ${scene.name}`}
        aria-pressed={selected}
        onClick={onSelect}
        style={{
          minWidth: 0,
          flex: 1,
          padding: '10px 8px 10px 12px',
          border: 0,
          background: 'transparent',
          color: 'inherit',
          cursor: 'pointer',
          textAlign: 'left',
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
      </div>

      {/* Status badges row — Lucide icons + tiny labels render as a
          uniform glyph row across operating systems (was emoji which
          shifted in size + colour per platform). */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <Badge ok={hasRecording} icon={Video} label="Rec" />
        <Badge ok={hasScript} icon={FileText} label="Script" />
        <Badge
          ok={totalChunks > 0 && narratedChunks === totalChunks}
          partial={narratedChunks > 0 && narratedChunks < totalChunks}
          icon={Volume2}
          label={totalChunks > 0 ? `${narratedChunks}/${totalChunks}` : ''}
        />
        <Badge ok={hasLowerThirds} icon={Tag} />
      </div>
      </button>
      {/* Independent actions stay outside the scene-selection button. */}
      <RowControls
        index={index}
        total={total}
        onMoveUp={onMoveUp}
        onMoveDown={onMoveDown}
        onEdit={() => setEditing(true)}
        onRemove={async () => {
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
  onMoveUp: () => void;
  onMoveDown: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <span style={{ display: 'inline-flex', flex: '0 0 auto', gap: 2, padding: '8px 8px 0 0', opacity: 0.6 }}>
      <button
        type="button"
        onClick={onMoveUp}
        disabled={index === 0}
        title="Move up"
        aria-label="Move up"
        style={miniBtnStyle(index === 0)}
      >
        ↑
      </button>
      <button
        type="button"
        onClick={onMoveDown}
        disabled={index === total - 1}
        title="Move down"
        aria-label="Move down"
        style={miniBtnStyle(index === total - 1)}
      >
        ↓
      </button>
      <button type="button" onClick={onEdit} title="Rename" aria-label="Rename" style={miniBtnStyle(false)}>
        ✏️
      </button>
      <button
        type="button"
        onClick={onRemove}
        title="Remove"
        aria-label="Remove"
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

function Badge({
  ok,
  partial,
  icon: Icon,
  label,
}: {
  ok: boolean;
  partial?: boolean;
  icon: LucideIcon;
  label?: string;
}) {
  const tone = ok
    ? { color: 'var(--success)', border: 'var(--success)', bg: 'rgba(115,192,90,0.12)' }
    : partial
      ? { color: 'var(--warn)', border: 'var(--warn)', bg: 'rgba(244,168,58,0.12)' }
      : { color: 'var(--fg-muted)', border: 'var(--border)', bg: 'transparent' };
  return (
    <span
      style={{
        fontSize: 10,
        padding: '2px 6px',
        borderRadius: 8,
        border: `1px solid ${tone.border}`,
        background: tone.bg,
        color: tone.color,
        whiteSpace: 'nowrap',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        lineHeight: 1.2,
      }}
    >
      <Icon size={11} strokeWidth={1.8} aria-hidden />
      {label}
    </span>
  );
}

function EmptyStoryboard({
  projectId,
  onAddPresentation,
}: {
  projectId: string;
  onAddPresentation(): void;
}) {
  return (
    <div style={{ padding: '60px 48px', textAlign: 'center' }}>
      <Clapperboard
        size={44}
        strokeWidth={1.2}
        color="var(--fg-dim)"
        style={{ marginBottom: 16 }}
        aria-hidden
      />
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
      <button
        type="button"
        className="storyboard-empty-add-presentation"
        onClick={onAddPresentation}
      >
        Add presentation
      </button>
    </div>
  );
}
