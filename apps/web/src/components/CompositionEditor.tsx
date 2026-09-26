import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AudioMixSettingsSchema,
  compositionDurationMs,
  effectiveMixSettings,
  type Asset,
  type AudioMixRole,
  type CompositionClip,
  type ProjectCommand,
  type Scene,
} from '@vpa/shared';
import { assetsApi, compositionApi, sceneRenderApi } from '../lib/api.js';

const MIX_ROLES: Array<{ role: AudioMixRole; label: string }> = [
  { role: 'original', label: 'Original recording' },
  { role: 'system-audio', label: 'Shared audio' },
  { role: 'microphone', label: 'Microphone' },
  { role: 'camera', label: 'Camera audio' },
  { role: 'narration', label: 'Narration' },
  { role: 'music', label: 'Music' },
];

function clipId(): string {
  return `clip_${crypto.randomUUID()}`;
}

function assetById(assets: Asset[]): Map<string, Asset> {
  return new Map(assets.map((asset) => [asset.id, asset]));
}

function initializeCommand(scene: Scene, assets: Asset[]): ProjectCommand | null {
  const byId = assetById(assets);
  const primaryId = scene.recording?.asset_id
    ?? scene.sources?.find((source) => ['screen', 'camera', 'image'].includes(source.role))?.asset_id;
  if (!primaryId) return null;
  const primary = byId.get(primaryId);
  const durationMs = Math.round((primary?.duration_sec ?? scene.recording?.duration_sec ?? 0) * 1_000);
  if (!primary || durationMs <= 0) return null;
  const primaryTiming = scene.sources?.find((source) => source.asset_id === primaryId)?.timing_origin_ms ?? 0;
  const linked = (scene.sources ?? [])
    .filter((source) => source.asset_id !== primaryId)
    .map((source) => ({ asset_id: source.asset_id, role: source.role, source_offset_ms: source.timing_origin_ms - primaryTiming }));
  const hasLinkedAudio = linked.some((track) => byId.get(track.asset_id)?.media_kind === 'audio');
  return {
    type: 'composition.set',
    sceneId: scene.id,
    composition: {
      version: 1,
      clips: [{
        id: clipId(),
        source_asset_id: primaryId,
        source_role: primary.media_kind === 'image' ? 'image' : primary.source_role === 'camera' ? 'camera' : 'screen',
        source_in_ms: 0,
        source_out_ms: durationMs,
        timeline_start_ms: 0,
        linked_tracks: linked,
      }],
      audio_mix: hasLinkedAudio
        ? { original: { gain_db: 0, mute: true, fade_in_ms: 0, fade_out_ms: 0 } }
        : {},
    },
  };
}

export function CompositionEditor({ projectId, scenes }: { projectId: string; scenes: Scene[] }) {
  const [expanded, setExpanded] = useState(false);
  const [activeScene, setActiveScene] = useState(scenes.find((scene) => scene.composition)?.id ?? scenes.find((scene) => scene.recording)?.id ?? '');
  const [preview, setPreview] = useState<{ sceneId: string; url: string } | null>(null);
  const queryClient = useQueryClient();
  const assetsQuery = useQuery({ queryKey: ['assets', projectId], queryFn: () => assetsApi.list(projectId), enabled: expanded });
  const revisionQuery = useQuery({ queryKey: ['revision', projectId], queryFn: () => assetsApi.currentRevision(projectId), enabled: expanded });
  const mutation = useMutation({
    mutationFn: (commands: ProjectCommand[]) => {
      if (revisionQuery.data == null) throw new Error('Project revision is unavailable.');
      return compositionApi.execute(projectId, revisionQuery.data, commands);
    },
    onSuccess: () => Promise.all([
      queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] }),
      queryClient.invalidateQueries({ queryKey: ['revision', projectId] }),
    ]),
  });
  const previewMutation = useMutation({
    mutationFn: async (sceneId: string) => {
      await sceneRenderApi.start(projectId, sceneId, { audioMode: 'mix', burnSubtitles: false });
      return {
        sceneId,
        url: `${sceneRenderApi.fileUrl(projectId, sceneId, 'combined', true)}&t=${Date.now()}`,
      };
    },
    onSuccess: setPreview,
  });
  const editableScenes = scenes.filter((scene) => scene.recording?.asset_id || scene.composition);
  const scene = editableScenes.find((candidate) => candidate.id === activeScene) ?? editableScenes[0];

  const execute = (command: ProjectCommand) => mutation.mutate([command]);
  return (
    <section style={{ marginTop: 16, border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', background: 'var(--bg-elev)' }}>
      <button type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} style={{ width: '100%', border: 0, background: 'transparent', color: 'var(--fg)', cursor: 'pointer', padding: '14px 16px', display: 'flex', justifyContent: 'space-between', textAlign: 'left' }}>
        <span><strong>Clip editor & audio mix</strong><span style={{ display: 'block', color: 'var(--fg-muted)', fontSize: 12, marginTop: 3 }}>Trim, split, reorder, and duplicate without changing source files.</span></span>
        <span style={{ color: 'var(--fg-muted)', fontSize: 12 }}>{expanded ? '▲' : '▼'}</span>
      </button>
      {expanded && (
        <div style={{ borderTop: '1px solid var(--border)', padding: 16 }}>
          {editableScenes.length === 0 ? <p style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Assign an immutable recording source to a scene first.</p> : scene && (
            <>
              <select aria-label="Composition scene" value={scene.id} onChange={(event) => setActiveScene(event.target.value)} style={{ minWidth: 240, padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)', color: 'var(--fg)' }}>
                {editableScenes.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
              </select>
              {!scene.composition ? (
                <div style={{ marginTop: 12 }}>
                  <button className="primary" disabled={mutation.isPending || !assetsQuery.data} onClick={() => {
                    const command = initializeCommand(scene, assetsQuery.data ?? []);
                    if (command) execute(command);
                  }}>Create editable composition</button>
                  <span style={{ marginLeft: 10, fontSize: 12, color: 'var(--fg-muted)' }}>Uses the current scene sources; source bytes stay immutable.</span>
                </div>
              ) : (
                <>
                  <div style={{ marginTop: 14, fontSize: 12, color: 'var(--fg-muted)' }}>Preview/export duration: {(compositionDurationMs(scene.composition) / 1_000).toFixed(2)}s · {scene.composition.clips.length} clip{scene.composition.clips.length === 1 ? '' : 's'}</div>
                  <div style={{ marginTop: 10 }}>
                    <button disabled={previewMutation.isPending || mutation.isPending} onClick={() => previewMutation.mutate(scene.id)}>
                      {previewMutation.isPending ? 'Rendering preview…' : 'Render preview'}
                    </button>
                    <span style={{ marginLeft: 8, color: 'var(--fg-muted)', fontSize: 11 }}>Uses the same combined render as scene export.</span>
                    {preview?.sceneId === scene.id && (
                      <video key={preview.url} controls preload="metadata" src={preview.url} style={{ display: 'block', width: '100%', maxHeight: 360, marginTop: 10, borderRadius: 8, background: '#090b10' }} />
                    )}
                  </div>
                  <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
                    {scene.composition.clips.map((clip, index) => (
                      <ClipRow key={clip.id} scene={scene} clip={clip} index={index} busy={mutation.isPending} execute={execute} />
                    ))}
                  </div>
                  <div style={{ marginTop: 18, fontSize: 12, fontWeight: 650 }}>Audio mix</div>
                  <div style={{ display: 'grid', gap: 7, marginTop: 8 }}>
                    {MIX_ROLES.map(({ role, label }) => (
                      <MixRow key={`${scene.id}-${role}`} scene={scene} role={role} label={label} busy={mutation.isPending} execute={execute} />
                    ))}
                  </div>
                </>
              )}
            </>
          )}
          {mutation.error && <p role="alert" style={{ color: 'var(--danger)', fontSize: 12 }}>{mutation.error instanceof Error ? mutation.error.message : 'Edit failed.'}</p>}
          {previewMutation.error && <p role="alert" style={{ color: 'var(--danger)', fontSize: 12 }}>{previewMutation.error instanceof Error ? previewMutation.error.message : 'Preview render failed.'}</p>}
        </div>
      )}
    </section>
  );
}

function ClipRow({ scene, clip, index, busy, execute }: { scene: Scene; clip: CompositionClip; index: number; busy: boolean; execute: (command: ProjectCommand) => void }) {
  const [inSec, setInSec] = useState(clip.source_in_ms / 1_000);
  const [outSec, setOutSec] = useState(clip.source_out_ms / 1_000);
  const clips = scene.composition!.clips;
  const move = (offset: number) => {
    const ids = clips.map((candidate) => candidate.id);
    const target = index + offset;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    execute({ type: 'clip.reorder', sceneId: scene.id, clipIds: ids });
  };
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 1fr) 80px 80px auto', gap: 8, alignItems: 'center', padding: 9, border: '1px solid var(--border)', borderRadius: 7, background: 'var(--surface)' }}>
      <div style={{ minWidth: 0 }}><strong style={{ fontSize: 12 }}>Clip {index + 1}</strong><div style={{ fontSize: 10, color: 'var(--fg-dim)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{clip.source_asset_id.slice(0, 18)}… · starts {(clip.timeline_start_ms / 1_000).toFixed(2)}s · {clip.linked_tracks.length} linked</div></div>
      <label style={{ fontSize: 10, color: 'var(--fg-muted)' }}>In (s)<input aria-label={`Clip ${index + 1} in`} type="number" min={0} step={0.1} value={inSec} onChange={(event) => setInSec(Number(event.target.value))} style={{ width: '100%' }} /></label>
      <label style={{ fontSize: 10, color: 'var(--fg-muted)' }}>Out (s)<input aria-label={`Clip ${index + 1} out`} type="number" min={0.001} step={0.1} value={outSec} onChange={(event) => setOutSec(Number(event.target.value))} style={{ width: '100%' }} /></label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
        <button disabled={busy} onClick={() => execute({ type: 'clip.trim', sceneId: scene.id, clipId: clip.id, sourceInMs: Math.round(inSec * 1_000), sourceOutMs: Math.round(outSec * 1_000) })}>Apply trim</button>
        <button disabled={busy || clip.source_out_ms - clip.source_in_ms < 2} onClick={() => execute({ type: 'clip.split', sceneId: scene.id, clipId: clip.id, splitSourceMs: Math.round((clip.source_in_ms + clip.source_out_ms) / 2), leftClipId: clipId(), rightClipId: clipId() })}>Split midpoint</button>
        <button disabled={busy} onClick={() => execute({ type: 'clip.duplicate', sceneId: scene.id, clipId: clip.id, newClipId: clipId() })}>Duplicate</button>
        <button disabled={busy || index === 0} onClick={() => move(-1)}>←</button>
        <button disabled={busy || index === clips.length - 1} onClick={() => move(1)}>→</button>
        <button disabled={busy || clips.length === 1} onClick={() => execute({ type: 'clip.delete', sceneId: scene.id, clipId: clip.id })}>Delete</button>
      </div>
    </div>
  );
}

function MixRow({ scene, role, label, busy, execute }: { scene: Scene; role: AudioMixRole; label: string; busy: boolean; execute: (command: ProjectCommand) => void }) {
  const initial = effectiveMixSettings(scene.composition!, role);
  const [gain, setGain] = useState(initial.gain_db);
  const [mute, setMute] = useState(initial.mute);
  const [fadeIn, setFadeIn] = useState(initial.fade_in_ms / 1_000);
  const [fadeOut, setFadeOut] = useState(initial.fade_out_ms / 1_000);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '130px 80px 70px 80px 80px auto', gap: 8, alignItems: 'end', fontSize: 11 }}>
      <span style={{ paddingBottom: 5 }}>{label}</span>
      <label>Gain dB<input aria-label={`${label} gain`} type="number" min={-60} max={12} step={1} value={gain} onChange={(event) => setGain(Number(event.target.value))} style={{ width: '100%' }} /></label>
      <label style={{ paddingBottom: 5 }}><input type="checkbox" checked={mute} onChange={(event) => setMute(event.target.checked)} /> Mute</label>
      <label>Fade in<input type="number" min={0} max={30} step={0.1} value={fadeIn} onChange={(event) => setFadeIn(Number(event.target.value))} style={{ width: '100%' }} /></label>
      <label>Fade out<input type="number" min={0} max={30} step={0.1} value={fadeOut} onChange={(event) => setFadeOut(Number(event.target.value))} style={{ width: '100%' }} /></label>
      <button disabled={busy} onClick={() => execute({ type: 'audio.mix.set', sceneId: scene.id, role, settings: AudioMixSettingsSchema.parse({ gain_db: gain, mute, fade_in_ms: Math.round(fadeIn * 1_000), fade_out_ms: Math.round(fadeOut * 1_000) }) })}>Save</button>
    </div>
  );
}
