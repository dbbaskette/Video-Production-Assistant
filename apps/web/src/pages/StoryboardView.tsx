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

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useSearchParams, useOutletContext, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { presentationsApi, storyboardApi } from '../lib/api.js';
import { useUi } from '../components/ui/UiProvider.js';
import { ScenePage } from './ScenePage.js';
import { SCENE_TYPE_COLOR } from '../lib/palette.js';
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  FileText,
  Maximize2,
  Minimize2,
  Pencil,
  Search,
  Trash2,
  Video,
  Volume2,
  type LucideIcon,
} from 'lucide-react';
import type { PresentationJob, Scene, SceneType, Storyboard } from '@vpa/shared';
import { PresentationImportDialog } from '../components/PresentationImportDialog.js';
import { PresentationProgress } from '../components/PresentationProgress.js';
import {
  PresentationImports,
  type PresentationRemovalContext,
} from '../components/PresentationImports.js';
import {
  canUseSceneShortcut,
  DEFAULT_SCENE_FILTERS,
  displayedSceneOrder,
  filterStoryboardScenes,
  sceneHasNarrationAudio,
  sceneHasScript,
  sceneNeighbor,
  sceneSelectionAfterRemoval,
  type SceneFilters,
  type SceneReadiness,
} from '../lib/storyboard-navigation.js';
import type { WorkspaceOutletContext } from './ProjectWorkspace.js';

const typeBadgeColors: Record<string, string> = SCENE_TYPE_COLOR;
const NOOP_SET_FOCUS = () => undefined;

export function StoryboardView() {
  const { projectId } = useParams<{ projectId: string }>();
  const {
    project,
    focusMode = false,
    setFocusMode = NOOP_SET_FOCUS,
  } = useOutletContext<WorkspaceOutletContext>();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [importOpen, setImportOpen] = useState(false);
  const [activePresentation, setActivePresentation] = useState<PresentationJob | null>(null);
  const [sceneFilters, setSceneFilters] = useState<SceneFilters>(DEFAULT_SCENE_FILTERS);
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
  const selectedScene = scenes.find((scene) => scene.id === selectedSceneId) ?? null;
  const matchingScenes = useMemo(
    () => filterStoryboardScenes(scenes, sceneFilters),
    [scenes, sceneFilters],
  );
  const displayedScenes = useMemo(
    () => displayedSceneOrder(scenes, selectedSceneId, sceneFilters),
    [scenes, selectedSceneId, sceneFilters],
  );
  const selectedOutsideFilters = !!selectedScene
    && !matchingScenes.some((scene) => scene.id === selectedScene.id);
  const previousSceneId = sceneNeighbor(displayedScenes, selectedSceneId, -1);
  const nextSceneId = sceneNeighbor(displayedScenes, selectedSceneId, 1);

  const selectScene = useCallback((sceneId: string) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.set('scene', sceneId);
      return next;
    });
  }, [setSearchParams]);

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
    if (context.freshScenes) {
      normalizeAfterRemoval(context.previousScenes, context.freshScenes);
      return;
    }
    setSearchParams(
      (current) => normalizeStoryboardAfterUnavailableRemoval(current, context.removedSceneIds),
      { replace: true },
    );
  }, [normalizeAfterRemoval, setSearchParams]);

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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!canUseSceneShortcut(event)) return;
      const targetId = event.key === '[' ? previousSceneId : nextSceneId;
      if (!targetId) return;
      event.preventDefault();
      selectScene(targetId);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [nextSceneId, previousSceneId, selectScene]);

  useEffect(() => {
    if (!focusMode) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (document.querySelector('dialog[open], [role="dialog"]')) return;
      setFocusMode(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [focusMode, setFocusMode]);

  useEffect(() => () => {
    setFocusMode(false);
  }, [setFocusMode]);

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

  const renderSceneRow = (scene: Scene) => {
    const index = scenes.findIndex((candidate) => candidate.id === scene.id);
    return (
      <SceneRow
        key={scene.id}
        scene={scene}
        index={index}
        total={scenes.length}
        projectId={projectId!}
        selected={scene.id === selectedSceneId}
        onSelect={() => selectScene(scene.id)}
        onMoveUp={() => moveScene(index, index - 1)}
        onMoveDown={() => moveScene(index, index + 1)}
        onRemoved={(nextScenes) => normalizeAfterRemoval(scenes, nextScenes)}
      />
    );
  };

  const storyboardBody = isLoading ? (
    <div style={{ padding: 40, color: 'var(--fg-muted)' }}>Loading storyboard…</div>
  ) : error ? (
    <div style={{ padding: 40, color: 'var(--danger)' }}>
      Failed to load storyboard: {error instanceof Error ? error.message : 'unknown'}
    </div>
  ) : (
    <div
      className={`storyboard-layout${focusMode ? ' storyboard-layout--focused' : ''}`}
      style={{
        height: '100%',
        minHeight: 'calc(100vh - 56px)', // navbar + breathing room
      }}
    >
      {!focusMode && (
        <aside className="storyboard-rail">
          <header className="storyboard-rail__header">
            <div>
              <h2>Storyboard</h2>
              <p>{scenes.length} {scenes.length === 1 ? 'scene' : 'scenes'}</p>
            </div>
            <button
              type="button"
              className="storyboard-add-presentation"
              onClick={() => setImportOpen(true)}
            >
              Add presentation
            </button>
          </header>

          <div className="storyboard-filter-toolbar" role="search" aria-label="Storyboard scenes">
            <label className="storyboard-filter-search">
              <span>Find a scene</span>
              <span className="storyboard-filter-search__field">
                <Search size={13} aria-hidden="true" />
                <input
                  type="search"
                  aria-label="Search scenes"
                  placeholder="Name or description"
                  value={sceneFilters.query}
                  onChange={(event) => setSceneFilters((current) => ({
                    ...current,
                    query: event.target.value,
                  }))}
                />
              </span>
            </label>
            <label>
              <span>Type</span>
              <select
                aria-label="Scene type"
                value={sceneFilters.type}
                onChange={(event) => setSceneFilters((current) => ({
                  ...current,
                  type: event.target.value as SceneType | 'all',
                }))}
              >
                <option value="all">All types</option>
                <option value="desktop">Desktop</option>
                <option value="browser">Browser</option>
                <option value="terminal">Terminal</option>
                <option value="slide">Slide</option>
              </select>
            </label>
            <label>
              <span>Readiness</span>
              <select
                aria-label="Scene readiness"
                value={sceneFilters.readiness}
                onChange={(event) => setSceneFilters((current) => ({
                  ...current,
                  readiness: event.target.value as SceneReadiness,
                }))}
              >
                <option value="all">All scenes</option>
                <option value="needs-recording">Needs recording</option>
                <option value="needs-script">Needs script</option>
                <option value="needs-narration">Needs narration</option>
              </select>
            </label>
            <div className="storyboard-filter-toolbar__summary">
              <span aria-live="polite">
                {matchingScenes.length} of {scenes.length} scenes
              </span>
              <button
                type="button"
                onClick={() => setSceneFilters(DEFAULT_SCENE_FILTERS)}
                disabled={
                  sceneFilters.query === ''
                  && sceneFilters.type === 'all'
                  && sceneFilters.readiness === 'all'
                }
              >
                Reset
              </button>
            </div>
          </div>

          {storyboard?.project.objective && (
            <p className="storyboard-objective" title={storyboard.project.objective}>
              {storyboard.project.objective.slice(0, 140)}
              {storyboard.project.objective.length > 140 && '…'}
            </p>
          )}

          {selectedOutsideFilters && selectedScene && (
            <section className="storyboard-scene-group storyboard-scene-group--pinned">
              <p>Current scene — outside filters</p>
              {renderSceneRow(selectedScene)}
            </section>
          )}

          <div className="storyboard-scene-list">
            {matchingScenes.map(renderSceneRow)}
            {matchingScenes.length === 0 && (
              <div className="storyboard-filter-empty">
                <strong>No scenes match these filters</strong>
                <span>The current scene stays open while you adjust the list.</span>
                <button type="button" onClick={() => setSceneFilters(DEFAULT_SCENE_FILTERS)}>
                  Reset filters
                </button>
              </div>
            )}
          </div>

          <PresentationImports
            projectId={projectId!}
            scenes={scenes}
            onRemoved={handlePresentationRemoved}
          />

          <div className="storyboard-refine-link">
            <Link to={`/project/${projectId}/ideation`}>✨ Refine in Ideation</Link>
          </div>
        </aside>
      )}

      {/* ── Right rail: embedded scene editor ────────────────── */}
      <section className="storyboard-detail">
        {selectedScene && (
          <SceneContextBar
            scene={selectedScene}
            position={scenes.findIndex((scene) => scene.id === selectedScene.id) + 1}
            total={scenes.length}
            previousSceneId={previousSceneId}
            nextSceneId={nextSceneId}
            onSelect={selectScene}
            focusMode={focusMode}
            onFocusModeChange={setFocusMode}
          />
        )}
        <div className="storyboard-detail__editor">
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
        </div>
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
  const nextSelectedId = sceneSelectionAfterRemoval(
    previousScenes,
    nextScenes,
    selectedId,
  );
  if (nextSelectedId) next.set('scene', nextSelectedId);
  else next.delete('scene');
  return next;
}

export function normalizeStoryboardAfterUnavailableRemoval(
  search: URLSearchParams,
  potentiallyRemovedSceneIds: readonly string[],
): URLSearchParams {
  const next = new URLSearchParams(search);
  const selectedId = search.get('scene');
  if (selectedId && potentiallyRemovedSceneIds.includes(selectedId)) next.delete('scene');
  return next;
}

function isValidPresentationId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function SceneContextBar({
  scene,
  position,
  total,
  previousSceneId,
  nextSceneId,
  onSelect,
  focusMode,
  onFocusModeChange,
}: {
  scene: Scene;
  position: number;
  total: number;
  previousSceneId: string | null;
  nextSceneId: string | null;
  onSelect: (sceneId: string) => void;
  focusMode: boolean;
  onFocusModeChange: (focused: boolean) => void;
}) {
  return (
    <header className="scene-context-bar" aria-label="Current scene">
      <div className="scene-context-bar__identity">
        <span className="scene-context-bar__position">Scene {position} of {total}</span>
        <span
          className="scene-context-bar__type"
          style={{ background: typeBadgeColors[scene.type] ?? '#666' }}
        >
          {scene.type}
        </span>
      </div>
      <h2 className="scene-context-bar__title" title={scene.name}>{scene.name}</h2>
      <div className="scene-context-bar__controls">
        <button
          type="button"
          aria-label="Previous scene"
          title="Previous scene ([)"
          disabled={!previousSceneId}
          onClick={() => previousSceneId && onSelect(previousSceneId)}
        >
          <ChevronLeft size={15} aria-hidden="true" />
          Previous
          <kbd>[</kbd>
        </button>
        <button
          type="button"
          aria-label="Next scene"
          title="Next scene (])"
          disabled={!nextSceneId}
          onClick={() => nextSceneId && onSelect(nextSceneId)}
        >
          Next
          <kbd>]</kbd>
          <ChevronRight size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="scene-context-bar__focus"
          aria-label={focusMode ? 'Exit editor focus' : 'Focus editor'}
          onClick={() => onFocusModeChange(!focusMode)}
        >
          {focusMode
            ? <Minimize2 size={15} aria-hidden="true" />
            : <Maximize2 size={15} aria-hidden="true" />}
          {focusMode ? 'Exit focus' : 'Focus editor'}
        </button>
      </div>
    </header>
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

  const hasRecording = !!scene.recording;
  const hasScript = sceneHasScript(scene);
  const hasNarrationAudio = sceneHasNarrationAudio(scene);
  const chunks = scene.narration?.chunks ?? [];
  const narratedChunks = chunks.filter((chunk) => !!chunk.audio).length;
  const totalChunks = chunks.length;
  const statusDescriptionId = `scene-status-${scene.id}`;

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
      <div className="scene-row scene-row--editing">
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
      className={`scene-row${selected ? ' scene-row--selected' : ''}`}
    >
      <button
        type="button"
        className="scene-row__select"
        aria-label={`Select scene ${scene.name}`}
        aria-describedby={statusDescriptionId}
        aria-pressed={selected}
        onClick={onSelect}
      >
        <span className="scene-row__identity">
          <span className="scene-row__number">{String(index + 1).padStart(2, '0')}</span>
          <span
            className="scene-row__type"
            style={{ background: typeBadgeColors[scene.type] ?? '#666' }}
          >
            {scene.type}
          </span>
        </span>
        <span className="scene-row__title" title={scene.name}>{scene.name}</span>
        <span className="scene-row__statuses" id={statusDescriptionId}>
          <StatusChip
            icon={Video}
            label="Recording"
            value={hasRecording ? 'Ready' : 'Missing'}
            tone={hasRecording ? 'ready' : 'missing'}
          />
          <StatusChip
            icon={FileText}
            label="Script"
            value={hasScript ? 'Ready' : 'Missing'}
            tone={hasScript ? 'ready' : 'missing'}
          />
          <StatusChip
            icon={Volume2}
            label="Narration"
            value={totalChunks > 0 ? `${narratedChunks}/${totalChunks}` : hasNarrationAudio ? 'Ready' : 'Missing'}
            tone={
              hasNarrationAudio && (totalChunks === 0 || narratedChunks === totalChunks)
                ? 'ready'
                : narratedChunks > 0
                  ? 'partial'
                  : 'missing'
            }
          />
        </span>
      </button>
      <RowControls
        index={index}
        total={total}
        sceneName={scene.name}
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
  sceneName,
  onMoveUp,
  onMoveDown,
  onEdit,
  onRemove,
}: {
  index: number;
  total: number;
  sceneName: string;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <span className="scene-row__actions" aria-label={`Actions for ${sceneName}`}>
      <button
        type="button"
        onClick={onMoveUp}
        disabled={index === 0}
        title="Move up"
        aria-label={`Move ${sceneName} up`}
      >
        <ArrowUp size={13} aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={onMoveDown}
        disabled={index === total - 1}
        title="Move down"
        aria-label={`Move ${sceneName} down`}
      >
        <ArrowDown size={13} aria-hidden="true" />
      </button>
      <button type="button" onClick={onEdit} title="Rename" aria-label={`Rename ${sceneName}`}>
        <Pencil size={13} aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={onRemove}
        title="Remove"
        aria-label={`Remove ${sceneName}`}
        className="scene-row__remove"
      >
        <Trash2 size={13} aria-hidden="true" />
      </button>
    </span>
  );
}

function StatusChip({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  tone: 'ready' | 'partial' | 'missing';
}) {
  return (
    <span className={`scene-status scene-status--${tone}`}>
      <Icon size={11} strokeWidth={1.8} aria-hidden="true" />
      <span>{label}</span>
      <strong>{value}</strong>
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
