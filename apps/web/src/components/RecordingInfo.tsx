import type { PresentationSource, Recording, SceneType } from '@vpa/shared';

interface VideoMeta {
  duration_sec: number;
  width: number;
  height: number;
  codec: string;
  fps: number;
  size_bytes: number;
}

interface RecordingInfoProps {
  source: string;
  duration_sec?: number;
  ingested_at?: string;
  metadata?: VideoMeta | null;
  source_kind?: Recording['source_kind'];
  scene_type?: SceneType;
  presentation_source?: Pick<PresentationSource, 'hold_duration_sec'>;
  has_narration_audio?: boolean;
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

interface RecordingDurationLabelInput {
  durationSec?: number;
  sourceKind?: Recording['source_kind'];
  sceneType?: SceneType;
  presentationSource?: Pick<PresentationSource, 'hold_duration_sec'>;
  hasNarrationAudio: boolean;
}

export function resolveRecordingDurationLabel(input: RecordingDurationLabelInput): string | null {
  const isPresentation = input.sourceKind === 'presentation'
    && input.sceneType === 'slide'
    && input.presentationSource !== undefined;
  if (isPresentation) {
    return input.hasNarrationAudio
      ? 'Narration sets final length'
      : `${formatDuration(input.presentationSource!.hold_duration_sec)} hold without narration`;
  }
  return input.durationSec === undefined ? null : formatDuration(input.durationSec);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function RecordingInfo({
  source,
  duration_sec,
  ingested_at,
  metadata,
  source_kind,
  scene_type,
  presentation_source,
  has_narration_audio = false,
}: RecordingInfoProps) {
  const durationLabel = resolveRecordingDurationLabel({
    durationSec: duration_sec,
    sourceKind: source_kind,
    sceneType: scene_type,
    presentationSource: presentation_source,
    hasNarrationAudio: has_narration_audio,
  });
  return (
    <div
      style={{
        background: 'var(--bg-elev)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 16,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 18 }}>📹</span>
        <span style={{ fontWeight: 600, fontSize: 14 }}>{source}</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 12 }}>
        {durationLabel != null && (
          <MetaItem label="Duration" value={durationLabel} />
        )}
        {metadata && (
          <>
            <MetaItem label="Resolution" value={`${metadata.width}×${metadata.height}`} />
            <MetaItem label="Codec" value={metadata.codec.toUpperCase()} />
            <MetaItem label="FPS" value={String(metadata.fps)} />
            <MetaItem label="File Size" value={formatBytes(metadata.size_bytes)} />
          </>
        )}
        {ingested_at && (
          <MetaItem
            label="Ingested"
            value={new Date(ingested_at).toLocaleDateString()}
          />
        )}
      </div>
    </div>
  );
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {label}
      </div>
      <div style={{ fontSize: 15, fontWeight: 600, marginTop: 2 }}>{value}</div>
    </div>
  );
}
