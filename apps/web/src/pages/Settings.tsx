import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { settingsApi, type ModelEntry } from '../lib/api.js';

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
  borderRadius: 10,
  padding: '16px 20px',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: 10,
};

const activeCard: React.CSSProperties = {
  ...card,
  border: '2px solid var(--accent)',
  background: 'var(--accent-bg)',
};

const badge: React.CSSProperties = {
  fontSize: 11,
  padding: '2px 8px',
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

export function Settings() {
  const qc = useQueryClient();
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

  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: '40px 24px' }}>
      <header style={{ marginBottom: 32, display: 'flex', alignItems: 'center', gap: 12 }}>
        <Link
          to="/"
          style={{
            textDecoration: 'none',
            fontSize: 20,
            color: 'var(--fg-muted)',
            lineHeight: 1,
          }}
          title="Back to dashboard"
        >
          &larr;
        </Link>
        <div>
          <h1 style={{ margin: 0, fontSize: 22 }}>Settings</h1>
          <p style={{ color: 'var(--fg-muted)', marginTop: 2, fontSize: 13 }}>
            Manage LLM model configurations
          </p>
        </div>
      </header>

      <section>
        <h2
          style={{
            margin: '0 0 16px',
            fontSize: 14,
            textTransform: 'uppercase',
            color: 'var(--fg-muted)',
            letterSpacing: 1,
          }}
        >
          Models
        </h2>

        {isLoading && <p>Loading models...</p>}
        {error && <p style={{ color: 'var(--danger, #c44)' }}>Failed to load models.</p>}

        {models && (
          <>
            {models.length === 0 && (
              <p style={{ color: 'var(--fg-muted)' }}>
                No models configured. Add one below to get started.
              </p>
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
    </main>
  );
}
