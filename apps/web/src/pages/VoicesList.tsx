import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { voiceCloneApi, type VoiceClone } from '../lib/api.js';

export function VoicesList() {
  const [showImport, setShowImport] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ['voice-clones'],
    queryFn: () => voiceCloneApi.list(),
  });

  return (
    <main className="page">
      <header style={{ marginBottom: 32, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h1 style={{ margin: 0 }}>Voice Clones</h1>
          <p style={{ color: 'var(--fg-muted)', fontSize: 14, margin: '4px 0 0' }}>
            Reference recordings that clone your voice for TTS narration. Use them via Fish Audio (local) or xAI (uploaded as a custom voice).
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link to="/voices/tts">
            <button
              style={{ padding: '8px 16px', fontSize: 13, background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--fg)' }}
              title="Generate one-off TTS clips with any voice"
            >
              Quick TTS
            </button>
          </Link>
          <button
            onClick={() => setShowImport(true)}
            style={{ padding: '8px 16px', fontSize: 13, background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--fg)' }}
          >
            Import xAI voice_id
          </button>
          <Link to="/voices/new">
            <button className="btn--outline-accent">+ New Voice</button>
          </Link>
        </div>
      </header>

      {showImport && <ImportXaiDialog onClose={() => setShowImport(false)} />}


      {isLoading && <p className="hint">Loading voices…</p>}
      {error && <p style={{ color: 'var(--danger)' }}>Failed to load voices.</p>}

      {data && (
        data.length === 0 ? (
          <div className="empty-state">
            No voices yet. Record or upload a 30–90 second sample to clone your voice.
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
            {data.map((v) => <VoiceCard key={v.id} voice={v} />)}
          </div>
        )
      )}
    </main>
  );
}

function VoiceCard({ voice }: { voice: VoiceClone }) {
  const xai = voice.providers.xai;
  return (
    <Link
      to={`/voices/${encodeURIComponent(voice.id)}`}
      style={{
        display: 'block',
        background: 'var(--bg-elev)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 16,
        textDecoration: 'none',
        color: 'var(--fg)',
        transition: 'border-color 120ms',
      }}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--accent)')}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--border)')}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>{voice.name}</div>
        <span style={{
          fontSize: 18, opacity: 0.6,
        }}>🎙</span>
      </div>
      {voice.description && (
        <p style={{ fontSize: 12, color: 'var(--fg-muted)', margin: '0 0 10px', minHeight: 28 }}>{voice.description}</p>
      )}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <Badge tone={voice.hasAudio ? 'good' : 'muted'}>
          {voice.hasAudio ? 'Local' : 'No audio'}
        </Badge>
        {xai ? (
          <Badge tone="accent" title={`xAI voice_id: ${xai.voice_id}${xai.imported ? ' (imported)' : ''}`}>
            xAI ✓
          </Badge>
        ) : (
          <Badge tone="muted">xAI</Badge>
        )}
        {voice.durationSec && (
          <Badge tone="muted">{Math.round(voice.durationSec)}s</Badge>
        )}
      </div>
    </Link>
  );
}

function ImportXaiDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [voiceId, setVoiceId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const importMutation = useMutation({
    mutationFn: async () => {
      // Two-step: create empty voice container, then attach the xAI voice_id.
      const trimmedName = name.trim();
      const trimmedVoiceId = voiceId.trim();
      if (!trimmedName || !trimmedVoiceId) throw new Error('Name and voice_id are required');
      const voice = await voiceCloneApi.create({ name: trimmedName });
      return voiceCloneApi.importXai(voice.id, trimmedVoiceId);
    },
    onSuccess: (voice) => {
      qc.invalidateQueries({ queryKey: ['voice-clones'] });
      onClose();
      navigate(`/voices/${encodeURIComponent(voice.id)}`);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Import failed'),
  });

  return (
    <div
      className="dialog-overlay"
      style={{ zIndex: 50 }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="dialog"
        style={{ width: 'min(480px, 90vw)' }}
      >
        <h2 style={{ margin: 0, fontSize: 18 }}>Import xAI voice</h2>
        <p style={{ color: 'var(--fg-muted)', fontSize: 13, margin: '6px 0 16px' }}>
          Paste a voice_id from your xAI console. We'll create a voice in your library that points at it (no audio file).
        </p>
        <label style={{ display: 'block', fontSize: 12, color: 'var(--fg-muted)', marginBottom: 12 }}>
          Display name <span style={{ color: 'var(--danger)' }}>*</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. My xAI Voice"
            style={{ display: 'block', width: '100%', marginTop: 4, padding: 8, background: 'var(--bg-elev)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 13 }}
          />
        </label>
        <label style={{ display: 'block', fontSize: 12, color: 'var(--fg-muted)', marginBottom: 12 }}>
          xAI voice_id <span style={{ color: 'var(--danger)' }}>*</span>
          <input
            value={voiceId}
            onChange={(e) => setVoiceId(e.target.value)}
            placeholder="e.g. rxnlivpqs7ba"
            style={{ display: 'block', width: '100%', marginTop: 4, padding: 8, background: 'var(--bg-elev)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 13, fontFamily: 'monospace' }}
          />
        </label>
        {error && <p style={{ color: 'var(--danger)', fontSize: 12, margin: '0 0 12px' }}>{error}</p>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose} style={{ padding: '8px 16px', fontSize: 13 }}>Cancel</button>
          <button
            onClick={() => importMutation.mutate()}
            disabled={importMutation.isPending || !name.trim() || !voiceId.trim()}
            className="btn--accent"
            style={{ padding: '8px 16px', fontSize: 13 }}
          >
            {importMutation.isPending ? 'Importing…' : 'Import'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Badge({ children, tone, title }: { children: React.ReactNode; tone: 'good' | 'accent' | 'muted'; title?: string }) {
  const cls = tone === 'good' ? 'pill pill--success' : tone === 'accent' ? 'pill pill--accent' : 'pill';
  return (
    <span title={title} className={cls}>
      {children}
    </span>
  );
}
