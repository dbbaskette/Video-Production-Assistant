import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { voiceCloneApi, type VoiceClone, type VoiceCloneUpdate } from '../lib/api.js';
import { useUi } from '../components/ui/UiProvider.js';

export function VoiceDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const ui = useUi();

  const voiceQuery = useQuery({
    queryKey: ['voice-clone', id],
    queryFn: () => voiceCloneApi.get(id!),
    enabled: !!id,
  });

  const updateMutation = useMutation({
    mutationFn: (patch: VoiceCloneUpdate) => voiceCloneApi.update(id!, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['voice-clone', id] });
      qc.invalidateQueries({ queryKey: ['voice-clones'] });
    },
  });

  const trimMutation = useMutation({
    mutationFn: (targetSec: number) => voiceCloneApi.trim(id!, targetSec),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['voice-clone', id] });
      qc.invalidateQueries({ queryKey: ['voice-clones'] });
    },
  });

  const restoreMutation = useMutation({
    mutationFn: () => voiceCloneApi.restore(id!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['voice-clone', id] });
      qc.invalidateQueries({ queryKey: ['voice-clones'] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (cascadeXai: boolean) => voiceCloneApi.remove(id!, { cascadeXai }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['voice-clones'] });
      navigate('/voices');
    },
  });

  if (voiceQuery.isLoading) return <main className="page"><p className="hint">Loading…</p></main>;
  if (voiceQuery.error || !voiceQuery.data) {
    return (
      <main className="page">
        <Link to="/voices" style={{ fontSize: 13, color: 'var(--fg-muted)', textDecoration: 'none' }}>
          ← All voices
        </Link>
        <p style={{ color: 'var(--danger)', marginTop: 12 }}>Voice not found.</p>
      </main>
    );
  }

  const voice = voiceQuery.data;
  return (
    <main className="page" style={{ maxWidth: 720 }}>
      <Link to="/voices" style={{ fontSize: 13, color: 'var(--fg-muted)', textDecoration: 'none' }}>
        ← All voices
      </Link>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 }}>
        <h1 style={{ margin: 0 }}>{voice.name}</h1>
        <button
          onClick={async () => {
            const cascade = voice.providers.xai != null;
            const ok = await ui.confirm({
              title: `Delete "${voice.name}"?`,
              body: cascade
                ? 'This will also remove the cloned voice from xAI. This action cannot be undone.'
                : 'This action cannot be undone.',
              confirmLabel: 'Delete',
              destructive: true,
            });
            if (ok) deleteMutation.mutate(cascade);
          }}
          disabled={deleteMutation.isPending}
          style={{ padding: '6px 12px', background: 'transparent', color: 'var(--danger)', border: '1px solid var(--danger)', borderRadius: 6, fontSize: 13, cursor: 'pointer' }}
        >
          Delete
        </button>
      </div>

      {/* Audio preview */}
      {voice.hasAudio ? (
        <div style={{ marginTop: 16 }}>
          <audio src={`${voiceCloneApi.audioUrl(voice.id)}?v=${voice.durationSec ?? 0}`} controls style={{ width: '100%' }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4, gap: 8, flexWrap: 'wrap' }}>
            <p style={{ fontSize: 12, color: 'var(--fg-muted)', margin: 0 }}>
              {voice.durationSec ? `${voice.durationSec.toFixed(1)} s` : 'unknown duration'}
              {' — saved as 24 kHz mono WAV'}
              {voice.isTrimmed && voice.originalDurationSec && (
                <span style={{ marginLeft: 8, color: 'var(--accent)' }}>
                  (trimmed from {voice.originalDurationSec.toFixed(1)} s)
                </span>
              )}
            </p>
            <TrimControls
              voice={voice}
              onTrim={(sec) => trimMutation.mutate(sec)}
              onRestore={() => restoreMutation.mutate()}
              trimming={trimMutation.isPending}
              restoring={restoreMutation.isPending}
              error={(trimMutation.error as Error | null)?.message ?? (restoreMutation.error as Error | null)?.message}
            />
          </div>
        </div>
      ) : (
        <div style={{ marginTop: 16, padding: 12, background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 13, color: 'var(--fg-muted)' }}>
          No audio file. (Imported xAI voice without local recording.)
        </div>
      )}

      <PreviewSection voice={voice} />

      <Section title="Local voice cloning (Qwen3-TTS)" hint={voice.hasAudio ? 'Available — uses your local recording at synthesis time.' : 'Needs an audio file.'}>
        <p style={{ fontSize: 13, color: 'var(--fg)', margin: 0, lineHeight: 1.6 }}>
          In any scene, pick the <strong>Qwen3-TTS (local)</strong> engine, then choose{' '}
          <strong>{voice.name} (cloned)</strong> from the voice dropdown.
        </p>
        <p style={{ fontSize: 11, color: 'var(--fg-muted)', margin: '6px 0 0' }}>
          Voice id: <code>{`clone:${voice.id}`}</code>
        </p>
      </Section>

      <MetadataForm voice={voice} onSave={(p) => updateMutation.mutate(p)} pending={updateMutation.isPending} />
    </main>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 32, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 16 }}>{title}</h2>
      {hint && <p style={{ color: 'var(--fg-muted)', fontSize: 12, margin: '0 0 12px' }}>{hint}</p>}
      <div style={{ marginTop: 8 }}>{children}</div>
    </section>
  );
}

function MetadataForm({ voice, onSave, pending }: { voice: VoiceClone; onSave: (p: VoiceCloneUpdate) => void; pending: boolean }) {
  const [name, setName] = useState(voice.name);
  const [description, setDescription] = useState(voice.description ?? '');
  const [transcript, setTranscript] = useState(voice.transcript ?? '');
  const [gender, setGender] = useState<string>(voice.gender ?? '');
  const [age, setAge] = useState<string>(voice.age ?? '');
  const [accent, setAccent] = useState(voice.accent ?? '');
  const [language, setLanguage] = useState(voice.language ?? '');
  const [useCase, setUseCase] = useState<string>(voice.use_case ?? '');
  const [tone, setTone] = useState<string>(voice.tone ?? '');

  const handleSave = () => {
    const patch: VoiceCloneUpdate = {
      name: name.trim(),
      description: description.trim() || null,
      transcript: transcript.trim() || null,
      gender: (gender || null) as VoiceCloneUpdate['gender'],
      age: (age || null) as VoiceCloneUpdate['age'],
      accent: accent.trim() || null,
      language: language.trim() || null,
      use_case: (useCase || null) as VoiceCloneUpdate['use_case'],
      tone: (tone || null) as VoiceCloneUpdate['tone'],
    };
    onSave(patch);
  };

  return (
    <details style={{ marginTop: 32, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
      <summary style={{ cursor: 'pointer', fontSize: 16, fontWeight: 600, color: 'var(--fg)', listStyle: 'revert', outline: 'none' }}>
        Metadata
        <span style={{ fontSize: 12, color: 'var(--fg-muted)', fontWeight: 400, marginLeft: 8 }}>
          (optional — name, transcript, gender, accent, etc.)
        </span>
      </summary>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} />
        </Field>
        <Field label="Language (BCP-47)">
          <input value={language} onChange={(e) => setLanguage(e.target.value)} placeholder="en-US" style={inputStyle} />
        </Field>
        <Field label="Description" full>
          <input value={description} onChange={(e) => setDescription(e.target.value)} style={inputStyle} />
        </Field>
        <Field label="Gender">
          <select value={gender} onChange={(e) => setGender(e.target.value)} style={inputStyle}>
            <option value="">—</option>
            <option value="male">male</option>
            <option value="female">female</option>
            <option value="neutral">neutral</option>
          </select>
        </Field>
        <Field label="Age">
          <select value={age} onChange={(e) => setAge(e.target.value)} style={inputStyle}>
            <option value="">—</option>
            <option value="young">young</option>
            <option value="middle-aged">middle-aged</option>
            <option value="old">old</option>
          </select>
        </Field>
        <Field label="Accent">
          <input value={accent} onChange={(e) => setAccent(e.target.value)} placeholder="e.g. British" style={inputStyle} />
        </Field>
        <Field label="Use case">
          <select value={useCase} onChange={(e) => setUseCase(e.target.value)} style={inputStyle}>
            <option value="">—</option>
            {['conversational', 'narration', 'characters', 'educational', 'advertisement', 'social_media', 'entertainment'].map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
        </Field>
        <Field label="Tone">
          <select value={tone} onChange={(e) => setTone(e.target.value)} style={inputStyle}>
            <option value="">—</option>
            {['warm', 'casual', 'professional', 'friendly', 'authoritative', 'expressive', 'calm'].map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
        </Field>
        <Field label="Transcript (what was said)" full>
          <textarea
            value={transcript}
            onChange={(e) => setTranscript(e.target.value)}
            rows={4}
            style={{ ...inputStyle, fontFamily: 'inherit', resize: 'vertical' }}
          />
        </Field>
      </div>
      <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
        <button onClick={handleSave} disabled={pending} className="btn--accent" style={{ padding: '8px 16px', fontSize: 13 }}>
          {pending ? 'Saving…' : 'Save metadata'}
        </button>
      </div>
    </details>
  );
}

const inputStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  marginTop: 4,
  padding: 8,
  background: 'var(--bg)',
  color: 'var(--fg)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  fontSize: 13,
};

function Field({ label, full, children }: { label: string; full?: boolean; children: React.ReactNode }) {
  return (
    <label style={{ fontSize: 12, color: 'var(--fg-muted)', gridColumn: full ? '1 / -1' : 'auto' }}>
      {label}
      {children}
    </label>
  );
}

function TrimControls({ voice, onTrim, onRestore, trimming, restoring, error }: {
  voice: VoiceClone;
  onTrim: (targetSec: number) => void;
  onRestore: () => void;
  trimming: boolean;
  restoring: boolean;
  error?: string;
}) {
  const [target, setTarget] = useState(20);
  const longEnough = (voice.durationSec ?? 0) > 30;
  const busy = trimming || restoring;
  if (voice.isTrimmed) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button
          onClick={onRestore}
          disabled={busy}
          title="Restore the original recording from audio.full.wav"
          style={{ padding: '5px 10px', fontSize: 12, background: 'transparent', border: '1px solid var(--border)', borderRadius: 5, color: 'var(--fg)', cursor: busy ? 'wait' : 'pointer' }}
        >
          {restoring ? 'Restoring…' : 'Restore original'}
        </button>
        {error && <span style={{ fontSize: 11, color: 'var(--danger)' }}>{error}</span>}
      </div>
    );
  }
  if (!longEnough) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <label style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
        Trim to
        <input
          type="number"
          value={target}
          min={5}
          max={60}
          onChange={(e) => setTarget(Math.max(5, Math.min(60, parseInt(e.target.value, 10) || 20)))}
          style={{ width: 50, marginLeft: 6, marginRight: 4, padding: '2px 4px', background: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 4, fontSize: 12 }}
        />
        s
      </label>
      <button
        onClick={() => onTrim(target)}
        disabled={busy}
        title={`Cut reference audio at the nearest silence near ${target}s; the original is preserved.`}
        style={{ padding: '5px 10px', fontSize: 12, background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 5, color: 'var(--fg)', cursor: busy ? 'wait' : 'pointer' }}
      >
        {trimming ? 'Trimming…' : 'Trim reference'}
      </button>
      {error && <span style={{ fontSize: 11, color: 'var(--danger)' }}>{error}</span>}
    </div>
  );
}

function PreviewSection({ voice }: { voice: VoiceClone }) {
  const DEFAULT_SAMPLE = "Hi, I'm a sample of how I sound. This is what I'd be like in your narration.";
  const [text, setText] = useState(DEFAULT_SAMPLE);
  const [activeProvider, setActiveProvider] = useState<'local' | 'xai' | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioProvider, setAudioProvider] = useState<'local' | 'xai' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canLocal = voice.hasAudio;
  const canXai = !!voice.providers.xai;

  const runPreview = async (provider: 'local' | 'xai') => {
    if (activeProvider) return;
    setActiveProvider(provider);
    setError(null);
    try {
      const blob = await voiceCloneApi.preview(voice.id, { provider, text: text.trim() });
      // Replace any prior object URL to avoid leaks
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      const url = URL.createObjectURL(blob);
      setAudioUrl(url);
      setAudioProvider(provider);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Preview failed');
    } finally {
      setActiveProvider(null);
    }
  };

  // Cleanup the blob URL on unmount or replacement
  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Section title="Preview voice" hint="Hear how this voice reads a short sentence — no project context needed.">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value.slice(0, 4000))}
        rows={2}
        placeholder={DEFAULT_SAMPLE}
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
      <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 4 }}>
        {text.length} / 4000 chars
      </div>
      {/*
        Preview button hierarchy: local (Qwen3-TTS) is the primary CTA when
        audio exists, since it's the path you'll actually use in narration.
        xAI fills in if registered. The unavailable side stays disabled.
       */}
      {(() => {
        const localIsPrimary = canLocal;
        const xaiIsPrimary = !canLocal && canXai;
        return (
          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <button
              onClick={() => runPreview('local')}
              disabled={!canLocal || !!activeProvider || text.trim().length === 0}
              title={!canLocal ? 'Add an audio file to enable local preview' : 'Synthesize via Qwen3-TTS (local)'}
              className={localIsPrimary ? 'primary' : undefined}
              style={{
                padding: '8px 14px',
                fontSize: 13,
                cursor: canLocal && !activeProvider ? 'pointer' : 'not-allowed',
                ...(localIsPrimary
                  ? {}
                  : {
                      background: 'var(--bg-elev)',
                      color: canLocal ? 'var(--fg)' : 'var(--fg-muted)',
                      border: '1px solid var(--border)',
                      borderRadius: 6,
                    }),
              }}
            >
              {activeProvider === 'local' ? 'Synthesizing…' : '▶ Preview (local)'}
            </button>
            <button
              onClick={() => runPreview('xai')}
              disabled={!canXai || !!activeProvider || text.trim().length === 0}
              title={!canXai ? 'Register this voice with xAI to enable preview' : 'Synthesize via xAI custom voice'}
              className={xaiIsPrimary ? 'primary' : undefined}
              style={{
                padding: '8px 14px',
                fontSize: 13,
                cursor: canXai && !activeProvider ? 'pointer' : 'not-allowed',
                ...(xaiIsPrimary
                  ? {}
                  : {
                      background: 'var(--bg-elev)',
                      color: canXai ? 'var(--fg)' : 'var(--fg-muted)',
                      border: '1px solid var(--border)',
                      borderRadius: 6,
                    }),
              }}
            >
              {activeProvider === 'xai' ? 'Synthesizing…' : '▶ Preview with xAI'}
            </button>
            {!canLocal && !canXai && (
              <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
                Record audio or register with xAI to enable preview
              </span>
            )}
          </div>
        );
      })()}

      {error && (
        <p style={{ color: 'var(--danger)', fontSize: 12, margin: '10px 0 0', whiteSpace: 'pre-wrap' }}>
          {error}
        </p>
      )}

      {audioUrl && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginBottom: 4 }}>
            Latest preview ({audioProvider})
          </div>
          <audio src={audioUrl} controls autoPlay style={{ width: '100%', maxWidth: 480 }} />
        </div>
      )}
    </Section>
  );
}

export default VoiceDetail;
