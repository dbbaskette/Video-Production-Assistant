import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BrowserCaptureSession, Scene } from '@vpa/shared';
import { browserCaptureApi } from '../lib/api.js';
import {
  attachCaptureEndedHandler,
  prepareBrowserCapture,
  releaseCapture,
  type PreparedBrowserCapture,
} from '../lib/browser-capture.js';

type CaptureState = 'idle' | 'preflight' | 'countdown' | 'recording' | 'finishing';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function MediaPreview({ stream, label }: { stream?: MediaStream; label: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream ?? null;
  }, [stream]);
  if (!stream) return null;
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ color: 'var(--fg-muted)', fontSize: 11, marginBottom: 5 }}>{label}</div>
      <video ref={ref} autoPlay playsInline muted style={{ width: '100%', maxHeight: 150, objectFit: 'cover', borderRadius: 8, background: '#090b10' }} />
    </div>
  );
}

function useAudioLevel(stream?: MediaStream): number {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (!stream || stream.getAudioTracks().length === 0 || typeof AudioContext === 'undefined') return;
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Uint8Array(analyser.frequencyBinCount);
    let frame = 0;
    const update = () => {
      analyser.getByteTimeDomainData(samples);
      const peak = samples.reduce((value, sample) => Math.max(value, Math.abs(sample - 128)), 0) / 128;
      setLevel(Math.min(1, peak * 2.5));
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => {
      cancelAnimationFrame(frame);
      void context.close();
    };
  }, [stream]);
  return level;
}

export function BrowserCapturePanel({ projectId, scenes }: { projectId: string; scenes: Scene[] }) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [sceneId, setSceneId] = useState(scenes[0]?.id ?? '');
  const [microphone, setMicrophone] = useState(true);
  const [camera, setCamera] = useState(false);
  const [state, setState] = useState<CaptureState>('idle');
  const [prepared, setPrepared] = useState<PreparedBrowserCapture | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [acknowledged, setAcknowledged] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const preparedRef = useRef<PreparedBrowserCapture | null>(null);
  const sessionRef = useRef<BrowserCaptureSession | null>(null);
  const recordersRef = useRef<MediaRecorder[]>([]);
  const queuesRef = useRef(new Map<string, Promise<unknown>>());
  const uploadErrorRef = useRef<unknown>(null);
  const stoppingRef = useRef(false);
  const elapsedTimerRef = useRef<number | null>(null);
  const maxTimerRef = useRef<number | null>(null);
  const removeEndedRef = useRef<(() => void) | null>(null);
  const microphoneStream = prepared?.tracks.find((track) => track.role === 'microphone')?.stream;
  const microphoneLevel = useAudioLevel(microphoneStream);

  useEffect(() => {
    if (!sceneId && scenes[0]) setSceneId(scenes[0].id);
  }, [sceneId, scenes]);

  const sessionsQuery = useQuery({
    queryKey: ['browser-captures', projectId],
    queryFn: () => browserCaptureApi.list(projectId),
    enabled: expanded,
    refetchInterval: state === 'recording' ? 5_000 : false,
  });

  const incomplete = useMemo(
    () => (sessionsQuery.data ?? []).filter((session) => ['incomplete', 'failed', 'recording'].includes(session.status)),
    [sessionsQuery.data],
  );

  const clearTimers = () => {
    if (elapsedTimerRef.current != null) window.clearInterval(elapsedTimerRef.current);
    if (maxTimerRef.current != null) window.clearTimeout(maxTimerRef.current);
    elapsedTimerRef.current = null;
    maxTimerRef.current = null;
  };

  const cleanupStreams = () => {
    clearTimers();
    removeEndedRef.current?.();
    removeEndedRef.current = null;
    releaseCapture(preparedRef.current);
    preparedRef.current = null;
    setPrepared(null);
    recordersRef.current = [];
  };

  const stopRecorders = async () => {
    const waits = recordersRef.current.map((recorder) => new Promise<void>((resolve) => {
      if (recorder.state === 'inactive') return resolve();
      recorder.addEventListener('stop', () => resolve(), { once: true });
      recorder.stop();
    }));
    await Promise.all(waits);
    await Promise.allSettled([...queuesRef.current.values()]);
  };

  const finishCapture = async (complete: boolean, reason?: string) => {
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    setState('finishing');
    clearTimers();
    try {
      await stopRecorders();
      const session = sessionRef.current;
      if (session) {
        if (complete && !uploadErrorRef.current) {
          await browserCaptureApi.complete(projectId, session.id);
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: ['browser-captures', projectId] }),
            queryClient.invalidateQueries({ queryKey: ['assets', projectId] }),
            queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] }),
            queryClient.invalidateQueries({ queryKey: ['revision', projectId] }),
          ]);
        } else {
          await browserCaptureApi.incomplete(projectId, session.id).catch(() => undefined);
          queryClient.invalidateQueries({ queryKey: ['browser-captures', projectId] });
          if (reason) setError(reason);
        }
      }
    } catch (captureError) {
      if (sessionRef.current) await browserCaptureApi.incomplete(projectId, sessionRef.current.id).catch(() => undefined);
      setError(captureError instanceof Error ? captureError.message : 'Capture could not be finalized. The uploaded chunks were preserved.');
    } finally {
      cleanupStreams();
      sessionRef.current = null;
      queuesRef.current.clear();
      uploadErrorRef.current = null;
      stoppingRef.current = false;
      setElapsed(0);
      setAcknowledged(0);
      setCountdown(null);
      setState('idle');
    }
  };

  useEffect(() => () => {
    clearTimers();
    for (const recorder of recordersRef.current) {
      if (recorder.state !== 'inactive') recorder.stop();
    }
    releaseCapture(preparedRef.current);
    const session = sessionRef.current;
    if (session) void browserCaptureApi.incomplete(projectId, session.id).catch(() => undefined);
  }, [projectId]);

  const prepare = async () => {
    setError(null);
    try {
      const next = await prepareBrowserCapture({ microphone, camera });
      preparedRef.current = next;
      setPrepared(next);
      setState('preflight');
    } catch (captureError) {
      setError(captureError instanceof Error ? captureError.message : 'Capture permissions could not be opened.');
      cleanupStreams();
      setState('idle');
    }
  };

  const start = async () => {
    if (!preparedRef.current || !sceneId) return;
    setError(null);
    setState('countdown');
    try {
      for (const count of [3, 2, 1]) {
        setCountdown(count);
        await delay(1_000);
      }
      const commonClockOriginMs = Math.round(performance.timeOrigin + performance.now());
      const session = await browserCaptureApi.create(projectId, {
        sceneId,
        commonClockOriginMs,
        tracks: preparedRef.current.tracks.map((track) => ({
          id: track.id,
          role: track.role,
          kind: track.kind,
          mimeType: track.mimeType,
          timingOriginMs: 0,
          sharedAudioAvailable: track.sharedAudioAvailable,
        })),
      });
      sessionRef.current = session;
      queuesRef.current.clear();
      uploadErrorRef.current = null;
      const recorders = preparedRef.current.tracks.map((track) => {
        let sequence = 0;
        const recorder = new MediaRecorder(track.stream, { mimeType: track.mimeType, videoBitsPerSecond: track.kind === 'video' ? 5_000_000 : undefined, audioBitsPerSecond: track.kind === 'audio' ? 128_000 : undefined });
        queuesRef.current.set(track.id, Promise.resolve());
        recorder.addEventListener('dataavailable', (event) => {
          if (event.data.size === 0) return;
          const currentSequence = sequence++;
          const queue = (queuesRef.current.get(track.id) ?? Promise.resolve())
            .then(() => browserCaptureApi.appendChunk(projectId, session.id, track.id, currentSequence, event.data))
            .then(() => setAcknowledged((value) => value + 1))
            .catch((uploadError) => {
              uploadErrorRef.current = uploadError;
              void finishCapture(false, 'The server stopped acknowledging capture chunks. The acknowledged chunks were preserved.');
            });
          queuesRef.current.set(track.id, queue);
        });
        recorder.addEventListener('error', () => void finishCapture(false, 'A browser recorder failed. The acknowledged chunks were preserved.'), { once: true });
        recorder.start(2_000);
        return recorder;
      });
      recordersRef.current = recorders;
      removeEndedRef.current = attachCaptureEndedHandler(preparedRef.current, () => void finishCapture(false, 'A capture device or shared source ended. The acknowledged chunks were preserved.'));
      setCountdown(null);
      setState('recording');
      const started = Date.now();
      elapsedTimerRef.current = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1_000)), 250);
      maxTimerRef.current = window.setTimeout(() => void finishCapture(true), 20 * 60 * 1_000);
    } catch (captureError) {
      setError(captureError instanceof Error ? captureError.message : 'Capture could not start.');
      if (sessionRef.current) await browserCaptureApi.incomplete(projectId, sessionRef.current.id).catch(() => undefined);
      cleanupStreams();
      sessionRef.current = null;
      setCountdown(null);
      setState('idle');
    }
  };

  const recoverMutation = useMutation({
    mutationFn: (sessionId: string) => browserCaptureApi.complete(projectId, sessionId),
    onSuccess: () => Promise.all([
      queryClient.invalidateQueries({ queryKey: ['browser-captures', projectId] }),
      queryClient.invalidateQueries({ queryKey: ['assets', projectId] }),
      queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] }),
      queryClient.invalidateQueries({ queryKey: ['revision', projectId] }),
    ]),
  });

  return (
    <section style={{ marginTop: 16, border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', background: 'var(--bg-elev)' }}>
      <button type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} style={{ width: '100%', border: 0, background: 'transparent', color: 'var(--fg)', cursor: 'pointer', padding: '14px 16px', display: 'flex', justifyContent: 'space-between', textAlign: 'left' }}>
        <span><strong>Record in browser</strong><span style={{ display: 'block', fontSize: 12, color: 'var(--fg-muted)', marginTop: 3 }}>Screen plus optional microphone and camera, saved as independent recoverable tracks.</span></span>
        <span style={{ color: 'var(--fg-muted)', fontSize: 12 }}>{expanded ? '▲' : '▼'}</span>
      </button>
      {expanded && (
        <div style={{ borderTop: '1px solid var(--border)', padding: 16 }}>
          {scenes.length === 0 ? <p style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Create a storyboard scene before recording in the browser.</p> : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 1fr) auto auto', gap: 12, alignItems: 'center' }}>
                <select aria-label="Capture scene" value={sceneId} disabled={state !== 'idle'} onChange={(event) => setSceneId(event.target.value)} style={{ padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)', color: 'var(--fg)' }}>
                  {scenes.map((scene) => <option key={scene.id} value={scene.id}>{scene.name}</option>)}
                </select>
                <label style={{ fontSize: 12 }}><input type="checkbox" checked={microphone} disabled={state !== 'idle'} onChange={(event) => setMicrophone(event.target.checked)} /> Microphone</label>
                <label style={{ fontSize: 12 }}><input type="checkbox" checked={camera} disabled={state !== 'idle'} onChange={(event) => setCamera(event.target.checked)} /> Camera</label>
              </div>

              {state === 'idle' && <button className="primary" style={{ marginTop: 12 }} onClick={() => void prepare()}>Prepare capture</button>}
              {prepared && ['preflight', 'countdown'].includes(state) && (
                <div style={{ marginTop: 14 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: prepared.userStream?.getVideoTracks().length ? '1fr 1fr' : '1fr', gap: 10 }}>
                    <MediaPreview stream={prepared.displayStream} label="Shared screen" />
                    <MediaPreview stream={prepared.tracks.find((track) => track.role === 'camera')?.stream} label="Camera" />
                  </div>
                  <div style={{ marginTop: 10, fontSize: 12, color: 'var(--fg-muted)' }}>
                    Shared audio: <strong style={{ color: prepared.sharedAudioAvailable ? 'var(--success)' : 'var(--fg)' }}>{prepared.sharedAudioAvailable ? 'available' : 'not supplied by the browser'}</strong>
                    {microphoneStream && <> · Microphone level <span aria-label="Microphone level" style={{ display: 'inline-block', width: 80, height: 6, marginLeft: 4, background: 'var(--border)', borderRadius: 6, verticalAlign: 'middle' }}><span style={{ display: 'block', width: `${Math.round(microphoneLevel * 100)}%`, height: '100%', borderRadius: 6, background: 'var(--success)' }} /></span></>}
                  </div>
                  {state === 'preflight' ? (
                    <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                      <button className="primary" onClick={() => void start()}>Start recording</button>
                      <button onClick={() => { cleanupStreams(); setState('idle'); }}>Cancel</button>
                    </div>
                  ) : <div style={{ marginTop: 12, fontSize: 28, fontWeight: 700 }}>Recording starts in {countdown}…</div>}
                </div>
              )}

              {state === 'recording' && (
                <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--danger)' }} />
                  <strong>{formatElapsed(elapsed)}</strong>
                  <span style={{ color: 'var(--fg-muted)', fontSize: 12 }}>{acknowledged} chunks saved</span>
                  <button className="primary" onClick={() => void finishCapture(true)}>Stop and save</button>
                  <button onClick={() => void finishCapture(false, 'Recording stopped before completion. The acknowledged chunks were preserved.')}>Stop as incomplete</button>
                </div>
              )}
              {state === 'finishing' && <p style={{ fontSize: 13, color: 'var(--fg-muted)' }}>Validating and adding tracks to the source tray…</p>}
            </>
          )}

          {error && <p role="alert" style={{ color: 'var(--danger)', fontSize: 12 }}>{error}</p>}
          {incomplete.length > 0 && (
            <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
              <div style={{ fontSize: 12, fontWeight: 600 }}>Recoverable takes</div>
              {incomplete.map((session) => (
                <div key={session.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginTop: 8, fontSize: 12 }}>
                  <span>{session.status === 'recording' ? 'Interrupted' : session.status} · {session.tracks.reduce((sum, track) => sum + track.chunks, 0)} chunks · {new Date(session.created_at).toLocaleString()}</span>
                  <button disabled={recoverMutation.isPending} onClick={() => recoverMutation.mutate(session.id)}>Recover uploaded tracks</button>
                </div>
              ))}
              {recoverMutation.error && <p role="alert" style={{ color: 'var(--danger)', fontSize: 12 }}>{recoverMutation.error instanceof Error ? recoverMutation.error.message : 'Recovery failed.'}</p>}
            </div>
          )}
          <p style={{ marginBottom: 0, color: 'var(--fg-dim)', fontSize: 11 }}>Desktop Chrome/Edge · macOS/Windows · up to 1080p/30 fps · 20-minute maximum. Browser and OS controls determine whether shared audio is available.</p>
        </div>
      )}
    </section>
  );
}
