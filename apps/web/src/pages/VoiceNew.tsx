import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { voiceCloneApi } from '../lib/api.js';
import { VoiceRecorder } from '../components/VoiceRecorder.js';

type Source = 'script' | 'upload';
type ScriptLength = 'short' | 'long';

export function VoiceNew() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [source, setSource] = useState<Source>('script');
  const [scriptLength, setScriptLength] = useState<ScriptLength>('short');
  const [uploadTranscript, setUploadTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const scriptQuery = useQuery({
    queryKey: ['voice-clone-script'],
    queryFn: () => voiceCloneApi.getScript(),
  });

  const activeScript =
    scriptQuery.data
      ? scriptLength === 'short' ? scriptQuery.data.short : scriptQuery.data.long
      : '';

  const createMutation = useMutation({
    mutationFn: (input: { name: string; transcript?: string; file: File | Blob }) =>
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
      setError('Voice name is required');
      return;
    }
    // Source determines transcript:
    //   - script: send the script the user just read; auto-trim on server will
    //     clip both audio and transcript in sync if the recording runs long
    //   - upload: send what the user pasted (optional; quality suffers without it)
    const transcript =
      source === 'script' ? activeScript : uploadTranscript.trim() || undefined;
    createMutation.mutate({ name: trimmed, transcript, file });
  };

  const busy = createMutation.isPending;

  return (
    <main className="page" style={{ maxWidth: 720 }}>
      <Link to="/voices" style={{ fontSize: 13, color: 'var(--fg-muted)', textDecoration: 'none' }}>
        ← All voices
      </Link>
      <h1 style={{ marginTop: 12 }}>New Voice</h1>
      <p style={{ color: 'var(--fg-muted)', fontSize: 14, margin: '4px 0 24px' }}>
        Three steps: name it, pick a source, record or upload. Long recordings get auto-trimmed to ~20 s — that's all the local cloner needs for a clean clone.
      </p>

      {/* Step 1: Name */}
      <Step n={1} title="Name this voice">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. My Narration Voice"
          style={inputStyle}
        />
      </Step>

      {/* Step 2: Source */}
      <Step n={2} title="How do you want to add audio?">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <SourceCard
            active={source === 'script'}
            label="Read a script"
            sub="We give you the words, you read them aloud. Transcript handled for you."
            onClick={() => setSource('script')}
          />
          <SourceCard
            active={source === 'upload'}
            label="Upload audio"
            sub="WAV, MP3, M4A, FLAC, OGG, Opus, or WebM. Bring your own."
            onClick={() => setSource('upload')}
          />
        </div>
      </Step>

      {/* Step 3 — script path */}
      {source === 'script' && (
        <Step n={3} title="Read this aloud, then record">
          <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
            <LengthPill active={scriptLength === 'short'} onClick={() => setScriptLength('short')}>
              Short (~18 s)
            </LengthPill>
            <LengthPill active={scriptLength === 'long'} onClick={() => setScriptLength('long')}>
              Long (~60 s)
            </LengthPill>
          </div>
          <div
            style={{
              padding: 14,
              background: 'var(--bg-elev)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              marginBottom: 14,
              maxHeight: 220,
              overflowY: 'auto',
              fontSize: 14,
              lineHeight: 1.6,
              whiteSpace: 'pre-wrap',
              color: 'var(--fg)',
            }}
          >
            {activeScript || (scriptQuery.isLoading ? 'Loading script…' : '')}
          </div>
          <VoiceRecorder
            onComplete={(blob, mime) => {
              const ext = mime.includes('webm') ? 'webm' : mime.includes('mp4') ? 'm4a' : 'ogg';
              const file = new File([blob], `recording.${ext}`, { type: mime });
              submit(file);
            }}
          />
        </Step>
      )}

      {/* Step 3 — upload path */}
      {source === 'upload' && (
        <Step n={3} title="Upload audio + paste transcript">
          <label style={{ display: 'block', fontSize: 13, marginBottom: 10 }}>
            Transcript <span style={{ color: 'var(--fg-muted)' }}>(what was said — strongly recommended)</span>
            <textarea
              value={uploadTranscript}
              onChange={(e) => setUploadTranscript(e.target.value)}
              placeholder="Paste exactly what you said. The cloner uses this as reference text; without it, the clone sounds worse."
              rows={5}
              style={{ ...inputStyle, marginTop: 4, lineHeight: 1.5, resize: 'vertical', fontFamily: 'inherit' }}
            />
          </label>
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
              Any common audio format works. Server converts to 24 kHz mono WAV.
            </p>
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
              className="btn--accent"
              style={{ padding: '10px 20px', fontSize: 14 }}
            >
              {busy ? 'Uploading…' : 'Choose audio file'}
            </button>
          </div>
        </Step>
      )}

      {error && <p style={{ color: 'var(--danger)', fontSize: 13, marginTop: 12 }}>{error}</p>}
      {busy && (
        <p style={{ fontSize: 13, color: 'var(--fg-muted)', marginTop: 12 }}>
          Transcoding and auto-trimming…
        </p>
      )}
    </main>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 24 }}>
      <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: 0.6, margin: '0 0 8px' }}>
        <span style={{ display: 'inline-block', width: 22, height: 22, borderRadius: 11, background: 'var(--bg-elev)', color: 'var(--fg)', textAlign: 'center', lineHeight: '22px', fontSize: 12, marginRight: 8 }}>
          {n}
        </span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function SourceCard({ active, label, sub, onClick }: { active: boolean; label: string; sub: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: '1 1 220px',
        padding: 14,
        textAlign: 'left',
        background: active ? 'var(--accent)15' : 'var(--bg-elev)',
        border: active ? '2px solid var(--accent)' : '1px solid var(--border)',
        borderRadius: 8,
        color: 'var(--fg)',
        cursor: 'pointer',
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 12, color: 'var(--fg-muted)', lineHeight: 1.5 }}>{sub}</div>
    </button>
  );
}

function LengthPill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '4px 10px',
        fontSize: 12,
        background: active ? 'var(--accent)' : 'var(--bg-elev)',
        color: active ? '#fff' : 'var(--fg-muted)',
        border: active ? 'none' : '1px solid var(--border)',
        borderRadius: 12,
        cursor: 'pointer',
        fontWeight: active ? 600 : 400,
      }}
    >
      {children}
    </button>
  );
}

const inputStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: 8,
  background: 'var(--bg)',
  color: 'var(--fg)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  fontSize: 14,
};

export default VoiceNew;
