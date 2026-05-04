import { useEffect, useRef, useState } from 'react';

interface Props {
  /** Maximum recording length in seconds. xAI's hard limit is 120; default to 110 to leave a safety margin. */
  maxSeconds?: number;
  /** Called once the user clicks "Use this take" — receives the recorded blob. */
  onComplete: (blob: Blob, mime: string) => void;
}

type Phase = 'idle' | 'requesting' | 'recording' | 'preview' | 'error';

/**
 * Browser-native voice recorder using `navigator.mediaDevices.getUserMedia` +
 * `MediaRecorder`. Produces a WebM/Opus blob (or whatever the browser picks);
 * the server transcodes to canonical 24 kHz mono WAV via ffmpeg.
 */
export function VoiceRecorder({ maxSeconds = 110, onComplete }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [mime, setMime] = useState<string>('audio/webm');

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const tickRef = useRef<number | null>(null);
  const objectUrl = blob ? URL.createObjectURL(blob) : null;

  useEffect(() => {
    return () => {
      // Cleanup: stop any active stream/recorder + release object URLs
      mediaRecorderRef.current?.stop();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (tickRef.current) window.clearInterval(tickRef.current);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function start() {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
      setPhase('error');
      setError('Browser does not support microphone recording.');
      return;
    }
    setError(null);
    setPhase('requesting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      // Pick a supported MIME — preferred order
      const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
      let chosenMime = '';
      for (const c of candidates) {
        if (typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(c)) {
          chosenMime = c;
          break;
        }
      }
      const recorder = chosenMime ? new MediaRecorder(stream, { mimeType: chosenMime }) : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];
      setMime(chosenMime || 'audio/webm');
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const finalBlob = new Blob(chunksRef.current, { type: chosenMime || 'audio/webm' });
        setBlob(finalBlob);
        setPhase('preview');
        if (tickRef.current) {
          window.clearInterval(tickRef.current);
          tickRef.current = null;
        }
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      };
      recorder.start();
      setPhase('recording');
      setElapsed(0);
      tickRef.current = window.setInterval(() => {
        setElapsed((prev) => {
          const next = prev + 1;
          if (next >= maxSeconds) stop();
          return next;
        });
      }, 1000);
    } catch (err) {
      setPhase('error');
      setError(err instanceof Error ? err.message : 'Microphone access denied.');
    }
  }

  function stop() {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
  }

  function reset() {
    setBlob(null);
    setElapsed(0);
    setError(null);
    setPhase('idle');
    chunksRef.current = [];
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }

  function commit() {
    if (blob) onComplete(blob, mime);
  }

  const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(1, '0')}:${String(s % 60).padStart(2, '0')}`;

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 16, background: 'var(--bg-elev)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        {phase === 'idle' && (
          <button onClick={start} className="btn--accent" style={{ padding: '8px 16px', fontSize: 14 }}>
            ● Start Recording
          </button>
        )}
        {phase === 'requesting' && <span style={{ fontSize: 13, color: 'var(--fg-muted)' }}>Requesting microphone…</span>}
        {phase === 'recording' && (
          <>
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 14, fontWeight: 600,
              color: 'var(--danger)',
            }}>
              <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: 'var(--danger)', animation: 'pulse 1s infinite' }} />
              REC {fmt(elapsed)} / {fmt(maxSeconds)}
            </span>
            <button onClick={stop} style={{ padding: '8px 16px', fontSize: 14 }}>
              ■ Stop
            </button>
          </>
        )}
        {phase === 'preview' && objectUrl && (
          <>
            <audio src={objectUrl} controls style={{ flex: 1, minWidth: 240 }} />
            <button onClick={commit} className="btn--accent" style={{ padding: '8px 16px', fontSize: 14 }}>
              Use this take
            </button>
            <button onClick={reset} style={{ padding: '8px 16px', fontSize: 14 }}>
              Re-record
            </button>
          </>
        )}
        {phase === 'error' && (
          <>
            <span style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</span>
            <button onClick={reset} style={{ padding: '8px 16px', fontSize: 14 }}>Try again</button>
          </>
        )}
      </div>
      <p style={{ margin: '10px 0 0', fontSize: 11, color: 'var(--fg-muted)' }}>
        Recordings are saved as WAV (24 kHz mono) on the server. Max {maxSeconds}s — xAI accepts up to 120s.
      </p>
    </div>
  );
}
