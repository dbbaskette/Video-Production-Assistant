import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ttsApi, type TtsEngineInfo, type TtsScratchClip } from '../lib/api.js';

const PREFS_KEY = 'vpa.tts-scratch.prefs.v1';
const MAX_TEXT_CHARS = 5000;

interface Prefs {
  engine?: string;
  voice?: string;
  speed?: number;
}

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? (JSON.parse(raw) as Prefs) : {};
  } catch {
    return {};
  }
}

function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    // ignore quota / disabled storage
  }
}

function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec - m * 60);
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const delta = Date.now() - t;
  const min = Math.round(delta / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

export function VoicesTts() {
  const qc = useQueryClient();
  const enginesQuery = useQuery({
    queryKey: ['tts-engines'],
    queryFn: () => ttsApi.listEngines(),
  });
  const clipsQuery = useQuery({
    queryKey: ['tts-scratch'],
    queryFn: () => ttsApi.scratch.list(),
  });

  const [engineId, setEngineId] = useState<string>('');
  const [voiceId, setVoiceId] = useState<string>('');
  const [speed, setSpeed] = useState<number>(1.0);
  const [text, setText] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [latestId, setLatestId] = useState<string | null>(null);

  const engines = enginesQuery.data ?? [];
  const currentEngine = useMemo<TtsEngineInfo | undefined>(
    () => engines.find((e) => e.id === engineId),
    [engines, engineId],
  );

  // Initial defaults: load prefs, then pick first available engine/voice that exists.
  useEffect(() => {
    if (!engines.length || engineId) return;
    const prefs = loadPrefs();
    const preferredEngine = prefs.engine && engines.find((e) => e.id === prefs.engine)
      ? prefs.engine
      : (engines.find((e) => e.id !== 'fake') ?? engines[0])?.id;
    if (!preferredEngine) return;
    const eng = engines.find((e) => e.id === preferredEngine);
    if (!eng) return;
    setEngineId(preferredEngine);
    const preferredVoice = prefs.voice && eng.voices.find((v) => v.id === prefs.voice)
      ? prefs.voice
      : eng.voices[0]?.id ?? '';
    setVoiceId(preferredVoice);
    if (typeof prefs.speed === 'number' && prefs.speed > 0) setSpeed(prefs.speed);
  }, [engines, engineId]);

  // When engine changes, reset voice to first available for that engine.
  useEffect(() => {
    if (!currentEngine) return;
    if (!currentEngine.voices.find((v) => v.id === voiceId)) {
      setVoiceId(currentEngine.voices[0]?.id ?? '');
    }
  }, [currentEngine, voiceId]);

  // Persist prefs as the user changes them.
  useEffect(() => {
    if (engineId || voiceId) savePrefs({ engine: engineId, voice: voiceId, speed });
  }, [engineId, voiceId, speed]);

  const generateMutation = useMutation({
    mutationFn: () =>
      ttsApi.scratch.generate({ engine: engineId, voice: voiceId, text: text.trim(), speed }),
    onSuccess: (clip) => {
      setError(null);
      setLatestId(clip.id);
      qc.invalidateQueries({ queryKey: ['tts-scratch'] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Generation failed'),
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => ttsApi.scratch.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tts-scratch'] }),
  });

  const charCount = text.length;
  const overLimit = charCount > MAX_TEXT_CHARS;
  const canGenerate =
    !!engineId && !!voiceId && text.trim().length > 0 && !overLimit && !generateMutation.isPending;

  const clips = clipsQuery.data ?? [];

  return (
    <main className="page page--wide">
      <header style={{ marginBottom: 24, display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h1 style={{ margin: 0 }}>Quick TTS</h1>
          <p style={{ color: 'var(--fg-muted)', fontSize: 14, margin: '4px 0 0' }}>
            Type or paste any text, pick a voice, and generate a one-off clip you can play or download.
            Recent clips are kept on disk so they survive reloads.
          </p>
        </div>
        <Link to="/voices" style={{ fontSize: 13, color: 'var(--fg-muted)', textDecoration: 'none' }}>
          ← Voices
        </Link>
      </header>

      {enginesQuery.isLoading && <p className="hint">Loading engines…</p>}
      {enginesQuery.error && (
        <p style={{ color: 'var(--danger)' }}>Failed to load TTS engines.</p>
      )}

      {engines.length === 0 && !enginesQuery.isLoading && (
        <div className="empty-state">
          No TTS engines registered. Configure providers via the <Link to="/setup">Setup</Link> page.
        </div>
      )}

      {engines.length > 0 && (
        <section
          style={{
            background: 'var(--bg-elev)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            padding: 20,
            display: 'grid',
            gap: 16,
          }}
        >
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 12, alignItems: 'end' }}>
            <Field label="Engine">
              <select
                value={engineId}
                onChange={(e) => setEngineId(e.target.value)}
                style={selectStyle}
              >
                {engines.map((eng) => (
                  <option key={eng.id} value={eng.id}>
                    {eng.displayName}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Voice">
              <select
                value={voiceId}
                onChange={(e) => setVoiceId(e.target.value)}
                disabled={!currentEngine || currentEngine.voices.length === 0}
                style={selectStyle}
              >
                {(currentEngine?.voices ?? []).map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={`Speed: ${speed.toFixed(2)}×`}>
              <input
                type="range"
                min={0.5}
                max={1.5}
                step={0.05}
                value={speed}
                onChange={(e) => setSpeed(Number(e.target.value))}
                style={{ width: 160 }}
              />
            </Field>
          </div>

          <Field
            label={`Text (${charCount.toLocaleString()} / ${MAX_TEXT_CHARS.toLocaleString()})`}
            tone={overLimit ? 'danger' : 'muted'}
          >
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Type or paste anything you want spoken aloud."
              rows={8}
              style={{
                width: '100%',
                resize: 'vertical',
                padding: 12,
                fontSize: 14,
                lineHeight: 1.5,
                fontFamily: 'inherit',
                background: 'var(--bg)',
                color: 'var(--fg)',
                border: `1px solid ${overLimit ? 'var(--danger)' : 'var(--border)'}`,
                borderRadius: 6,
              }}
            />
          </Field>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
              {currentEngine && currentEngine.supportedEmotives.length > 0 && (
                <>
                  Supports tags:{' '}
                  <code style={{ fontSize: 11 }}>
                    {currentEngine.supportedEmotives.slice(0, 6).map((t) => `[${t}]`).join(' ')}
                    {currentEngine.supportedEmotives.length > 6 ? ' …' : ''}
                  </code>
                </>
              )}
            </div>
            <button
              className="btn--accent"
              disabled={!canGenerate}
              onClick={() => generateMutation.mutate()}
              style={{ padding: '10px 18px', fontSize: 14 }}
            >
              {generateMutation.isPending ? 'Generating…' : 'Generate'}
            </button>
          </div>

          {error && (
            <p style={{ color: 'var(--danger)', fontSize: 13, margin: 0 }}>{error}</p>
          )}
        </section>
      )}

      {clips.length > 0 && (
        <section style={{ marginTop: 28 }}>
          <h2 style={{ fontSize: 14, textTransform: 'uppercase', letterSpacing: 0.6, color: 'var(--fg-muted)', margin: '0 0 12px' }}>
            Recent
          </h2>
          <div style={{ display: 'grid', gap: 10 }}>
            {clips.map((clip) => (
              <ClipCard
                key={clip.id}
                clip={clip}
                isLatest={clip.id === latestId}
                onDelete={() => removeMutation.mutate(clip.id)}
                deleting={removeMutation.isPending && removeMutation.variables === clip.id}
              />
            ))}
          </div>
        </section>
      )}
    </main>
  );
}

const selectStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  fontSize: 13,
  background: 'var(--bg)',
  color: 'var(--fg)',
  border: '1px solid var(--border)',
  borderRadius: 6,
};

function Field({
  label,
  children,
  tone = 'muted',
}: {
  label: string;
  children: React.ReactNode;
  tone?: 'muted' | 'danger';
}) {
  return (
    <label style={{ display: 'block' }}>
      <span
        style={{
          display: 'block',
          fontSize: 11,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: 0.6,
          color: tone === 'danger' ? 'var(--danger)' : 'var(--fg-muted)',
          marginBottom: 6,
        }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}

function ClipCard({
  clip,
  isLatest,
  onDelete,
  deleting,
}: {
  clip: TtsScratchClip;
  isLatest: boolean;
  onDelete: () => void;
  deleting: boolean;
}) {
  const audioUrl = ttsApi.scratch.audioUrl(clip.id);
  const downloadName = `tts-${clip.id}.${clip.format}`;
  const preview = clip.text.length > 140 ? `${clip.text.slice(0, 140)}…` : clip.text;

  return (
    <div
      style={{
        background: 'var(--bg-elev)',
        border: `1px solid ${isLatest ? 'var(--accent)' : 'var(--border)'}`,
        borderRadius: 8,
        padding: 14,
        display: 'grid',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg)' }}>
            {clip.engine} · {clip.voice}
          </span>
          <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
            {formatDuration(clip.durationSec)} · {clip.speed.toFixed(2)}× · {formatRelative(clip.createdAt)}
          </span>
          {isLatest && (
            <span style={{ fontSize: 10, color: 'var(--accent)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.6 }}>
              Latest
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <a
            href={audioUrl}
            download={downloadName}
            style={{
              padding: '4px 10px',
              fontSize: 12,
              color: 'var(--fg)',
              background: 'var(--bg-elev2)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              textDecoration: 'none',
            }}
          >
            Download
          </a>
          <button
            onClick={onDelete}
            disabled={deleting}
            style={{
              padding: '4px 10px',
              fontSize: 12,
              color: 'var(--fg-muted)',
              background: 'transparent',
              border: '1px solid var(--border)',
              borderRadius: 6,
            }}
          >
            {deleting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
      <p style={{ margin: 0, fontSize: 13, color: 'var(--fg-muted)', lineHeight: 1.5 }}>{preview}</p>
      <audio
        controls
        preload="none"
        src={audioUrl}
        style={{ width: '100%', height: 36 }}
      />
    </div>
  );
}
