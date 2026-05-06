import { useEffect, useRef, useState } from 'react';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { storyboardApi, exportApi, api, brandsApi, renderApi, musicApi } from '../lib/api.js';
import { useUi } from '../components/ui/UiProvider.js';
import { CollapsibleSection } from '../components/ui/CollapsibleSection.js';
import { SourceDocsSection } from '../components/SourceDocsSection.js';
import { usePipelineSteps, type PipelineStep } from '../lib/pipeline.js';
// Shared relativeTime helper. Local `timeAgo` alias keeps the rest of
// the file's call sites reading the same as before.
import { relativeTime as timeAgo } from '../lib/format.js';
import {
  Video, FileText, Volume2, Tag, Film, Check, ArrowRight, Layers,
  CircleCheck, ListChecks,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ProjectTrackerEntry } from '@vpa/shared';

interface WorkspaceContext {
  project: ProjectTrackerEntry;
}

export function ProjectOverview() {
  const { project } = useOutletContext<WorkspaceContext>();
  const { projectId } = useParams<{ projectId: string }>();

  // Pipeline steps come from the shared lib/pipeline so the sidebar
  // and this view are always in sync.
  const { steps, next: nextStep } = usePipelineSteps(projectId);
  const { data: storyboard } = useQuery({
    queryKey: ['storyboard', projectId],
    queryFn: () => storyboardApi.get(projectId!),
    enabled: !!projectId,
  });
  const hasStoryboard = !!storyboard && (storyboard.scenes?.length ?? 0) > 0;

  return (
    <div style={{ padding: '40px 48px', maxWidth: 800 }}>
      <h1 style={{ margin: 0, fontSize: 24 }}>{project.name}</h1>
      <p style={{ color: 'var(--fg-muted)', marginTop: 4, fontSize: 13 }}>
        {project.path}
      </p>

      <Pipeline
        steps={steps}
        nextStep={nextStep}
        projectId={project.id}
        hasStoryboard={hasStoryboard}
      />

      {/* ── Reference materials — source docs that ground every AI write ── */}
      <CollapsibleSection
        title="Reference materials"
        defaultOpen
        subtitle="Used as AI context for every generated line"
      >
        <SourceDocsSection projectId={project.id} />
      </CollapsibleSection>

      {/* ── Output — brand, music, finished video, export bundle ────
          Collapsed by default until a storyboard exists; the user
          doesn't need any of this before there are scenes. */}
      <CollapsibleSection
        title="Output"
        defaultOpen={hasStoryboard}
        subtitle="Brand · music · render · export"
      >
        <ProjectBrandSection projectId={project.id} />
        <ProjectMusicAndRender projectId={project.id} hasStoryboard={hasStoryboard} />
      </CollapsibleSection>

      {/* ── Workflow guide — per-scene reference, collapsed by default ── */}
      {hasStoryboard && (
        <CollapsibleSection
          title="Per-scene workflow"
          defaultOpen={false}
          subtitle="Click any scene in the sidebar"
        >
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
            {[
              { Icon: Video, title: 'Recording', desc: 'Upload screen recording' },
              { Icon: FileText, title: 'Script', desc: 'Write or AI-generate narration script' },
              { Icon: Volume2, title: 'Narration', desc: 'Select TTS engine, voice & speed' },
              { Icon: Tag, title: 'Lower Thirds', desc: 'Add title/subtitle overlays' },
            ].map(({ Icon, title, desc }) => (
              <div
                key={title}
                style={{
                  background: 'var(--bg-elev)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '14px 16px',
                  textAlign: 'center',
                }}
              >
                <Icon
                  size={22}
                  strokeWidth={1.5}
                  color="var(--fg-muted)"
                  style={{ marginBottom: 8 }}
                  aria-hidden
                />
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{title}</div>
                <div style={{ fontSize: 11, color: 'var(--fg-muted)', lineHeight: 1.4 }}>{desc}</div>
              </div>
            ))}
          </div>
        </CollapsibleSection>
      )}
    </div>
  );
}

/**
 * Pick the most useful "next step" link based on where the project is in the
 * workflow, render it prominently, and demote the other shortcuts to a small
 * muted row beneath. Keeps the same set of destinations, just clarifies
 * where the user should go.
 */
// ── Pipeline ──────────────────────────────────────────────────────
//
// The signature element of the product. A horizontal stepper that
// shows the workflow as a connected sequence: numbered nodes with
// Lucide glyphs, a filament behind them that fills as steps complete,
// per-step labels + counts, and the next-up step pulsing in violet to
// declare itself as the call to action.
//
// Step computation lives in lib/pipeline so the sidebar renders a
// compact version against the same source of truth.

const STEP_ICONS: Record<string, LucideIcon> = {
  storyboard: ListChecks,
  recordings: Video,
  narration: Volume2,
  'lower-thirds': Tag,
  render: Film,
  review: CircleCheck,
};

function Pipeline({
  steps,
  nextStep,
  projectId,
  hasStoryboard,
}: {
  steps: PipelineStep[];
  nextStep?: PipelineStep;
  projectId: string;
  hasStoryboard: boolean;
}) {
  // The filament behind the row needs to know how far to fill. We
  // count completed steps + half-credit for the "next" step so the
  // user feels progress as soon as they engage with each step.
  const doneIndex = steps.findIndex((s) => s.status !== 'done');
  // doneIndex === -1 means everything's done.
  const completedCount = doneIndex === -1 ? steps.length : doneIndex;
  const total = steps.length;
  const fillRatio =
    total <= 1 ? 1 : Math.min(1, (completedCount + (nextStep ? 0.5 : 0)) / (total - 1));

  return (
    <section className="pipeline" aria-label="Project pipeline">
      {/* Header — section label + next-up CTA. Pulled into the same
          line so the user's eye lands on "where am I → what's next"
          without scrolling between two visual hits. */}
      <div className="pipeline__header">
        <div>
          <span className="pipeline__eyebrow">Workflow</span>
          <h3 className="pipeline__title">{nextStep ? nextStep.label : 'All steps complete'}</h3>
          <p className="pipeline__sub">
            {nextStep
              ? nextStep.detail
                ? `${completedCount} of ${total} done · ${nextStep.detail} remaining`
                : `${completedCount} of ${total} done`
              : 'Ready to ship.'}
          </p>
        </div>
        <div className="pipeline__cta-row">
          {nextStep ? (
            <Link
              to={nextStep.to}
              className="primary pipeline__cta"
              aria-label={`Go to ${nextStep.label}`}
            >
              <span>Continue</span>
              <ArrowRight size={16} strokeWidth={2} aria-hidden />
            </Link>
          ) : (
            <span className="pipeline__complete">
              <Check size={14} strokeWidth={2.5} aria-hidden />
              All steps complete
            </span>
          )}
          {hasStoryboard && <ExportButton projectId={projectId} />}
        </div>
      </div>

      {/* Stepper rail — the filament is a static border that becomes a
          progress fill via the inline width. Steps sit on top of it. */}
      <ol className="pipeline__rail" role="list">
        <div
          aria-hidden
          className="pipeline__filament"
          style={{ width: `calc(${fillRatio * 100}% )` }}
        />
        {steps.map((step, i) => {
          const Icon = STEP_ICONS[step.key] ?? Layers;
          const index = String(i + 1).padStart(2, '0');
          const total = String(steps.length).padStart(2, '0');
          return (
            <li key={step.key} className={`pipeline__step pipeline__step--${step.status}`}>
              <Link
                to={step.to}
                className="pipeline__node"
                aria-label={`Step ${i + 1} of ${steps.length}: ${step.label}${step.detail ? ` — ${step.detail}` : ''}`}
              >
                <span className="pipeline__node-disc">
                  {step.status === 'done' ? (
                    <Check size={16} strokeWidth={2.5} aria-hidden />
                  ) : (
                    <Icon size={16} strokeWidth={1.8} aria-hidden />
                  )}
                </span>
                <span className="pipeline__node-meta">
                  <span className="pipeline__node-num" aria-hidden>
                    {index}
                    <span className="pipeline__node-num-sep">/</span>
                    {total}
                  </span>
                  <span className="pipeline__node-label">{step.label}</span>
                  {step.detail && (
                    <span className="pipeline__node-detail">{step.detail}</span>
                  )}
                </span>
              </Link>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

interface RenderProgressEvent {
  type: 'step';
  step: 'concat-audio' | 'mux-scene' | 'concat-scenes' | 'done';
  sceneIndex?: number;
  sceneId?: string;
  totalScenes?: number;
  message: string;
}

function RenderSection({
  projectId,
  hasStoryboard,
  musicTrackId,
  musicVolumeDb,
  musicEnabled,
}: {
  projectId: string;
  hasStoryboard: boolean;
  musicTrackId: string | null;
  musicVolumeDb: number;
  musicEnabled: boolean;
}) {
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<RenderProgressEvent | null>(null);
  const [doneAt, setDoneAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [audioMode, setAudioMode] = useState<'replace' | 'mix'>('replace');
  const [burnSubtitles, setBurnSubtitles] = useState(false);
  const closeStreamRef = useRef<(() => void) | null>(null);

  const status = useQuery({
    queryKey: ['render-status', projectId],
    queryFn: () => renderApi.status(projectId),
    enabled: hasStoryboard,
  });

  const startRender = useMutation({
    mutationFn: () =>
      renderApi.start(projectId, {
        audioMode,
        burnSubtitles,
        musicTrackId: musicEnabled ? musicTrackId : null,
        musicVolumeDb,
      }),
    onSuccess: ({ jobId }) => {
      setError(null);
      setProgress(null);
      setDoneAt(null);
      // Subscribe to SSE for progress
      closeStreamRef.current?.();
      const close = renderApi.subscribe(jobId, (raw) => {
        // Each event from the queue is shaped as { type, timestamp, data }.
        const evt = raw as { type: string; data?: unknown };
        if (evt.type === 'progress' && evt.data) {
          setProgress(evt.data as RenderProgressEvent);
        } else if (evt.type === 'done') {
          setProgress(null);
          setDoneAt(Date.now());
          queryClient.invalidateQueries({ queryKey: ['render-status', projectId] });
          closeStreamRef.current?.();
          closeStreamRef.current = null;
        } else if (evt.type === 'error') {
          const data = evt.data as { error?: string } | undefined;
          setError(data?.error ?? 'Render failed');
          setProgress(null);
          closeStreamRef.current?.();
          closeStreamRef.current = null;
        }
      });
      closeStreamRef.current = close;
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed to start render'),
  });

  useEffect(() => {
    return () => {
      closeStreamRef.current?.();
    };
  }, []);

  if (!hasStoryboard) return null;

  const exists = status.data?.exists;
  const sizeMb = exists && status.data?.sizeBytes ? (status.data.sizeBytes / 1024 / 1024).toFixed(1) : null;
  const isRunning = startRender.isPending || progress !== null;
  const progressPct = progress && progress.totalScenes && progress.sceneIndex !== undefined
    ? Math.round(((progress.sceneIndex + (progress.step === 'mux-scene' ? 0.5 : 0)) / progress.totalScenes) * 100)
    : progress?.step === 'concat-scenes' ? 95 : null;

  return (
    <div
      style={{
        marginTop: 32,
        background: 'var(--bg-elev)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 20,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 12, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: 1 }}>
            Finished Video
          </div>
          <div style={{ fontSize: 16, fontWeight: 600, marginTop: 4 }}>
            {exists
              ? <>Ready · {sizeMb} MB · <span style={{ fontSize: 12, color: 'var(--fg-muted)', fontWeight: 400 }}>last rendered {timeAgo(status.data?.modifiedAt)}</span></>
              : 'Not rendered yet'}
          </div>
        </div>
      </div>

      {/* Options */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 12, fontSize: 13 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          Audio:
          <select
            value={audioMode}
            onChange={(e) => setAudioMode(e.target.value as 'replace' | 'mix')}
            disabled={isRunning}
            style={{ padding: '4px 8px', background: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 4 }}
          >
            <option value="replace">replace original</option>
            <option value="mix">mix narration over original (-20dB)</option>
          </select>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="checkbox"
            checked={burnSubtitles}
            onChange={(e) => setBurnSubtitles(e.target.checked)}
            disabled={isRunning}
          />
          Burn in subtitles
        </label>
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          onClick={() => startRender.mutate()}
          disabled={isRunning}
          className="btn--accent"
          style={{ padding: '10px 20px', fontSize: 14 }}
        >
          <Film
            size={16}
            strokeWidth={1.6}
            style={{ marginRight: 8, marginBottom: -3, marginTop: -2 }}
            aria-hidden
          />
          {isRunning ? 'Rendering full project…' : exists ? 'Re-render full project' : 'Render full project'}
        </button>
        {exists && (
          <>
            <a
              href={renderApi.videoUrl(projectId)}
              download="final.mp4"
              style={{ fontSize: 13, color: 'var(--accent)', textDecoration: 'none' }}
            >
              Download
            </a>
            <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
              ready-to-share mp4 with narration + lower thirds baked in
            </span>
          </>
        )}
      </div>

      {/* Progress */}
      {progress && (
        <div style={{ marginTop: 12 }}>
          <div style={{
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            height: 8,
            overflow: 'hidden',
          }}>
            <div
              style={{
                background: 'var(--accent)',
                height: '100%',
                width: `${progressPct ?? 0}%`,
                transition: 'width 200ms',
              }}
            />
          </div>
          <p style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 6 }}>
            {progress.message}
            {progressPct !== null && ` (${progressPct}%)`}
          </p>
        </div>
      )}

      {error && (
        <p style={{ fontSize: 13, color: 'var(--danger)', marginTop: 12, whiteSpace: 'pre-wrap' }}>
          {error}
        </p>
      )}

      {/* Inline player */}
      {(exists || doneAt) && !isRunning && (
        <video
          key={status.data?.modifiedAt ?? doneAt}
          src={renderApi.videoUrl(projectId)}
          controls
          playsInline
          preload="metadata"
          style={{
            display: 'block',
            width: '100%',
            maxWidth: 720,
            marginTop: 16,
            borderRadius: 6,
            background: '#000',
          }}
        />
      )}
    </div>
  );
}


/**
 * Holds the shared music selection state so the BackgroundMusicSection (where
 * tracks are generated and picked) and the RenderSection (which mixes the
 * selected track in) stay in sync without prop-drilling through ProjectOverview.
 */
function ProjectMusicAndRender({
  projectId,
  hasStoryboard,
}: {
  projectId: string;
  hasStoryboard: boolean;
}) {
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  const [musicEnabled, setMusicEnabled] = useState(true);
  const [musicVolumeDb, setMusicVolumeDb] = useState(-20);
  // Order: BackgroundMusic (with the mix-into-render controls embedded
  // as its footer) → RenderSection. Previously the mix controls floated
  // between the two cards with `marginTop: -16` overlapping into the
  // gap, which made the volume slider look like it belonged to neither
  // card. Now it's clearly part of the music card it actually controls.
  return (
    <>
      <BackgroundMusicSection
        projectId={projectId}
        selectedTrackId={selectedTrackId}
        onSelect={setSelectedTrackId}
        musicEnabled={musicEnabled}
        onEnabledChange={setMusicEnabled}
        musicVolumeDb={musicVolumeDb}
        onVolumeChange={setMusicVolumeDb}
      />
      <RenderSection
        projectId={projectId}
        hasStoryboard={hasStoryboard}
        musicTrackId={selectedTrackId}
        musicEnabled={musicEnabled && !!selectedTrackId}
        musicVolumeDb={musicVolumeDb}
      />
    </>
  );
}

function BackgroundMusicSection({
  projectId,
  selectedTrackId,
  onSelect,
  musicEnabled,
  onEnabledChange,
  musicVolumeDb,
  onVolumeChange,
}: {
  projectId: string;
  selectedTrackId: string | null;
  onSelect: (trackId: string | null) => void;
  musicEnabled: boolean;
  onEnabledChange: (next: boolean) => void;
  musicVolumeDb: number;
  onVolumeChange: (next: number) => void;
}) {
  const queryClient = useQueryClient();
  const ui = useUi();
  const tracksQuery = useQuery({
    queryKey: ['music', projectId],
    queryFn: () => musicApi.list(projectId),
  });
  const [prompt, setPrompt] = useState('');
  const [progressMessage, setProgressMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef<(() => void) | null>(null);

  const tracks = tracksQuery.data ?? [];

  // Auto-select the most recent track when it lands
  useEffect(() => {
    if (!selectedTrackId && tracks.length > 0) {
      onSelect(tracks[0]!.id);
    }
  }, [tracks, selectedTrackId, onSelect]);

  useEffect(() => () => { closeRef.current?.(); }, []);

  const generate = useMutation({
    mutationFn: () =>
      // 30-second clips loop across the video. Plenty for a demo bed; faster
      // and cheaper than the Pro model.
      musicApi.generate(projectId, { prompt: prompt.trim(), model: 'clip' }),
    onSuccess: ({ jobId }) => {
      setError(null);
      setProgressMessage('Generating…');
      closeRef.current?.();
      const close = musicApi.subscribe(jobId, (raw) => {
        const evt = raw as { type: string; data?: { message?: string; track?: { id: string }; error?: string } };
        if (evt.type === 'progress') {
          setProgressMessage(evt.data?.message ?? 'Generating…');
        } else if (evt.type === 'done') {
          setProgressMessage(null);
          queryClient.invalidateQueries({ queryKey: ['music', projectId] });
          // Newly-generated track becomes the selection
          const tid = evt.data?.track?.id;
          if (tid) onSelect(tid);
          closeRef.current?.();
          closeRef.current = null;
        } else if (evt.type === 'error') {
          setProgressMessage(null);
          setError(evt.data?.error ?? 'Music generation failed');
          closeRef.current?.();
          closeRef.current = null;
        }
      });
      closeRef.current = close;
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed to start'),
  });

  const remove = useMutation({
    mutationFn: (trackId: string) => musicApi.remove(projectId, trackId),
    onSuccess: (_, trackId) => {
      if (selectedTrackId === trackId) onSelect(null);
      queryClient.invalidateQueries({ queryKey: ['music', projectId] });
    },
  });

  const isBusy = generate.isPending || progressMessage !== null;

  return (
    <div
      style={{
        marginTop: 32,
        background: 'var(--bg-elev)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 20,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 12, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: 1 }}>
            Background Music
          </div>
          <div style={{ fontSize: 16, fontWeight: 600, marginTop: 4 }}>
            {tracks.length === 0
              ? 'None yet — describe the vibe and generate a 30-second loop'
              : `${tracks.length} loop${tracks.length === 1 ? '' : 's'}`}
          </div>
        </div>
      </div>

      <textarea
        rows={2}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value.slice(0, 1500))}
        placeholder="e.g. calm low-key tech demo loop, soft piano and pads, no vocals, consistent feel — a 30-second bed that loops cleanly"
        disabled={isBusy}
        style={{
          width: '100%',
          padding: 8,
          background: 'var(--bg)',
          color: 'var(--fg)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          fontSize: 13,
          fontFamily: 'inherit',
          resize: 'vertical',
        }}
      />
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
        <button
          onClick={() => generate.mutate()}
          disabled={isBusy || prompt.trim().length === 0}
          className="primary"
          style={{ padding: '8px 16px', fontSize: 13 }}
        >
          {isBusy ? (progressMessage ?? 'Working…') : 'Generate 30-Second Bed'}
        </button>
        <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
          {prompt.length} / 1500 · Lyria 3 · loops to fit any video length
        </span>
      </div>

      {error && (
        <p style={{ fontSize: 12, color: 'var(--danger)', margin: '10px 0 0', whiteSpace: 'pre-wrap' }}>{error}</p>
      )}

      {/* Mix-into-render controls — these used to float between this card
          and the Render card with a negative margin overlap that made the
          volume slider look orphaned. Now they sit inside this card,
          where the user can clearly see they belong to the music
          selection above. They're only useful when a track is selected,
          so we conditionally render below the track list. */}

      {tracks.length > 0 && (
        <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {tracks.map((t) => {
            const isSelected = t.id === selectedTrackId;
            return (
              <div
                key={t.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '8px 12px',
                  background: isSelected ? 'var(--accent-bg)' : 'var(--bg)',
                  border: `1px solid ${isSelected ? 'var(--accent)' : 'var(--border)'}`,
                  borderRadius: 6,
                }}
              >
                <input
                  type="radio"
                  name="bg-music-selection"
                  checked={isSelected}
                  onChange={() => onSelect(t.id)}
                  aria-label={`Use ${t.prompt.slice(0, 40)}`}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
                    {(t.sizeBytes / 1024).toFixed(0)} KB ·{' '}
                    {new Date(t.generatedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    {t.model === 'pro' ? ' · Pro (legacy)' : ''}
                  </div>
                  <div
                    style={{
                      fontSize: 13,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      display: '-webkit-box',
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical' as const,
                    }}
                    title={t.prompt}
                  >
                    {t.prompt}
                  </div>
                </div>
                <audio
                  src={musicApi.audioUrl(projectId, t.id)}
                  controls
                  preload="none"
                  style={{ width: 240 }}
                />
                <button
                  onClick={async () => {
                    const ok = await ui.confirm({
                      title: 'Delete track?',
                      body: `"${t.prompt.slice(0, 80)}${t.prompt.length > 80 ? '…' : ''}"`,
                      confirmLabel: 'Delete',
                      destructive: true,
                    });
                    if (ok) remove.mutate(t.id);
                  }}
                  disabled={remove.isPending}
                  title="Delete track"
                  style={{
                    padding: '4px 10px',
                    fontSize: 12,
                    color: 'var(--danger)',
                    background: 'transparent',
                    border: '1px solid var(--danger)',
                    borderRadius: 4,
                    cursor: 'pointer',
                  }}
                >
                  Delete
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Mix controls (only when a track is selected). Sits within the
          card border, so the volume slider visibly belongs to the music
          it controls — no more orphan negative-margin layout. */}
      {selectedTrackId && (
        <div
          style={{
            marginTop: 16,
            paddingTop: 14,
            borderTop: '1px dashed var(--border)',
            display: 'flex',
            gap: 16,
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
            <input
              type="checkbox"
              checked={musicEnabled}
              onChange={(e) => onEnabledChange(e.target.checked)}
            />
            Mix into the next render
          </label>
          <label
            style={{
              display: 'flex',
              gap: 6,
              alignItems: 'center',
              fontSize: 13,
              opacity: musicEnabled ? 1 : 0.5,
            }}
          >
            Volume:
            <input
              type="range"
              min={-30}
              max={0}
              step={1}
              value={musicVolumeDb}
              disabled={!musicEnabled}
              onChange={(e) => onVolumeChange(Number.parseInt(e.target.value, 10))}
              style={{ width: 160 }}
            />
            <span style={{ fontFamily: 'monospace', minWidth: 48 }}>{musicVolumeDb} dB</span>
          </label>
          <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
            -20 dB sits comfortably under narration; 0 dB is full volume.
          </span>
        </div>
      )}
    </div>
  );
}

function ProjectBrandSection({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const sectionRef = useRef<HTMLDivElement>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  const [highlight, setHighlight] = useState(false);

  // When the route lands with #brand, scroll the section into view, focus the
  // picker, and flash a subtle highlight so it's obvious which control to use.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.location.hash !== '#brand') return;
    sectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlight(true);
    const focusTimer = window.setTimeout(() => selectRef.current?.focus(), 350);
    const fadeTimer = window.setTimeout(() => setHighlight(false), 1800);
    return () => {
      window.clearTimeout(focusTimer);
      window.clearTimeout(fadeTimer);
    };
  }, []);

  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.getProject(projectId),
  });

  const { data: registry } = useQuery({
    queryKey: ['brands'],
    queryFn: () => brandsApi.list(),
  });

  const setBrand = useMutation({
    mutationFn: (brand: { id: string; applied_version: number } | null) =>
      api.setProjectBrand(projectId, brand),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
    },
  });

  const appliedBrandId = project?.brand?.id ?? null;
  const appliedBrand = registry?.brands.find((b) => b.id === appliedBrandId) ?? null;

  return (
    <div
      id="brand"
      ref={sectionRef}
      style={{
        marginTop: 32,
        background: 'var(--bg-elev)',
        border: highlight ? '1px solid var(--accent)' : '1px solid var(--border)',
        boxShadow: highlight ? '0 0 0 3px var(--accent-bg)' : 'none',
        borderRadius: 8,
        padding: 20,
        transition: 'border-color 200ms, box-shadow 600ms',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 12,
        }}
      >
        <div>
          <div style={{ fontSize: 12, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: 1 }}>
            Brand
          </div>
          <div style={{ fontSize: 16, fontWeight: 600, marginTop: 4 }}>
            {appliedBrand
              ? `${appliedBrand.name} (v${project?.brand?.applied_version ?? appliedBrand.version})`
              : 'No brand applied'}
          </div>
        </div>
        <Link
          to="/brands"
          style={{
            fontSize: 12,
            color: 'var(--fg-muted)',
            textDecoration: 'none',
            border: '1px solid var(--border)',
            padding: '4px 10px',
            borderRadius: 6,
          }}
        >
          Manage brands →
        </Link>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <select
          ref={selectRef}
          value={appliedBrandId ?? ''}
          onChange={(e) => {
            const id = e.target.value;
            if (!id) {
              setBrand.mutate(null);
              return;
            }
            const entry = registry?.brands.find((b) => b.id === id);
            if (entry) setBrand.mutate({ id: entry.id, applied_version: entry.version });
          }}
          disabled={setBrand.isPending || !registry}
          style={{
            padding: '6px 10px',
            borderRadius: 6,
            background: 'var(--bg)',
            color: 'var(--fg)',
            border: '1px solid var(--border)',
            fontSize: 13,
            minWidth: 200,
          }}
        >
          <option value="">— None —</option>
          {registry?.brands.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
              {b.id === registry.default_brand_id ? ' (default)' : ''}
            </option>
          ))}
        </select>
        {setBrand.isPending && <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>Saving...</span>}
        {setBrand.isError && (
          <span style={{ fontSize: 12, color: 'var(--danger)' }}>
            {setBrand.error instanceof Error ? setBrand.error.message : 'Save failed'}
          </span>
        )}
      </div>
    </div>
  );
}

function ExportButton({ projectId }: { projectId: string }) {
  const [exportDir, setExportDir] = useState<string | null>(null);

  const exportMutation = useMutation({
    mutationFn: () => exportApi.run(projectId),
    onSuccess: (data) => setExportDir(data.exportDir),
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <button
        onClick={() => exportMutation.mutate()}
        disabled={exportMutation.isPending}
        style={{
          padding: '12px 24px',
          background: exportMutation.isPending ? 'var(--bg-elev)' : 'var(--accent)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          color: '#fff',
          cursor: exportMutation.isPending ? 'wait' : 'pointer',
          fontWeight: 600,
          fontSize: 14,
        }}
      >
        {exportMutation.isPending ? 'Exporting…' : 'Export Source Assets'}
      </button>
      {exportDir && (
        <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
          Exported to: {exportDir}
        </span>
      )}
      <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
        Bundle of source clips + narration + subtitles for an external editor (Final Cut, Premiere, etc.)
      </span>
      {exportMutation.isError && (
        <span style={{ fontSize: 11, color: 'var(--danger)' }}>
          {exportMutation.error instanceof Error ? exportMutation.error.message : 'Export failed'}
        </span>
      )}
    </div>
  );
}
