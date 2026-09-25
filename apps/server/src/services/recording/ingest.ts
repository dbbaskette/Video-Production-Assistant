import { loadStoryboard, mutateStoryboard, updateScene } from '../storyboard/index.js';
import type { VideoMetadata } from './metadata.js';
import type { RecordingProvenance } from '@vpa/shared';
import { AssetStore } from '../assets/store.js';

export interface IngestResult {
  sceneId: string;
  relativePath: string;
  metadata: VideoMetadata;
  assetId?: string;
}

export async function ingestRecording(
  projectRoot: string,
  sceneId: string,
  sourcePath: string,
  metadata: VideoMetadata,
  provenance: RecordingProvenance = { source_kind: 'manual' },
): Promise<IngestResult> {
  const assets = new AssetStore(projectRoot, { probe: async () => metadata });
  const asset = await assets.importFile(sourcePath, {
    originalName: `${sceneId}.mp4`,
    sourceRole: 'screen',
    captureSessionId: provenance.capture_session_id,
    validatedVideoMetadata: metadata,
  });
  const relativePath = asset.source;

  // Update storyboard with recording info. We ALSO clear the cached render
  // artifacts (`overlay_render`, `frame_render`) — both are baked from the
  // recording's pixels, so a new upload invalidates them. Without this, the
  // next project-level render would happily reuse the stale baked files
  // (which still exist on disk under the old filenames) and the user would
  // see their previous recording in the final video. The next render's
  // bake-on-demand step will regenerate fresh files from the new recording.
  if (await loadStoryboard(projectRoot)) {
    await mutateStoryboard(projectRoot, (sb) => updateScene(sb!, sceneId, {
      recording: {
        source: relativePath,
        asset_id: asset.id,
        duration_sec: metadata.duration_sec,
        ingested_at: new Date().toISOString(),
        source_kind: provenance.source_kind,
        capture_session_id: provenance.capture_session_id,
        captured_at: provenance.captured_at,
        source_role: 'screen',
        timing_origin_ms: asset.timing_origin_ms,
      },
      overlay_render: undefined,
      frame_render: undefined,
    }));
  }

  return { sceneId, relativePath, metadata, assetId: asset.id };
}
