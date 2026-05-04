import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { voiceCloneApi } from '../lib/api.js';
import { VoiceRecorder } from '../components/VoiceRecorder.js';

type Tab = 'record' | 'upload';

export function VoiceNew() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>('record');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [showScript, setShowScript] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const scriptQuery = useQuery({
    queryKey: ['voice-clone-script'],
    queryFn: () => voiceCloneApi.getScript(),
  });

  const createMutation = useMutation({
    mutationFn: (input: { name: string; description?: string; file: File | Blob }) =>
      voiceCloneApi.create(input),
    onSuccess: (voice) => {
      queryClient.invalidateQueries({ queryKey: ['voice-clones'] });
      navigate(`/voices/${encodeURIComponent(voice.id)}`);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Save failed');
    },
  });

  const submit = (file: File | Blob) => {
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Name is required');
      return;
    }
    createMutation.mutate({ name: trimmed, description: description.trim() || undefined, file });
  };

  return (
    <main className="page">
      <Link to="/voices" style={{ fontSize: 13, color: 'var(--fg-muted)', textDecoration: 'none' }}>
        ← All voices
      </Link>
      <h1 style={{ marginTop: 12 }}>New Voice</h1>
      <p style={{ color: 'var(--fg-muted)', fontSize: 14 }}>
        Record yourself or upload an existing audio clip. The server transcodes to 24 kHz mono WAV automatically.
      </p>

      {/* Reading script */}
      <div style={{ marginTop: 16, marginBottom: 24 }}>
        <button
          onClick={() => setShowScript((v) => !v)}
          style={{ padding: '6px 12px', fontSize: 13, background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--fg)' }}
        >
          📝 {showScript ? 'Hide' : 'Show'} reading script
        </button>
        {showScript && scriptQuery.data && (
          <div style={{ marginTop: 12, padding: 16, background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 8 }}>
            <p style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap', color: 'var(--fg)' }}>
              {scriptQuery.data.script}
            </p>
          </div>
        )}
      </div>

      {/* Name + description */}
      <div style={{ display: 'grid', gap: 12, maxWidth: 520, marginBottom: 24 }}>
        <label style={{ fontSize: 13 }}>
          Name <span style={{ color: 'var(--danger)' }}>*</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. My Voice"
            style={{ display: 'block', width: '100%', marginTop: 4, padding: 8, background: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 14 }}
          />
        </label>
        <label style={{ fontSize: 13 }}>
          Description <span style={{ color: 'var(--fg-muted)' }}>(optional)</span>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. Professional narration voice"
            style={{ display: 'block', width: '100%', marginTop: 4, padding: 8, background: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 14 }}
          />
        </label>
      </div>

      {/* Tab switcher */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', marginBottom: 16 }}>
        {(['record', 'upload'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: '10px 20px',
              background: 'transparent',
              border: 'none',
              borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
              color: tab === t ? 'var(--accent)' : 'var(--fg-muted)',
              fontSize: 14,
              fontWeight: tab === t ? 600 : 400,
              cursor: 'pointer',
              marginBottom: -1,
            }}
          >
            {t === 'record' ? 'Record' : 'Upload'}
          </button>
        ))}
      </div>

      {tab === 'record' && (
        <VoiceRecorder
          onComplete={(blob, mime) => {
            const ext = mime.includes('webm') ? 'webm' : mime.includes('mp4') ? 'm4a' : 'ogg';
            const file = new File([blob], `recording.${ext}`, { type: mime });
            submit(file);
          }}
        />
      )}

      {tab === 'upload' && (
        <div style={{ border: '1px dashed var(--border)', borderRadius: 8, padding: 24, textAlign: 'center' }}>
          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*,.wav,.mp3,.m4a,.flac,.ogg,.opus,.webm"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) submit(f);
            }}
          />
          <p style={{ margin: '0 0 12px', color: 'var(--fg-muted)', fontSize: 13 }}>
            WAV, MP3, M4A, FLAC, OGG, Opus, or WebM — any common audio format works.
          </p>
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={createMutation.isPending}
            className="btn--accent"
            style={{ padding: '10px 20px', fontSize: 14 }}
          >
            {createMutation.isPending ? 'Uploading…' : 'Choose audio file'}
          </button>
        </div>
      )}

      {error && (
        <p style={{ color: 'var(--danger)', fontSize: 13, marginTop: 12 }}>{error}</p>
      )}
      {createMutation.isPending && (
        <p style={{ fontSize: 13, color: 'var(--fg-muted)', marginTop: 12 }}>Transcoding to canonical WAV…</p>
      )}
    </main>
  );
}

export default VoiceNew;
