import { useEffect, useRef, useState } from 'react';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { storyboardApi, exportApi, api, brandsApi, renderApi, musicApi, framesApi } from '../lib/api.js';
import { useUi } from '../components/ui/UiProvider.js';
import { CollapsibleSection } from '../components/ui/CollapsibleSection.js';
import { SourceDocsSection } from '../components/SourceDocsSection.js';
import { FrameStylePicker } from '../components/FrameStylePicker.js';
import { usePipelineSteps, type PipelineStep } from '../lib/pipeline.js';
// Shared relativeTime helper. Local `timeAgo` alias keeps the rest of
// the file's call sites reading the same as before.
import { relativeTime as timeAgo } from '../lib/format.js';
import {
  Video, FileText, Volume2, Tag, Film, Check, ArrowRight, Layers,
  CircleCheck, ListChecks,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ProjectTrackerEntry, Storyboard } from '@vpa/shared';
import { computeActionItems } from '../lib/scene-health.js';
import { SnapshotHistory } from '../components/SnapshotHistory.js';

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

      {/* Granular action items — surfaces scene-level issues that the
          high-level pipeline can't (e.g. "scene-04 narration overruns the
          recording by 1.4s"). Renders below the pipeline so the workflow
          stepper stays the main wayfinding signal; this is a focused punch
          list for the specific scene the user should touch next. */}
      {hasStoryboard && storyboard && projectId && (
        <ActionItemsCard projectId={projectId} storyboard={storyboard} />
      )}

      {/* ── Reference materials — source docs that ground every AI write ── */}
      <CollapsibleSection
        title="Reference materials"
        defaultOpen
        subtitle="Used as AI context for every generated line"
      >
        <SourceDocsSection projectId={project.id} />
      </CollapsibleSection>

      {/* ── Brand — project-level brand selection / styling. Music + Render
          used to live here too, but they now have a dedicated /render page
          (sidebar "Render" entry lands there) so the overview stays focused
          on setup and progress. */}
      <CollapsibleSection
        title="Brand"
        defaultOpen={hasStoryboard}
        subtitle="Project-level branding & styling"
        anchorHash="brand"
      >
        <ProjectBrandSection projectId={project.id} />
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

      {/* ── Snapshot history — rolling backups, restore on click ── */}
      <CollapsibleSection
        title="History"
        defaultOpen={false}
        subtitle="Roll back to a previous save"
        anchorHash="history"
      >
        <SnapshotHistory projectId={project.id} />
      </CollapsibleSection>
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

      {/* Stepper rail — the filament is the progress fill behind the
          nodes. Its length is set via the --fill custom property so CSS
          can map it to width (horizontal) or height (vertical) without
          fighting an inline width style. */}
      <ol
        className="pipeline__rail"
        role="list"
        style={{ ['--fill' as string]: `${fillRatio * 100}%` }}
      >
        <div aria-hidden className="pipeline__filament" />
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
  projectName,
  hasStoryboard,
  musicTrackId,
  musicVolumeDb,
  musicEnabled,
}: {
  projectId: string;
  projectName: string;
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
  // Narration & lower-thirds are OPTIONAL in the final render. The user can
  // generate them for a subset of scenes (or none) and still ship the video
  // using the recording's original audio / without burned overlays. Defaults
  // are populated from the storyboard below: ON if any scene has the data,
  // OFF if the project is bare. The user can flip either at render time.
  const [includeNarration, setIncludeNarration] = useState<boolean | null>(null);
  const [includeLowerThirds, setIncludeLowerThirds] = useState<boolean | null>(null);
  // Brand asset toggles. Both default to true when the linked brand actually
  // has the asset (smart default — match the narration / lower-thirds pattern).
  const [useBrandBumpers, setUseBrandBumpers] = useState<boolean | null>(null);
  const [useBrandMusic, setUseBrandMusic] = useState<boolean | null>(null);
  // Where music plays: 'full' timeline (default) or only over the bumpers.
  const [musicScope, setMusicScope] = useState<'full' | 'bumpers'>('full');
  const closeStreamRef = useRef<(() => void) | null>(null);

  const status = useQuery({
    queryKey: ['render-status', projectId],
    queryFn: () => renderApi.status(projectId),
    enabled: hasStoryboard,
  });

  // Frame style defaults — fetched from storyboard (already cached by ProjectOverview)
  // and from the frames manifest.
  const storyboardQuery = useQuery({
    queryKey: ['storyboard', projectId],
    queryFn: () => storyboardApi.get(projectId),
    enabled: !!projectId,
  });

  // Detect whether any scene actually has narration / lower-thirds. Used to
  // (a) drive the smart default for the render-time toggles and (b) tell the
  // user when a toggle is moot (no data to include in the first place).
  const sb = storyboardQuery.data;
  const hasAnyNarration = !!sb?.scenes?.some(
    (s) => s.narration?.audio || (s.narration?.chunks?.length ?? 0) > 0,
  );
  const hasAnyLowerThirds = !!sb?.scenes?.some(
    (s) => (s.lower_thirds?.length ?? 0) > 0,
  );

  // Project → brand → audio assets. We need to know what bumpers / default
  // music the linked brand provides so we can render the Brand assets section
  // with previews + Include toggles. Two queries: getProject (cheap; just
  // gives us brand.id) then brandsApi.detail (loads the full design.md).
  const projectQuery = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.getProject(projectId),
    enabled: !!projectId,
  });
  const brandSlug = projectQuery.data?.brand?.id ?? null;
  const brandQuery = useQuery({
    queryKey: ['brand', brandSlug],
    queryFn: () => brandsApi.detail(brandSlug!),
    enabled: !!brandSlug,
  });
  const brandAudio = brandQuery.data?.doc.frontMatter.vpa?.audio as
    | {
        bumper_intro?: string | null;
        bumper_outro?: string | null;
        default_music_track?: string | null;
      }
    | undefined;
  const brandHasBumpers = !!(brandAudio?.bumper_intro || brandAudio?.bumper_outro);
  const brandHasMusic = !!brandAudio?.default_music_track;

  // Hydrate the include toggles once storyboard data is available. `null` is
  // the "not yet decided" sentinel — we keep it null until the storyboard
  // loads so the user's explicit choice (if any) is never overwritten.
  useEffect(() => {
    if (sb && includeNarration === null) {
      setIncludeNarration(hasAnyNarration);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sb, hasAnyNarration]);
  useEffect(() => {
    if (sb && includeLowerThirds === null) {
      setIncludeLowerThirds(hasAnyLowerThirds);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sb, hasAnyLowerThirds]);
  // Same hydrate pattern for brand toggles — default ON when the brand has
  // the asset; users can flip explicitly to opt out.
  useEffect(() => {
    if (brandQuery.data && useBrandBumpers === null) setUseBrandBumpers(brandHasBumpers);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandQuery.data, brandHasBumpers]);
  useEffect(() => {
    if (brandQuery.data && useBrandMusic === null) setUseBrandMusic(brandHasMusic);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandQuery.data, brandHasMusic]);
  const effectiveIncludeNarration = includeNarration ?? hasAnyNarration;
  const effectiveIncludeLowerThirds = includeLowerThirds ?? hasAnyLowerThirds;
  const effectiveUseBrandBumpers = useBrandBumpers ?? brandHasBumpers;
  const effectiveUseBrandMusic = useBrandMusic ?? brandHasMusic;
  // Will music actually be mixed into this render? (project track enabled, or
  // the brand's default music applies because no project track is chosen)
  const musicActiveInRender =
    musicEnabled || (!musicTrackId && effectiveUseBrandMusic && brandHasMusic);
  // Will a bumper appear? 'bumpers'-only music needs one, so we coerce back to
  // 'full' when there isn't one (the UI also disables the option).
  const bumpersActiveInRender = effectiveUseBrandBumpers && brandHasBumpers;
  const effectiveMusicScope: 'full' | 'bumpers' =
    musicScope === 'bumpers' && bumpersActiveInRender && musicActiveInRender ? 'bumpers' : 'full';
  const framesQuery = useQuery({
    queryKey: ['frames'],
    queryFn: () => framesApi.list(),
  });
  const updateDefaultsMutation = useMutation({
    mutationFn: (next: { frame_style?: string | null; frame_background?: 'brand' | 'transparent' | string | null }) =>
      storyboardApi.updateDefaults(projectId, next),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] });
    },
  });

  const startRender = useMutation({
    mutationFn: () =>
      renderApi.start(projectId, {
        audioMode,
        burnSubtitles,
        includeNarration: effectiveIncludeNarration,
        includeLowerThirds: effectiveIncludeLowerThirds,
        musicTrackId: musicEnabled ? musicTrackId : null,
        musicVolumeDb,
        musicScope: effectiveMusicScope,
        useBrandBumpers: effectiveUseBrandBumpers,
        useBrandMusic: effectiveUseBrandMusic,
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
          <input
            type="checkbox"
            checked={effectiveIncludeNarration}
            onChange={(e) => setIncludeNarration(e.target.checked)}
            disabled={isRunning || !hasAnyNarration}
          />
          <span>
            Include narration
            {!hasAnyNarration && (
              <span style={{ color: 'var(--fg-muted)', marginLeft: 6 }}>(none generated)</span>
            )}
          </span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="checkbox"
            checked={effectiveIncludeLowerThirds}
            onChange={(e) => setIncludeLowerThirds(e.target.checked)}
            disabled={isRunning || !hasAnyLowerThirds}
          />
          <span>
            Include lower thirds
            {!hasAnyLowerThirds && (
              <span style={{ color: 'var(--fg-muted)', marginLeft: 6 }}>(none added)</span>
            )}
          </span>
        </label>
        {/* Audio / subtitles options only matter when narration is included. */}
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            opacity: effectiveIncludeNarration ? 1 : 0.5,
          }}
        >
          Audio:
          <select
            value={audioMode}
            onChange={(e) => setAudioMode(e.target.value as 'replace' | 'mix')}
            disabled={isRunning || !effectiveIncludeNarration}
            style={{ padding: '4px 8px', background: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 4 }}
          >
            <option value="replace">replace original</option>
            <option value="mix">mix narration over original (-20dB)</option>
          </select>
        </label>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            opacity: effectiveIncludeNarration ? 1 : 0.5,
          }}
        >
          <input
            type="checkbox"
            checked={burnSubtitles}
            onChange={(e) => setBurnSubtitles(e.target.checked)}
            disabled={isRunning || !effectiveIncludeNarration}
          />
          Burn in subtitles
        </label>
      </div>

      {/* Brand assets — shown only when the project is linked to a brand AND
          the brand actually has bumpers / default music. Pure visibility +
          opt-out: the render auto-applies these otherwise. */}
      {brandSlug && (brandHasBumpers || brandHasMusic) && (
        <BrandAssetsSection
          slug={brandSlug}
          bumperIntro={brandAudio?.bumper_intro ?? null}
          bumperOutro={brandAudio?.bumper_outro ?? null}
          defaultMusic={brandAudio?.default_music_track ?? null}
          useBumpers={effectiveUseBrandBumpers}
          useMusic={effectiveUseBrandMusic}
          onChangeBumpers={setUseBrandBumpers}
          onChangeMusic={setUseBrandMusic}
          disabled={isRunning}
          projectMusicSelected={musicEnabled && !!musicTrackId}
          musicScope={musicScope}
          onMusicScopeChange={setMusicScope}
          musicActive={musicActiveInRender}
        />
      )}

      {/* Frame style — project-level default applied to all scenes unless overridden */}
      {framesQuery.data && (
        <div
          style={{
            marginBottom: 16,
            paddingTop: 14,
            borderTop: '1px dashed var(--border)',
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.6, color: 'var(--fg-muted)', marginBottom: 10 }}>
            Frame style (project default)
          </div>
          {framesQuery.data.length === 0 ? (
            <p style={{ fontSize: 12, color: 'var(--fg-muted)', margin: 0 }}>
              No frame templates found.
            </p>
          ) : (
            <>
              <FrameStylePicker
                frames={framesQuery.data}
                value={{
                  frameStyle: storyboardQuery.data?.defaults?.frame_style ?? null,
                  frameBackground: storyboardQuery.data?.defaults?.frame_background ?? null,
                }}
                onChange={(next) =>
                  updateDefaultsMutation.mutate({
                    frame_style: next.frameStyle,
                    frame_background: next.frameBackground,
                  })
                }
              />
              {updateDefaultsMutation.isPending && (
                <p style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 6, marginBottom: 0 }}>Saving…</p>
              )}
              {updateDefaultsMutation.isError && (
                <p style={{ fontSize: 11, color: 'var(--danger)', marginTop: 6, marginBottom: 0 }}>
                  {updateDefaultsMutation.error instanceof Error
                    ? updateDefaultsMutation.error.message
                    : 'Save failed'}
                </p>
              )}
              <p style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 8, marginBottom: 0 }}>
                Applied to every scene unless overridden on the scene's Recording tab.
              </p>
            </>
          )}
        </div>
      )}
      {framesQuery.isError && (
        <p style={{ fontSize: 11, color: 'var(--danger)', marginBottom: 12 }}>
          Could not load frame templates.
        </p>
      )}

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
            {/* `download` HTML attribute alone is ignored cross-origin (web on
                :5173, API on :3000). The server-side handler honours
                `?download=1` by sending Content-Disposition: attachment, which
                forces a download instead of inline playback. */}
            <a
              href={renderApi.downloadUrl(projectId, `${projectName}.mp4`)}
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
 * Brand assets card on the Render page. Surfaces the bumpers + default music
 * the linked brand will contribute to this render, with per-asset Include
 * toggles. Hidden entirely when the project has no brand or the brand has
 * none of these assets — there's nothing to show.
 *
 * The render route auto-applies these when set; this card just makes that
 * visible and gives the user an opt-out for a given render.
 */
function BrandAssetsSection({
  slug,
  bumperIntro,
  bumperOutro,
  defaultMusic,
  useBumpers,
  useMusic,
  onChangeBumpers,
  onChangeMusic,
  disabled,
  projectMusicSelected,
  musicScope,
  onMusicScopeChange,
  musicActive,
}: {
  slug: string;
  bumperIntro: string | null;
  bumperOutro: string | null;
  defaultMusic: string | null;
  useBumpers: boolean;
  useMusic: boolean;
  onChangeBumpers: (v: boolean) => void;
  onChangeMusic: (v: boolean) => void;
  disabled: boolean;
  /** Whether the user has explicitly picked a project-level music track. When
   *  true, the brand's default music is overridden regardless of `useMusic`,
   *  so we dim that toggle and explain. */
  projectMusicSelected: boolean;
  /** 'full' or 'bumpers' — where background music plays in the render. */
  musicScope: 'full' | 'bumpers';
  onMusicScopeChange: (v: 'full' | 'bumpers') => void;
  /** Whether any music will actually be mixed into this render. The
   *  bumpers-only option is meaningless (disabled) without music. */
  musicActive: boolean;
}) {
  const hasBumpers = !!(bumperIntro || bumperOutro);
  const hasMusic = !!defaultMusic;

  return (
    <div
      style={{
        marginBottom: 16,
        paddingTop: 14,
        borderTop: '1px dashed var(--border)',
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: 0.6,
          color: 'var(--fg-muted)',
          marginBottom: 10,
        }}
      >
        Brand assets ({slug})
      </div>

      <div style={{ display: 'grid', gap: 14 }}>
        {hasBumpers && (
          <div>
            <label
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 13,
                marginBottom: 8,
              }}
            >
              <input
                type="checkbox"
                checked={useBumpers}
                onChange={(e) => onChangeBumpers(e.target.checked)}
                disabled={disabled}
              />
              <span style={{ fontWeight: 500 }}>
                Include bumpers
                {bumperIntro && bumperOutro
                  ? ' (start + end)'
                  : bumperIntro
                    ? ' (start only)'
                    : ' (end only)'}
              </span>
            </label>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                gap: 10,
                opacity: useBumpers ? 1 : 0.4,
                transition: 'opacity 120ms',
              }}
            >
              {bumperIntro && (
                <BumperPreview slug={slug} relPath={bumperIntro} label="Start" />
              )}
              {bumperOutro && (
                <BumperPreview slug={slug} relPath={bumperOutro} label="End" />
              )}
            </div>

            {/* Music scope — only meaningful when bumpers ARE included and
                some music is actually playing. Per design, we disable (not
                hide) with a hint so the option is discoverable but never
                produces a silent render. */}
            {(() => {
              const canScope = useBumpers && musicActive;
              const hint = !musicActive
                ? 'Add or enable background music first'
                : !useBumpers
                  ? 'Turn on “Include bumpers” first'
                  : undefined;
              return (
                <label
                  title={hint}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    fontSize: 13,
                    marginTop: 12,
                    opacity: canScope ? 1 : 0.45,
                    cursor: canScope && !disabled ? 'pointer' : 'not-allowed',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={canScope && musicScope === 'bumpers'}
                    disabled={disabled || !canScope}
                    onChange={(e) => onMusicScopeChange(e.target.checked ? 'bumpers' : 'full')}
                  />
                  <span>Play background music only over the bumpers</span>
                </label>
              );
            })()}
          </div>
        )}

        {hasMusic && (
          <div>
            <label
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 13,
                marginBottom: 8,
                opacity: projectMusicSelected ? 0.5 : 1,
              }}
            >
              <input
                type="checkbox"
                checked={useMusic && !projectMusicSelected}
                onChange={(e) => onChangeMusic(e.target.checked)}
                disabled={disabled || projectMusicSelected}
              />
              <span style={{ fontWeight: 500 }}>
                Use brand default music
                {projectMusicSelected && (
                  <span style={{ color: 'var(--fg-muted)', marginLeft: 6, fontWeight: 400 }}>
                    (overridden by selected project track)
                  </span>
                )}
              </span>
            </label>
            <audio
              src={brandsApi.assetUrl(slug, defaultMusic!)}
              controls
              preload="metadata"
              style={{
                width: '100%',
                maxWidth: 360,
                opacity: useMusic && !projectMusicSelected ? 1 : 0.5,
                transition: 'opacity 120ms',
              }}
            />
            <p
              style={{
                fontSize: 11,
                color: 'var(--fg-muted)',
                margin: '6px 0 0',
              }}
            >
              {defaultMusic!.split('/').pop()}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/** Tiny inline video preview for a single bumper slot. */
function BumperPreview({
  slug,
  relPath,
  label,
}: {
  slug: string;
  relPath: string;
  label: string;
}) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginBottom: 4 }}>
        {label} · {relPath.split('/').pop()}
      </div>
      <video
        src={brandsApi.assetUrl(slug, relPath)}
        controls
        muted
        playsInline
        preload="metadata"
        style={{
          width: '100%',
          aspectRatio: '16 / 9',
          background: '#000',
          borderRadius: 6,
        }}
      />
    </div>
  );
}


/**
 * Holds the shared music selection state so the BackgroundMusicSection (where
 * tracks are generated and picked) and the RenderSection (which mixes the
 * selected track in) stay in sync without prop-drilling through ProjectOverview.
 *
 * Exported so the dedicated /render page can reuse this assembly without
 * duplicating the music/render plumbing.
 */
export function ProjectMusicAndRender({
  projectId,
  projectName,
  hasStoryboard,
}: {
  projectId: string;
  projectName: string;
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
        projectName={projectName}
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
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !isBusy && prompt.trim().length > 0) {
            e.preventDefault();
            generate.mutate();
          }
        }}
        placeholder="e.g. calm low-key tech demo loop, soft piano and pads, no vocals, consistent feel — a 30-second bed that loops cleanly  (⌘↵ to generate)"
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

  // Auto-dismiss the success line after a few seconds so it doesn't
  // linger across navigations and look like a fresh result.
  useEffect(() => {
    if (!exportDir) return;
    const t = window.setTimeout(() => setExportDir(null), 6000);
    return () => window.clearTimeout(t);
  }, [exportDir]);

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

// ── ActionItemsCard ─────────────────────────────────────────────────
//
// Scene-granular "what's blocking you" punch list. The Pipeline above
// answers at the workflow-step level ("you're on Script"); this answers
// at the scene level ("scene-04 needs TTS regenerated"). Computes
// items client-side from the storyboard so it's always live without
// running Quality Review.
//
// Items render in priority order (most blocking first); we cap at 5 to
// keep the card scannable. The card itself hides when there's nothing
// actionable — Pipeline alone handles the happy path.

function ActionItemsCard({ projectId, storyboard }: { projectId: string; storyboard: Storyboard }) {
  const items = computeActionItems(storyboard);
  if (items.length === 0) return null;
  return (
    <div
      style={{
        marginTop: 16,
        padding: 16,
        background: 'var(--bg-elev)',
        border: '1px solid var(--border)',
        borderRadius: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
        <h3 style={{ margin: 0, fontSize: 14 }}>Needs attention</h3>
        <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
          {items.length} scene{items.length === 1 ? '' : 's'}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {items.map((item, idx) => (
          <Link
            key={`${item.sceneId}-${idx}`}
            to={`/project/${projectId}/storyboard?scene=${encodeURIComponent(item.sceneId)}&tab=${encodeURIComponent(item.tab)}`}
            style={{
              display: 'flex',
              gap: 10,
              alignItems: 'center',
              padding: '8px 12px',
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              textDecoration: 'none',
              color: 'inherit',
              fontSize: 12,
              transition: 'border-color 120ms',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--accent)')}
            onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--border)')}
          >
            <span
              style={{
                fontSize: 9,
                padding: '2px 6px',
                borderRadius: 3,
                background: item.severity === 'issue' ? 'var(--danger)' : 'var(--warn, #d4a017)',
                color: '#fff',
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: 0.5,
                whiteSpace: 'nowrap',
              }}
            >
              {item.severity}
            </span>
            <span style={{ fontWeight: 500, whiteSpace: 'nowrap' }}>{item.sceneName}</span>
            <span style={{ color: 'var(--fg-muted)', flex: 1 }}>{item.message}</span>
            <span style={{ color: 'var(--accent)', fontSize: 11, whiteSpace: 'nowrap' }}>
              Open {item.tab} →
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
