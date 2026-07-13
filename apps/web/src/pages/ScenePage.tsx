import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useOutletContext, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { storyboardApi, recordingsApi, scriptApi, ttsApi, voiceApi, narrationApi, lowerThirdsApi, overlayApi, settingsApi, framesApi } from '../lib/api.js';
import { FrameStylePicker } from '../components/FrameStylePicker.js';
import type { LowerThirdItem, VoiceProfileInfo, NarrationChunkInfo, TtsEngineInfo, SpeakerConfig } from '../lib/api.js';
import { RecordingUpload } from '../components/RecordingUpload.js';
import { ShotPlanSection } from '../components/ShotPlanSection.js';
import { RecordingInfo } from '../components/RecordingInfo.js';
import { TransitionPicker, type SceneTransition } from '../components/TransitionPicker.js';
import { ScenePreview } from '../components/ScenePreview.js';
import { SceneRenderSection } from '../components/SceneRenderSection.js';
import { useUi } from '../components/ui/UiProvider.js';
import { estimateTtsCost, formatUsd } from '../lib/tts-pricing.js';
import { GenerationModal } from '../components/ui/GenerationModal.js';
import { FieldStatus, type FieldSaveState } from '../components/ui/FieldStatus.js';
import { RefreshCcw, Sparkles, Upload } from 'lucide-react';
import { SCENE_TYPE_COLOR, STATUS_COLOR } from '../lib/palette.js';
import type { ProjectTrackerEntry } from '@vpa/shared';
import { TightenScriptModal } from '../components/TightenScriptModal.js';
import { PolishScriptModal } from '../components/PolishScriptModal.js';
import { classifyFit, computeProjectWpm } from '../lib/wpm.js';
import { LowerThirdsTimeline } from '../components/LowerThirdsTimeline.js';
import { confirmDestructiveSave } from '../lib/destructive-save.js';

interface WorkspaceContext {
  project: ProjectTrackerEntry;
}

const typeBadgeColors: Record<string, string> = SCENE_TYPE_COLOR;

const TABS = ['Recording', 'Script', 'Narration', 'Lower Thirds', 'Preview'] as const;
type Tab = (typeof TABS)[number];

/** useOutletContext that returns undefined instead of throwing when there's no Outlet. */
function useOutletContextSafe<T>(): T | undefined {
  try {
    return useOutletContext<T>();
  } catch {
    return undefined;
  }
}

/**
 * ScenePage props. All optional — when omitted we fall back to react-router's
 * useParams + useOutletContext (the route-mounted use). When provided, the
 * caller controls projectId / sceneId / project, which is how StoryboardView
 * embeds the editor in its master-detail layout.
 */
export interface ScenePageProps {
  projectId?: string;
  sceneId?: string;
  project?: ProjectTrackerEntry;
  /** When true, the embedded mode hides the breadcrumb-y outer chrome
   *  (top scene name + description) since the host page already shows them. */
  embedded?: boolean;
}

export function ScenePage(props: ScenePageProps = {}) {
  const params = useParams<{ projectId: string; sceneId: string }>();
  // useOutletContext throws when called outside an Outlet — guard for the
  // embedded case where there's no parent Outlet.
  const outletProject = useOutletContextSafe<WorkspaceContext>()?.project;
  const projectId = props.projectId ?? params.projectId;
  const sceneId = props.sceneId ?? params.sceneId;
  const project = props.project ?? outletProject;
  const embedded = props.embedded ?? false;
  // Quality Review can deep-link with ?tab=Script (etc.) so a click-to-jump
  // Tab state is mirrored to ?tab= in the URL so it survives:
  //   • a refresh
  //   • switching to a different scene in StoryboardView (the user
  //     reviewing chunks across scenes shouldn't be bounced back to
  //     Recording on every click)
  //   • being deep-linked from Quality Review's click-to-jump
  // Validate against TABS to avoid setting arbitrary state from a URL.
  const [searchParams, setSearchParams] = useSearchParams();
  const tabFromUrl = ((): Tab => {
    const fromUrl = searchParams.get('tab');
    if (fromUrl && (TABS as readonly string[]).includes(fromUrl)) return fromUrl as Tab;
    return 'Recording';
  })();
  const [activeTab, setActiveTab] = useState<Tab>(tabFromUrl);

  // Keep the URL in sync when the user clicks a different tab pill.
  // Effect on activeTab change rather than wrapping setActiveTab so we
  // don't break the existing render-derived initial value or any other
  // setActiveTab callers that might land later.
  useEffect(() => {
    if (searchParams.get('tab') === activeTab) return;
    const next = new URLSearchParams(searchParams);
    if (activeTab === 'Recording') {
      // Recording is the default; drop the param to keep URLs short.
      next.delete('tab');
    } else {
      next.set('tab', activeTab);
    }
    setSearchParams(next, { replace: true });
  }, [activeTab, searchParams, setSearchParams]);

  // Pull tab from URL when it changes externally (StoryboardView changes
  // ?scene= without touching ?tab=, deep links, browser back/forward).
  useEffect(() => {
    if (tabFromUrl !== activeTab) setActiveTab(tabFromUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabFromUrl]);
  const [editingScript, setEditingScript] = useState<string | null>(null);
  const [scriptDirty, setScriptDirty] = useState(false);
  const [editingDialogScript, setEditingDialogScript] = useState<string | null>(null);
  const [dialogEditDirty, setDialogEditDirty] = useState(false);
  // Which sub-tab of the consolidated script editor is visible. Replaces
  // the previous design where Monologue + Dialog were stacked vertically
  // and edited independently with their own dirty pip / Save / Discard.
  // Now one editor is visible at a time; Regenerate (top button) checks
  // both panes' dirty state before clobbering them.
  const [scriptViewTab, setScriptViewTab] = useState<'monologue' | 'dialog'>('monologue');
  /** When true, the TightenScriptModal is mounted for this scene. */
  const [tightenOpen, setTightenOpen] = useState(false);
  // Script input mode (radio at the top of the Script tab):
  //   'describe' — the user describes the scene, AI writes it (the existing
  //                intent + Generate flow).
  //   'byo'      — the user pastes their own script, AI evaluates + polishes
  //                it (adds emotives, fits to the recording) via PolishScriptModal.
  const [scriptInputMode, setScriptInputMode] = useState<'describe' | 'byo'>('describe');
  /** The user's pasted draft, in 'byo' mode. Local-only; not persisted until
   *  the polished result is accepted and saved. */
  const [draftScript, setDraftScript] = useState('');
  /** When true, the PolishScriptModal is mounted for this scene. */
  const [polishOpen, setPolishOpen] = useState(false);
  // Whether to ground the next script generation in the actual video (Gemini
  // Files API). Defaults to true when the active provider is Gemini and the
  // scene has a recording — see effect below. User can untick to fall back
  // to the (faster, cheaper) text-only path.
  const [groundInVideo, setGroundInVideo] = useState(true);
  const [showReplaceUpload, setShowReplaceUpload] = useState(false);
  const generateAbortRef = useRef<AbortController | null>(null);
  // Local edit buffer for the user-authored "what is this scene
  // demonstrating?" string. Hydrated from the storyboard scene; saved on
  // blur via saveIntentMutation.
  const [intentDraft, setIntentDraft] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const ui = useUi();

  const { data: storyboard } = useQuery({
    queryKey: ['storyboard', projectId],
    queryFn: () => storyboardApi.get(projectId!),
    enabled: !!projectId,
  });

  // Active model — used to gate the "ground in video" toggle. Only Gemini
  // accepts video natively; everything else falls back to text-only.
  const { data: activeModel } = useQuery({
    queryKey: ['active-model'],
    queryFn: () => settingsApi.getActiveModel(),
    staleTime: 60_000,
  });

  const scene = storyboard?.scenes.find((s) => s.id === sceneId);
  const canGroundInVideo = activeModel?.provider === 'gemini' && !!scene?.recording;

  const uploadMutation = useMutation({
    mutationFn: (file: File) => recordingsApi.uploadForScene(projectId!, sceneId!, file),
    onSuccess: (_data, file) => {
      setShowReplaceUpload(false);
      queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] });
      ui.showToast({
        message: 'Recording replaced',
        detail: file.name,
        tone: 'success',
      });
    },
  });

  // Persist the user's scene-intent edit. Saved on blur from the textarea
  // on the Script tab. Empty string clears the field server-side.
  const saveIntentMutation = useMutation({
    mutationFn: (intent: string) => scriptApi.saveIntent(projectId!, sceneId!, intent),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] });
    },
  });

  // Hydrate the local intent draft once when the scene loads or sceneId
  // changes. Keying off sceneId (not the scene object) avoids clobbering
  // unsaved edits every time the storyboard query refetches.
  useEffect(() => {
    setIntentDraft(scene?.intent ?? '');
  }, [sceneId, scene?.intent]);

  // Re-analyze the recording. Two-step UX:
  //   1. Click "Re-analyze" → server runs the analysis with dryRun:true,
  //      returns proposed + current values without saving.
  //   2. Diff panel shows old vs new; user clicks Apply or Cancel.
  // This replaces the previous immediate-overwrite behaviour (which
  // silently destroyed any manual edits the user had typed).
  const [reanalyzeGroundInVideo, setReanalyzeGroundInVideo] = useState(true);
  const [analyzePreview, setAnalyzePreview] = useState<
    | null
    | {
        proposed: { name: string; description: string; type: string };
        current: { name: string; description: string; type: string };
        mode: 'text' | 'video';
      }
  >(null);
  const reanalyzeMutation = useMutation({
    mutationFn: () =>
      recordingsApi.reanalyze(projectId!, sceneId!, {
        groundInVideo: reanalyzeGroundInVideo && canGroundInVideo,
        dryRun: true,
      }),
    onSuccess: (data) => {
      if ('dryRun' in data && data.dryRun) {
        setAnalyzePreview({
          proposed: data.proposed,
          current: data.current,
          mode: data.mode,
        });
      }
    },
  });
  const applyAnalyzeMutation = useMutation({
    mutationFn: (proposed: { name: string; description: string; type: string }) =>
      recordingsApi.saveSceneMetadata(projectId!, sceneId!, proposed),
    onSuccess: () => {
      setAnalyzePreview(null);
      queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] });
    },
  });

  // Saves the per-scene out-transition picked in the Recording tab. `cut` and
  // `null` durations are normalised so the server can clear the fields cleanly.
  const saveTransitionMutation = useMutation({
    mutationFn: (patch: { transition: string; transition_duration_sec: number | null }) =>
      recordingsApi.saveSceneMetadata(projectId!, sceneId!, {
        transition: patch.transition === 'cut' ? null : patch.transition,
        transition_duration_sec: patch.transition === 'cut' ? null : patch.transition_duration_sec,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] });
    },
  });

  // Per-scene frame style + background. Each can be cleared independently
  // (null on the wire = clear override, fall back to project default).
  const saveFrameMutation = useMutation({
    mutationFn: (patch: {
      frame_style?: string | null;
      frame_background?: string | null;
    }) => recordingsApi.saveSceneMetadata(projectId!, sceneId!, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] });
    },
  });

  // Frame template catalogue — cached app-wide so opening multiple scenes
  // doesn't re-fetch. Shared with the project-default picker on /render.
  const framesQuery = useQuery({
    queryKey: ['frames'],
    queryFn: () => framesApi.list(),
  });

  const generateScriptMutation = useMutation({
    mutationFn: () => {
      const controller = new AbortController();
      generateAbortRef.current = controller;
      return scriptApi.generate(projectId!, sceneId!, {
        groundInVideo: groundInVideo && canGroundInVideo,
        signal: controller.signal,
      });
    },
    onSuccess: (data) => {
      generateAbortRef.current = null;
      setEditingScript(data.script);
      setEditingDialogScript(null);
      setScriptDirty(false);
      setDialogEditDirty(false);
      queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] });
      queryClient.invalidateQueries({ queryKey: ['narration', projectId, sceneId] });
    },
    onError: () => {
      generateAbortRef.current = null;
    },
  });

  const saveMonologueMutation = useMutation({
    mutationFn: (script: string) => narrationApi.saveScript(projectId!, sceneId!, script, 'monologue'),
    onSuccess: () => {
      setScriptDirty(false);
      queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] });
      queryClient.invalidateQueries({ queryKey: ['narration', projectId, sceneId] });
      queryClient.invalidateQueries({ queryKey: ['script', projectId, sceneId] });
      ui.showToast({ message: 'Monologue script saved. Existing TTS chunks were cleared.', tone: 'success' });
    },
    onError: (err) => {
      ui.showToast({ message: `Save failed: ${err instanceof Error ? err.message : 'unknown error'}`, tone: 'error' });
    },
  });

  const saveDialogMutation = useMutation({
    mutationFn: (script: string) => narrationApi.saveScript(projectId!, sceneId!, script, 'dialog'),
    onSuccess: () => {
      setDialogEditDirty(false);
      queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] });
      queryClient.invalidateQueries({ queryKey: ['narration', projectId, sceneId] });
      queryClient.invalidateQueries({ queryKey: ['script', projectId, sceneId] });
      ui.showToast({ message: 'Dialog script saved. Existing TTS chunks were cleared.', tone: 'success' });
    },
    onError: (err) => {
      ui.showToast({ message: `Save failed: ${err instanceof Error ? err.message : 'unknown error'}`, tone: 'error' });
    },
  });

  const restoreMonologueMutation = useMutation({
    mutationFn: () => narrationApi.restoreScript(projectId!, sceneId!, 'monologue'),
    onSuccess: (data) => {
      setEditingScript(data.script);
      setScriptDirty(false);
      queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] });
      queryClient.invalidateQueries({ queryKey: ['narration', projectId, sceneId] });
      queryClient.invalidateQueries({ queryKey: ['script', projectId, sceneId] });
    },
  });

  const restoreDialogMutation = useMutation({
    mutationFn: () => narrationApi.restoreScript(projectId!, sceneId!, 'dialog'),
    onSuccess: (data) => {
      setEditingDialogScript(data.script);
      setDialogEditDirty(false);
      queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] });
      queryClient.invalidateQueries({ queryKey: ['narration', projectId, sceneId] });
      queryClient.invalidateQueries({ queryKey: ['script', projectId, sceneId] });
    },
  });

  // Tab queries pre-fetch on scene load instead of gating on activeTab.
  // The previous behavior caused a 200–500ms "Loading…" flash on every
  // tab switch because the query didn't fire until the tab was active.
  // Now everything is requested in parallel as soon as the user lands
  // on a scene, so switching tabs is instant. Cost is small (4 cheap
  // requests on mount) compared to the felt slowness on every click.
  const { data: scriptState } = useQuery({
    queryKey: ['script', projectId, sceneId],
    queryFn: () => scriptApi.get(projectId!, sceneId!),
    enabled: !!projectId && !!sceneId,
  });

  // NOTE: monologue script sync moved after narrationState declaration

  // --- Narration state ---
  const [selectedEngine, setSelectedEngine] = useState('fake');
  const [selectedVoice, setSelectedVoice] = useState('alice');
  const [selectedSpeed, setSelectedSpeed] = useState(1.0);
  const [editedChunks, setEditedChunks] = useState<Map<number, string>>(new Map());
  const [chunkScriptDirty, setChunkScriptDirty] = useState(false);
  const [generatingChunks, setGeneratingChunks] = useState<Set<number>>(new Set());
  const [generateAllProgress, setGenerateAllProgress] = useState<{ done: number; total: number; failed: number; message?: string } | null>(null);
  const [generateAllJobId, setGenerateAllJobId] = useState<string | null>(null);
  const generateAllCloseRef = useRef<(() => void) | null>(null);
  // Cache-bust key for audio elements after regeneration
  const audioCacheBust = useRef(0);
  // Dialog mode state
  const [narrationMode, setNarrationMode] = useState<'monologue' | 'dialog'>('monologue');
  const [speakerConfigs, setSpeakerConfigs] = useState<Record<string, SpeakerConfig>>({});
  const [chunkSpeakers, setChunkSpeakers] = useState<Map<number, string>>(new Map());
  const [convertingDialog, setConvertingDialog] = useState(false);
  const [convertError, setConvertError] = useState<string | null>(null);

  // TTS engine + voice lists are tiny and stable — fetch once at app
  // level (not gated to activeTab) so opening the Narration tab never
  // shows a loading state.
  const { data: engines } = useQuery({
    queryKey: ['tts-engines'],
    queryFn: () => ttsApi.listEngines(),
    staleTime: 5 * 60_000,
  });
  const { data: voiceProfiles } = useQuery({
    queryKey: ['voice-profiles'],
    queryFn: () => voiceApi.list(),
    staleTime: 60_000,
  });
  // Narration state is per-scene; pre-fetch on scene mount so all
  // tabs that use it (Narration, Script, Preview) render immediately.
  const { data: narrationState } = useQuery({
    queryKey: ['narration', projectId, sceneId],
    queryFn: () => narrationApi.get(projectId!, sceneId!),
    enabled: !!projectId && !!sceneId,
  });

  // Sync engine/voice from narration state when it loads
  useEffect(() => {
    if (narrationState?.tts) {
      if (narrationState.tts.engine) setSelectedEngine(narrationState.tts.engine);
      if (narrationState.tts.voice) setSelectedVoice(narrationState.tts.voice);
      if (narrationState.tts.speed) setSelectedSpeed(narrationState.tts.speed);
    }
    if (narrationState?.mode) {
      setNarrationMode(narrationState.mode);
    }
    if (narrationState?.speakers && Object.keys(narrationState.speakers).length > 0) {
      setSpeakerConfigs(narrationState.speakers);
    }
    // Load per-chunk speaker assignments
    if (narrationState?.chunks) {
      const assignments = new Map<number, string>();
      narrationState.chunks.forEach((c) => {
        if (c.speaker) assignments.set(c.index, c.speaker);
      });
      setChunkSpeakers(assignments);
    }
  }, [narrationState]);

  // Sync monologue script — ONLY use monologueScript, never scriptState.script (which could be dialog text)
  useEffect(() => {
    if (editingScript !== null) return;
    if (narrationState?.monologueScript) {
      setEditingScript(narrationState.monologueScript);
    }
  }, [narrationState?.monologueScript, editingScript]);

  // Sync dialog script when narration data loads
  useEffect(() => {
    if (editingDialogScript !== null) return;
    if (narrationState?.dialogScript) {
      setEditingDialogScript(narrationState.dialogScript);
    }
  }, [narrationState?.dialogScript, editingDialogScript]);

  // Initialize speaker configs with sane defaults when entering dialog mode
  useEffect(() => {
    if (narrationMode === 'dialog' && Object.keys(speakerConfigs).length === 0 && engines?.length) {
      const defaultEngine = engines[0]!;
      const voiceA = defaultEngine.voices[0];
      const voiceB = defaultEngine.voices[1] ?? defaultEngine.voices[0];
      setSpeakerConfigs({
        A: { engine: defaultEngine.id, voice: voiceA?.id ?? '', speed: 1.0, label: 'Speaker A' },
        B: { engine: defaultEngine.id, voice: voiceB?.id ?? '', speed: 1.0, label: 'Speaker B' },
      });
    }
  }, [narrationMode, speakerConfigs, engines]);

  // Auto-assign alternating speakers when entering dialog mode with no assignments
  useEffect(() => {
    if (narrationMode === 'dialog' && narrationState?.chunks && chunkSpeakers.size === 0) {
      const auto = new Map<number, string>();
      narrationState.chunks.forEach((c, i) => auto.set(c.index, i % 2 === 0 ? 'A' : 'B'));
      setChunkSpeakers(auto);
    }
  }, [narrationMode, narrationState?.chunks, chunkSpeakers.size]);

  const currentEngine = engines?.find((e) => e.id === selectedEngine);

  // Helper: get the engine info for a speaker's engine
  const getEngineForSpeaker = useCallback((speakerKey: string): TtsEngineInfo | undefined => {
    const cfg = speakerConfigs[speakerKey];
    if (!cfg) return undefined;
    return engines?.find((e) => e.id === cfg.engine);
  }, [speakerConfigs, engines]);

  // Get the current text for a chunk (edited or original)
  const getChunkText = useCallback((chunk: NarrationChunkInfo) => {
    return editedChunks.get(chunk.index) ?? chunk.text;
  }, [editedChunks]);

  // Resolve voice settings for a chunk (dialog uses per-speaker, monologue uses global)
  const resolveChunkVoice = useCallback((chunk: NarrationChunkInfo): { engine: string; voice: string; speed: number } => {
    if (narrationMode === 'dialog') {
      const speaker = chunkSpeakers.get(chunk.index) ?? 'A';
      const cfg = speakerConfigs[speaker];
      if (cfg) return { engine: cfg.engine, voice: cfg.voice, speed: cfg.speed };
    }
    return { engine: selectedEngine, voice: selectedVoice, speed: selectedSpeed };
  }, [narrationMode, chunkSpeakers, speakerConfigs, selectedEngine, selectedVoice, selectedSpeed]);

  // Estimate the cost of generating every chunk that doesn't already have
  // audio. Honors per-speaker engines in dialog mode, so a scene split
  // between paid (xAI) and free (Gemini) speakers totals only the paid
  // half. Recomputed any time the chunk list, edited text, or engine
  // selection changes.
  const pendingCost = (() => {
    const chunks = narrationState?.chunks ?? [];
    const pending = chunks.filter((c) => !c.audio);
    if (pending.length === 0) {
      return { chars: 0, costUsd: 0, free: true, label: 'nothing to generate', engines: [] as string[] };
    }
    let totalUsd = 0;
    let totalChars = 0;
    let anyUnknown = false;
    const engineSet = new Set<string>();
    for (const chunk of pending) {
      const { engine } = resolveChunkVoice(chunk);
      const chars = getChunkText(chunk).length;
      totalChars += chars;
      engineSet.add(engine);
      const est = estimateTtsCost(engine, chars);
      if (est.costUsd === undefined) {
        anyUnknown = true;
      } else {
        totalUsd += est.costUsd;
      }
    }
    return {
      chars: totalChars,
      costUsd: totalUsd,
      free: totalUsd === 0 && !anyUnknown,
      unknown: anyUnknown,
      label:
        pending.length === 1
          ? `${pending.length} chunk · ${totalChars.toLocaleString()} chars`
          : `${pending.length} chunks · ${totalChars.toLocaleString()} chars`,
      engines: Array.from(engineSet),
    } as { chars: number; costUsd: number; free: boolean; unknown?: boolean; label: string; engines: string[] };
  })();

  // Generate a single chunk
  const generateChunk = useCallback(async (chunk: NarrationChunkInfo) => {
    if (!projectId || !sceneId) return;
    const text = getChunkText(chunk);
    const voiceSettings = resolveChunkVoice(chunk);
    setGeneratingChunks((prev) => new Set(prev).add(chunk.index));
    try {
      // In dialog mode, save speaker assignment for this chunk first
      if (narrationMode === 'dialog') {
        const speaker = chunkSpeakers.get(chunk.index) ?? 'A';
        await narrationApi.saveSpeakerAssignments(projectId, sceneId, [{ index: chunk.index, speaker }]);
      }
      await narrationApi.generateChunk(projectId, sceneId, {
        chunkIndex: chunk.index,
        text,
        ...voiceSettings,
      });
      audioCacheBust.current++;
      queryClient.invalidateQueries({ queryKey: ['narration', projectId, sceneId] });
    } finally {
      setGeneratingChunks((prev) => {
        const next = new Set(prev);
        next.delete(chunk.index);
        return next;
      });
    }
  }, [projectId, sceneId, resolveChunkVoice, getChunkText, queryClient, narrationMode, chunkSpeakers]);

  // Generate chunks on the server with SSE progress. `selector`:
  //   'missing' (default) — only chunks without audio (skips already-rendered ones)
  //   'failed' — only chunks marked failed
  //   'all' — regenerate everything
  const generateAllChunks = useCallback(async (selector: 'all' | 'missing' | 'failed' = 'missing') => {
    if (!narrationState?.chunks?.length || !projectId || !sceneId) return;
    if (!selectedEngine || !selectedVoice) return;
    // Persist speaker configs + assignments before generating
    await narrationApi.saveMode(projectId, sceneId, narrationMode, speakerConfigs);
    if (narrationMode === 'dialog') {
      const assignments = Array.from(chunkSpeakers.entries()).map(([index, speaker]) => ({ index, speaker }));
      await narrationApi.saveSpeakerAssignments(projectId, sceneId, assignments);
    }

    // Close any prior subscription
    generateAllCloseRef.current?.();

    setGenerateAllProgress({ done: 0, total: narrationState.chunks.length, failed: 0, message: 'Starting…' });
    let jobId: string;
    try {
      const res = await narrationApi.generateAll(projectId, sceneId, {
        engine: selectedEngine,
        voice: selectedVoice,
        speed: selectedSpeed,
        selector,
      });
      jobId = res.jobId;
      setGenerateAllJobId(jobId);
    } catch (err) {
      setGenerateAllProgress(null);
      setGenerateAllJobId(null);
      ui.showToast({
        message: 'Could not start chunk generation',
        detail: err instanceof Error ? err.message : 'unknown error',
        tone: 'error',
      });
      return;
    }

    const close = narrationApi.subscribeGenerateAll(jobId, (raw) => {
      const evt = raw as { type: string; data?: { type?: string; total?: number; completed?: number; failed?: number; message?: string; chunkIndex?: number; reason?: string } };
      if (evt.type === 'progress' && evt.data) {
        setGenerateAllProgress({
          done: evt.data.completed ?? 0,
          total: evt.data.total ?? 0,
          failed: evt.data.failed ?? 0,
          message: evt.data.message,
        });
        // On any per-chunk completion, refresh narration state so the UI shows the audio player
        if (evt.data.type === 'chunk-success' || evt.data.type === 'chunk-failed') {
          queryClient.invalidateQueries({ queryKey: ['narration', projectId, sceneId] });
          audioCacheBust.current += 1;
        }
      } else if (evt.type === 'done') {
        setGenerateAllProgress(null);
        setGenerateAllJobId(null);
        queryClient.invalidateQueries({ queryKey: ['narration', projectId, sceneId] });
        queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] });
        generateAllCloseRef.current?.();
        generateAllCloseRef.current = null;
      } else if (evt.type === 'error') {
        setGenerateAllProgress(null);
        setGenerateAllJobId(null);
        const data = evt.data as { error?: string } | undefined;
        ui.showToast({
          message: 'Chunk generation failed',
          detail: data?.error ?? 'unknown error',
          tone: 'error',
        });
        generateAllCloseRef.current?.();
        generateAllCloseRef.current = null;
      } else if (evt.type === 'cancel') {
        setGenerateAllProgress(null);
        setGenerateAllJobId(null);
        queryClient.invalidateQueries({ queryKey: ['narration', projectId, sceneId] });
        generateAllCloseRef.current?.();
        generateAllCloseRef.current = null;
      }
    });
    generateAllCloseRef.current = close;
  }, [narrationState?.chunks, projectId, sceneId, narrationMode, speakerConfigs, chunkSpeakers, selectedEngine, selectedVoice, selectedSpeed, queryClient, ui]);

  // Cancel an in-flight generate-all job
  const cancelGenerateAll = useCallback(async () => {
    if (!generateAllJobId) return;
    try {
      await narrationApi.cancelJob(generateAllJobId);
    } catch { /* best-effort */ }
  }, [generateAllJobId]);

  useEffect(() => {
    return () => {
      generateAllCloseRef.current?.();
    };
  }, []);

  // Switch mode handler — swaps scripts, only converts when needed
  // Generate (or regenerate) dialog from monologue — used by Script tab
  const generateDialog = useCallback(async () => {
    if (!projectId || !sceneId) return;
    setConvertingDialog(true);
    setConvertError(null);
    try {
      const result = await narrationApi.convertToDialog(projectId, sceneId);
      setEditingDialogScript(null); // Reset to sync fresh dialog from server
      const assignments = new Map<number, string>();
      result.chunks.forEach((c) => assignments.set(c.index, c.speaker));
      setChunkSpeakers(assignments);
    } catch (err) {
      setConvertError(err instanceof Error ? err.message : 'Conversion failed');
    } finally {
      setConvertingDialog(false);
      queryClient.invalidateQueries({ queryKey: ['narration', projectId, sceneId] });
      queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] });
      queryClient.invalidateQueries({ queryKey: ['script', projectId, sceneId] });
    }
  }, [projectId, sceneId, queryClient]);

  // Switch narration mode — used by Narration tab mode toggle
  const switchMode = useCallback(async (newMode: 'monologue' | 'dialog') => {
    if (newMode === narrationMode) return;
    if (!projectId || !sceneId) return;

    setNarrationMode(newMode);
    setConvertError(null);

    // Tell the server to swap scripts + save mode
    const modeResult = await narrationApi.saveMode(projectId, sceneId, newMode, speakerConfigs);

    if (newMode === 'dialog' && modeResult.needsConversion) {
      // No dialog version — need LLM conversion
      setConvertingDialog(true);
      try {
        const result = await narrationApi.convertToDialog(projectId, sceneId);
        setEditingDialogScript(null); // Reset to sync fresh dialog from server
        const assignments = new Map<number, string>();
        result.chunks.forEach((c) => assignments.set(c.index, c.speaker));
        setChunkSpeakers(assignments);
      } catch (err) {
        setConvertError(err instanceof Error ? err.message : 'Conversion failed');
        // Revert to monologue on failure
        setNarrationMode('monologue');
        await narrationApi.saveMode(projectId, sceneId, 'monologue', {});
      } finally {
        setConvertingDialog(false);
      }
    } else if (newMode === 'dialog') {
      // Dialog exists — reset to sync from server
      setEditingDialogScript(null);
    }

    // Refresh everything
    queryClient.invalidateQueries({ queryKey: ['narration', projectId, sceneId] });
    queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] });
    queryClient.invalidateQueries({ queryKey: ['script', projectId, sceneId] });
  }, [narrationMode, projectId, sceneId, speakerConfigs, queryClient]);

  // Save edited chunk texts back to the full script
  const saveChunkEdits = useCallback(async () => {
    if (!projectId || !sceneId || !narrationState?.chunks) return;
    const fullScript = narrationState.chunks
      .map((c) => editedChunks.get(c.index) ?? c.text)
      .join('\n\n');
    // Save to the correct slot based on current narration mode
    const slot = narrationMode === 'dialog' ? 'dialog' : 'monologue';
    await narrationApi.saveScript(projectId, sceneId, fullScript, slot);
    setEditedChunks(new Map());
    setChunkScriptDirty(false);
    queryClient.invalidateQueries({ queryKey: ['narration', projectId, sceneId] });
    queryClient.invalidateQueries({ queryKey: ['script', projectId, sceneId] });
    queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] });
  }, [projectId, sceneId, narrationState?.chunks, editedChunks, narrationMode, queryClient]);

  // Speaker color palette
  const speakerColors: Record<string, { bg: string; border: string; text: string; badge: string }> = {
    A: { bg: '#7aa2f710', border: '#7aa2f740', text: '#7aa2f7', badge: '#7aa2f7' },
    B: { bg: '#c27adb10', border: '#c27adb40', text: '#c27adb', badge: '#c27adb' },
  };

  // --- Lower Thirds state ---
  const [editingLTs, setEditingLTs] = useState<LowerThirdItem[] | null>(null);
  const [ltDirty, setLtDirty] = useState(false);

  // Pre-fetched on scene mount (not gated to activeTab) so the LT tab
  // never flashes "Loading…" on first open. See pre-fetch note above.
  const { data: ltData } = useQuery({
    queryKey: ['lower-thirds', projectId, sceneId],
    queryFn: () => lowerThirdsApi.get(projectId!, sceneId!),
    enabled: !!projectId && !!sceneId,
  });

  useEffect(() => {
    if (ltData && editingLTs === null && ltData.lowerThirds.length > 0) {
      setEditingLTs(ltData.lowerThirds);
    }
  }, [ltData, editingLTs]);

  // Whether to ground the next LT recommendation in the actual video.
  // Defaults to true; falls back to text-only on the server when the
  // active provider isn't Gemini or the scene lacks a recording.
  const [ltGroundInVideo, setLtGroundInVideo] = useState(true);
  const recommendLTsMutation = useMutation({
    mutationFn: () =>
      lowerThirdsApi.recommend(projectId!, sceneId!, {
        groundInVideo: ltGroundInVideo && canGroundInVideo,
      }),
    onSuccess: (data) => {
      setEditingLTs(data.lowerThirds);
      setLtDirty(false);
      queryClient.invalidateQueries({ queryKey: ['lower-thirds', projectId, sceneId] });
      queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] });
      ui.showToast({ message: `Recommended ${data.lowerThirds.length} lower thirds.`, tone: 'success' });
    },
    onError: (err) => {
      ui.showToast({ message: `Recommend failed: ${err instanceof Error ? err.message : 'unknown error'}`, tone: 'error' });
    },
  });

  const saveLTsMutation = useMutation({
    mutationFn: (lts: LowerThirdItem[]) => lowerThirdsApi.save(projectId!, sceneId!, lts),
    onSuccess: (_data, vars) => {
      setLtDirty(false);
      queryClient.invalidateQueries({ queryKey: ['lower-thirds', projectId, sceneId] });
      queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] });
      ui.showToast({
        message: vars.length === 0
          ? 'Lower thirds cleared. Cached overlay invalidated.'
          : `Saved ${vars.length} lower third${vars.length === 1 ? '' : 's'}. Cached overlay invalidated.`,
        tone: 'success',
      });
    },
    onError: (err) => {
      ui.showToast({ message: `Save failed: ${err instanceof Error ? err.message : 'unknown error'}`, tone: 'error' });
    },
  });

  const overlayRenderMutation = useMutation({
    mutationFn: () => overlayApi.render(projectId!, sceneId!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] });
      ui.showToast({ message: 'Overlay rendered.', tone: 'success' });
    },
    onError: (err) => {
      ui.showToast({ message: `Render failed: ${err instanceof Error ? err.message : 'unknown error'}`, tone: 'error' });
    },
  });

  if (!scene) {
    return (
      <div style={{ padding: 40, color: 'var(--fg-muted)' }}>
        {storyboard ? 'Scene not found' : 'Loading…'}
      </div>
    );
  }

  return (
    <div style={embedded
      ? { padding: '0', maxWidth: '100%' }
      : { padding: '32px 48px', maxWidth: 900 }}
    >
      {/* Scene header — full version standalone, compact description-only when
          embedded in StoryboardView (the left rail already shows the name). */}
      {!embedded ? (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
            <span
              style={{
                fontSize: 10,
                padding: '2px 8px',
                borderRadius: 4,
                background: typeBadgeColors[scene.type] ?? '#666',
                color: '#fff',
                fontWeight: 600,
                textTransform: 'uppercase',
              }}
            >
              {scene.type}
            </span>
            <h1 style={{ margin: 0, fontSize: 22 }}>{scene.name}</h1>
          </div>
          <p style={{ color: 'var(--fg-muted)', margin: '0 0 24px', fontSize: 14, lineHeight: 1.5 }}>
            {scene.description}
          </p>
        </>
      ) : scene.description ? (
        <p
          style={{
            color: 'var(--fg-muted)',
            margin: '0 0 20px',
            fontSize: 13,
            lineHeight: 1.5,
            padding: '12px 14px',
            background: 'var(--bg-elev)',
            border: '1px solid var(--border)',
            borderRadius: 6,
          }}
          title="Scene description from ideation (click the pencil in the sidebar to edit)"
        >
          {scene.description}
        </p>
      ) : null}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--border)', marginBottom: 24 }}>
        {TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            style={{
              padding: '10px 20px',
              background: 'none',
              border: 'none',
              borderBottom: activeTab === tab ? '2px solid var(--accent)' : '2px solid transparent',
              color: activeTab === tab ? 'var(--fg)' : 'var(--fg-muted)',
              fontWeight: activeTab === tab ? 600 : 400,
              cursor: 'pointer',
              fontSize: 14,
            }}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'Recording' && (
        <div>
          {/* Re-analyze blocking modal — running this also calls Gemini Files
              API in the video-grounded path, which adds an upload + poll
              before the actual generateContent. */}
          <GenerationModal
            open={reanalyzeMutation.isPending}
            title="Re-analyzing scene"
            phase={
              reanalyzeGroundInVideo && canGroundInVideo
                ? 'Uploading video to Gemini → analysing → writing scene description…'
                : 'Reading scene metadata + source-docs → writing description…'
            }
            hint={
              reanalyzeGroundInVideo && canGroundInVideo
                ? 'Video-grounded analysis usually takes 20–40 seconds. Please don\'t navigate away.'
                : 'Usually a few seconds.'
            }
          />

          {scene.recording ? (
            <>
              <RecordingInfo
                source={scene.recording.source}
                duration_sec={scene.recording.duration_sec}
                ingested_at={scene.recording.ingested_at}
              />

              {/* Replace recording — lets the user swap the video file without
                  deleting the scene. The backend's ingestRecording already
                  overwrites the existing file, so this just exposes the
                  upload dropzone again. */}
              <div style={{ marginTop: 12 }}>
                {!showReplaceUpload ? (
                  <button
                    onClick={() => setShowReplaceUpload(true)}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '7px 14px',
                      background: 'var(--surface)',
                      color: 'var(--fg-muted)',
                      border: '1px solid var(--border)',
                      borderRadius: 6,
                      cursor: 'pointer',
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    <Upload size={13} strokeWidth={1.8} aria-hidden />
                    Replace recording
                  </button>
                ) : (
                  <div
                    style={{
                      padding: 14,
                      background: 'var(--bg-elev)',
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                    }}
                  >
                    <div
                      style={{
                        fontSize: 11,
                        color: 'var(--fg-muted)',
                        textTransform: 'uppercase',
                        letterSpacing: 1,
                        marginBottom: 10,
                        fontWeight: 600,
                      }}
                    >
                      Upload replacement
                    </div>
                    <RecordingUpload
                      multiple={false}
                      isUploading={uploadMutation.isPending}
                      onFilesSelected={async (files) => {
                        const file = files[0];
                        if (!file || !scene) return;
                        const ok = await confirmDestructiveSave(ui, {
                          scope: 'recording',
                          scene,
                        });
                        if (!ok) return;
                        uploadMutation.mutate(file);
                      }}
                    />
                    {uploadMutation.isError && (
                      <p style={{ color: 'var(--danger)', marginTop: 8, fontSize: 13 }}>
                        Upload failed:{' '}
                        {uploadMutation.error instanceof Error
                          ? uploadMutation.error.message
                          : 'Unknown error'}
                      </p>
                    )}
                    <button
                      onClick={() => {
                        setShowReplaceUpload(false);
                        uploadMutation.reset();
                      }}
                      disabled={uploadMutation.isPending}
                      style={{
                        marginTop: 10,
                        padding: '6px 14px',
                        background: 'transparent',
                        color: 'var(--fg-muted)',
                        border: '1px solid var(--border)',
                        borderRadius: 6,
                        cursor: uploadMutation.isPending ? 'wait' : 'pointer',
                        fontSize: 12,
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>

              {/* Per-scene out-transition. Hidden when this is the final scene
                  (nothing to transition into). Defaults to `cut` (hard concat).
                  Anything else triggers an ffmpeg xfade pass at render time. */}
              <div style={{ marginTop: 12 }}>
                <TransitionPicker
                  value={scene.transition as SceneTransition | undefined}
                  durationSec={scene.transition_duration_sec}
                  isLastScene={
                    !!storyboard &&
                    storyboard.scenes[storyboard.scenes.length - 1]?.id === scene.id
                  }
                  isSaving={saveTransitionMutation.isPending}
                  projectId={projectId}
                  sceneId={sceneId}
                  onChange={(transition, durationSec) => {
                    saveTransitionMutation.mutate({
                      transition,
                      transition_duration_sec: durationSec ?? null,
                    });
                  }}
                />
                {saveTransitionMutation.isError && (
                  <p style={{ color: 'var(--danger)', marginTop: 8, fontSize: 12 }}>
                    Save failed:{' '}
                    {saveTransitionMutation.error instanceof Error
                      ? saveTransitionMutation.error.message
                      : 'Unknown error'}
                  </p>
                )}
              </div>

              {/* Per-scene frame override. The render pipeline already prefers
                  scene-level values over project defaults (storyboard.defaults
                  is the fallback); the picker just exposes that override at
                  the scene level. Empty selection = inherit project default. */}
              {framesQuery.data && framesQuery.data.length > 0 && (
                <div
                  style={{
                    marginTop: 12,
                    padding: 14,
                    background: 'var(--bg-elev)',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                  }}
                >
                  <div
                    style={{
                      fontSize: 11,
                      color: 'var(--fg-muted)',
                      textTransform: 'uppercase',
                      letterSpacing: 1,
                      marginBottom: 8,
                      fontWeight: 600,
                    }}
                  >
                    Frame style (this scene)
                  </div>
                  <FrameStylePicker
                    frames={framesQuery.data}
                    value={{
                      // Scene-level override; falls through to project default
                      // visually so the user can see what's effectively applied.
                      frameStyle:
                        scene.frame_style ?? storyboard?.defaults?.frame_style ?? null,
                      frameBackground:
                        scene.frame_background ??
                        storyboard?.defaults?.frame_background ??
                        null,
                    }}
                    onChange={(next) => {
                      const projectStyle = storyboard?.defaults?.frame_style ?? null;
                      const projectBg = storyboard?.defaults?.frame_background ?? null;
                      // If the chosen value matches the project default, clear
                      // the override (null on the wire). Otherwise persist it.
                      saveFrameMutation.mutate({
                        frame_style:
                          next.frameStyle === projectStyle ? null : next.frameStyle ?? null,
                        frame_background:
                          next.frameBackground === projectBg ? null : next.frameBackground ?? null,
                      });
                    }}
                  />
                  <p
                    style={{
                      fontSize: 11,
                      color: 'var(--fg-muted)',
                      margin: '8px 0 0',
                      lineHeight: 1.5,
                    }}
                  >
                    {scene.frame_style || scene.frame_background ? (
                      <>
                        Override active for this scene. Pick the project default to
                        clear it.
                      </>
                    ) : (
                      <>
                        Inheriting project default ({storyboard?.defaults?.frame_style ?? 'none'}
                        ). Pick a different style to override for this scene only.
                      </>
                    )}
                  </p>
                  {saveFrameMutation.isPending && (
                    <p style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 6, marginBottom: 0 }}>
                      Saving…
                    </p>
                  )}
                  {saveFrameMutation.isError && (
                    <p style={{ color: 'var(--danger)', marginTop: 6, fontSize: 12 }}>
                      Save failed:{' '}
                      {saveFrameMutation.error instanceof Error
                        ? saveFrameMutation.error.message
                        : 'Unknown error'}
                    </p>
                  )}
                </div>
              )}

              {/* Two-card layout. The previous design crammed scene
                  metadata + the Re-analyze action into a single card
                  titled "Scene description", which buried the action.
                  Now metadata sits in its own static card and re-analysis
                  has a dedicated card with a clearer heading.

                  Card 1 — current name + description (read-only). */}
              <div
                style={{
                  marginTop: 16,
                  padding: 14,
                  background: 'var(--bg-elev)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                }}
              >
                <div style={{ fontSize: 11, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>
                  Scene description
                </div>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
                  {scene.name}
                </div>
                <div style={{ fontSize: 13, color: 'var(--fg-muted)', lineHeight: 1.5 }}>
                  {scene.description || <em>(no description)</em>}
                </div>
              </div>

              {/* Card 2 — re-analysis action. Prominent heading + dedicated
                  card make it discoverable; toggle and Apply/Cancel diff
                  panel live here too. */}
              <div
                style={{
                  marginTop: 12,
                  padding: 14,
                  background: 'var(--bg-elev)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                }}
              >
                <div
                  style={{
                    fontSize: 11,
                    color: 'var(--fg-muted)',
                    textTransform: 'uppercase',
                    letterSpacing: 1,
                    marginBottom: 6,
                    fontWeight: 600,
                  }}
                >
                  <RefreshCcw
                    size={11}
                    strokeWidth={1.8}
                    style={{ marginRight: 5, marginBottom: -1 }}
                    aria-hidden
                  />
                  Refresh from docs / video
                </div>
                <p
                  style={{
                    fontSize: 12,
                    color: 'var(--fg-muted)',
                    margin: '0 0 10px',
                    lineHeight: 1.5,
                  }}
                >
                  Re-runs scene analysis using the current objective + source-docs (and the actual
                  video, when grounded). Useful after adding documentation or editing the
                  project objective. You'll get a diff to review before anything is saved.
                </p>

                {canGroundInVideo && (
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      marginBottom: 10,
                      fontSize: 12,
                      color: 'var(--fg-muted)',
                      userSelect: 'none',
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={reanalyzeGroundInVideo}
                      onChange={(e) => setReanalyzeGroundInVideo(e.target.checked)}
                      disabled={reanalyzeMutation.isPending}
                    />
                    <span>
                      Ground in actual video (sends recording to {activeModel?.label ?? 'Gemini'})
                    </span>
                  </label>
                )}

                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <button
                    onClick={() => reanalyzeMutation.mutate()}
                    disabled={reanalyzeMutation.isPending || !!analyzePreview}
                    style={{
                      padding: '7px 14px',
                      background: 'var(--surface)',
                      color: 'var(--fg)',
                      border: '1px solid var(--border)',
                      borderRadius: 6,
                      cursor: reanalyzeMutation.isPending ? 'wait' : 'pointer',
                      fontSize: 12,
                      fontWeight: 600,
                      opacity: analyzePreview ? 0.5 : 1,
                    }}
                  >
                    {reanalyzeMutation.isPending ? (
                      'Re-analyzing…'
                    ) : (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <RefreshCcw size={13} strokeWidth={1.8} aria-hidden />
                        Re-analyze scene
                      </span>
                    )}
                  </button>
                  {analyzePreview && (
                    <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
                      Preview ready below — review then Apply or Cancel
                    </span>
                  )}
                </div>

                {/* Diff preview — old vs new. Shown after a dry-run analysis.
                    The user explicitly Applies before any storyboard write
                    happens. Replaces the previous "fire and update" behaviour
                    that silently overwrote any manual edits. */}
                {analyzePreview && (
                  // Violet (--accent-2) signals "AI-generated content";
                  // primary blue is reserved for human-driven actions. The
                  // diff panel is literally model output awaiting Apply.
                  <div
                    style={{
                      marginTop: 14,
                      padding: 14,
                      background: 'var(--surface)',
                      border: `1px solid var(--accent-2)`,
                      borderRadius: 8,
                    }}
                  >
                    <div
                      style={{
                        fontSize: 11,
                        textTransform: 'uppercase',
                        letterSpacing: 1,
                        color: 'var(--fg-muted)',
                        marginBottom: 10,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                      }}
                    >
                      <span style={{ fontWeight: 700, color: 'var(--accent-2)' }}>
                        Proposed update
                      </span>
                      <span>mode: {analyzePreview.mode}</span>
                    </div>
                    <DiffRow
                      label="Name"
                      current={analyzePreview.current.name}
                      proposed={analyzePreview.proposed.name}
                    />
                    <DiffRow
                      label="Description"
                      current={analyzePreview.current.description}
                      proposed={analyzePreview.proposed.description}
                      multiline
                    />
                    <DiffRow
                      label="Type"
                      current={analyzePreview.current.type}
                      proposed={analyzePreview.proposed.type}
                    />
                    <div
                      style={{
                        display: 'flex',
                        gap: 8,
                        marginTop: 12,
                        alignItems: 'center',
                      }}
                    >
                      <button
                        onClick={() => applyAnalyzeMutation.mutate(analyzePreview.proposed)}
                        disabled={applyAnalyzeMutation.isPending}
                        className="primary"
                        style={{ padding: '7px 16px', fontSize: 12, fontWeight: 600 }}
                      >
                        {applyAnalyzeMutation.isPending ? 'Applying…' : 'Apply'}
                      </button>
                      <button
                        onClick={() => setAnalyzePreview(null)}
                        disabled={applyAnalyzeMutation.isPending}
                        style={{
                          padding: '7px 16px',
                          background: 'transparent',
                          color: 'var(--fg-muted)',
                          border: '1px solid var(--border)',
                          borderRadius: 6,
                          cursor: 'pointer',
                          fontSize: 12,
                        }}
                      >
                        Cancel
                      </button>
                      {applyAnalyzeMutation.isError && (
                        <span style={{ fontSize: 11, color: 'var(--danger)' }}>
                          Apply failed:{' '}
                          {applyAnalyzeMutation.error instanceof Error
                            ? applyAnalyzeMutation.error.message
                            : 'unknown'}
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {reanalyzeMutation.isError && (
                  <p style={{ color: 'var(--danger)', fontSize: 12, marginTop: 8 }}>
                    Re-analyze failed:{' '}
                    {reanalyzeMutation.error instanceof Error
                      ? reanalyzeMutation.error.message
                      : 'Unknown error'}
                  </p>
                )}
              </div>
            </>
          ) : (
            <div>
              <p style={{ color: 'var(--fg-muted)', marginBottom: 16 }}>
                No recording uploaded for this scene yet.
              </p>
              <ShotPlanSection projectId={projectId!} sceneId={sceneId!} />
              <RecordingUpload
                multiple={false}
                isUploading={uploadMutation.isPending}
                onFilesSelected={(files) => {
                  if (files[0]) uploadMutation.mutate(files[0]);
                }}
              />
              {uploadMutation.isError && (
                <p style={{ color: 'var(--danger)', marginTop: 8, fontSize: 13 }}>
                  Upload failed: {uploadMutation.error instanceof Error ? uploadMutation.error.message : 'Unknown error'}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {activeTab === 'Script' && (
        <div>
          {/* Generation modal — blocks the page so the user can't navigate
              away mid-generation (which previously left the page showing
              the pre-generation state until both halves landed). Phase
              copy adapts to the chosen mode: video-grounded does an extra
              upload + Gemini-side analysis pass before the actual write. */}
          <GenerationModal
            open={generateScriptMutation.isPending}
            title="Generating script"
            phase={
              groundInVideo && canGroundInVideo
                ? 'Uploading video to Gemini → analysing → writing script → converting to dialog…'
                : 'Writing monologue, then dialog…'
            }
            hint={
              groundInVideo && canGroundInVideo
                ? 'Video upload + Gemini analysis usually takes 30–60s on top of the LLM calls.'
                : 'Two LLM calls run in sequence.'
            }
            onCancel={() => {
              generateAbortRef.current?.abort();
              generateAbortRef.current = null;
            }}
          />

          {/* ── Input-mode radio ──
              Two ways to get a script: describe the scene and let the AI
              write it (the original flow), or paste your own and have the AI
              evaluate + polish it. The choice swaps the primary input + button
              below; the intent field stays visible in both (north star when
              describing, optional context when polishing). */}
          <div
            style={{
              display: 'flex',
              gap: 8,
              marginBottom: 14,
              flexWrap: 'wrap',
            }}
          >
            {([
              { key: 'describe', label: 'Describe the scene → AI writes it' },
              { key: 'byo', label: "I'll write the script → AI polishes it" },
            ] as const).map((opt) => {
              const active = scriptInputMode === opt.key;
              return (
                <label
                  key={opt.key}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '8px 12px',
                    fontSize: 13,
                    cursor: 'pointer',
                    userSelect: 'none',
                    background: active ? 'var(--bg-elev)' : 'transparent',
                    border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                    borderRadius: 8,
                    color: active ? 'var(--fg)' : 'var(--fg-muted)',
                  }}
                >
                  <input
                    type="radio"
                    name="script-input-mode"
                    checked={active}
                    onChange={() => setScriptInputMode(opt.key)}
                  />
                  <span>{opt.label}</span>
                </label>
              );
            })}
          </div>

          {/* Scene intent — the user's "north star" for this scene. The
              prompt treats it as authoritative; the video and source-docs
              are framed as the visual anchor / factual reference for it.
              Saved on blur so the value is captured even if the user
              clicks Generate immediately. */}
          <div
            style={{
              marginBottom: 14,
              padding: 12,
              background: 'var(--bg-elev)',
              border: '1px solid var(--border)',
              borderRadius: 8,
            }}
          >
            {/* Header row: label + FieldStatus pip aligned right. The pip
                makes the autosave-on-blur semantics visible — was previously
                a tiny "Saving…" word buried in helper text. */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 6,
              }}
            >
              <label
                htmlFor="scene-intent"
                style={{
                  fontSize: 11,
                  color: 'var(--fg-muted)',
                  textTransform: 'uppercase',
                  letterSpacing: 1,
                }}
              >
                What is this scene demonstrating?
              </label>
              <FieldStatus
                state={
                  saveIntentMutation.isPending
                    ? 'saving'
                    : saveIntentMutation.isError
                      ? 'error'
                      : (intentDraft ?? '').trim() !== (scene?.intent ?? '').trim()
                        ? 'dirty'
                        : saveIntentMutation.isSuccess
                          ? 'saved'
                          : 'idle'
                }
                detail={
                  saveIntentMutation.error instanceof Error
                    ? saveIntentMutation.error.message
                    : undefined
                }
              />
            </div>
            <textarea
              id="scene-intent"
              value={intentDraft ?? ''}
              onChange={(e) => setIntentDraft(e.target.value)}
              onBlur={() => {
                const next = (intentDraft ?? '').trim();
                if (next !== (scene?.intent ?? '').trim()) {
                  saveIntentMutation.mutate(next);
                }
              }}
              placeholder={
                "e.g. Show how RBAC limits Analyst users from seeing PII when querying the customers table, and how Viewer users get a further-restricted view."
              }
              rows={3}
              disabled={saveIntentMutation.isPending}
              style={{
                width: '100%',
                resize: 'vertical',
                padding: '8px 10px',
                fontSize: 13,
                lineHeight: 1.5,
                background: 'var(--bg)',
                color: 'var(--fg)',
                // Dirty state gets a warm border so the unsaved status is
                // visible without having to read the pip.
                border:
                  (intentDraft ?? '').trim() !== (scene?.intent ?? '').trim()
                    ? '1px solid var(--warn)'
                    : '1px solid var(--border)',
                borderRadius: 6,
                fontFamily: 'inherit',
              }}
            />
            <div style={{ marginTop: 6, fontSize: 11, color: 'var(--fg-muted)', lineHeight: 1.4 }}>
              {scriptInputMode === 'byo'
                ? 'Optional context for the polisher — it uses this to judge whether your script stays on-message. Your pasted script below is what actually gets polished.'
                : 'The script generator treats this as the north star. Project objective + source-docs are the factual reference; the video (when grounded) is the visual / pacing anchor for what you describe here. Leave blank to fall back to the auto-generated description.'}
            </div>
          </div>

          {/* Video-grounded toggle. Only shown when the active provider can
              actually use it — otherwise the toggle would be a no-op trap
              ("turn this on but nothing changes"). Hidden in 'byo' mode: it
              only applies to writing from scratch, not polishing a draft. */}
          {scriptInputMode === 'describe' && canGroundInVideo && (
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBottom: 12,
                fontSize: 13,
                color: 'var(--fg-muted)',
                userSelect: 'none',
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={groundInVideo}
                onChange={(e) => setGroundInVideo(e.target.checked)}
                disabled={generateScriptMutation.isPending}
              />
              <span>
                Ground in actual video (sends recording to {activeModel?.label ?? 'Gemini'} —
                more accurate, slower, costs more tokens)
              </span>
            </label>
          )}

          {/* ── Describe mode: Generate/Regenerate top bar ──
              Unified affordance — same shape and color whether this is a
              first-time generate or a regenerate. Previously the button
              flipped from filled accent ("✨ Generate Script") to muted
              outline ("🔄 Regenerate") between states; users learn
              affordances visually and that swap erased the visual
              identity of the primary action. */}
          {scriptInputMode === 'describe' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
            <button
              onClick={async () => {
                // Pre-flight: if either pane has unsaved edits, regenerating
                // would silently overwrite them. Surface the cost.
                const isFirstTime =
                  !editingScript &&
                  !scriptState?.script &&
                  !narrationState?.monologueScript;
                const dirtyPanes: string[] = [];
                if (scriptDirty) dirtyPanes.push('Monologue');
                if (dialogEditDirty) dirtyPanes.push('Dialog');

                if (!isFirstTime && dirtyPanes.length > 0) {
                  const ok = await ui.confirm({
                    title: `Regenerate will overwrite ${dirtyPanes.join(' + ')}`,
                    body: `Your unsaved edits in the ${dirtyPanes.join(' and ')} pane${dirtyPanes.length === 1 ? '' : 's'} will be lost. Continue?`,
                    confirmLabel: 'Discard & regenerate',
                    destructive: true,
                  });
                  if (!ok) return;
                }
                generateScriptMutation.mutate();
              }}
              disabled={generateScriptMutation.isPending}
              className="primary"
              style={{
                padding: '8px 16px',
                fontSize: 13,
                fontWeight: 600,
                cursor: generateScriptMutation.isPending ? 'wait' : 'pointer',
                opacity: generateScriptMutation.isPending ? 0.7 : 1,
              }}
            >
              {generateScriptMutation.isPending ? (
                'Generating…'
              ) : !editingScript && !scriptState?.script && !narrationState?.monologueScript ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <Sparkles size={14} strokeWidth={1.8} aria-hidden />
                  Generate script
                </span>
              ) : (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <RefreshCcw size={14} strokeWidth={1.8} aria-hidden />
                  Regenerate
                </span>
              )}
            </button>
          </div>
          )}

          {/* ── BYO mode: paste box + Evaluate & polish ──
              The user pastes their own draft; the button opens the
              PolishScriptModal, which evaluates + polishes it side-by-side.
              Disabled until there's non-whitespace text to work on. */}
          {scriptInputMode === 'byo' && (
            <div style={{ marginBottom: 16 }}>
              <label
                htmlFor="byo-script"
                style={{
                  display: 'block',
                  fontSize: 11,
                  color: 'var(--fg-muted)',
                  textTransform: 'uppercase',
                  letterSpacing: 1,
                  marginBottom: 6,
                }}
              >
                Paste your script
              </label>
              <textarea
                id="byo-script"
                value={draftScript}
                onChange={(e) => setDraftScript(e.target.value)}
                placeholder="Paste the narration you've written for this scene. The AI will evaluate it, polish pacing and clarity, add emotive tags, and fit it to the recording length — then show you the result to accept or reject."
                rows={8}
                style={{
                  width: '100%',
                  resize: 'vertical',
                  padding: '10px 12px',
                  fontSize: 13,
                  lineHeight: 1.5,
                  background: 'var(--bg)',
                  color: 'var(--fg)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  fontFamily: 'inherit',
                }}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
                <button
                  onClick={() => setPolishOpen(true)}
                  disabled={!draftScript.trim()}
                  className="primary"
                  style={{
                    padding: '8px 16px',
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: draftScript.trim() ? 'pointer' : 'not-allowed',
                    opacity: draftScript.trim() ? 1 : 0.5,
                  }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <Sparkles size={14} strokeWidth={1.8} aria-hidden />
                    Evaluate &amp; polish
                  </span>
                </button>
                <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
                  {draftScript.trim()
                    ? 'Opens a side-by-side review — nothing is saved until you accept.'
                    : 'Paste a script to enable.'}
                </span>
              </div>
            </div>
          )}

          {/* Error displays */}
          {generateScriptMutation.isError && (
            <p style={{ color: 'var(--danger)', fontSize: 13, marginBottom: 12 }}>
              Generation failed: {generateScriptMutation.error instanceof Error ? generateScriptMutation.error.message : 'Unknown error'}
            </p>
          )}
          {(saveMonologueMutation.isError || saveDialogMutation.isError) && (
            <p style={{ color: 'var(--danger)', fontSize: 13, marginBottom: 12 }}>
              Save failed: {(saveMonologueMutation.error ?? saveDialogMutation.error) instanceof Error
                ? ((saveMonologueMutation.error ?? saveDialogMutation.error) as Error).message
                : 'Unknown error'}
            </p>
          )}

          {/* Generation modal — covers the explicit "switch to dialog mode"
              path that triggers an on-demand conversion when no dialog
              version exists yet. */}
          <GenerationModal
            open={convertingDialog}
            title="Converting to dialog"
            phase="Rewriting narration as a two-speaker conversation…"
            hint="Usually 10–20 seconds. Please don't navigate away."
          />

          {/* Convert error banner */}
          {convertError && (
            <div style={{
              background: '#2a1a1a', border: '1px solid #c25d5d', borderRadius: 8,
              padding: '10px 14px', marginBottom: 12, fontSize: 13, color: '#f5a0a0',
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <span>Dialog conversion failed: {convertError}</span>
              <button
                onClick={() => { setConvertError(null); }}
                style={{
                  marginLeft: 'auto', background: 'transparent', border: '1px solid #c25d5d',
                  borderRadius: 5, padding: '3px 10px', color: '#f5a0a0', cursor: 'pointer', fontSize: 11,
                }}
              >
                Dismiss
              </button>
            </div>
          )}

          {/* ── Consolidated script editor ──
              Replaces the previous design where Monologue + Dialog were
              two stacked editors with separate Save / Discard / Unsaved
              pips. The two were independently editable but the top-level
              Regenerate would silently overwrite both — and the dirty
              state of the pane you weren't currently looking at was
              invisible. Now: ONE editor, internal Monologue/Dialog tabs,
              Regenerate confirms when either pane is dirty (handled at
              the top button above).
              The dirty pip + active-pane-aware Save/Discard/Restore live
              in the pane header so the user never has to scroll to see
              save state. */}
          {(editingScript !== null || scriptState?.script || narrationState?.monologueScript) ? (
            (() => {
              const monologueValue = editingScript ?? narrationState?.monologueScript ?? '';
              const dialogValue = editingDialogScript ?? narrationState?.dialogScript ?? '';
              const dialogExists = !!(editingDialogScript || narrationState?.dialogScript);
              const isMono = scriptViewTab === 'monologue';
              const activeDirty = isMono ? scriptDirty : dialogEditDirty;
              const activeSaveMutation = isMono ? saveMonologueMutation : saveDialogMutation;
              const activeRestoreMutation = isMono ? restoreMonologueMutation : restoreDialogMutation;
              const hasPrevious = isMono
                ? !!narrationState?.hasPreviousMonologue
                : !!narrationState?.hasPreviousDialog;
              const onSave = async () => {
                if (!scene) return;
                if (isMono) {
                  if (!editingScript) return;
                  const ok = await confirmDestructiveSave(ui, {
                    scope: 'script',
                    scene,
                    slot: 'monologue',
                  });
                  if (!ok) return;
                  saveMonologueMutation.mutate(editingScript);
                } else {
                  if (!editingDialogScript) return;
                  const ok = await confirmDestructiveSave(ui, {
                    scope: 'script',
                    scene,
                    slot: 'dialog',
                  });
                  if (!ok) return;
                  saveDialogMutation.mutate(editingDialogScript);
                }
              };
              const onDiscard = () => {
                if (isMono) {
                  setEditingScript(null);
                  setScriptDirty(false);
                } else {
                  setEditingDialogScript(null);
                  setDialogEditDirty(false);
                }
              };
              const onRestore = () => {
                if (isMono) restoreMonologueMutation.mutate();
                else restoreDialogMutation.mutate();
              };

              return (
                <div
                  style={{
                    border: '1px solid var(--border)',
                    borderRadius: 10,
                    background: 'var(--bg-elev)',
                    padding: 16,
                  }}
                >
                  {/* Pane header: Monologue / Dialog tabs + dirty pip */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      marginBottom: 12,
                    }}
                  >
                    <div
                      role="tablist"
                      aria-label="Script version"
                      style={{
                        display: 'flex',
                        gap: 2,
                        padding: 2,
                        background: 'var(--surface)',
                        border: '1px solid var(--border)',
                        borderRadius: 6,
                      }}
                    >
                      {(['monologue', 'dialog'] as const).map((tab) => {
                        const active = scriptViewTab === tab;
                        const tabDirty = tab === 'monologue' ? scriptDirty : dialogEditDirty;
                        return (
                          <button
                            key={tab}
                            role="tab"
                            aria-selected={active}
                            onClick={() => setScriptViewTab(tab)}
                            disabled={tab === 'dialog' && !dialogExists}
                            title={
                              tab === 'dialog' && !dialogExists
                                ? 'No dialog version yet — Regenerate to create one'
                                : undefined
                            }
                            style={{
                              padding: '5px 14px',
                              fontSize: 12,
                              fontWeight: active ? 600 : 500,
                              background: active ? 'var(--bg)' : 'transparent',
                              color: active ? 'var(--fg)' : 'var(--fg-muted)',
                              border: 'none',
                              borderRadius: 4,
                              cursor: tab === 'dialog' && !dialogExists ? 'not-allowed' : 'pointer',
                              opacity: tab === 'dialog' && !dialogExists ? 0.5 : 1,
                              textTransform: 'capitalize',
                            }}
                          >
                            {tab}
                            {tabDirty && (
                              <span
                                aria-label="unsaved"
                                style={{
                                  display: 'inline-block',
                                  width: 6,
                                  height: 6,
                                  borderRadius: '50%',
                                  background: 'var(--warn)',
                                  marginLeft: 6,
                                  verticalAlign: 'middle',
                                }}
                              />
                            )}
                          </button>
                        );
                      })}
                    </div>
                    <div style={{ marginLeft: 'auto' }}>
                      <FieldStatus
                        state={
                          activeSaveMutation.isPending
                            ? 'saving'
                            : activeSaveMutation.isError
                              ? 'error'
                              : activeDirty
                                ? 'dirty'
                                : activeSaveMutation.isSuccess
                                  ? 'saved'
                                  : 'idle'
                        }
                        detail={
                          activeSaveMutation.error instanceof Error
                            ? activeSaveMutation.error.message
                            : undefined
                        }
                      />
                    </div>
                  </div>

                  {/* Editor — single textarea, content depends on active tab */}
                  {isMono || dialogExists ? (
                    <textarea
                      key={scriptViewTab /* force remount so cursor doesn't leak across tabs */}
                      value={isMono ? monologueValue : dialogValue}
                      onChange={(e) => {
                        if (isMono) {
                          setEditingScript(e.target.value);
                          setScriptDirty(true);
                        } else {
                          setEditingDialogScript(e.target.value);
                          setDialogEditDirty(true);
                        }
                      }}
                      style={{
                        width: '100%',
                        minHeight: 320,
                        padding: 14,
                        boxSizing: 'border-box',
                        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                        fontSize: 12,
                        lineHeight: 1.7,
                        background: 'var(--surface)',
                        color: 'var(--fg)',
                        border: activeDirty ? '1px solid var(--warn)' : '1px solid var(--border)',
                        borderRadius: 8,
                        resize: 'vertical',
                        outline: 'none',
                      }}
                      placeholder={isMono ? 'Monologue script…' : 'Dialog script…'}
                    />
                  ) : (
                    <div
                      style={{
                        padding: '16px 20px',
                        border: '1px dashed var(--border)',
                        borderRadius: 8,
                        color: 'var(--fg-muted)',
                        fontSize: 13,
                      }}
                    >
                      No dialog version yet. Click <strong>Regenerate</strong> at the top to
                      rewrite both monologue and dialog from the scene description.
                    </div>
                  )}

                  {/* Live word-count + fit indicator. Mirrors the math the
                      server uses for Quality Review and Tighten — same wpm
                      (measured from this project's TTS chunks, or 150
                      fallback), same ratio thresholds. Shown right above
                      the action row so the user can self-correct length
                      before generating TTS. */}
                  {(() => {
                    const activeText = (isMono ? editingScript : editingDialogScript) ?? '';
                    const words = activeText.split(/\s+/).filter(Boolean).length;
                    const durSec = scene?.recording?.duration_sec;
                    if (!durSec || words === 0) return null;
                    const wpmInfo = computeProjectWpm(storyboard ?? null);
                    const fit = classifyFit(words, durSec, wpmInfo.wpm);
                    const color =
                      fit.verdict === 'over' ? 'var(--danger)'
                      : fit.verdict === 'short' ? 'var(--warn, #d4a017)'
                      : '#9bc572';
                    const verdictLabel =
                      fit.verdict === 'over' ? `TOO LONG — over by ${words - fit.targetWords}w`
                      : fit.verdict === 'short' ? `unusually short — well under ${fit.targetWords}w target`
                      : fit.verdict === 'within' ? `within target (~${fit.estimatedSec.toFixed(1)}s of ${durSec.toFixed(0)}s)`
                      : `room to grow — ${fit.targetWords - words}w under target`;
                    return (
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 12,
                          marginTop: 12,
                          padding: '8px 12px',
                          background: 'var(--bg)',
                          border: '1px solid var(--border)',
                          borderRadius: 6,
                          fontSize: 12,
                          flexWrap: 'wrap',
                        }}
                      >
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ width: 8, height: 8, borderRadius: '50%', background: color }} aria-hidden />
                          <strong style={{ color: 'var(--fg)' }}>{words} words</strong>
                          <span style={{ color: 'var(--fg-muted)' }}>· {verdictLabel}</span>
                        </span>
                        <span style={{ color: 'var(--fg-dim)', fontSize: 11 }}>
                          at {wpmInfo.wpm} wpm{wpmInfo.isMeasured ? ` (measured, ${wpmInfo.sampleChunks} chunks)` : ' (default)'}
                        </span>
                        {fit.verdict === 'over' && (
                          <button
                            onClick={() => setTightenOpen(true)}
                            style={{
                              marginLeft: 'auto',
                              padding: '4px 10px',
                              fontSize: 11,
                              background: 'var(--accent)',
                              color: '#fff',
                              border: 'none',
                              borderRadius: 4,
                              cursor: 'pointer',
                              fontWeight: 600,
                              whiteSpace: 'nowrap',
                            }}
                            title="Ask the LLM to shorten the script so it fits the recording"
                          >
                            ✨ Tighten script
                          </button>
                        )}
                      </div>
                    );
                  })()}

                  {/* Footer — Save / Discard / Restore + emotive-tag hint.
                      Only one set of buttons total; what they act on is the
                      active tab. */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      marginTop: 10,
                      flexWrap: 'wrap',
                    }}
                  >
                    {activeDirty && (
                      <>
                        <button
                          onClick={onSave}
                          disabled={activeSaveMutation.isPending}
                          className="primary"
                          style={{
                            padding: '6px 14px',
                            fontSize: 12,
                            fontWeight: 600,
                            cursor: 'pointer',
                          }}
                        >
                          {activeSaveMutation.isPending ? 'Saving…' : 'Save'}
                        </button>
                        <button
                          onClick={onDiscard}
                          style={{
                            padding: '6px 14px',
                            background: 'transparent',
                            color: 'var(--fg-muted)',
                            border: '1px solid var(--border)',
                            borderRadius: 6,
                            fontSize: 12,
                            cursor: 'pointer',
                          }}
                        >
                          Discard
                        </button>
                      </>
                    )}
                    {!activeDirty && hasPrevious && (
                      <button
                        onClick={onRestore}
                        disabled={activeRestoreMutation.isPending}
                        style={{
                          padding: '6px 14px',
                          background: 'transparent',
                          color: 'var(--fg-muted)',
                          border: '1px solid var(--border)',
                          borderRadius: 6,
                          fontSize: 12,
                          cursor: 'pointer',
                        }}
                      >
                        {activeRestoreMutation.isPending ? 'Restoring…' : 'Restore Previous'}
                      </button>
                    )}
                    <p style={{ margin: 0, color: 'var(--fg-muted)', fontSize: 11 }}>
                      Use emotive tags like{' '}
                      <code style={{ background: 'var(--bg)', padding: '1px 5px', borderRadius: 3 }}>
                        [warm]
                      </code>
                      ,{' '}
                      <code style={{ background: 'var(--bg)', padding: '1px 5px', borderRadius: 3 }}>
                        [confident]
                      </code>
                      ,{' '}
                      <code style={{ background: 'var(--bg)', padding: '1px 5px', borderRadius: 3 }}>
                        [thoughtful]
                      </code>{' '}
                      to guide narration tone.
                    </p>
                  </div>
                </div>
              );
            })()
          ) : (
            <div style={{
              padding: 48, textAlign: 'center', color: 'var(--fg-muted)',
              border: '1px dashed var(--border)', borderRadius: 8,
            }}>
              <p style={{ fontSize: 14, marginBottom: 4 }}>No script yet for this scene.</p>
              <p style={{ fontSize: 12 }}>
                Click <strong>Generate Script</strong> to create a narration script from the scene description.
              </p>
            </div>
          )}
        </div>
      )}

      {activeTab === 'Narration' && (
        <div>
          {/* Generation modal — same blocking semantics as the Script tab.
              Shows live "X / N" + failure count from the SSE progress feed
              so the user knows the batch is making forward progress.
              Cancel button calls into the existing cancelGenerateAll
              handler so the server-side loop bails at the next chunk. */}
          <GenerationModal
            open={!!generateAllProgress}
            title="Generating narration"
            phase={
              generateAllProgress
                ? `${generateAllProgress.message ?? 'Synthesizing chunks…'} · ${generateAllProgress.done} / ${generateAllProgress.total}${
                    generateAllProgress.failed > 0 ? ` · ${generateAllProgress.failed} failed` : ''
                  }`
                : undefined
            }
            progress={
              generateAllProgress && generateAllProgress.total > 0
                ? (generateAllProgress.done + generateAllProgress.failed) / generateAllProgress.total
                : undefined
            }
            steps={(() => {
              if (!generateAllProgress || !narrationState?.chunks?.length) return undefined;
              // First chunk that's neither done nor failed is the one
              // currently in flight — the server processes sequentially.
              const activeIdx = narrationState.chunks.findIndex(
                (c) => !c.audio && !c.failed,
              );
              return narrationState.chunks.map((chunk, i) => {
                if (chunk.audio) return { status: 'done' as const };
                if (chunk.failed) return { status: 'failed' as const };
                if (i === activeIdx) return { status: 'active' as const };
                return { status: 'queued' as const };
              });
            })()}
            hint="Each chunk is synthesised one at a time. Cancel stops at the next chunk boundary."
            onCancel={generateAllJobId ? cancelGenerateAll : undefined}
          />

          {/* No script warning */}
          {!narrationState?.hasScript && (
            <div
              style={{
                padding: 24,
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                color: 'var(--fg-muted)',
                textAlign: 'center',
                marginBottom: 16,
              }}
            >
              <p style={{ fontSize: 14, marginBottom: 4 }}>
                No script available for this scene.
              </p>
              <p style={{ fontSize: 12 }}>
                Go to the <strong>Script</strong> tab and generate or write a script first.
              </p>
            </div>
          )}

          {/* TTS controls + chunked narration */}
          {narrationState?.hasScript && (
            <div>
              {/* ── Mode toggle ─────────────────────────────── */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14,
              }}>
                <div style={{
                  display: 'inline-flex', borderRadius: 8, overflow: 'hidden',
                  border: '1px solid var(--border)', background: 'var(--surface)',
                }}>
                  <button
                    onClick={() => switchMode('monologue')}
                    style={{
                      padding: '7px 18px', border: 'none',
                      background: narrationMode === 'monologue' ? 'var(--accent)' : 'transparent',
                      color: narrationMode === 'monologue' ? '#fff' : 'var(--fg-muted)',
                      cursor: 'pointer', fontSize: 12,
                      fontWeight: narrationMode === 'monologue' ? 700 : 400,
                      transition: 'all 0.15s ease',
                    }}
                  >
                    Single Voice
                  </button>
                  <button
                    onClick={() => switchMode('dialog')}
                    disabled={!narrationState?.dialogScript}
                    title={!narrationState?.dialogScript ? 'Generate a dialog script first in the Script tab' : undefined}
                    style={{
                      padding: '7px 18px', border: 'none',
                      background: narrationMode === 'dialog' ? 'var(--accent)' : 'transparent',
                      color: !narrationState?.dialogScript
                        ? 'var(--fg-muted)'
                        : narrationMode === 'dialog' ? '#fff' : 'var(--fg-muted)',
                      cursor: !narrationState?.dialogScript ? 'not-allowed' : 'pointer',
                      fontSize: 12,
                      fontWeight: narrationMode === 'dialog' ? 700 : 400,
                      opacity: !narrationState?.dialogScript ? 0.4 : 1,
                      transition: 'all 0.15s ease',
                    }}
                  >
                    Dialog
                  </button>
                </div>
                <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
                  {narrationMode === 'monologue'
                    ? 'One voice narrates the entire script'
                    : 'Two speakers discuss the topic naturally'}
                </span>
              </div>

              {/* ── Voice selection bar (Monologue) ──────────── */}
              {narrationMode === 'monologue' && (
                <div
                  style={{
                    background: 'var(--surface)',
                    border: '1px solid var(--border)',
                    borderRadius: 10,
                    padding: 14,
                    marginBottom: 16,
                  }}
                >
                  {/* Saved profiles row */}
                  {voiceProfiles && voiceProfiles.length > 0 && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
                      {voiceProfiles.map((p: VoiceProfileInfo) => {
                        const isActive =
                          selectedEngine === p.engine &&
                          selectedVoice === p.voice &&
                          Math.abs(selectedSpeed - p.speed) < 0.05;
                        return (
                          <button
                            key={p.id}
                            onClick={() => {
                              setSelectedEngine(p.engine);
                              setSelectedVoice(p.voice);
                              setSelectedSpeed(p.speed);
                            }}
                            style={{
                              padding: '5px 12px',
                              borderRadius: 6,
                              border: isActive ? '2px solid var(--accent)' : '1px solid var(--border)',
                              background: isActive ? 'var(--accent)15' : 'transparent',
                              color: isActive ? 'var(--accent)' : 'var(--fg-muted)',
                              cursor: 'pointer',
                              fontSize: 12,
                              fontWeight: isActive ? 600 : 400,
                            }}
                          >
                            {p.name}
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {/* Engine / Voice / Speed row */}
                  <div style={{ display: 'flex', gap: 12, alignItems: 'end', flexWrap: 'wrap' }}>
                    <div style={{ flex: '1 1 140px', minWidth: 120 }}>
                      <label style={{ display: 'block', fontSize: 10, color: 'var(--fg-muted)', marginBottom: 3, fontWeight: 600, textTransform: 'uppercase' }}>
                        Engine
                      </label>
                      <select
                        value={selectedEngine}
                        onChange={(e) => {
                          setSelectedEngine(e.target.value);
                          const eng = engines?.find((x) => x.id === e.target.value);
                          if (eng?.voices[0]) setSelectedVoice(eng.voices[0].id);
                        }}
                        style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--fg)', fontSize: 12 }}
                      >
                        {engines?.map((eng) => (
                          <option key={eng.id} value={eng.id}>{eng.displayName}</option>
                        ))}
                      </select>
                    </div>
                    <div style={{ flex: '2 1 180px', minWidth: 150 }}>
                      <label style={{ display: 'block', fontSize: 10, color: 'var(--fg-muted)', marginBottom: 3, fontWeight: 600, textTransform: 'uppercase' }}>
                        Voice
                      </label>
                      <select
                        value={selectedVoice}
                        onChange={(e) => setSelectedVoice(e.target.value)}
                        style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--fg)', fontSize: 12 }}
                      >
                        {currentEngine?.voices.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.name}{v.description ? ` — ${v.description}` : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div style={{ flex: '0 0 100px' }}>
                      <label style={{ display: 'block', fontSize: 10, color: 'var(--fg-muted)', marginBottom: 3, fontWeight: 600, textTransform: 'uppercase' }}>
                        Speed {selectedSpeed.toFixed(1)}x
                      </label>
                      <input type="range" min={0.5} max={2.0} step={0.1} value={selectedSpeed}
                        onChange={(e) => setSelectedSpeed(parseFloat(e.target.value))}
                        style={{ width: '100%' }}
                      />
                    </div>
                    <button
                      onClick={() => generateAllChunks('all')}
                      disabled={!!generateAllProgress || generatingChunks.size > 0}
                      style={{
                        padding: '7px 16px',
                        background: 'var(--accent)',
                        color: '#fff',
                        border: 'none',
                        borderRadius: 6,
                        cursor: generateAllProgress ? 'wait' : 'pointer',
                        fontSize: 12,
                        fontWeight: 600,
                        opacity: generateAllProgress ? 0.7 : 1,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {generateAllProgress
                        ? `Generating ${generateAllProgress.done}/${generateAllProgress.total}...`
                        : 'Generate All'}
                    </button>
                  </div>

                  {/* Cost estimate for the upcoming Generate All — sums
                      every un-narrated chunk against the engine that
                      would actually be called (per-speaker in dialog,
                      global selection in monologue). */}
                  {pendingCost.chars > 0 && (
                    <NarrationCostBadge cost={pendingCost} />
                  )}

                  {/* Emotive tags hint */}
                  {currentEngine && currentEngine.supportedEmotives.length > 0 && (
                    <div style={{ marginTop: 8, fontSize: 10, color: 'var(--fg-muted)' }}>
                      Tags:{' '}
                      {currentEngine.supportedEmotives.map((tag) => (
                        <code key={tag} style={{ background: 'var(--bg)', padding: '1px 4px', borderRadius: 3, marginRight: 3, fontSize: 10 }}>
                          [{tag}]
                        </code>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* ── Speaker configs (Dialog mode) ──────────── */}
              {narrationMode === 'dialog' && (
                <div style={{
                  display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16,
                }}>
                  {['A', 'B'].map((key) => {
                    const cfg = speakerConfigs[key];
                    const colors = speakerColors[key]!;
                    const speakerEngine = engines?.find((e) => e.id === cfg?.engine);

                    return (
                      <div
                        key={key}
                        style={{
                          background: colors.bg,
                          border: `1px solid ${colors.border}`,
                          borderRadius: 10,
                          padding: 14,
                        }}
                      >
                        {/* Speaker label */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                          <span style={{
                            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                            width: 24, height: 24, borderRadius: 12, background: colors.badge,
                            color: '#fff', fontSize: 11, fontWeight: 800,
                          }}>
                            {key}
                          </span>
                          <input
                            value={cfg?.label ?? `Speaker ${key}`}
                            onChange={(e) => {
                              setSpeakerConfigs((prev) => ({
                                ...prev,
                                [key]: { ...(prev[key] ?? { engine: 'fake', voice: 'alice', speed: 1.0 }), label: e.target.value },
                              }));
                              // speaker config auto-saved on generate
                            }}
                            style={{
                              flex: 1, padding: '4px 8px', border: '1px solid var(--border)',
                              borderRadius: 5, background: 'var(--bg)', color: 'var(--fg)',
                              fontSize: 13, fontWeight: 600,
                            }}
                            placeholder={`Speaker ${key}`}
                          />
                        </div>

                        {/* Engine */}
                        <div style={{ marginBottom: 8 }}>
                          <label style={{ display: 'block', fontSize: 10, color: 'var(--fg-muted)', marginBottom: 2, fontWeight: 600, textTransform: 'uppercase' }}>
                            Engine
                          </label>
                          <select
                            value={cfg?.engine ?? ''}
                            onChange={(e) => {
                              const eng = engines?.find((x) => x.id === e.target.value);
                              setSpeakerConfigs((prev) => ({
                                ...prev,
                                [key]: {
                                  ...(prev[key] ?? { voice: '', speed: 1.0 }),
                                  engine: e.target.value,
                                  voice: eng?.voices[0]?.id ?? '',
                                },
                              }));
                              // speaker config auto-saved on generate
                            }}
                            style={{ width: '100%', padding: '5px 8px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--fg)', fontSize: 12 }}
                          >
                            {engines?.map((eng) => (
                              <option key={eng.id} value={eng.id}>{eng.displayName}</option>
                            ))}
                          </select>
                        </div>

                        {/* Voice */}
                        <div style={{ marginBottom: 8 }}>
                          <label style={{ display: 'block', fontSize: 10, color: 'var(--fg-muted)', marginBottom: 2, fontWeight: 600, textTransform: 'uppercase' }}>
                            Voice
                          </label>
                          <select
                            value={cfg?.voice ?? ''}
                            onChange={(e) => {
                              setSpeakerConfigs((prev) => ({
                                ...prev,
                                [key]: { ...(prev[key] ?? { engine: 'fake', speed: 1.0 }), voice: e.target.value },
                              }));
                              // speaker config auto-saved on generate
                            }}
                            style={{ width: '100%', padding: '5px 8px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--fg)', fontSize: 12 }}
                          >
                            {speakerEngine?.voices.map((v) => (
                              <option key={v.id} value={v.id}>
                                {v.name}{v.description ? ` — ${v.description}` : ''}
                              </option>
                            ))}
                          </select>
                        </div>

                        {/* Speed */}
                        <div>
                          <label style={{ display: 'block', fontSize: 10, color: 'var(--fg-muted)', marginBottom: 2, fontWeight: 600, textTransform: 'uppercase' }}>
                            Speed {(cfg?.speed ?? 1.0).toFixed(1)}x
                          </label>
                          <input type="range" min={0.5} max={2.0} step={0.1} value={cfg?.speed ?? 1.0}
                            onChange={(e) => {
                              setSpeakerConfigs((prev) => ({
                                ...prev,
                                [key]: { ...(prev[key] ?? { engine: 'fake', voice: 'alice' }), speed: parseFloat(e.target.value) },
                              }));
                              // speaker config auto-saved on generate
                            }}
                            style={{ width: '100%' }}
                          />
                        </div>
                      </div>
                    );
                  })}

                  {/* Generate All / Retry Failed buttons */}
                  <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                    {(() => {
                      const failedCount = (narrationState.chunks ?? []).filter((c) => c.failed).length;
                      return failedCount > 0 ? (
                        <button
                          onClick={() => generateAllChunks('failed')}
                          disabled={!!generateAllProgress || generatingChunks.size > 0}
                          style={{
                            padding: '8px 16px',
                            background: 'var(--surface)',
                            color: 'var(--danger)',
                            border: '1px solid var(--danger)',
                            borderRadius: 6,
                            cursor: generateAllProgress ? 'wait' : 'pointer',
                            fontSize: 12,
                            fontWeight: 600,
                          }}
                        >
                          Retry Failed ({failedCount})
                        </button>
                      ) : null;
                    })()}
                    <button
                      onClick={() => generateAllChunks('all')}
                      disabled={!!generateAllProgress || generatingChunks.size > 0}
                      style={{
                        padding: '8px 20px',
                        background: 'var(--accent)',
                        color: '#fff',
                        border: 'none',
                        borderRadius: 6,
                        cursor: generateAllProgress ? 'wait' : 'pointer',
                        fontSize: 12,
                        fontWeight: 600,
                        opacity: generateAllProgress ? 0.7 : 1,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {generateAllProgress
                        ? `Generating ${generateAllProgress.done}/${generateAllProgress.total}…`
                        : 'Generate All'}
                    </button>
                  </div>
                </div>
              )}

              {/* ── Progress bar with cancel ─────────────────── */}
              {generateAllProgress && (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--fg-muted)', marginBottom: 4 }}>
                    <span>{generateAllProgress.message ?? 'Generating narration…'}</span>
                    <span>
                      {generateAllProgress.done} / {generateAllProgress.total}
                      {generateAllProgress.failed > 0 && (
                        <span style={{ color: 'var(--danger)', marginLeft: 8 }}>· {generateAllProgress.failed} failed</span>
                      )}
                    </span>
                  </div>
                  <div style={{ height: 6, background: 'var(--surface)', borderRadius: 3, overflow: 'hidden', border: '1px solid var(--border)' }}>
                    <div
                      style={{
                        height: '100%',
                        width: `${generateAllProgress.total > 0 ? ((generateAllProgress.done + generateAllProgress.failed) / generateAllProgress.total) * 100 : 0}%`,
                        background: 'var(--accent)',
                        borderRadius: 3,
                        transition: 'width 0.3s ease',
                      }}
                    />
                  </div>
                  {generateAllJobId && (
                    <div style={{ marginTop: 6, textAlign: 'right' }}>
                      <button
                        onClick={cancelGenerateAll}
                        style={{
                          fontSize: 11,
                          padding: '4px 10px',
                          background: 'transparent',
                          color: 'var(--fg-muted)',
                          border: '1px solid var(--border)',
                          borderRadius: 4,
                          cursor: 'pointer',
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* ── Paragraph chunks (read-only text + audio) ── */}
              {narrationState.chunks.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {narrationState.chunks.map((chunk) => {
                    const isGenerating = generatingChunks.has(chunk.index);
                    const chunkSpeaker = chunkSpeakers.get(chunk.index) ?? 'A';
                    const colors = speakerColors[chunkSpeaker] ?? speakerColors.A!;
                    const isDialog = narrationMode === 'dialog';
                    const speakerLabel = isDialog ? (speakerConfigs[chunkSpeaker]?.label ?? `Speaker ${chunkSpeaker}`) : undefined;

                    return (
                      <div
                        key={chunk.index}
                        style={{
                          background: isDialog ? colors.bg : 'var(--surface)',
                          border: chunk.failed
                            ? '1px solid var(--danger)'
                            : chunk.hasAudio
                              ? `1px solid #5e8a3a40`
                              : isDialog ? `1px solid ${colors.border}` : '1px solid var(--border)',
                          borderRadius: 10,
                          padding: 14,
                          opacity: isGenerating ? 0.7 : 1,
                          transition: 'all 0.2s ease',
                          borderLeft: chunk.failed
                            ? '3px solid var(--danger)'
                            : isDialog ? `3px solid ${colors.badge}` : undefined,
                        }}
                      >
                        {chunk.failed && (
                          <div
                            title={chunk.failed.reason}
                            style={{
                              fontSize: 11,
                              color: 'var(--danger)',
                              background: 'rgba(194, 93, 93, 0.08)',
                              border: '1px solid rgba(194, 93, 93, 0.4)',
                              padding: '6px 8px',
                              borderRadius: 4,
                              marginBottom: 8,
                              display: 'flex',
                              gap: 6,
                              alignItems: 'flex-start',
                            }}
                          >
                            <span style={{ flexShrink: 0, fontWeight: 700 }}>FAILED</span>
                            <span style={{
                              flex: 1,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              display: '-webkit-box',
                              WebkitLineClamp: 2,
                              WebkitBoxOrient: 'vertical' as const,
                              wordBreak: 'break-word',
                            }}>
                              {chunk.failed.reason}
                            </span>
                          </div>
                        )}
                        {/* Chunk header */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                          {/* Speaker toggle (dialog mode) */}
                          {isDialog && (
                            <div style={{
                              display: 'inline-flex', borderRadius: 6, overflow: 'hidden',
                              border: '1px solid var(--border)',
                            }}>
                              {['A', 'B'].map((s) => (
                                <button
                                  key={s}
                                  onClick={() => {
                                    setChunkSpeakers((prev) => {
                                      const next = new Map(prev);
                                      next.set(chunk.index, s);
                                      return next;
                                    });
                                    // Auto-save speaker assignment
                                    if (projectId && sceneId) {
                                      narrationApi.saveSpeakerAssignments(projectId, sceneId, [{ index: chunk.index, speaker: s }]);
                                    }
                                  }}
                                  style={{
                                    padding: '2px 10px',
                                    border: 'none',
                                    background: chunkSpeaker === s ? speakerColors[s]!.badge : 'transparent',
                                    color: chunkSpeaker === s ? '#fff' : 'var(--fg-muted)',
                                    cursor: 'pointer',
                                    fontSize: 10,
                                    fontWeight: 700,
                                    transition: 'all 0.1s',
                                  }}
                                >
                                  {s}
                                </button>
                              ))}
                            </div>
                          )}

                          {isDialog && speakerLabel && (
                            <span style={{ fontSize: 11, color: colors.text, fontWeight: 600 }}>
                              {speakerLabel}
                            </span>
                          )}

                          <span style={{
                            fontSize: 10, fontWeight: 700, color: 'var(--fg-muted)',
                            background: 'var(--bg)', padding: '2px 8px', borderRadius: 4,
                            textTransform: 'uppercase', letterSpacing: '0.05em',
                          }}>
                            {isDialog ? `¶${chunk.index + 1}` : `Paragraph ${chunk.index + 1}`}
                          </span>
                          {chunk.hasAudio && (
                            <span style={{ fontSize: 10, color: STATUS_COLOR.success, fontWeight: 600 }}>
                              {chunk.durationSec != null ? `${chunk.durationSec.toFixed(1)}s` : 'Done'}
                            </span>
                          )}
                          <div style={{ flex: 1 }} />
                          <button
                            onClick={() => generateChunk(chunk)}
                            disabled={isGenerating || !!generateAllProgress}
                            style={{
                              padding: '4px 12px',
                              background: isGenerating ? 'var(--surface)' : chunk.hasAudio ? 'transparent' : 'var(--accent)',
                              color: isGenerating ? 'var(--fg-muted)' : chunk.hasAudio ? 'var(--fg-muted)' : '#fff',
                              border: chunk.hasAudio && !isGenerating ? '1px solid var(--border)' : 'none',
                              borderRadius: 5,
                              cursor: isGenerating ? 'wait' : 'pointer',
                              fontSize: 11,
                              fontWeight: 600,
                            }}
                          >
                            {isGenerating ? 'Generating...' : chunk.hasAudio ? 'Regenerate' : 'Generate'}
                          </button>
                        </div>

                        {/* Script text (read-only — edit in Script tab) */}
                        <p style={{
                          margin: 0, padding: 10,
                          fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                          fontSize: 12, lineHeight: 1.6,
                          color: 'var(--fg-muted)', whiteSpace: 'pre-wrap',
                          background: 'var(--bg)', borderRadius: 6,
                          border: '1px solid var(--border)',
                        }}>
                          {chunk.text}
                        </p>

                        {/* Audio player */}
                        {chunk.hasAudio && (
                          <audio
                            controls
                            key={`${chunk.index}-${audioCacheBust.current}`}
                            src={narrationApi.chunkAudioUrl(projectId!, sceneId!, chunk.index)}
                            style={{ width: '100%', marginTop: 8, height: 36 }}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div style={{
                  padding: 32, textAlign: 'center', color: 'var(--fg-muted)',
                  border: '1px dashed var(--border)', borderRadius: 8,
                }}>
                  <p style={{ fontSize: 13 }}>Script will be split into paragraphs for narration.</p>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {activeTab === 'Lower Thirds' && (
        <div>
          {/* Blocking modal during overlay burn-in. ffmpeg drawtext+drawbox can
              run for several seconds on longer scenes, and rendering is the
              one step that's safe to navigate away from on the server side
              but confusing on the client side because the only progress
              indicator was the inline button label. */}
          <GenerationModal
            open={overlayRenderMutation.isPending}
            title="Rendering overlay"
            phase="Burning lower thirds into the scene video…"
            hint="ffmpeg is drawing the LT graphics onto the recording. Usually a few seconds per scene minute."
          />
          <GenerationModal
            open={recommendLTsMutation.isPending}
            title="Recommending lower thirds"
            phase={
              ltGroundInVideo && canGroundInVideo
                ? 'Uploading video to Gemini → analysing → picking moments to label…'
                : 'Asking the model for title cards…'
            }
            hint={
              ltGroundInVideo && canGroundInVideo
                ? 'Video upload + Gemini analysis usually takes 30–60s. The model anchors each LT to a real on-screen moment.'
                : 'One LLM call, usually 5–15 seconds.'
            }
          />

          {/* Video-grounded toggle. Same pattern as the Script tab —
              only shown when toggling would actually change behaviour
              (Gemini active + recording present). */}
          {canGroundInVideo && (
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBottom: 12,
                fontSize: 13,
                color: 'var(--fg-muted)',
                userSelect: 'none',
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={ltGroundInVideo}
                onChange={(e) => setLtGroundInVideo(e.target.checked)}
                disabled={recommendLTsMutation.isPending}
              />
              <span>
                Ground in actual video (sends recording to {activeModel?.label ?? 'Gemini'} — anchors
                each LT to a real on-screen moment)
              </span>
            </label>
          )}

          {/* Action buttons */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <button
              onClick={() => recommendLTsMutation.mutate()}
              disabled={recommendLTsMutation.isPending}
              style={{
                padding: '8px 16px',
                background: editingLTs && editingLTs.length > 0 ? 'var(--surface)' : 'var(--accent)',
                color: editingLTs && editingLTs.length > 0 ? 'var(--fg)' : '#fff',
                border: editingLTs && editingLTs.length > 0 ? '1px solid var(--border)' : 'none',
                borderRadius: 6,
                cursor: recommendLTsMutation.isPending ? 'wait' : 'pointer',
                fontSize: 13,
                fontWeight: 600,
                opacity: recommendLTsMutation.isPending ? 0.7 : 1,
              }}
            >
              {recommendLTsMutation.isPending
                ? 'Recommending...'
                : editingLTs && editingLTs.length > 0
                  ? 'Re-recommend'
                  : 'Recommend Lower Thirds'}
            </button>
            {editingLTs && (
              <button
                onClick={() => {
                  setEditingLTs([
                    ...editingLTs,
                    { title: 'New Title', style: 'frosted', in_sec: 0, out_sec: 4 },
                  ]);
                  setLtDirty(true);
                }}
                style={{
                  padding: '8px 16px',
                  background: 'var(--surface)',
                  color: 'var(--fg)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  cursor: 'pointer',
                  fontSize: 13,
                }}
              >
                + Add
              </button>
            )}
            {/* Save is gated on ltDirty (not array length) so deleting the
                last entry — or all entries — can still be persisted. The
                empty array is a valid saved state. */}
            {ltDirty && editingLTs && (
              <button
                onClick={async () => {
                  if (!scene) return;
                  const ok = await confirmDestructiveSave(ui, {
                    scope: 'lower-thirds',
                    scene,
                  });
                  if (!ok) return;
                  saveLTsMutation.mutate(editingLTs);
                }}
                disabled={saveLTsMutation.isPending}
                style={{
                  padding: '8px 16px',
                  background: 'var(--accent)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 6,
                  cursor: 'pointer',
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                {saveLTsMutation.isPending ? 'Saving...' : 'Save'}
              </button>
            )}
            {scene?.recording && !ltDirty && editingLTs && editingLTs.length > 0 && (
              <button
                onClick={() => overlayRenderMutation.mutate()}
                disabled={overlayRenderMutation.isPending}
                style={{
                  padding: '8px 16px',
                  background: overlayRenderMutation.isPending ? 'var(--surface)' : STATUS_COLOR.success,
                  color: '#fff',
                  border: 'none',
                  borderRadius: 6,
                  cursor: overlayRenderMutation.isPending ? 'wait' : 'pointer',
                  fontSize: 13,
                  fontWeight: 600,
                  opacity: overlayRenderMutation.isPending ? 0.7 : 1,
                }}
              >
                {overlayRenderMutation.isPending ? 'Rendering...' : 'Render Overlay'}
              </button>
            )}
          </div>

          {/* Overlay render result */}
          {overlayRenderMutation.isSuccess && (
            <p style={{ color: STATUS_COLOR.success, fontSize: 12, marginBottom: 12 }}>
              Overlay rendered successfully ({overlayRenderMutation.data.durationSec.toFixed(1)}s)
            </p>
          )}
          {overlayRenderMutation.isError && (
            <p style={{ color: 'var(--danger)', fontSize: 12, marginBottom: 12 }}>
              Render failed:{' '}
              {overlayRenderMutation.error instanceof Error
                ? overlayRenderMutation.error.message
                : 'Unknown error'}
            </p>
          )}
          {scene?.overlay_render && !overlayRenderMutation.isPending && (
            <p style={{ fontSize: 12, color: 'var(--fg-muted)', marginBottom: 12 }}>
              Rendered overlay available:{' '}
              <a
                href={overlayApi.videoUrl(projectId!, sceneId!)}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: 'var(--accent)' }}
              >
                View video
              </a>
            </p>
          )}

          {/* Error */}
          {recommendLTsMutation.isError && (
            <p style={{ color: 'var(--danger)', fontSize: 13, marginBottom: 12 }}>
              Recommendation failed:{' '}
              {recommendLTsMutation.error instanceof Error
                ? recommendLTsMutation.error.message
                : 'Unknown error'}
            </p>
          )}

          {/* Lower thirds list */}
          {/* Timeline overview — gives the user a visual on overlap +
              ordering and a drag-to-position editor that complements the
              precise numeric inputs in the cards below. Only shown when
              we have a recording duration to scale the track by. */}
          {editingLTs && editingLTs.length > 0 && scene?.recording?.duration_sec && (
            <LowerThirdsTimeline
              lts={editingLTs}
              durationSec={scene.recording.duration_sec}
              onChange={(idx, in_sec, out_sec) => {
                const updated = editingLTs.map((lt, i) => (i === idx ? { ...lt, in_sec, out_sec } : lt));
                setEditingLTs(updated);
                setLtDirty(true);
              }}
            />
          )}

          {editingLTs && editingLTs.length > 0 ? (
            // Each LT renders as a card with a clear header (number + Remove)
            // and the form fields stacked below as one visual unit. The
            // previous layout split the row into "Title / Subtitle / Remove"
            // and a separate "Style / In / Out" line, with Remove sitting
            // visually attached to Title/Subtitle while actually deleting
            // the whole thing including the line below — mental model
            // mismatch. Now Remove lives in the card header where its
            // scope is unambiguous.
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {editingLTs.map((lt, idx) => (
                <div
                  key={idx}
                  style={{
                    background: 'var(--surface)',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    padding: 14,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 10,
                  }}
                >
                  {/* Card header — number + Remove. Remove's position here
                      reads as "delete this card", not "delete title". */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      paddingBottom: 8,
                      borderBottom: '1px solid var(--border)',
                    }}
                  >
                    <span
                      style={{
                        fontSize: 11,
                        color: 'var(--fg-muted)',
                        textTransform: 'uppercase',
                        letterSpacing: 1,
                        fontWeight: 600,
                      }}
                    >
                      Lower third {idx + 1}
                    </span>
                    <button
                      onClick={() => {
                        setEditingLTs(editingLTs.filter((_, i) => i !== idx));
                        setLtDirty(true);
                      }}
                      title="Remove this lower third"
                      style={{
                        padding: '4px 10px',
                        background: 'transparent',
                        border: '1px solid var(--border)',
                        borderRadius: 4,
                        color: 'var(--danger)',
                        cursor: 'pointer',
                        fontSize: 11,
                      }}
                    >
                      ✕ Remove
                    </button>
                  </div>

                  {/* Title + Subtitle on one row */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    <div>
                      <label
                        style={{
                          display: 'block',
                          fontSize: 11,
                          color: 'var(--fg-muted)',
                          marginBottom: 4,
                          textTransform: 'uppercase',
                          letterSpacing: 0.5,
                        }}
                      >
                        Title
                      </label>
                      <input
                        value={lt.title}
                        onChange={(e) => {
                          const updated = [...editingLTs];
                          updated[idx] = { ...lt, title: e.target.value };
                          setEditingLTs(updated);
                          setLtDirty(true);
                        }}
                        style={{
                          width: '100%',
                          padding: '6px 8px',
                          border: '1px solid var(--border)',
                          borderRadius: 4,
                          background: 'var(--bg)',
                          color: 'var(--fg)',
                          fontSize: 13,
                        }}
                      />
                    </div>
                    <div>
                      <label
                        style={{
                          display: 'block',
                          fontSize: 11,
                          color: 'var(--fg-muted)',
                          marginBottom: 4,
                          textTransform: 'uppercase',
                          letterSpacing: 0.5,
                        }}
                      >
                        Subtitle <span style={{ textTransform: 'none', letterSpacing: 0, opacity: 0.7 }}>(optional)</span>
                      </label>
                      <input
                        value={lt.subtitle ?? ''}
                        onChange={(e) => {
                          const updated = [...editingLTs];
                          updated[idx] = { ...lt, subtitle: e.target.value || undefined };
                          setEditingLTs(updated);
                          setLtDirty(true);
                        }}
                        style={{
                          width: '100%',
                          padding: '6px 8px',
                          border: '1px solid var(--border)',
                          borderRadius: 4,
                          background: 'var(--bg)',
                          color: 'var(--fg)',
                          fontSize: 13,
                        }}
                      />
                    </div>
                  </div>

                  {/* Style + timing on the next row, visually grouped */}
                  <div
                    style={{
                      display: 'flex',
                      gap: 14,
                      alignItems: 'flex-end',
                      flexWrap: 'wrap',
                    }}
                  >
                    <div style={{ minWidth: 110 }}>
                      <label
                        style={{
                          display: 'block',
                          fontSize: 11,
                          color: 'var(--fg-muted)',
                          marginBottom: 4,
                          textTransform: 'uppercase',
                          letterSpacing: 0.5,
                        }}
                      >
                        Style
                      </label>
                      <select
                        value={lt.style}
                        onChange={(e) => {
                          const updated = [...editingLTs];
                          updated[idx] = { ...lt, style: e.target.value as 'frosted' | 'solid' | 'minimal' };
                          setEditingLTs(updated);
                          setLtDirty(true);
                        }}
                        style={{
                          width: '100%',
                          padding: '6px 8px',
                          border: '1px solid var(--border)',
                          borderRadius: 4,
                          background: 'var(--bg)',
                          color: 'var(--fg)',
                          fontSize: 13,
                        }}
                      >
                        <option value="frosted">Frosted</option>
                        <option value="solid">Solid</option>
                        <option value="minimal">Minimal</option>
                      </select>
                    </div>
                    <div>
                      <label
                        style={{
                          display: 'block',
                          fontSize: 11,
                          color: 'var(--fg-muted)',
                          marginBottom: 4,
                          textTransform: 'uppercase',
                          letterSpacing: 0.5,
                        }}
                      >
                        In (s)
                      </label>
                      <input
                        type="number"
                        min={0}
                        step={0.5}
                        value={lt.in_sec}
                        onChange={(e) => {
                          const updated = [...editingLTs];
                          updated[idx] = { ...lt, in_sec: parseFloat(e.target.value) || 0 };
                          setEditingLTs(updated);
                          setLtDirty(true);
                        }}
                        style={{
                          width: 80,
                          padding: '6px 8px',
                          border: '1px solid var(--border)',
                          borderRadius: 4,
                          background: 'var(--bg)',
                          color: 'var(--fg)',
                          fontSize: 13,
                        }}
                      />
                    </div>
                    <div>
                      <label
                        style={{
                          display: 'block',
                          fontSize: 11,
                          color: 'var(--fg-muted)',
                          marginBottom: 4,
                          textTransform: 'uppercase',
                          letterSpacing: 0.5,
                        }}
                      >
                        Out (s)
                      </label>
                      <input
                        type="number"
                        min={0}
                        step={0.5}
                        value={lt.out_sec}
                        onChange={(e) => {
                          const updated = [...editingLTs];
                          updated[idx] = { ...lt, out_sec: parseFloat(e.target.value) || 0 };
                          setEditingLTs(updated);
                          setLtDirty(true);
                        }}
                        style={{
                          width: 80,
                          padding: '6px 8px',
                          border: '1px solid var(--border)',
                          borderRadius: 4,
                          background: 'var(--bg)',
                          color: 'var(--fg)',
                          fontSize: 13,
                        }}
                      />
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: 'var(--fg-muted)',
                        marginLeft: 'auto',
                        paddingBottom: 6,
                      }}
                    >
                      duration {Math.max(0, lt.out_sec - lt.in_sec).toFixed(1)}s
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div
              style={{
                padding: 48,
                textAlign: 'center',
                color: 'var(--fg-muted)',
                border: '1px dashed var(--border)',
                borderRadius: 8,
              }}
            >
              <p style={{ fontSize: 14, marginBottom: 4 }}>No lower thirds yet.</p>
              <p style={{ fontSize: 12 }}>
                {ltDirty
                  ? <>You've removed all entries. Click <strong>Save</strong> above to commit the empty list, or <strong>Recommend</strong> to start over.</>
                  : <>Click <strong>Recommend Lower Thirds</strong> to get AI-suggested overlays.</>}
              </p>
            </div>
          )}
          {ltDirty && (
            <p style={{ color: 'var(--warn)', fontSize: 12, marginTop: 12 }}>Unsaved changes</p>
          )}
        </div>
      )}

      {activeTab === 'Preview' && projectId && scene && (
        <>
          <ScenePreview
            projectId={projectId}
            scene={scene}
            chunks={(narrationState?.chunks ?? []).map((c) => ({
              index: c.index,
              durationSec: c.durationSec ?? null,
              hasAudio: c.hasAudio,
            }))}
          />
          <SceneRenderSection projectId={projectId} sceneId={scene.id} />
        </>
      )}

      {tightenOpen && projectId && sceneId && (
        <TightenScriptModal
          projectId={projectId}
          sceneId={sceneId}
          sceneName={scene?.name ?? sceneId}
          onClose={() => setTightenOpen(false)}
          onAccepted={() => {
            // Server saved a new script + wiped TTS chunks. Drop our
            // local edit buffer so the next render reads the new value
            // from the storyboard query.
            setEditingScript(null);
            setScriptDirty(false);
            queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] });
            queryClient.invalidateQueries({ queryKey: ['narration', projectId, sceneId] });
            queryClient.invalidateQueries({ queryKey: ['script', projectId, sceneId] });
          }}
        />
      )}

      {polishOpen && projectId && sceneId && (
        <PolishScriptModal
          projectId={projectId}
          sceneId={sceneId}
          sceneName={scene?.name ?? sceneId}
          draft={draftScript}
          onClose={() => setPolishOpen(false)}
          onAccepted={() => {
            // Polished script was saved as the monologue (+ TTS chunks wiped,
            // previous version backed up). Same as Tighten: drop the local
            // edit buffer so the editor re-reads the saved value, and show a
            // toast for parity with the editor's own Save.
            setEditingScript(null);
            setScriptDirty(false);
            queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] });
            queryClient.invalidateQueries({ queryKey: ['narration', projectId, sceneId] });
            queryClient.invalidateQueries({ queryKey: ['script', projectId, sceneId] });
            ui.showToast({ message: 'Polished script saved. Existing TTS chunks were cleared.', tone: 'success' });
          }}
        />
      )}
    </div>
  );
}

// ── DiffRow ─────────────────────────────────────────────────────────
//
// Shows current vs proposed values side-by-side. Used by the Re-analyze
// diff preview so the user sees exactly what's about to be overwritten.
// Equal values render as a single line with a muted "(unchanged)" tag
// to keep the panel concise when only one field actually changed.

/** Inline cost summary for the "Generate All" affordance. Mirrors the
 *  shape used on the Quick TTS page so users see consistent pricing UI
 *  whether they're scratching a one-off or generating a scene. */
function NarrationCostBadge({
  cost,
}: {
  cost: { chars: number; costUsd: number; free: boolean; unknown?: boolean; label: string; engines: string[] };
}) {
  const enginesLabel = cost.engines.length === 1
    ? cost.engines[0]
    : `${cost.engines.length} engines`;
  const tone: 'paid' | 'free' | 'unknown' = cost.unknown
    ? 'unknown'
    : cost.free
      ? 'free'
      : 'paid';
  const stylesByTone: Record<typeof tone, React.CSSProperties> = {
    paid: { background: 'var(--accent-bg)', color: 'var(--accent)', borderColor: 'var(--accent)' },
    free: { background: 'transparent', color: 'var(--fg-muted)', borderColor: 'var(--border)' },
    unknown: { background: 'transparent', color: 'var(--fg-muted)', borderColor: 'var(--border)' },
  };
  const valueLabel = tone === 'paid'
    ? `~${formatUsd(cost.costUsd)}`
    : tone === 'free'
      ? 'free'
      : 'pricing unknown';
  return (
    <div
      title={
        tone === 'paid'
          ? `Estimated cost to synthesize ${cost.chars.toLocaleString()} characters across ${enginesLabel}.`
          : tone === 'free'
            ? `No per-character charge on ${enginesLabel} (local model or preview tier).`
            : `No price data for ${enginesLabel}.`
      }
      style={{
        marginTop: 8,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 11,
        fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, monospace",
        fontVariantNumeric: 'tabular-nums',
        padding: '4px 10px',
        borderRadius: 999,
        border: '1px solid',
        ...stylesByTone[tone],
      }}
    >
      <span aria-hidden>{tone === 'paid' ? '$' : '○'}</span>
      <span>{valueLabel}</span>
      <span style={{ opacity: 0.7 }}>· {cost.label}</span>
      <span style={{ opacity: 0.5 }}>· {enginesLabel}</span>
    </div>
  );
}

function DiffRow({
  label,
  current,
  proposed,
  multiline,
}: {
  label: string;
  current: string;
  proposed: string;
  multiline?: boolean;
}) {
  const unchanged = current === proposed;
  return (
    <div style={{ marginBottom: 10, fontSize: 12 }}>
      <div
        style={{
          fontSize: 10,
          color: 'var(--fg-muted)',
          textTransform: 'uppercase',
          letterSpacing: 1,
          marginBottom: 4,
          fontWeight: 600,
        }}
      >
        {label}
        {unchanged && (
          <span style={{ marginLeft: 8, opacity: 0.7, textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>
            (unchanged)
          </span>
        )}
      </div>
      {unchanged ? (
        <div
          style={{
            color: 'var(--fg-muted)',
            whiteSpace: multiline ? 'pre-wrap' : 'nowrap',
            overflow: multiline ? 'visible' : 'hidden',
            textOverflow: multiline ? 'clip' : 'ellipsis',
            lineHeight: 1.5,
          }}
        >
          {current || <em>(empty)</em>}
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 8,
          }}
        >
          <div
            style={{
              padding: 8,
              background: 'var(--bg)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              opacity: 0.7,
              textDecoration: 'line-through',
              whiteSpace: multiline ? 'pre-wrap' : 'nowrap',
              overflow: multiline ? 'visible' : 'hidden',
              textOverflow: 'ellipsis',
              lineHeight: 1.5,
            }}
          >
            {current || <em>(empty)</em>}
          </div>
          <div
            style={{
              padding: 8,
              background: 'var(--accent-2-bg)',
              border: '1px solid var(--accent-2)',
              borderRadius: 4,
              whiteSpace: multiline ? 'pre-wrap' : 'nowrap',
              overflow: multiline ? 'visible' : 'hidden',
              textOverflow: 'ellipsis',
              lineHeight: 1.5,
            }}
          >
            {proposed || <em>(empty)</em>}
          </div>
        </div>
      )}
    </div>
  );
}
