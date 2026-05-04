import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useOutletContext } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { storyboardApi, recordingsApi, scriptApi, ttsApi, voiceApi, narrationApi, lowerThirdsApi, overlayApi } from '../lib/api.js';
import type { LowerThirdItem, VoiceProfileInfo, NarrationChunkInfo, TtsEngineInfo, SpeakerConfig } from '../lib/api.js';
import { RecordingUpload } from '../components/RecordingUpload.js';
import { RecordingInfo } from '../components/RecordingInfo.js';
import { ScenePreview } from '../components/ScenePreview.js';
import type { ProjectTrackerEntry } from '@vpa/shared';

interface WorkspaceContext {
  project: ProjectTrackerEntry;
}

const typeBadgeColors: Record<string, string> = {
  desktop: '#7aa2f7',
  terminal: '#5e8a3a',
  browser: '#f4a83a',
  slide: '#c25d5d',
};

const TABS = ['Recording', 'Script', 'Narration', 'Lower Thirds', 'Preview'] as const;
type Tab = (typeof TABS)[number];

export function ScenePage() {
  const { projectId, sceneId } = useParams<{ projectId: string; sceneId: string }>();
  const { project } = useOutletContext<WorkspaceContext>();
  const [activeTab, setActiveTab] = useState<Tab>('Recording');
  const [editingScript, setEditingScript] = useState<string | null>(null);
  const [scriptDirty, setScriptDirty] = useState(false);
  const [editingDialogScript, setEditingDialogScript] = useState<string | null>(null);
  const [dialogEditDirty, setDialogEditDirty] = useState(false);
  const queryClient = useQueryClient();

  const { data: storyboard } = useQuery({
    queryKey: ['storyboard', projectId],
    queryFn: () => storyboardApi.get(projectId!),
    enabled: !!projectId,
  });

  const scene = storyboard?.scenes.find((s) => s.id === sceneId);

  const uploadMutation = useMutation({
    mutationFn: (file: File) => recordingsApi.uploadForScene(projectId!, sceneId!, file),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] });
    },
  });

  const generateScriptMutation = useMutation({
    mutationFn: () => scriptApi.generate(projectId!, sceneId!),
    onSuccess: (data) => {
      setEditingScript(data.script);
      setScriptDirty(false);
      queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] });
    },
  });

  const saveMonologueMutation = useMutation({
    mutationFn: (script: string) => narrationApi.saveScript(projectId!, sceneId!, script, 'monologue'),
    onSuccess: () => {
      setScriptDirty(false);
      queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] });
      queryClient.invalidateQueries({ queryKey: ['narration', projectId, sceneId] });
      queryClient.invalidateQueries({ queryKey: ['script', projectId, sceneId] });
    },
  });

  const saveDialogMutation = useMutation({
    mutationFn: (script: string) => narrationApi.saveScript(projectId!, sceneId!, script, 'dialog'),
    onSuccess: () => {
      setDialogEditDirty(false);
      queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] });
      queryClient.invalidateQueries({ queryKey: ['narration', projectId, sceneId] });
      queryClient.invalidateQueries({ queryKey: ['script', projectId, sceneId] });
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

  const { data: scriptState } = useQuery({
    queryKey: ['script', projectId, sceneId],
    queryFn: () => scriptApi.get(projectId!, sceneId!),
    enabled: !!projectId && !!sceneId && activeTab === 'Script',
  });

  // NOTE: monologue script sync moved after narrationState declaration

  // --- Narration state ---
  const [selectedEngine, setSelectedEngine] = useState('fake');
  const [selectedVoice, setSelectedVoice] = useState('alice');
  const [selectedSpeed, setSelectedSpeed] = useState(1.0);
  const [editedChunks, setEditedChunks] = useState<Map<number, string>>(new Map());
  const [chunkScriptDirty, setChunkScriptDirty] = useState(false);
  const [generatingChunks, setGeneratingChunks] = useState<Set<number>>(new Set());
  const [generateAllProgress, setGenerateAllProgress] = useState<{ done: number; total: number } | null>(null);
  // Cache-bust key for audio elements after regeneration
  const audioCacheBust = useRef(0);
  // Dialog mode state
  const [narrationMode, setNarrationMode] = useState<'monologue' | 'dialog'>('monologue');
  const [speakerConfigs, setSpeakerConfigs] = useState<Record<string, SpeakerConfig>>({});
  const [chunkSpeakers, setChunkSpeakers] = useState<Map<number, string>>(new Map());
  const [convertingDialog, setConvertingDialog] = useState(false);
  const [convertError, setConvertError] = useState<string | null>(null);

  const { data: engines } = useQuery({
    queryKey: ['tts-engines'],
    queryFn: () => ttsApi.listEngines(),
    enabled: activeTab === 'Narration',
  });

  const { data: voiceProfiles } = useQuery({
    queryKey: ['voice-profiles'],
    queryFn: () => voiceApi.list(),
    enabled: activeTab === 'Narration',
  });

  const { data: narrationState } = useQuery({
    queryKey: ['narration', projectId, sceneId],
    queryFn: () => narrationApi.get(projectId!, sceneId!),
    enabled: !!projectId && !!sceneId && (activeTab === 'Narration' || activeTab === 'Script' || activeTab === 'Preview'),
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

  // Generate all chunks sequentially with progress
  const generateAllChunks = useCallback(async () => {
    if (!narrationState?.chunks?.length || !projectId || !sceneId) return;
    // Always persist speaker configs + assignments before generating
    await narrationApi.saveMode(projectId, sceneId, narrationMode, speakerConfigs);
    if (narrationMode === 'dialog') {
      const assignments = Array.from(chunkSpeakers.entries()).map(([index, speaker]) => ({ index, speaker }));
      await narrationApi.saveSpeakerAssignments(projectId, sceneId, assignments);
    }
    const chunks = narrationState.chunks;
    setGenerateAllProgress({ done: 0, total: chunks.length });
    for (let i = 0; i < chunks.length; i++) {
      await generateChunk(chunks[i]!);
      setGenerateAllProgress({ done: i + 1, total: chunks.length });
    }
    setGenerateAllProgress(null);
    queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] });
  }, [narrationState?.chunks, generateChunk, projectId, sceneId, narrationMode, speakerConfigs, chunkSpeakers, queryClient]);

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

  const { data: ltData } = useQuery({
    queryKey: ['lower-thirds', projectId, sceneId],
    queryFn: () => lowerThirdsApi.get(projectId!, sceneId!),
    enabled: !!projectId && !!sceneId && activeTab === 'Lower Thirds',
  });

  useEffect(() => {
    if (ltData && editingLTs === null && ltData.lowerThirds.length > 0) {
      setEditingLTs(ltData.lowerThirds);
    }
  }, [ltData, editingLTs]);

  const recommendLTsMutation = useMutation({
    mutationFn: () => lowerThirdsApi.recommend(projectId!, sceneId!),
    onSuccess: (data) => {
      setEditingLTs(data.lowerThirds);
      setLtDirty(false);
      queryClient.invalidateQueries({ queryKey: ['lower-thirds', projectId, sceneId] });
      queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] });
    },
  });

  const saveLTsMutation = useMutation({
    mutationFn: (lts: LowerThirdItem[]) => lowerThirdsApi.save(projectId!, sceneId!, lts),
    onSuccess: () => {
      setLtDirty(false);
      queryClient.invalidateQueries({ queryKey: ['lower-thirds', projectId, sceneId] });
      queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] });
    },
  });

  const overlayRenderMutation = useMutation({
    mutationFn: () => overlayApi.render(projectId!, sceneId!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] });
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
    <div style={{ padding: '32px 48px', maxWidth: 900 }}>
      {/* Scene header */}
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
          {scene.recording ? (
            <RecordingInfo
              source={scene.recording.source}
              duration_sec={scene.recording.duration_sec}
              ingested_at={scene.recording.ingested_at}
            />
          ) : (
            <div>
              <p style={{ color: 'var(--fg-muted)', marginBottom: 16 }}>
                No recording uploaded for this scene yet.
              </p>
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
          {/* ── Top bar: Generate/Regenerate ── */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
            {!editingScript && !scriptState?.script && !narrationState?.monologueScript ? (
              <button
                onClick={() => generateScriptMutation.mutate()}
                disabled={generateScriptMutation.isPending}
                style={{
                  padding: '8px 16px', background: 'var(--accent)', color: '#fff',
                  border: 'none', borderRadius: 6,
                  cursor: generateScriptMutation.isPending ? 'wait' : 'pointer',
                  fontSize: 13, fontWeight: 600,
                  opacity: generateScriptMutation.isPending ? 0.7 : 1,
                }}
              >
                {generateScriptMutation.isPending ? 'Generating…' : '✨ Generate Script'}
              </button>
            ) : (
              <button
                onClick={() => generateScriptMutation.mutate()}
                disabled={generateScriptMutation.isPending}
                style={{
                  padding: '8px 16px', background: 'var(--surface)', color: 'var(--fg)',
                  border: '1px solid var(--border)', borderRadius: 6,
                  cursor: generateScriptMutation.isPending ? 'wait' : 'pointer',
                  fontSize: 13, opacity: generateScriptMutation.isPending ? 0.7 : 1,
                }}
              >
                {generateScriptMutation.isPending ? 'Regenerating…' : '🔄 Regenerate'}
              </button>
            )}
          </div>

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

          {/* ── Converting to Dialog modal ── */}
          {convertingDialog && (
            <div style={{
              position: 'fixed', inset: 0, zIndex: 9999,
              background: 'rgba(0,0,0,0.65)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              backdropFilter: 'blur(4px)',
            }}>
              <div style={{
                background: 'var(--surface)', border: '1px solid var(--border)',
                borderRadius: 16, padding: '40px 48px', maxWidth: 420,
                textAlign: 'center', boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
              }}>
                <div style={{
                  width: 48, height: 48, margin: '0 auto 20px',
                  border: '3px solid var(--border)', borderTopColor: 'var(--accent)',
                  borderRadius: '50%', animation: 'spin 0.8s linear infinite',
                }} />
                <h3 style={{ margin: '0 0 8px', fontSize: 18 }}>Converting to Dialog</h3>
                <p style={{ margin: 0, color: 'var(--fg-muted)', fontSize: 13, lineHeight: 1.6 }}>
                  AI is rewriting your narration as a natural two-person conversation.
                  This usually takes 10–20 seconds.
                </p>
              </div>
            </div>
          )}

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

          {/* ── Vertically stacked script editor ── */}
          {(editingScript !== null || scriptState?.script || narrationState?.monologueScript) ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              {/* ─── Monologue section ─── */}
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <h3 style={{ margin: 0, fontSize: 14 }}>Monologue Script</h3>
                  {scriptDirty && (
                    <span style={{ fontSize: 10, color: 'var(--accent)', marginLeft: 'auto' }}>Unsaved</span>
                  )}
                </div>
                <textarea
                  value={editingScript ?? narrationState?.monologueScript ?? ''}
                  onChange={(e) => { setEditingScript(e.target.value); setScriptDirty(true); }}
                  style={{
                    width: '100%', minHeight: 280, padding: 14, boxSizing: 'border-box',
                    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                    fontSize: 12, lineHeight: 1.7,
                    background: 'var(--surface)', color: 'var(--fg)',
                    border: '1px solid var(--border)',
                    borderRadius: 8, resize: 'vertical', outline: 'none',
                  }}
                  placeholder="Script content..."
                />
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                  {scriptDirty && (
                    <>
                      <button
                        onClick={() => { if (editingScript) saveMonologueMutation.mutate(editingScript); }}
                        disabled={saveMonologueMutation.isPending}
                        style={{
                          padding: '6px 14px', background: 'var(--accent)', color: '#fff',
                          border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                        }}
                      >
                        {saveMonologueMutation.isPending ? 'Saving…' : 'Save'}
                      </button>
                      <button
                        onClick={() => { setEditingScript(null); setScriptDirty(false); }}
                        style={{
                          padding: '6px 14px', background: 'transparent', color: 'var(--fg-muted)',
                          border: '1px solid var(--border)', borderRadius: 6, fontSize: 12, cursor: 'pointer',
                        }}
                      >
                        Discard
                      </button>
                    </>
                  )}
                  {!scriptDirty && narrationState?.hasPreviousMonologue && (
                    <button
                      onClick={() => restoreMonologueMutation.mutate()}
                      disabled={restoreMonologueMutation.isPending}
                      style={{
                        padding: '6px 14px', background: 'transparent', color: 'var(--fg-muted)',
                        border: '1px solid var(--border)', borderRadius: 6, fontSize: 12, cursor: 'pointer',
                      }}
                    >
                      {restoreMonologueMutation.isPending ? 'Restoring…' : 'Restore Previous'}
                    </button>
                  )}
                  <p style={{ margin: 0, color: 'var(--fg-muted)', fontSize: 11 }}>
                    Use emotive tags like <code>[warm]</code>, <code>[confident]</code>,{' '}
                    <code>[thoughtful]</code> to guide narration tone.
                  </p>
                </div>
              </div>

              {/* ─── Dialog section ─── */}
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <h3 style={{ margin: 0, fontSize: 14 }}>Dialog Script</h3>
                  {dialogEditDirty && (
                    <span style={{ fontSize: 10, color: 'var(--accent)' }}>Unsaved</span>
                  )}
                </div>

                {(editingDialogScript || narrationState?.dialogScript) ? (
                  <>
                    <textarea
                      value={editingDialogScript ?? narrationState?.dialogScript ?? ''}
                      onChange={(e) => { setEditingDialogScript(e.target.value); setDialogEditDirty(true); }}
                      style={{
                        width: '100%', minHeight: 280, padding: 14, boxSizing: 'border-box',
                        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                        fontSize: 12, lineHeight: 1.7,
                        background: 'var(--surface)', color: 'var(--fg)',
                        border: '1px solid var(--border)',
                        borderRadius: 8, resize: 'vertical', outline: 'none',
                      }}
                    />
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                      {dialogEditDirty && (
                        <>
                          <button
                            onClick={() => { if (editingDialogScript) saveDialogMutation.mutate(editingDialogScript); }}
                            disabled={saveDialogMutation.isPending}
                            style={{
                              padding: '6px 14px', background: 'var(--accent)', color: '#fff',
                              border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                            }}
                          >
                            {saveDialogMutation.isPending ? 'Saving…' : 'Save'}
                          </button>
                          <button
                            onClick={() => { setEditingDialogScript(null); setDialogEditDirty(false); }}
                            style={{
                              padding: '6px 14px', background: 'transparent', color: 'var(--fg-muted)',
                              border: '1px solid var(--border)', borderRadius: 6, fontSize: 12, cursor: 'pointer',
                            }}
                          >
                            Discard
                          </button>
                        </>
                      )}
                      {!dialogEditDirty && narrationState?.hasPreviousDialog && (
                        <button
                          onClick={() => restoreDialogMutation.mutate()}
                          disabled={restoreDialogMutation.isPending}
                          style={{
                            padding: '6px 14px', background: 'transparent', color: 'var(--fg-muted)',
                            border: '1px solid var(--border)', borderRadius: 6, fontSize: 12, cursor: 'pointer',
                          }}
                        >
                          {restoreDialogMutation.isPending ? 'Restoring…' : 'Restore Previous'}
                        </button>
                      )}
                      <button
                        onClick={generateDialog}
                        disabled={convertingDialog || scriptDirty}
                        title={scriptDirty ? 'Save monologue changes first' : 'Regenerate dialog from current monologue'}
                        style={{
                          padding: '6px 14px', background: 'var(--surface)', color: 'var(--fg-muted)',
                          border: '1px solid var(--border)', borderRadius: 6, fontSize: 12,
                          cursor: (convertingDialog || scriptDirty) ? 'not-allowed' : 'pointer',
                          opacity: (convertingDialog || scriptDirty) ? 0.5 : 1,
                        }}
                      >
                        {convertingDialog ? 'Regenerating…' : 'Regenerate from Monologue'}
                      </button>
                      <p style={{ margin: 0, color: 'var(--fg-muted)', fontSize: 11 }}>
                        Use emotive tags like <code>[curious]</code>, <code>[excited]</code>,{' '}
                        <code>[thoughtful]</code> for natural speaker tone.
                      </p>
                    </div>
                  </>
                ) : (
                  <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '20px 24px',
                    border: '1px dashed var(--border)', borderRadius: 8,
                    color: 'var(--fg-muted)',
                  }}>
                    <p style={{ margin: 0, fontSize: 13 }}>
                      No dialog version yet. Generate a two-speaker conversation from your monologue.
                    </p>
                    <button
                      onClick={generateDialog}
                      disabled={convertingDialog || scriptDirty}
                      title={scriptDirty ? 'Save monologue changes first' : undefined}
                      style={{
                        padding: '8px 18px', background: 'var(--accent)', color: '#fff',
                        border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 600,
                        cursor: (convertingDialog || scriptDirty) ? 'not-allowed' : 'pointer',
                        opacity: (convertingDialog || scriptDirty) ? 0.5 : 1,
                        whiteSpace: 'nowrap', flexShrink: 0,
                      }}
                    >
                      Generate Dialog
                    </button>
                  </div>
                )}
              </div>
            </div>
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
                      onClick={() => generateAllChunks()}
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

                  {/* Generate All button spanning both columns */}
                  <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'flex-end' }}>
                    <button
                      onClick={() => generateAllChunks()}
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
                        ? `Generating ${generateAllProgress.done}/${generateAllProgress.total}...`
                        : 'Generate All Chunks'}
                    </button>
                  </div>
                </div>
              )}

              {/* ── Progress bar ─────────────────────────────── */}
              {generateAllProgress && (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--fg-muted)', marginBottom: 4 }}>
                    <span>Generating narration...</span>
                    <span>{generateAllProgress.done} / {generateAllProgress.total} chunks</span>
                  </div>
                  <div style={{ height: 6, background: 'var(--surface)', borderRadius: 3, overflow: 'hidden', border: '1px solid var(--border)' }}>
                    <div
                      style={{
                        height: '100%',
                        width: `${(generateAllProgress.done / generateAllProgress.total) * 100}%`,
                        background: 'var(--accent)',
                        borderRadius: 3,
                        transition: 'width 0.3s ease',
                      }}
                    />
                  </div>
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
                          border: chunk.hasAudio
                            ? `1px solid #5e8a3a40`
                            : isDialog ? `1px solid ${colors.border}` : '1px solid var(--border)',
                          borderRadius: 10,
                          padding: 14,
                          opacity: isGenerating ? 0.7 : 1,
                          transition: 'all 0.2s ease',
                          borderLeft: isDialog ? `3px solid ${colors.badge}` : undefined,
                        }}
                      >
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
                            <span style={{ fontSize: 10, color: '#5e8a3a', fontWeight: 600 }}>
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
            {editingLTs && editingLTs.length > 0 && (
              <>
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
                <button
                  onClick={() => {
                    if (editingLTs) saveLTsMutation.mutate(editingLTs);
                  }}
                  disabled={!ltDirty || saveLTsMutation.isPending}
                  style={{
                    padding: '8px 16px',
                    background: ltDirty ? 'var(--accent)' : 'var(--surface)',
                    color: ltDirty ? '#fff' : 'var(--fg-muted)',
                    border: ltDirty ? 'none' : '1px solid var(--border)',
                    borderRadius: 6,
                    cursor: !ltDirty ? 'default' : 'pointer',
                    fontSize: 13,
                    fontWeight: ltDirty ? 600 : 400,
                    opacity: !ltDirty ? 0.5 : 1,
                  }}
                >
                  {saveLTsMutation.isPending ? 'Saving...' : 'Save'}
                </button>
                {scene?.recording && !ltDirty && (
                  <button
                    onClick={() => overlayRenderMutation.mutate()}
                    disabled={overlayRenderMutation.isPending}
                    style={{
                      padding: '8px 16px',
                      background: overlayRenderMutation.isPending ? 'var(--surface)' : '#5e8a3a',
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
              </>
            )}
          </div>

          {/* Overlay render result */}
          {overlayRenderMutation.isSuccess && (
            <p style={{ color: '#5e8a3a', fontSize: 12, marginBottom: 12 }}>
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
          {editingLTs && editingLTs.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {editingLTs.map((lt, idx) => (
                <div
                  key={idx}
                  style={{
                    background: 'var(--surface)',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    padding: 16,
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr auto',
                    gap: 12,
                    alignItems: 'end',
                  }}
                >
                  {/* Title */}
                  <div>
                    <label style={{ display: 'block', fontSize: 11, color: 'var(--fg-muted)', marginBottom: 4 }}>
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

                  {/* Subtitle */}
                  <div>
                    <label style={{ display: 'block', fontSize: 11, color: 'var(--fg-muted)', marginBottom: 4 }}>
                      Subtitle
                    </label>
                    <input
                      value={lt.subtitle ?? ''}
                      onChange={(e) => {
                        const updated = [...editingLTs];
                        updated[idx] = { ...lt, subtitle: e.target.value || undefined };
                        setEditingLTs(updated);
                        setLtDirty(true);
                      }}
                      placeholder="Optional"
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

                  {/* Delete button */}
                  <button
                    onClick={() => {
                      setEditingLTs(editingLTs.filter((_, i) => i !== idx));
                      setLtDirty(true);
                    }}
                    style={{
                      padding: '6px 10px',
                      background: 'none',
                      border: '1px solid var(--border)',
                      borderRadius: 4,
                      color: 'var(--danger, #c25d5d)',
                      cursor: 'pointer',
                      fontSize: 12,
                    }}
                  >
                    Remove
                  </button>

                  {/* Style + timing row */}
                  <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 16, alignItems: 'center' }}>
                    <div>
                      <label style={{ fontSize: 11, color: 'var(--fg-muted)', marginRight: 4 }}>Style</label>
                      <select
                        value={lt.style}
                        onChange={(e) => {
                          const updated = [...editingLTs];
                          updated[idx] = { ...lt, style: e.target.value as 'frosted' | 'solid' | 'minimal' };
                          setEditingLTs(updated);
                          setLtDirty(true);
                        }}
                        style={{
                          padding: '4px 8px',
                          border: '1px solid var(--border)',
                          borderRadius: 4,
                          background: 'var(--bg)',
                          color: 'var(--fg)',
                          fontSize: 12,
                        }}
                      >
                        <option value="frosted">Frosted</option>
                        <option value="solid">Solid</option>
                        <option value="minimal">Minimal</option>
                      </select>
                    </div>
                    <div>
                      <label style={{ fontSize: 11, color: 'var(--fg-muted)', marginRight: 4 }}>In (s)</label>
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
                          width: 70,
                          padding: '4px 8px',
                          border: '1px solid var(--border)',
                          borderRadius: 4,
                          background: 'var(--bg)',
                          color: 'var(--fg)',
                          fontSize: 12,
                        }}
                      />
                    </div>
                    <div>
                      <label style={{ fontSize: 11, color: 'var(--fg-muted)', marginRight: 4 }}>Out (s)</label>
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
                          width: 70,
                          padding: '4px 8px',
                          border: '1px solid var(--border)',
                          borderRadius: 4,
                          background: 'var(--bg)',
                          color: 'var(--fg)',
                          fontSize: 12,
                        }}
                      />
                    </div>
                  </div>
                </div>
              ))}
              {ltDirty && (
                <p style={{ color: 'var(--accent)', fontSize: 12 }}>Unsaved changes</p>
              )}
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
                Click <strong>Recommend Lower Thirds</strong> to get AI-suggested overlays.
              </p>
            </div>
          )}
        </div>
      )}

      {activeTab === 'Preview' && projectId && scene && (
        <ScenePreview
          projectId={projectId}
          scene={scene}
          chunks={(narrationState?.chunks ?? []).map((c) => ({
            index: c.index,
            durationSec: c.durationSec ?? null,
            hasAudio: c.hasAudio,
          }))}
        />
      )}
    </div>
  );
}
