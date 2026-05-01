import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useOutletContext } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { storyboardApi, recordingsApi, scriptApi, ttsApi, voiceApi, narrationApi, lowerThirdsApi, overlayApi } from '../lib/api.js';
import type { LowerThirdItem, VoiceProfileInfo, NarrationChunkInfo } from '../lib/api.js';
import { RecordingUpload } from '../components/RecordingUpload.js';
import { RecordingInfo } from '../components/RecordingInfo.js';
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

const TABS = ['Recording', 'Script', 'Narration', 'Lower Thirds'] as const;
type Tab = (typeof TABS)[number];

export function ScenePage() {
  const { projectId, sceneId } = useParams<{ projectId: string; sceneId: string }>();
  const { project } = useOutletContext<WorkspaceContext>();
  const [activeTab, setActiveTab] = useState<Tab>('Recording');
  const [editingScript, setEditingScript] = useState<string | null>(null);
  const [scriptDirty, setScriptDirty] = useState(false);
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

  const saveScriptMutation = useMutation({
    mutationFn: (script: string) => scriptApi.save(projectId!, sceneId!, script),
    onSuccess: () => {
      setScriptDirty(false);
      queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] });
    },
  });

  const { data: scriptState } = useQuery({
    queryKey: ['script', projectId, sceneId],
    queryFn: () => scriptApi.get(projectId!, sceneId!),
    enabled: !!projectId && !!sceneId && activeTab === 'Script',
  });

  // Sync local editing state when script data loads (only if not already editing)
  useEffect(() => {
    if (scriptState && editingScript === null && scriptState.script !== null) {
      setEditingScript(scriptState.script);
    }
  }, [scriptState, editingScript]);

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
    enabled: !!projectId && !!sceneId && activeTab === 'Narration',
  });

  // Sync engine/voice from narration state when it loads
  useEffect(() => {
    if (narrationState?.tts) {
      if (narrationState.tts.engine) setSelectedEngine(narrationState.tts.engine);
      if (narrationState.tts.voice) setSelectedVoice(narrationState.tts.voice);
      if (narrationState.tts.speed) setSelectedSpeed(narrationState.tts.speed);
    }
  }, [narrationState]);

  const currentEngine = engines?.find((e) => e.id === selectedEngine);

  // Get the current text for a chunk (edited or original)
  const getChunkText = useCallback((chunk: NarrationChunkInfo) => {
    return editedChunks.get(chunk.index) ?? chunk.text;
  }, [editedChunks]);

  // Generate a single chunk
  const generateChunk = useCallback(async (chunk: NarrationChunkInfo) => {
    if (!projectId || !sceneId) return;
    const text = getChunkText(chunk);
    setGeneratingChunks((prev) => new Set(prev).add(chunk.index));
    try {
      await narrationApi.generateChunk(projectId, sceneId, {
        chunkIndex: chunk.index,
        text,
        engine: selectedEngine,
        voice: selectedVoice,
        speed: selectedSpeed,
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
  }, [projectId, sceneId, selectedEngine, selectedVoice, selectedSpeed, getChunkText, queryClient]);

  // Generate all chunks sequentially with progress
  const generateAllChunks = useCallback(async () => {
    if (!narrationState?.chunks?.length) return;
    const chunks = narrationState.chunks;
    setGenerateAllProgress({ done: 0, total: chunks.length });
    for (let i = 0; i < chunks.length; i++) {
      await generateChunk(chunks[i]!);
      setGenerateAllProgress({ done: i + 1, total: chunks.length });
    }
    setGenerateAllProgress(null);
    queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] });
  }, [narrationState?.chunks, generateChunk, projectId, queryClient]);

  // Save edited chunk texts back to the full script
  const saveChunkEdits = useCallback(async () => {
    if (!projectId || !sceneId || !narrationState?.chunks) return;
    const fullScript = narrationState.chunks
      .map((c) => editedChunks.get(c.index) ?? c.text)
      .join('\n\n');
    await narrationApi.saveScript(projectId, sceneId, fullScript);
    setEditedChunks(new Map());
    setChunkScriptDirty(false);
    queryClient.invalidateQueries({ queryKey: ['narration', projectId, sceneId] });
    queryClient.invalidateQueries({ queryKey: ['script', projectId, sceneId] });
    queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] });
  }, [projectId, sceneId, narrationState?.chunks, editedChunks, queryClient]);

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
          {/* Action buttons */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            {!editingScript && !scriptState?.script ? (
              <button
                onClick={() => generateScriptMutation.mutate()}
                disabled={generateScriptMutation.isPending}
                style={{
                  padding: '8px 16px',
                  background: 'var(--accent)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 6,
                  cursor: generateScriptMutation.isPending ? 'wait' : 'pointer',
                  fontSize: 13,
                  fontWeight: 600,
                  opacity: generateScriptMutation.isPending ? 0.7 : 1,
                }}
              >
                {generateScriptMutation.isPending ? 'Generating…' : '✨ Generate Script'}
              </button>
            ) : (
              <>
                <button
                  onClick={() => generateScriptMutation.mutate()}
                  disabled={generateScriptMutation.isPending}
                  style={{
                    padding: '8px 16px',
                    background: 'var(--surface)',
                    color: 'var(--fg)',
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    cursor: generateScriptMutation.isPending ? 'wait' : 'pointer',
                    fontSize: 13,
                    opacity: generateScriptMutation.isPending ? 0.7 : 1,
                  }}
                >
                  {generateScriptMutation.isPending ? 'Regenerating…' : '🔄 Regenerate'}
                </button>
                <button
                  onClick={() => {
                    if (editingScript) saveScriptMutation.mutate(editingScript);
                  }}
                  disabled={!scriptDirty || saveScriptMutation.isPending}
                  style={{
                    padding: '8px 16px',
                    background: scriptDirty ? 'var(--accent)' : 'var(--surface)',
                    color: scriptDirty ? '#fff' : 'var(--fg-muted)',
                    border: scriptDirty ? 'none' : '1px solid var(--border)',
                    borderRadius: 6,
                    cursor: !scriptDirty || saveScriptMutation.isPending ? 'default' : 'pointer',
                    fontSize: 13,
                    fontWeight: scriptDirty ? 600 : 400,
                    opacity: !scriptDirty ? 0.5 : 1,
                  }}
                >
                  {saveScriptMutation.isPending ? 'Saving…' : '💾 Save'}
                </button>
              </>
            )}
          </div>

          {/* Error display */}
          {generateScriptMutation.isError && (
            <p style={{ color: 'var(--danger)', fontSize: 13, marginBottom: 12 }}>
              Generation failed:{' '}
              {generateScriptMutation.error instanceof Error
                ? generateScriptMutation.error.message
                : 'Unknown error'}
            </p>
          )}
          {saveScriptMutation.isError && (
            <p style={{ color: 'var(--danger)', fontSize: 13, marginBottom: 12 }}>
              Save failed:{' '}
              {saveScriptMutation.error instanceof Error
                ? saveScriptMutation.error.message
                : 'Unknown error'}
            </p>
          )}

          {/* Script editor or empty state */}
          {editingScript !== null || scriptState?.script ? (
            <div>
              <textarea
                value={editingScript ?? scriptState?.script ?? ''}
                onChange={(e) => {
                  setEditingScript(e.target.value);
                  setScriptDirty(true);
                }}
                style={{
                  width: '100%',
                  minHeight: 300,
                  padding: 16,
                  fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                  fontSize: 13,
                  lineHeight: 1.7,
                  background: 'var(--surface)',
                  color: 'var(--fg)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  resize: 'vertical',
                  outline: 'none',
                }}
                placeholder="Script content..."
              />
              <p style={{ color: 'var(--fg-muted)', fontSize: 12, marginTop: 8 }}>
                Use emotive tags like <code>[warm]</code>, <code>[confident]</code>,{' '}
                <code>[thoughtful]</code> to guide narration tone.
                {scriptDirty && (
                  <span style={{ color: 'var(--accent)', marginLeft: 8 }}>• Unsaved changes</span>
                )}
              </p>
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
              <p style={{ fontSize: 14, marginBottom: 4 }}>No script yet for this scene.</p>
              <p style={{ fontSize: 12 }}>
                Click <strong>Generate Script</strong> to create a narration script from the scene
                description.
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
              {/* ── Voice selection bar ──────────────────────── */}
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

              {/* ── Script edit save bar ─────────────────────── */}
              {chunkScriptDirty && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12,
                  padding: '8px 12px', background: 'var(--accent)10', border: '1px solid var(--accent)30',
                  borderRadius: 8, fontSize: 12,
                }}>
                  <span style={{ color: 'var(--accent)', flex: 1 }}>Script has unsaved edits</span>
                  <button
                    onClick={saveChunkEdits}
                    style={{
                      padding: '4px 12px', background: 'var(--accent)', color: '#fff',
                      border: 'none', borderRadius: 5, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                    }}
                  >
                    Save Script
                  </button>
                  <button
                    onClick={() => { setEditedChunks(new Map()); setChunkScriptDirty(false); }}
                    style={{
                      padding: '4px 12px', background: 'transparent', color: 'var(--fg-muted)',
                      border: '1px solid var(--border)', borderRadius: 5, fontSize: 12, cursor: 'pointer',
                    }}
                  >
                    Discard
                  </button>
                </div>
              )}

              {/* ── Paragraph chunks ─────────────────────────── */}
              {narrationState.chunks.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {narrationState.chunks.map((chunk) => {
                    const isGenerating = generatingChunks.has(chunk.index);
                    const chunkText = getChunkText(chunk);
                    const isEdited = editedChunks.has(chunk.index);

                    return (
                      <div
                        key={chunk.index}
                        style={{
                          background: 'var(--surface)',
                          border: chunk.hasAudio
                            ? '1px solid #5e8a3a40'
                            : '1px solid var(--border)',
                          borderRadius: 10,
                          padding: 14,
                          opacity: isGenerating ? 0.7 : 1,
                          transition: 'opacity 0.2s',
                        }}
                      >
                        {/* Chunk header */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                          <span style={{
                            fontSize: 10, fontWeight: 700, color: 'var(--fg-muted)',
                            background: 'var(--bg)', padding: '2px 8px', borderRadius: 4,
                            textTransform: 'uppercase', letterSpacing: '0.05em',
                          }}>
                            Paragraph {chunk.index + 1}
                          </span>
                          {chunk.hasAudio && (
                            <span style={{ fontSize: 10, color: '#5e8a3a', fontWeight: 600 }}>
                              {chunk.durationSec != null ? `${chunk.durationSec.toFixed(1)}s` : 'Done'}
                            </span>
                          )}
                          {isEdited && (
                            <span style={{ fontSize: 10, color: 'var(--accent)' }}>edited</span>
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

                        {/* Editable script text */}
                        <textarea
                          value={chunkText}
                          onChange={(e) => {
                            const next = new Map(editedChunks);
                            next.set(chunk.index, e.target.value);
                            setEditedChunks(next);
                            setChunkScriptDirty(true);
                          }}
                          style={{
                            width: '100%',
                            padding: 10,
                            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                            fontSize: 12,
                            lineHeight: 1.6,
                            background: 'var(--bg)',
                            color: 'var(--fg)',
                            border: '1px solid var(--border)',
                            borderRadius: 6,
                            resize: 'vertical',
                            outline: 'none',
                            minHeight: 60,
                            boxSizing: 'border-box',
                          }}
                          rows={Math.max(2, chunkText.split('\n').length)}
                        />

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
    </div>
  );
}
