import { useEffect, useState, useRef, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError, settingsApi, ttsApi, voiceApi, type ModelEntry, type TtsEngineInfo, type VoiceProfileInfo } from '../lib/api.js';
import { useUi } from '../components/ui/UiProvider.js';
import { ModelAssignments } from '../components/ModelAssignments.js';
import { boundedMessage, modelEditDraft, MODEL_ASSIGNMENT_ROWS } from '../lib/model-routing.js';

type Provider = ModelEntry['provider'];

const PROVIDERS: { value: Provider; label: string; needsEndpoint: boolean; needsApiKey: boolean; hint: string }[] = [
  { value: 'openai-compat', label: 'OpenAI Compatible (LM Studio / Ollama)', needsEndpoint: true, needsApiKey: false, hint: 'e.g. http://localhost:1234/v1' },
  { value: 'gemini', label: 'Google Gemini', needsEndpoint: false, needsApiKey: true, hint: '' },
  { value: 'anthropic', label: 'Anthropic', needsEndpoint: false, needsApiKey: true, hint: '' },
  { value: 'claude-code', label: 'Claude Code (claude -p)', needsEndpoint: false, needsApiKey: false, hint: 'Uses local Claude CLI' },
  { value: 'codex-cli', label: 'Codex CLI (codex exec)', needsEndpoint: false, needsApiKey: false, hint: 'Uses your local Codex login' },
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

interface ModelReferences {
  globalRoles: Array<'video-understanding' | 'writing' | 'general'>;
  projects: Array<{
    id: string;
    name: string;
    roles: Array<'video-understanding' | 'writing' | 'general'>;
  }>;
  truncated: boolean;
}

function roleLabel(role: ModelReferences['globalRoles'][number]): string {
  return MODEL_ASSIGNMENT_ROWS.find(([candidate]) => candidate === role)?.[1] ?? role;
}

function parseModelReferences(value: unknown): ModelReferences | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  const knownRole = (role: unknown): role is ModelReferences['globalRoles'][number] =>
    role === 'video-understanding' || role === 'writing' || role === 'general';
  if (!Array.isArray(candidate.globalRoles) || !candidate.globalRoles.every(knownRole)) return undefined;
  if (typeof candidate.truncated !== 'boolean' || !Array.isArray(candidate.projects)) return undefined;
  const projects = candidate.projects.flatMap((project) => {
    if (!project || typeof project !== 'object') return [];
    const record = project as Record<string, unknown>;
    if (typeof record.id !== 'string' || typeof record.name !== 'string'
      || !Array.isArray(record.roles) || !record.roles.every(knownRole)) return [];
    return [{ id: record.id, name: record.name, roles: record.roles }];
  });
  if (projects.length !== candidate.projects.length) return undefined;
  return { globalRoles: candidate.globalRoles, projects, truncated: candidate.truncated };
}

function ModelCard({
  entry,
  onDelete,
  onUpdate,
  deleteError,
  deleteMessage,
}: {
  entry: ModelEntry;
  onDelete: () => void;
  onUpdate: (patch: { name?: string; model?: string; endpoint?: string; apiKey?: string }) => Promise<void>;
  deleteError?: ModelReferences;
  deleteMessage?: string;
}) {
  const meta = providerMeta(entry.provider);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => modelEditDraft(entry));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (editing) return;
    setDraft(modelEditDraft(entry));
  }, [editing, entry.endpoint, entry.model, entry.name]);

  async function save() {
    setSaving(true);
    setError('');
    try {
      const savedDraft = {
        name: draft.name.trim(),
        model: draft.model.trim(),
        endpoint: draft.endpoint.trim(),
        apiKey: '',
      };
      await onUpdate({
        name: savedDraft.name,
        model: savedDraft.model,
        ...(meta.needsEndpoint ? { endpoint: savedDraft.endpoint } : {}),
        ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
      });
      setDraft(savedDraft);
      setEditing(false);
    } catch (saveError) {
      setError(boundedMessage(saveError instanceof Error ? saveError.message : 'Could not save this model. Try again.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="model-library-card">
      {editing ? (
        <div className="model-library-card__editor">
          <label>
            Display name
            <input
              value={draft.name}
              onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            />
          </label>
          <label>
            Model name / ID
            <input
              value={draft.model}
              onChange={(event) => setDraft((current) => ({ ...current, model: event.target.value }))}
            />
          </label>
          {meta.needsEndpoint && (
            <label>
              API endpoint
              <input
                value={draft.endpoint}
                onChange={(event) => setDraft((current) => ({ ...current, endpoint: event.target.value }))}
              />
            </label>
          )}
          {meta.needsApiKey && (
            <label>
              Replace API key
              <input
                type="password"
                value={draft.apiKey}
                placeholder={entry.hasApiKey ? 'Leave blank to keep the saved key' : 'Add an API key'}
                onChange={(event) => setDraft((current) => ({ ...current, apiKey: event.target.value }))}
              />
            </label>
          )}
          {error && <p className="model-library-card__error" role="alert">{error}</p>}
          <div className="model-library-card__actions">
            <button
              type="button"
              onClick={() => {
                setDraft(modelEditDraft(entry));
                setEditing(false);
                setError('');
              }}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn--accent"
              onClick={() => void save()}
              disabled={saving || !draft.name.trim() || !draft.model.trim()}
            >
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="model-library-card__summary">
            <div className="model-library-card__titleline">
              <strong>{entry.name}</strong>
              <span className={`model-readiness model-readiness--${entry.ready ? 'ready' : 'attention'}`}>
                {entry.ready ? 'Ready' : 'Needs attention'}
              </span>
              {entry.capabilities.text && <span className="model-capability">Text</span>}
              {entry.capabilities.video && <span className="model-capability model-capability--video">Video</span>}
            </div>
            <div className="model-library-card__identity">
              {meta.label} <span aria-hidden>·</span> <code>{entry.model}</code>
              {entry.endpoint && <span className="model-library-card__endpoint">{entry.endpoint}</span>}
            </div>
            {!entry.ready && (
              <p className="model-library-card__readiness">
                {entry.readinessMessage ?? 'Check this model configuration, then check its status again.'}
              </p>
            )}
          </div>
          <div className="model-library-card__actions">
            <button type="button" onClick={() => setEditing(true)}>Edit</button>
            <button type="button" className="model-library-card__remove" onClick={onDelete}>
              Remove
            </button>
          </div>
        </>
      )}
      {error && !editing && <p className="model-library-card__error" role="alert">{error}</p>}
      {deleteError && (
        <div className="model-library-card__references" role="alert">
          <strong>Reassign this model before deleting it.</strong>
          {deleteError.globalRoles.length > 0 && (
            <p>Global jobs: {deleteError.globalRoles.map(roleLabel).join(', ')}.</p>
          )}
          {deleteError.projects.map((project) => (
            <p key={project.id}>{project.name}: {project.roles.map(roleLabel).join(', ')}.</p>
          ))}
          {deleteError.truncated && <p>More project references were omitted. Reassign those projects too.</p>}
        </div>
      )}
      {deleteMessage && <p className="model-library-card__error" role="alert">{deleteMessage}</p>}
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
            onChange={(e) => {
              const nextProvider = e.target.value as Provider;
              setProvider(nextProvider);
              if (nextProvider === 'codex-cli' && !model.trim()) setModel('default');
            }}
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
                    : provider === 'codex-cli'
                      ? 'default'
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

  // Auto-select first engine & voice when engines load. Must run in an effect —
  // calling setState during render produces React warnings + double renders.
  useEffect(() => {
    if (engines && engines.length > 0 && !engineId) {
      setEngineId(engines[0]!.id);
      if (engines[0]!.voices.length > 0) {
        setVoiceId(engines[0]!.voices[0]!.id);
      }
    }
  }, [engines, engineId]);

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

/* Voice cloning moved to /voices — see VoicesList / VoiceNew / VoiceDetail. */

/* ── Settings Page ──────────────────────────────────── */

export function Settings() {
  const qc = useQueryClient();
  const ui = useUi();
  const [deleteErrors, setDeleteErrors] = useState<Record<string, ModelReferences>>({});
  const [deleteMessages, setDeleteMessages] = useState<Record<string, string>>({});

  // Models
  const { data: models, isLoading, error } = useQuery({
    queryKey: ['settings', 'models'],
    queryFn: () => settingsApi.listModels(),
  });

  const routingQuery = useQuery({
    queryKey: ['settings', 'model-routing'],
    queryFn: () => settingsApi.getModelRouting(),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => settingsApi.deleteModel(id),
    onMutate: (id) => {
      setDeleteErrors((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setDeleteMessages((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    },
    onSuccess: async (_data, id) => {
      setDeleteErrors((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setDeleteMessages((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['settings', 'models'] }),
        qc.invalidateQueries({ queryKey: ['settings', 'model-routing'] }),
      ]);
    },
    onError: (deleteError, id) => {
      if (!(deleteError instanceof ApiError) || deleteError.status !== 409) {
        const reason = deleteError instanceof Error ? deleteError.message : 'The server did not accept the request.';
        setDeleteMessages((current) => ({
          ...current,
          [id]: boundedMessage(`Could not remove this model. Check the connection, then try again. ${reason}`),
        }));
        return;
      }
      const payload = deleteError.payload;
      if (!payload || typeof payload !== 'object' || !('code' in payload) || payload.code !== 'model_in_use'
        || !('references' in payload)) {
        setDeleteMessages((current) => ({
          ...current,
          [id]: 'Could not remove this model. Reload the page, then try again.',
        }));
        return;
      }
      const references = parseModelReferences(payload.references);
      if (!references) {
        setDeleteMessages((current) => ({
          ...current,
          [id]: 'Could not read the model references. Reload the page, then try again.',
        }));
        return;
      }
      setDeleteErrors((current) => ({ ...current, [id]: references }));
    },
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
          Assign AI specialists to production jobs and manage their connections.
        </p>
      </header>

      <section id="model-assignments" className="settings-model-assignments">
        <div className="section-header" style={{ marginBottom: 18 }}>
          <span className="section-label">Model assignments</span>
        </div>
        <p className="settings-section-intro">
          Choose which model takes responsibility for each stable production job.
        </p>
        {routingQuery.isLoading && <p className="hint">Loading model assignments…</p>}
        {routingQuery.error && (
          <p className="model-routing-load-error" role="alert">
            Could not load model assignments. Check that VPA is running, then reload this page.
          </p>
        )}
        {models && routingQuery.data && (
          <ModelAssignments
            mode="global"
            models={models}
            routing={routingQuery.data}
            onUpdate={async (update) => {
              const next = await settingsApi.updateModelRouting(update);
              qc.setQueryData(['settings', 'model-routing'], next);
              return next;
            }}
          />
        )}
      </section>

      {/* The catalog stays visually quiet: assignments above explain why an
          entry exists before this library exposes provider maintenance. */}
      <section id="model-library" className="settings-model-library">
        <div className="section-header" style={{ marginBottom: 12 }}>
          <span className="section-label">Model library</span>
        </div>
        <p className="settings-section-intro">
          Add and maintain the provider connections available to the assignments above.
        </p>

        {isLoading && <p className="hint">Loading models...</p>}
        {error && (
          <p className="model-routing-load-error" role="alert">
            Could not load the model library. Check that VPA is running, then reload this page.
          </p>
        )}

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
                deleteError={deleteErrors[m.id]}
                deleteMessage={deleteMessages[m.id]}
                onUpdate={async (patch) => {
                  await settingsApi.updateModel(m.id, patch);
                  await Promise.all([
                    qc.invalidateQueries({ queryKey: ['settings', 'models'] }),
                    qc.invalidateQueries({ queryKey: ['settings', 'model-routing'] }),
                  ]);
                }}
                onDelete={async () => {
                  const ok = await ui.confirm({
                    title: 'Delete this model configuration?',
                    body: `"${m.name}" (${m.provider}${m.model ? ` / ${m.model}` : ''}) will be removed. This can't be undone.`,
                    confirmLabel: 'Delete',
                    destructive: true,
                  });
                  if (ok) deleteMutation.mutate(m.id);
                }}
              />
            ))}
            <AddModelForm onAdded={() => {
              void Promise.all([
                qc.invalidateQueries({ queryKey: ['settings', 'models'] }),
                qc.invalidateQueries({ queryKey: ['settings', 'model-routing'] }),
              ]);
            }} />
          </>
        )}
      </section>

      {/* TTS section — voice profiles, plus a clear pointer to the
          separate /voices library. Previously this surface had two
          sections ("TTS Voice Profiles" + "Voice Cloning") with cross
          links and overlapping vocabulary. Now it's one section that
          explains the difference upfront and lets the link out be the
          only mention of voice clones. */}
      <section style={{ marginTop: 48 }}>
        <div className="section-header" style={{ marginBottom: 12 }}>
          <span className="section-label">Text-to-Speech</span>
        </div>
        <p style={{ color: 'var(--fg-muted)', fontSize: 13, margin: '0 0 8px', lineHeight: 1.5 }}>
          A <strong style={{ color: 'var(--fg)' }}>voice profile</strong> is a saved preset
          (engine + voice + speed) you pick when generating narration for a scene.
        </p>
        <p style={{ color: 'var(--fg-muted)', fontSize: 13, margin: '0 0 18px', lineHeight: 1.5 }}>
          Looking for <strong style={{ color: 'var(--fg)' }}>voice cloning</strong>? That's a
          separate library of your own cloned voices —{' '}
          <a href="/voices" style={{ color: 'var(--accent)', textDecoration: 'none' }}>open Voices →</a>
        </p>

        {voicesLoading && <p className="hint">Loading voice profiles…</p>}
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
                onDelete={async () => {
                  const ok = await ui.confirm({
                    title: 'Delete voice profile?',
                    body: `"${v.name}" (${v.engine} / ${v.voice}) will be removed. Scenes already configured with this profile will keep their settings, but you'll need to recreate it to use it again.`,
                    confirmLabel: 'Delete',
                    destructive: true,
                  });
                  if (ok) deleteVoiceMutation.mutate(v.id);
                }}
              />
            ))}
            <AddVoiceProfileForm onAdded={() => qc.invalidateQueries({ queryKey: ['settings', 'voices'] })} />
          </>
        )}
      </section>
    </main>
  );
}
