import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { recordingsApi, narrationApi, overlayApi } from '../lib/api.js';
import type { Scene } from '@vpa/shared';

/**
 * Scene preview — combines the recording video with chunked narration audio
 * and DOM-rendered lower thirds, driven by a single play/pause control. No
 * server-side render needed.
 *
 * The video's currentTime is the master clock:
 *   - The right narration chunk is selected and sought to (currentTime - offset)
 *   - Lower thirds appear when currentTime ∈ [in_sec, out_sec)
 *   - On play/pause, both `<video>` and `<audio>` move together
 */
interface Props {
  projectId: string;
  scene: Scene;
  /**
   * Per-chunk durations + indices for sequencing the narration audio. Must
   * match the order/index of the chunks the server has rendered audio for.
   */
  chunks: Array<{ index: number; durationSec: number | null; hasAudio: boolean }>;
}

export function ScenePreview({ projectId, scene, chunks }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  const [currentTime, setCurrentTime] = useState(0);
  const [hasError, setHasError] = useState<string | null>(null);

  // Resolved LT palette — matches what the ffmpeg renderer will produce.
  const paletteQuery = useQuery({
    queryKey: ['lt-colors', projectId],
    queryFn: () => overlayApi.colors(projectId),
    staleTime: 60_000,
  });
  const palette = paletteQuery.data ?? {
    accent: '#0EA5E9',
    textColor: '#FFFFFF',
    bgColor: '#000000',
    source: 'default' as const,
  };

  // Pre-compute cumulative audio offsets:
  //   offsets[i] = wall-clock time at which chunk i should START
  // We only count chunks with audio + a duration; un-rendered chunks contribute 0
  // (so the next chunk lines up immediately, which is closest to "no audio for that paragraph").
  const offsets = useMemo(() => {
    const out: number[] = [];
    let acc = 0;
    for (const c of chunks) {
      out.push(acc);
      const d = c.hasAudio && c.durationSec ? c.durationSec : 0;
      acc += d;
    }
    return out;
  }, [chunks]);

  /** Find the chunk index that should be playing at time t (or -1 if none). */
  function chunkAtTime(t: number): number {
    if (chunks.length === 0) return -1;
    let last = -1;
    for (let i = 0; i < chunks.length; i++) {
      if (offsets[i]! <= t && chunks[i]!.hasAudio) {
        const end = i + 1 < offsets.length ? offsets[i + 1]! : offsets[i]! + (chunks[i]!.durationSec ?? 0);
        if (t < end) last = i;
      }
    }
    return last;
  }

  // Track which chunk is currently loaded into the <audio> element so we don't
  // restart it on every timeupdate.
  const loadedChunkRef = useRef<number>(-1);

  function syncAudioToVideo(t: number, isPlaying: boolean) {
    const audio = audioRef.current;
    if (!audio) return;
    const idx = chunkAtTime(t);
    if (idx < 0) {
      // Out of bounds — pause and clear
      if (!audio.paused) audio.pause();
      loadedChunkRef.current = -1;
      return;
    }
    const offset = offsets[idx]!;
    const localTime = t - offset;
    if (loadedChunkRef.current !== idx) {
      audio.src = narrationApi.chunkAudioUrl(projectId, scene.id, chunks[idx]!.index);
      loadedChunkRef.current = idx;
      // After src changes we need a small wait for metadata before seeking
      const onLoaded = () => {
        audio.currentTime = Math.max(0, Math.min(localTime, audio.duration || 0));
        if (isPlaying) void audio.play().catch(() => { /* ignore play() race */ });
        audio.removeEventListener('loadedmetadata', onLoaded);
      };
      audio.addEventListener('loadedmetadata', onLoaded);
    } else {
      // Same chunk — only resync if drift > 0.25 s (ignore normal playback drift)
      if (Math.abs(audio.currentTime - localTime) > 0.25) {
        audio.currentTime = localTime;
      }
      if (isPlaying && audio.paused) void audio.play().catch(() => { /* ignore */ });
      else if (!isPlaying && !audio.paused) audio.pause();
    }
  }

  // Video event handlers ──────────────────────────────────────────────
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => {
      setCurrentTime(v.currentTime);
      syncAudioToVideo(v.currentTime, !v.paused);
    };
    const onPlay = () => syncAudioToVideo(v.currentTime, true);
    const onPause = () => syncAudioToVideo(v.currentTime, false);
    const onSeeked = () => syncAudioToVideo(v.currentTime, !v.paused);
    const onError = () => setHasError('Failed to load recording.');
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('seeked', onSeeked);
    v.addEventListener('error', onError);
    return () => {
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('seeked', onSeeked);
      v.removeEventListener('error', onError);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chunks, projectId, scene.id]);

  // Visible lower thirds based on currentTime
  const visibleLTs = (scene.lower_thirds ?? []).filter((lt) =>
    currentTime >= lt.in_sec && currentTime < lt.out_sec,
  );

  const hasRecording = !!scene.recording?.source;
  const audioChunks = chunks.filter((c) => c.hasAudio);

  if (!hasRecording) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: 'var(--fg-muted)', border: '1px dashed var(--border)', borderRadius: 8 }}>
        <p style={{ fontSize: 14, margin: 0 }}>No recording uploaded for this scene yet.</p>
        <p style={{ fontSize: 12, marginTop: 6 }}>Upload one in the Recording tab to enable preview.</p>
      </div>
    );
  }

  return (
    <div>
      <div
        style={{
          position: 'relative',
          background: '#000',
          borderRadius: 8,
          overflow: 'hidden',
          aspectRatio: '16 / 9',
          maxWidth: 960,
        }}
      >
        <video
          ref={videoRef}
          src={recordingsApi.videoUrl(projectId, scene.id)}
          controls
          muted
          playsInline
          preload="metadata"
          style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#000' }}
        />

        {/* Lower thirds overlay layer */}
        <div
          aria-hidden
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            top: 0,
            pointerEvents: 'none',
            padding: '0 0 56px 0', // leave space for the native video controls
          }}
        >
          {visibleLTs.map((lt, i) => (
            <LowerThirdOverlay key={`${lt.title}-${i}`} lt={lt} palette={palette} />
          ))}
        </div>
      </div>

      <audio ref={audioRef} preload="metadata" />

      {hasError && (
        <p style={{ color: 'var(--danger)', fontSize: 13, marginTop: 8 }}>{hasError}</p>
      )}

      <p style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 8 }}>
        Preview — recording's audio is muted; narration plays from the chunk audio you've generated.
        {audioChunks.length === 0 && ' (No narration chunks generated yet — only video plays.)'}
      </p>
    </div>
  );
}

/** Convert #RRGGBB into an rgba(...) string at the given alpha. */
function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9A-Fa-f]{6})$/.exec(hex);
  if (!m) return `rgba(0, 0, 0, ${alpha})`;
  const v = m[1]!;
  const r = Number.parseInt(v.slice(0, 2), 16);
  const g = Number.parseInt(v.slice(2, 4), 16);
  const b = Number.parseInt(v.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

interface PaletteShape {
  accent: string;
  textColor: string;
  bgColor: string;
}

function LowerThirdOverlay({
  lt,
  palette,
}: {
  lt: { title: string; subtitle?: string; style: 'frosted' | 'solid' | 'minimal' };
  palette: PaletteShape;
}) {
  // Opacity table mirrors the ffmpeg renderer so Preview and rendered output
  // have matching contrast.
  const bgOpacity =
    lt.style === 'solid' ? 0.88 :
    lt.style === 'minimal' ? 0.40 :
    /* frosted */ 0.62;
  const containerBg = hexToRgba(palette.bgColor, bgOpacity);
  // Subtitle is muted relative to title when the brand text is white.
  // For dark brand text colors, keep the subtitle at the same color.
  const subtitleColor =
    palette.textColor.toUpperCase() === '#FFFFFF' ? '#E0E0E0' : palette.textColor;
  return (
    <div
      style={{
        position: 'absolute',
        left: '4%',
        bottom: '6%',
        display: 'inline-block',
        color: palette.textColor,
        background: containerBg,
        backdropFilter: lt.style === 'frosted' ? 'blur(4px)' : 'none',
        WebkitBackdropFilter: lt.style === 'frosted' ? 'blur(4px)' : 'none',
        borderLeft: `4px solid ${palette.accent}`,
        padding: '10px 16px 10px 14px',
      }}
    >
      <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.2, textShadow: '0 2px 4px rgba(0, 0, 0, 0.7)' }}>
        {lt.title}
      </div>
      {lt.subtitle && (
        <div
          style={{
            fontSize: 14,
            marginTop: 4,
            color: subtitleColor,
            textShadow: '0 2px 4px rgba(0, 0, 0, 0.7)',
          }}
        >
          {lt.subtitle}
        </div>
      )}
    </div>
  );
}
