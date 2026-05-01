import { useState, useRef, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { settingsApi, ttsApi, voiceApi, voiceCloneApi, type ModelEntry, type TtsEngineInfo, type VoiceProfileInfo, type VoiceCloneRef } from '../lib/api.js';

type Provider = ModelEntry['provider'];

const PROVIDERS: { value: Provider; label: string; needsEndpoint: boolean; needsApiKey: boolean; hint: string }[] = [
  { value: 'openai-compat', label: 'OpenAI Compatible (LM Studio / Ollama)', needsEndpoint: true, needsApiKey: false, hint: 'e.g. http://localhost:1234/v1' },
  { value: 'gemini', label: 'Google Gemini', needsEndpoint: false, needsApiKey: true, hint: '' },
  { value: 'anthropic', label: 'Anthropic', needsEndpoint: false, needsApiKey: true, hint: '' },
  { value: 'claude-code', label: 'Claude Code (claude -p)', needsEndpoint: false, needsApiKey: false, hint: 'Uses local Claude CLI' },
  { value: 'fake', label: 'Fake / Test', needsEndpoint: false, needsApiKey: false, hint: 'Returns placeholder responses' },
];

function providerMeta(p: Provider): (typeof PROVIDERS)[number] {
  return PROVIDERS.find((x) => x.value === p) ?? PROVIDERS[0]!;
}

const card: React.CSSProperties = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)',
  padding: '16px 20px',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: 10,
  transition: 'border-color 150ms ease',
};

const activeCard: React.CSSProperties = {
  ...card,
  border: '2px solid var(--accent)',
  background: 'var(--accent-bg)',
};

const badge: React.CSSProperties = {
  fontSize: 10,
  padding: '3px 8px',
  borderRadius: 999,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
};

function ModelCard({
  entry,
  onActivate,
  onDelete,
  activating,
}: {
  entry: ModelEntry;
  onActivate: () => void;
  onDelete: () => void;
  activating: boolean;
}) {
  const meta = providerMeta(entry.provider);
  return (
    <div style={entry.active ? activeCard : card}>
      <div>
        <div style={{ fontWeight: 600, fontSize: 15 }}>
          {entry.name}
          {entry.active && (
            <span style={{ ...badge, marginLeft: 8, background: 'var(--accent)', color: '#fff' }}>
              Active
            </span>
          )}
        </div>
        <div style={{ fontSize: 13, color: 'var(--fg-muted)', marginTop: 4 }}>
          {meta.label} &mdash; <code style={{ fontSize: 12 }}>{entry.model}</code>
          {entry.endpoint && (
            <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--fg-muted)' }}>
              @ {entry.endpoint}
            </span>
          )}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {!entry.active && (
          <button
            onClick={onActivate}
            disabled={activating}
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              border: '1px solid var(--accent)',
              background: 'transparent',
              color: 'var(--accent)',
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            {activating ? 'Switching...' : 'Use This'}
          </button>
        )}
        {!entry.active && (
          <button
            onClick={onDelete}
            title="Remove this model configuration"
            style={{
              padding: '6px 10px',
              borderRadius: 6,
              border: '1px solid var(--danger, #c44)',
              background: 'transparent',
              color: 'var(--danger, #c44)',
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            Remove
          </button>
        )}
      </div>
    </div>
  );
}

function AddModelForm({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [provider, setProvider] = useState<Provider>('openai-compat');
  const [model, setModel] = useState('');
  const [endpoint, setEndpoint] = useState('http://localhost:1234/v1');
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState('');

  const meta = providerMeta(provider);

  const addMutation = useMutation({
    mutationFn: () =>
      settingsApi.addModel({
        id: crypto.randomUUID(),
        name,
        provider,
        model,
        endpoint: meta.needsEndpoint ? endpoint : undefined,
        apiKey: meta.needsApiKey ? apiKey : undefined,
      }),
    onSuccess: () => {
      setName('');
      setModel('');
      setEndpoint('http://localhost:1234/v1');
      setApiKey('');
      setError('');
      setOpen(false);
      onAdded();
    },
    onError: (err: Error) => setError(err.message),
  });

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        style={{
          width: '100%',
          padding: '14px',
          borderRadius: 10,
          border: '2px dashed var(--border)',
          background: 'transparent',
          color: 'var(--fg-muted)',
          cursor: 'pointer',
          fontSize: 14,
          marginTop: 4,
        }}
      >
        + Add Model Configuration
      </button>
    );
  }

  const fieldStyle: React.CSSProperties = {
    width: '100%',
    padding: '8px 12px',
    borderRadius: 6,
    border: '1px solid var(--border)',
    background: 'var(--bg)',
    color: 'var(--fg)',
    fontSize: 14,
    boxSizing: 'border-box',
  };

  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: 13,
    fontWeight: 600,
    marginBottom: 4,
    color: 'var(--fg)',
  };

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: 20,
        background: 'var(--surface)',
        marginTop: 4,
      }}
    >
      <h3 style={{ margin: '0 0 16px', fontSize: 16 }}>Add a Model</h3>

      <div style={{ display: 'grid', gap: 14 }}>
        <div>
          <label style={labelStyle}>Display Name</label>
          <input
            style={fieldStyle}
            placeholder="e.g. My Local Qwen"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div>
          <label style={labelStyle}>Provider</label>
          <select
            style={fieldStyle}
            value={provider}
            onChange={(e) => setProvider(e.target.value as Provider)}
          >
            {PROVIDERS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          {meta.hint && (
            <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 4 }}>{meta.hint}</div>
          )}
        </div>

        <div>
          <label style={labelStyle}>Model Name / ID</label>
          <input
            style={fieldStyle}
            placeholder={
              provider === 'openai-compat'
                ? 'e.g. qwen/qwen3.5-35b-a3b'
                : provider === 'gemini'
                  ? 'e.g. gemini-2.5-flash'
                  : provider === 'anthropic'
                    ? 'e.g. claude-sonnet-4-20250514'
                    : 'model identifier'
            }
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        </div>

        {meta.needsEndpoint && (
          <div>
            <label style={labelStyle}>API Endpoint</label>
            <input
              style={fieldStyle}
              placeholder="http://localhost:1234/v1"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
            />
          </div>
        )}

        {meta.needsApiKey && (
          <div>
            <label style={labelStyle}>API Key</label>
            <input
              style={fieldStyle}
              type="password"
              placeholder="sk-..."
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>
        )}
      </div>

      {error && (
        <div style={{ marginTop: 12, color: 'var(--danger, #c44)', fontSize: 13 }}>{error}</div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
        <button
          onClick={() => {
            setOpen(false);
            setError('');
          }}
          style={{
            padding: '8px 16px',
            borderRadius: 6,
            border: '1px solid var(--border)',
            background: 'transparent',
            cursor: 'pointer',
            fontSize: 13,
          }}
        >
          Cancel
        </button>
        <button
          onClick={() => addMutation.mutate()}
          disabled={!name || !model || addMutation.isPending}
          style={{
            padding: '8px 16px',
            borderRadius: 6,
            border: 'none',
            background: 'var(--accent)',
            color: '#fff',
            cursor: !name || !model ? 'not-allowed' : 'pointer',
            fontSize: 13,
            fontWeight: 600,
            opacity: !name || !model ? 0.5 : 1,
          }}
        >
          {addMutation.isPending ? 'Adding...' : 'Add Model'}
        </button>
      </div>
    </div>
  );
}

/* ── Voice Profiles ──────────────────────────────────── */

function VoiceProfileCard({
  profile,
  engineName,
  onDelete,
}: {
  profile: VoiceProfileInfo;
  engineName: string;
  onDelete: () => void;
}) {
  return (
    <div style={card}>
      <div>
        <div style={{ fontWeight: 600, fontSize: 15 }}>
          {profile.name}
        </div>
        <div style={{ fontSize: 13, color: 'var(--fg-muted)', marginTop: 4 }}>
          {engineName} &mdash; <code style={{ fontSize: 12 }}>{profile.voice}</code>
          <span style={{ marginLeft: 8, fontSize: 12 }}>
            {profile.speed}x speed
          </span>
        </div>
        {profile.description && (
          <div style={{ fontSize: 12, color: 'var(--fg-dim)', marginTop: 2 }}>
            {profile.description}
          </div>
        )}
      </div>
      <button
        onClick={onDelete}
        title="Remove this voice profile"
        style={{
          padding: '6px 10px',
          borderRadius: 6,
          border: '1px solid var(--danger, #c44)',
          background: 'transparent',
          color: 'var(--danger, #c44)',
          cursor: 'pointer',
          fontSize: 13,
        }}
      >
        Remove
      </button>
    </div>
  );
}

function AddVoiceProfileForm({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [engineId, setEngineId] = useState('');
  const [voiceId, setVoiceId] = useState('');
  const [speed, setSpeed] = useState(1.0);
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');

  const { data: engines } = useQuery({
    queryKey: ['tts', 'engines'],
    queryFn: () => ttsApi.listEngines(),
    enabled: open,
  });

  const selectedEngine = engines?.find((e) => e.id === engineId);

  // Auto-select first engine & voice when engines load
  const enginesLoaded = engines && engines.length > 0;
  if (enginesLoaded && !engineId) {
    setEngineId(engines[0]!.id);
    if (engines[0]!.voices.length > 0) {
      setVoiceId(engines[0]!.voices[0]!.id);
    }
  }

  const createMutation = useMutation({
    mutationFn: () =>
      voiceApi.create({
        name,
        engine: engineId,
        voice: voiceId,
        speed,
        description: description.trim() || undefined,
      }),
    onSuccess: () => {
      setName('');
      setEngineId('');
      setVoiceId('');
      setSpeed(1.0);
      setDescription('');
      setError('');
      setOpen(false);
      onAdded();
    },
    onError: (err: Error) => setError(err.message),
  });

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        style={{
          width: '100%',
          padding: '14px',
          borderRadius: 10,
          border: '2px dashed var(--border)',
          background: 'transparent',
          color: 'var(--fg-muted)',
          cursor: 'pointer',
          fontSize: 14,
          marginTop: 4,
        }}
      >
        + Add Voice Profile
      </button>
    );
  }

  const fieldStyle: React.CSSProperties = {
    width: '100%',
    padding: '8px 12px',
    borderRadius: 6,
    border: '1px solid var(--border)',
    background: 'var(--bg)',
    color: 'var(--fg)',
    fontSize: 14,
    boxSizing: 'border-box',
  };

  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: 13,
    fontWeight: 600,
    marginBottom: 4,
    color: 'var(--fg)',
  };

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: 20,
        background: 'var(--surface)',
        marginTop: 4,
      }}
    >
      <h3 style={{ margin: '0 0 16px', fontSize: 16 }}>Add a Voice Profile</h3>

      <div style={{ display: 'grid', gap: 14 }}>
        <div>
          <label style={labelStyle}>Profile Name</label>
          <input
            style={fieldStyle}
            placeholder="e.g. Demo Narrator"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div>
          <label style={labelStyle}>TTS Engine</label>
          {!engines ? (
            <div style={{ fontSize: 13, color: 'var(--fg-muted)' }}>Loading engines...</div>
          ) : engines.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
              No TTS engines available. Only a development/test engine is currently registered.
            </div>
          ) : (
            <select
              style={fieldStyle}
              value={engineId}
              onChange={(e) => {
                setEngineId(e.target.value);
                const eng = engines.find((x) => x.id === e.target.value);
                if (eng && eng.voices.length > 0) setVoiceId(eng.voices[0]!.id);
                else setVoiceId('');
              }}
            >
              {engines.map((e) => (
                <option key={e.id} value={e.id}>{e.displayName}</option>
              ))}
            </select>
          )}
        </div>

        {selectedEngine && selectedEngine.voices.length > 0 && (
          <div>
            <label style={labelStyle}>Voice</label>
            <select
              style={fieldStyle}
              value={voiceId}
              onChange={(e) => setVoiceId(e.target.value)}
            >
              {selectedEngine.voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}{v.description ? ` — ${v.description}` : ''}
                </option>
              ))}
            </select>
          </div>
        )}

        <div>
          <label style={labelStyle}>Speed ({speed.toFixed(1)}x)</label>
          <input
            type="range"
            min="0.5"
            max="2.0"
            step="0.1"
            value={speed}
            onChange={(e) => setSpeed(parseFloat(e.target.value))}
            style={{ width: '100%' }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--fg-muted)' }}>
            <span>0.5x</span>
            <span>1.0x</span>
            <span>2.0x</span>
          </div>
        </div>

        <div>
          <label style={labelStyle}>Description (optional)</label>
          <input
            style={fieldStyle}
            placeholder="e.g. Calm, professional tone for product demos"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
      </div>

      {error && (
        <div style={{ marginTop: 12, color: 'var(--danger, #c44)', fontSize: 13 }}>{error}</div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
        <button
          onClick={() => { setOpen(false); setError(''); }}
          style={{
            padding: '8px 16px',
            borderRadius: 6,
            border: '1px solid var(--border)',
            background: 'transparent',
            cursor: 'pointer',
            fontSize: 13,
          }}
        >
          Cancel
        </button>
        <button
          onClick={() => createMutation.mutate()}
          disabled={!name || !engineId || !voiceId || createMutation.isPending}
          style={{
            padding: '8px 16px',
            borderRadius: 6,
            border: 'none',
            background: 'var(--accent)',
            color: '#fff',
            cursor: !name || !engineId || !voiceId ? 'not-allowed' : 'pointer',
            fontSize: 13,
            fontWeight: 600,
            opacity: !name || !engineId || !voiceId ? 0.5 : 1,
          }}
        >
          {createMutation.isPending ? 'Adding...' : 'Add Voice Profile'}
        </button>
      </div>
    </div>
  );
}

/* ── Voice Cloning ────────────────────────────────────── */

function VoiceCloneSection() {
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [showScript, setShowScript] = useState(false);

  const { data: clones, isLoading: clonesLoading } = useQuery({
    queryKey: ['voice-clones'],
    queryFn: () => voiceCloneApi.list(),
  });

  const { data: scriptData } = useQuery({
    queryKey: ['voice-clone-script'],
    queryFn: () => voiceCloneApi.getScript(),
    enabled: showScript,
  });

  const deleteMutation = useMutation({
    mutationFn: (filename: string) => voiceCloneApi.remove(filename),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['voice-clones'] }),
  });

  const handleUpload = useCallback(async (file: File) => {
    setUploading(true);
    try {
      await voiceCloneApi.upload(file);
      qc.invalidateQueries({ queryKey: ['voice-clones'] });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [qc]);

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div>
      <p style={{ color: 'var(--fg-muted)', fontSize: 13, margin: '0 0 16px' }}>
        Record yourself reading a script and upload the WAV file. Fish Audio will use your voice as a reference for TTS narration.
      </p>

      {/* Show/hide recording script */}
      <button
        onClick={() => setShowScript(!showScript)}
        style={{
          padding: '8px 16px',
          background: showScript ? 'var(--accent-bg)' : 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          cursor: 'pointer',
          fontSize: 13,
          fontWeight: 600,
          color: showScript ? 'var(--accent)' : 'var(--fg)',
          marginBottom: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          transition: 'all 0.15s ease',
        }}
      >
        📝 {showScript ? 'Hide Recording Script' : 'Show Recording Script'}
      </button>

      {showScript && scriptData && (
        <div style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          padding: 20,
          marginBottom: 16,
        }}>
          <h4 style={{ margin: '0 0 12px', fontSize: 14 }}>Script to Read Aloud</h4>
          <div style={{
            background: 'var(--bg)',
            borderRadius: 8,
            padding: 16,
            fontSize: 14,
            lineHeight: 1.8,
            whiteSpace: 'pre-wrap',
            fontFamily: 'Georgia, serif',
            color: 'var(--fg)',
            marginBottom: 16,
            border: '1px solid var(--border)',
          }}>
            {scriptData.script}
          </div>

          <details style={{ marginTop: 8 }}>
            <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600, color: 'var(--fg-muted)' }}>
              Recording Tips
            </summary>
            <div style={{
              fontSize: 13,
              lineHeight: 1.7,
              color: 'var(--fg-muted)',
              marginTop: 8,
              whiteSpace: 'pre-wrap',
            }}>
              {scriptData.instructions}
            </div>
          </details>
        </div>
      )}

      {/* Upload area */}
      <div
        style={{
          background: 'var(--surface)',
          border: '2px dashed var(--border)',
          borderRadius: 10,
          padding: '24px 20px',
          textAlign: 'center',
          marginBottom: 16,
          cursor: uploading ? 'wait' : 'pointer',
          transition: 'border-color 0.15s ease',
        }}
        onClick={() => !uploading && fileInputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const file = e.dataTransfer.files[0];
          if (file && file.name.endsWith('.wav')) handleUpload(file);
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".wav,audio/wav"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleUpload(file);
          }}
        />
        {uploading ? (
          <span style={{ color: 'var(--fg-muted)', fontSize: 14 }}>Uploading…</span>
        ) : (
          <>
            <div style={{ fontSize: 28, marginBottom: 8 }}>🎙️</div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>
              Drop a WAV file here or click to upload
            </div>
            <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 4 }}>
              Record yourself reading the script above, then upload the WAV
            </div>
          </>
        )}
      </div>

      {/* Saved clones list */}
      {clonesLoading && <p className="hint">Loading voice clones…</p>}
      {clones && clones.length > 0 && (
        <div>
          <h4 style={{ fontSize: 13, fontWeight: 600, margin: '0 0 8px', color: 'var(--fg-muted)' }}>
            Saved Reference Files
          </h4>
          {clones.map((clone) => (
            <div
              key={clone.filename}
              style={{
                ...card,
                padding: '12px 16px',
              }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>
                  🎙️ {clone.filename}
                </div>
                <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 2 }}>
                  {formatSize(clone.size)} · {new Date(clone.createdAt).toLocaleDateString()}
                  {clone.transcript && (
                    <span style={{ marginLeft: 8 }}>✓ Transcript saved</span>
                  )}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{
                  fontSize: 10,
                  padding: '3px 8px',
                  borderRadius: 999,
                  background: '#1a2a1a',
                  color: '#5e8a3a',
                  fontWeight: 600,
                }}>
                  Ready
                </span>
                <button
                  onClick={() => deleteMutation.mutate(clone.filename)}
                  style={{
                    background: 'transparent',
                    border: '1px solid var(--border)',
                    borderRadius: 5,
                    padding: '4px 8px',
                    cursor: 'pointer',
                    fontSize: 11,
                    color: 'var(--danger)',
                  }}
                  title="Remove this voice clone reference"
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
          <p style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 4 }}>
            Use the "Voice Clone" voice in Fish Audio engine to narrate with your cloned voice.
            Set <code>FISH_AUDIO_REF_AUDIO</code> in <code>.env</code> to the file path above, or select "clone" as the voice.
          </p>
        </div>
      )}
    </div>
  );
}

/* ── Settings Page ──────────────────────────────────── */

export function Settings() {
  const qc = useQueryClient();

  // Models
  const { data: models, isLoading, error } = useQuery({
    queryKey: ['settings', 'models'],
    queryFn: () => settingsApi.listModels(),
  });

  const activateMutation = useMutation({
    mutationFn: (id: string) => settingsApi.activateModel(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings', 'models'] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => settingsApi.deleteModel(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings', 'models'] }),
  });

  // Voice Profiles
  const { data: voices, isLoading: voicesLoading, error: voicesError } = useQuery({
    queryKey: ['settings', 'voices'],
    queryFn: () => voiceApi.list(),
  });

  const { data: engines } = useQuery({
    queryKey: ['tts', 'engines'],
    queryFn: () => ttsApi.listEngines(),
  });

  const deleteVoiceMutation = useMutation({
    mutationFn: (id: string) => voiceApi.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings', 'voices'] }),
  });

  const engineNameMap = new Map(engines?.map((e) => [e.id, e.displayName]) ?? []);

  return (
    <main className="page page--narrow">
      <header style={{ marginBottom: 32 }}>
        <h1>Settings</h1>
        <p style={{ color: 'var(--fg-muted)', fontSize: 14, margin: 0 }}>
          Manage LLM models and TTS voice configurations
        </p>
      </header>

      {/* Models section */}
      <section>
        <div className="section-header" style={{ marginBottom: 18 }}>
          <span className="section-label">Models</span>
        </div>

        {isLoading && <p className="hint">Loading models...</p>}
        {error && <p style={{ color: 'var(--danger)' }}>Failed to load models.</p>}

        {models && (
          <>
            {models.length === 0 && (
              <div className="empty-state">
                No models configured. Add one below to get started.
              </div>
            )}
            {models.map((m) => (
              <ModelCard
                key={m.id}
                entry={m}
                onActivate={() => activateMutation.mutate(m.id)}
                onDelete={() => deleteMutation.mutate(m.id)}
                activating={activateMutation.isPending && activateMutation.variables === m.id}
              />
            ))}
            <AddModelForm onAdded={() => qc.invalidateQueries({ queryKey: ['settings', 'models'] })} />
          </>
        )}
      </section>

      {/* Voice Profiles section */}
      <section style={{ marginTop: 48 }}>
        <div className="section-header" style={{ marginBottom: 18 }}>
          <span className="section-label">Voice Profiles</span>
        </div>
        <p style={{ color: 'var(--fg-muted)', fontSize: 13, margin: '0 0 16px' }}>
          Configure TTS voices for narration. Each profile pairs a TTS engine with a voice and speed setting.
        </p>

        {voicesLoading && <p className="hint">Loading voice profiles...</p>}
        {voicesError && <p style={{ color: 'var(--danger)' }}>Failed to load voice profiles.</p>}

        {voices && (
          <>
            {voices.length === 0 && (
              <div className="empty-state">
                No voice profiles yet. Add one below to use for narration.
              </div>
            )}
            {voices.map((v) => (
              <VoiceProfileCard
                key={v.id}
                profile={v}
                engineName={engineNameMap.get(v.engine) ?? v.engine}
                onDelete={() => deleteVoiceMutation.mutate(v.id)}
              />
            ))}
            <AddVoiceProfileForm onAdded={() => qc.invalidateQueries({ queryKey: ['settings', 'voices'] })} />
          </>
        )}
      </section>

      {/* Voice Cloning section */}
      <section style={{ marginTop: 48 }}>
        <div className="section-header" style={{ marginBottom: 18 }}>
          <span className="section-label">Voice Cloning</span>
          <span style={{
            marginLeft: 10,
            fontSize: 10,
            padding: '2px 8px',
            borderRadius: 999,
            background: '#1a2a3a',
            color: '#7aa2f7',
            fontWeight: 600,
            textTransform: 'uppercase',
          }}>
            Fish Audio
          </span>
        </div>
        <VoiceCloneSection />
      </section>
    </main>
  );
}
