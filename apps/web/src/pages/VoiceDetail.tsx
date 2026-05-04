import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { voiceCloneApi, type VoiceClone, type VoiceCloneUpdate } from '../lib/api.js';

export function VoiceDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const voiceQuery = useQuery({
    queryKey: ['voice-clone', id],
    queryFn: () => voiceCloneApi.get(id!),
    enabled: !!id,
  });

  const consoleUrlQuery = useQuery({
    queryKey: ['xai-console-url'],
    queryFn: () => voiceCloneApi.getXaiConsoleUrl(),
  });

  const updateMutation = useMutation({
    mutationFn: (patch: VoiceCloneUpdate) => voiceCloneApi.update(id!, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['voice-clone', id] });
      qc.invalidateQueries({ queryKey: ['voice-clones'] });
    },
  });

  const registerXai = useMutation({
    mutationFn: () => voiceCloneApi.registerXai(id!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['voice-clone', id] });
      qc.invalidateQueries({ queryKey: ['voice-clones'] });
    },
  });

  const unregisterXai = useMutation({
    mutationFn: () => voiceCloneApi.unregisterXai(id!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['voice-clone', id] });
      qc.invalidateQueries({ queryKey: ['voice-clones'] });
    },
  });

  const importXai = useMutation({
    mutationFn: (voice_id: string) => voiceCloneApi.importXai(id!, voice_id),
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
          onClick={() => {
            const cascade = voice.providers.xai != null;
            const msg = cascade
              ? `Delete "${voice.name}"? This will also remove the cloned voice from xAI.`
              : `Delete "${voice.name}"? This action cannot be undone.`;
            if (window.confirm(msg)) deleteMutation.mutate(cascade);
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
          <audio src={voiceCloneApi.audioUrl(voice.id)} controls style={{ width: '100%' }} />
          {voice.durationSec && (
            <p style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 4 }}>
              {voice.durationSec.toFixed(1)} s — saved as 24 kHz mono WAV
            </p>
          )}
        </div>
      ) : (
        <div style={{ marginTop: 16, padding: 12, background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 13, color: 'var(--fg-muted)' }}>
          No audio file. (Imported xAI voice without local recording.)
        </div>
      )}

      <PreviewSection voice={voice} />

      <MetadataForm voice={voice} onSave={(p) => updateMutation.mutate(p)} pending={updateMutation.isPending} />

      <Section title="Fish Audio (local)" hint={voice.hasAudio ? 'Available — uses your local recording at synthesis time.' : 'Needs an audio file.'}>
        <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
          Pick voice <code>{`clone:${voice.id}`}</code> in any Fish Audio chunk.
        </span>
      </Section>

      <Section title="xAI Custom Voice">
        {voice.providers.xai ? (
          <XaiRegistered
            voice={voice}
            onUnregister={() => unregisterXai.mutate()}
            onReregister={() => registerXai.mutate()}
            unregistering={unregisterXai.isPending}
            reregistering={registerXai.isPending}
          />
        ) : (
          <XaiNotRegistered
            consoleUrl={consoleUrlQuery.data?.url}
            hasTeamId={consoleUrlQuery.data?.hasTeamId ?? false}
            onRegister={() => registerXai.mutate()}
            registering={registerXai.isPending}
            registerError={(registerXai.error as Error | null)?.message}
            onImport={(voiceId) => importXai.mutate(voiceId)}
            importing={importXai.isPending}
            importError={(importXai.error as Error | null)?.message}
            disableRegister={!voice.hasAudio}
          />
        )}
      </Section>
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
    <Section title="Metadata" hint="Sent to xAI when you register or re-register this voice.">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
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
    </Section>
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

function XaiRegistered({ voice, onUnregister, onReregister, unregistering, reregistering }: {
  voice: VoiceClone;
  onUnregister: () => void;
  onReregister: () => void;
  unregistering: boolean;
  reregistering: boolean;
}) {
  const reg = voice.providers.xai!;
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 13 }}>
          <strong>voice_id:</strong> <code>{reg.voice_id}</code>
        </span>
        {reg.imported && <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>(imported)</span>}
      </div>
      <p style={{ fontSize: 12, color: 'var(--fg-muted)', margin: '0 0 12px' }}>
        Registered {new Date(reg.registeredAt).toLocaleString()}. The voice now appears in the xAI engine voice picker.
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={onReregister} disabled={reregistering || !voice.hasAudio} style={{ padding: '6px 12px', fontSize: 13 }}>
          {reregistering ? 'Re-registering…' : 'Re-register (delete + re-upload)'}
        </button>
        <button onClick={onUnregister} disabled={unregistering} style={{ padding: '6px 12px', fontSize: 13, color: 'var(--danger)', border: '1px solid var(--danger)', background: 'transparent', borderRadius: 6 }}>
          {unregistering ? 'Unregistering…' : 'Unregister'}
        </button>
      </div>
    </div>
  );
}

function XaiNotRegistered({ consoleUrl, hasTeamId, onRegister, registering, registerError, onImport, importing, importError, disableRegister }: {
  consoleUrl?: string;
  hasTeamId: boolean;
  onRegister: () => void;
  registering: boolean;
  registerError?: string;
  onImport: (voiceId: string) => void;
  importing: boolean;
  importError?: string;
  disableRegister: boolean;
}) {
  const [voiceId, setVoiceId] = useState('');
  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <button
          onClick={onRegister}
          disabled={registering || disableRegister}
          className="btn--accent"
          style={{ padding: '8px 16px', fontSize: 13 }}
          title={disableRegister ? 'Add an audio file first' : 'Upload your local recording to xAI'}
        >
          {registering ? 'Uploading to xAI…' : 'Register with xAI'}
        </button>
        {consoleUrl && (
          <a href={consoleUrl} target="_blank" rel="noreferrer" style={{ fontSize: 13, color: 'var(--accent)', textDecoration: 'none' }}>
            Clone via xAI console →
          </a>
        )}
        {!hasTeamId && (
          <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
            (set <code>XAI_TEAM_ID</code> for direct link to your library)
          </span>
        )}
      </div>
      {registerError && (
        <p style={{ fontSize: 12, color: 'var(--danger)', margin: '0 0 12px' }}>
          Register failed: {registerError}. Use manual import if your account isn't on Enterprise.
        </p>
      )}
      <div style={{ marginTop: 8, padding: 12, background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 8 }}>
        <p style={{ fontSize: 12, color: 'var(--fg-muted)', margin: '0 0 8px' }}>
          Or paste a <code>voice_id</code> from the xAI console:
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={voiceId}
            onChange={(e) => setVoiceId(e.target.value)}
            placeholder="8-char voice_id"
            style={{ ...inputStyle, marginTop: 0, flex: 1 }}
          />
          <button
            onClick={() => onImport(voiceId.trim())}
            disabled={!voiceId.trim() || importing}
            style={{ padding: '6px 16px', fontSize: 13 }}
          >
            {importing ? 'Importing…' : 'Import'}
          </button>
        </div>
        {importError && (
          <p style={{ fontSize: 12, color: 'var(--danger)', margin: '8px 0 0' }}>{importError}</p>
        )}
      </div>
    </div>
  );
}

function PreviewSection({ voice }: { voice: VoiceClone }) {
  const DEFAULT_SAMPLE = "Hi, I'm a sample of how I sound. This is what I'd be like in your narration.";
  const [text, setText] = useState(DEFAULT_SAMPLE);
  const [activeProvider, setActiveProvider] = useState<'fish' | 'xai' | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioProvider, setAudioProvider] = useState<'fish' | 'xai' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canFish = voice.hasAudio;
  const canXai = !!voice.providers.xai;

  const runPreview = async (provider: 'fish' | 'xai') => {
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
        onChange={(e) => setText(e.target.value.slice(0, 400))}
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
        {text.length} / 400 chars
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <button
          onClick={() => runPreview('fish')}
          disabled={!canFish || !!activeProvider || text.trim().length === 0}
          title={!canFish ? 'Add an audio file to enable Fish preview' : 'Synthesize via Fish Audio (local)'}
          style={{
            padding: '8px 14px',
            fontSize: 13,
            background: 'var(--bg-elev)',
            color: canFish ? 'var(--fg)' : 'var(--fg-muted)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            cursor: canFish && !activeProvider ? 'pointer' : 'not-allowed',
          }}
        >
          {activeProvider === 'fish' ? 'Synthesizing…' : '▶ Preview with Fish'}
        </button>
        <button
          onClick={() => runPreview('xai')}
          disabled={!canXai || !!activeProvider || text.trim().length === 0}
          title={!canXai ? 'Register this voice with xAI to enable preview' : 'Synthesize via xAI custom voice'}
          style={{
            padding: '8px 14px',
            fontSize: 13,
            background: 'var(--bg-elev)',
            color: canXai ? 'var(--fg)' : 'var(--fg-muted)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            cursor: canXai && !activeProvider ? 'pointer' : 'not-allowed',
          }}
        >
          {activeProvider === 'xai' ? 'Synthesizing…' : '▶ Preview with xAI'}
        </button>
        {!canFish && !canXai && (
          <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
            Record audio or register with xAI to enable preview
          </span>
        )}
      </div>

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
