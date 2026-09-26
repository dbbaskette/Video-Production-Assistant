import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  VisualEffectSchema,
  compositionDurationMs,
  type Scene,
  type VisualEffect,
} from '@vpa/shared';
import { assetsApi, compositionApi, recordingsApi, sceneRenderApi, sourceEvidenceApi } from '../lib/api.js';

function id(prefix: 'effect'): string { return `${prefix}_${crypto.randomUUID()}`; }
function overlaps(a: VisualEffect, b: VisualEffect): boolean {
  return a.clip_instance_id === b.clip_instance_id && a.source_in_ms < b.source_out_ms && b.source_in_ms < a.source_out_ms;
}

export function VisualEvidenceEditor({ projectId, scenes }: { projectId: string; scenes: Scene[] }) {
  const editable = scenes.filter((scene) => scene.composition);
  const [sceneId, setSceneId] = useState(editable[0]?.id ?? '');
  const scene = editable.find((candidate) => candidate.id === sceneId) ?? editable[0];
  const [drafts, setDrafts] = useState<Record<string, VisualEffect[]>>(() => Object.fromEntries(editable.map((item) => [item.id, item.visual_effects ?? []])));
  const effects = scene ? drafts[scene.id] ?? scene.visual_effects ?? [] : [];
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(effects[0]?.id ?? null);
  const [currentMs, setCurrentMs] = useState(0);
  const [timelineZoom, setTimelineZoom] = useState(1);
  const [search, setSearch] = useState('');
  const [exactPreview, setExactPreview] = useState<{ sceneId: string; url: string } | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty.size) event.preventDefault(); };
    const links = (event: MouseEvent) => {
      if (!dirty.size || !(event.target instanceof Element) || !event.target.closest('a[href]')) return;
      if (!window.confirm('You have unsaved visual changes. Leave without saving?')) event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    document.addEventListener('click', links, true);
    return () => { window.removeEventListener('beforeunload', warn); document.removeEventListener('click', links, true); };
  }, [dirty]);

  const revision = useQuery({ queryKey: ['revision', projectId], queryFn: () => assetsApi.currentRevision(projectId), enabled: !!scene });
  const assets = useQuery({ queryKey: ['assets', projectId], queryFn: () => assetsApi.list(projectId), enabled: !!scene });
  const evidence = useQuery({ queryKey: ['source-evidence', projectId, scene?.id], queryFn: () => sourceEvidenceApi.get(projectId, scene!.id), enabled: !!scene });
  const save = useMutation({
    mutationFn: async () => {
      if (!scene || revision.data == null) throw new Error('Project revision is unavailable.');
      return compositionApi.execute(projectId, revision.data, [{ type: 'visual.effects.set', sceneId: scene.id, effects }]);
    },
    onSuccess: async () => {
      setDirty((value) => { const next = new Set(value); if (scene) next.delete(scene.id); return next; });
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] }), queryClient.invalidateQueries({ queryKey: ['revision', projectId] })]);
    },
  });
  const transcribe = useMutation({ mutationFn: () => sourceEvidenceApi.transcribe(projectId, scene!.id), onSuccess: () => queryClient.invalidateQueries({ queryKey: ['source-evidence', projectId, scene?.id] }) });
  const correct = useMutation({ mutationFn: ({ wordId, text }: { wordId: string; text: string }) => sourceEvidenceApi.correct(projectId, scene!.id, wordId, text), onSuccess: () => queryClient.invalidateQueries({ queryKey: ['source-evidence', projectId, scene?.id] }) });
  const artifact = useMutation({ mutationFn: (input: { kind: 'frame' | 'contact-sheet' | 'excerpt'; startMs: number; endMs?: number; density?: number }) => sourceEvidenceApi.createArtifact(projectId, scene!.id, input), onSuccess: () => queryClient.invalidateQueries({ queryKey: ['source-evidence', projectId, scene?.id] }) });
  const renderPreview = useMutation({ mutationFn: async () => { await sceneRenderApi.start(projectId, scene!.id, { audioMode: 'mix', burnSubtitles: true }); return { sceneId: scene!.id, url: `${sceneRenderApi.fileUrl(projectId, scene!.id, 'combined', true)}&t=${Date.now()}` }; }, onSuccess: setExactPreview });

  const setEffects = (next: VisualEffect[]) => {
    if (!scene) return;
    setDrafts((value) => ({ ...value, [scene.id]: next }));
    setExactPreview(null);
    setDirty((value) => new Set(value).add(scene.id));
  };
  const selected = effects.find((effect) => effect.id === selectedId) ?? null;
  const durationMs = scene?.composition ? compositionDurationMs(scene.composition) : 0;
  const clip = scene?.composition?.clips.find((candidate) => currentMs >= candidate.timeline_start_ms && currentMs < candidate.timeline_start_ms + candidate.source_out_ms - candidate.source_in_ms) ?? scene?.composition?.clips[0];
  const sourceAtCursor = clip ? clip.source_in_ms + Math.max(0, currentMs - clip.timeline_start_ms) : 0;

  const add = (type: VisualEffect['type']) => {
    if (!clip) return;
    const end = Math.min(clip.source_out_ms, sourceAtCursor + 4_000);
    const base = { id: id('effect'), clip_instance_id: clip.id, source_asset_id: clip.source_asset_id, source_in_ms: sourceAtCursor, source_out_ms: Math.max(sourceAtCursor + 1, end), rect: { x: 0.1, y: 0.1, width: 0.35, height: 0.16 } };
    const extra: Record<string, unknown> = type === 'text' ? { text: 'New text', color: '#FFFFFF' }
      : type === 'redaction' ? { opacity: 1 }
        : type === 'highlight' ? { color: '#FACC15', opacity: 0.3 }
          : type === 'zoom' ? { scale: 1.5, transition_ms: 250 }
            : type === 'arrow' ? { color: '#F97316', direction: 'right' }
              : type === 'background' ? { color: '#111827' }
                : type === 'camera' ? { corner_radius: 16 }
                  : type === 'logo' ? { asset_id: assets.data?.find((asset) => asset.media_kind === 'image')?.id, opacity: 1 }
                    : { text: type === 'title' ? 'New title' : 'New lower third', preset: 'fade' };
    if (type === 'logo' && !extra.asset_id) return;
    const next = VisualEffectSchema.parse({ ...base, type, ...extra });
    setEffects([...effects, next]);
    setSelectedId(next.id);
  };

  const updateSelected = (patch: Record<string, unknown>) => {
    if (!selected) return;
    const next = VisualEffectSchema.parse({ ...selected, ...patch });
    setEffects(effects.map((effect) => effect.id === selected.id ? next : effect));
  };

  const visible = effects.filter((effect) => effect.clip_instance_id === clip?.id && sourceAtCursor >= effect.source_in_ms && sourceAtCursor < effect.source_out_ms);
  const overlapIds = new Set(effects.flatMap((effect, index) => effects.slice(index + 1).filter((other) => overlaps(effect, other)).flatMap((other) => [effect.id, other.id])));
  const collision = effects.some((effect) => effect.type === 'camera' && effect.rect.y + effect.rect.height > 0.78) && !!evidence.data?.transcript;
  const passages = (evidence.data?.transcript?.passages ?? []).filter((passage) => passage.text.toLocaleLowerCase().includes(search.toLocaleLowerCase()));

  if (!scene) return <section style={{ padding: 16, border: '1px dashed var(--border)', borderRadius: 8 }}>Create an editable composition on the Recordings page before adding source-time effects.</section>;
  return (
    <section style={{ marginTop: 24, padding: 18, border: '1px solid var(--border)', borderRadius: 10, background: 'var(--bg-elev)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <div><strong>Visual & evidence editor</strong><div style={{ color: 'var(--fg-muted)', fontSize: 12 }}>Source-time effects and recorded-speech evidence use the same immutable clip clock.</div></div>
        <select value={scene.id} onChange={(event) => { setSceneId(event.target.value); setSelectedId(null); }} aria-label="Visual editor scene">{editable.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
        <span style={{ fontSize: 12, color: dirty.has(scene.id) ? 'var(--warning)' : 'var(--success)' }}>{save.isPending ? 'Saving…' : dirty.has(scene.id) ? 'Unsaved changes' : 'Saved'}</span>
        <button className="primary" disabled={!dirty.has(scene.id) || save.isPending} onClick={() => save.mutate()}>Save effects</button>
        <button disabled={dirty.has(scene.id) || renderPreview.isPending} onClick={() => renderPreview.mutate()}>{renderPreview.isPending ? 'Rendering exact preview…' : 'Render exact preview'}</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(360px, 1.5fr) minmax(280px, 1fr)', gap: 16, marginTop: 16 }}>
        <div>
          <div ref={previewRef} style={{ position: 'relative', aspectRatio: '16/9', background: '#05070a', overflow: 'hidden', borderRadius: 8 }}>
            <video src={exactPreview?.sceneId === scene.id ? exactPreview.url : recordingsApi.videoUrl(projectId, scene.id)} controls preload="metadata" onTimeUpdate={(event) => setCurrentMs(Math.round(event.currentTarget.currentTime * 1_000))} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
            {exactPreview?.sceneId !== scene.id && visible.map((effect) => <button key={effect.id} aria-label={`Select ${effect.type}`} onClick={() => setSelectedId(effect.id)} onPointerDown={(event) => {
              if (!previewRef.current) return;
              const rect = previewRef.current.getBoundingClientRect();
              const x = Math.max(0, Math.min(1 - effect.rect.width, (event.clientX - rect.left) / rect.width - effect.rect.width / 2));
              const y = Math.max(0, Math.min(1 - effect.rect.height, (event.clientY - rect.top) / rect.height - effect.rect.height / 2));
              setSelectedId(effect.id); updateSelected({ rect: { ...effect.rect, x, y } });
            }} style={{ position: 'absolute', left: `${effect.rect.x * 100}%`, top: `${effect.rect.y * 100}%`, width: `${effect.rect.width * 100}%`, height: `${effect.rect.height * 100}%`, border: effect.id === selectedId ? '2px solid #38bdf8' : '1px solid white', background: effect.type === 'redaction' ? '#000' : effect.type === 'highlight' ? 'rgba(250,204,21,.3)' : 'rgba(15,23,42,.55)', color: '#fff', cursor: 'move', overflow: 'hidden' }}>{'text' in effect ? effect.text : effect.type}</button>)}
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
            {(['text', 'redaction', 'highlight', 'arrow', 'zoom', 'background', 'camera', 'title', 'lower-third'] as const).map((type) => <button key={type} onClick={() => add(type)}>+ {type}</button>)}
            <button disabled={!assets.data?.some((asset) => asset.media_kind === 'image')} onClick={() => add('logo')}>+ logo</button>
          </div>
          <div style={{ marginTop: 14, overflowX: 'auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}><label>Timeline zoom <input type="range" min={1} max={10} value={timelineZoom} onChange={(event) => setTimelineZoom(Number(event.target.value))} /></label><span>{(durationMs / 1_000).toFixed(1)}s</span></div>
            {durationMs ? <div style={{ position: 'relative', minWidth: `${timelineZoom * 100}%`, height: 54, marginTop: 6, background: 'var(--surface)', borderRadius: 6 }} onClick={(event) => setCurrentMs(Math.round((event.nativeEvent.offsetX / event.currentTarget.clientWidth) * durationMs))}>
              {effects.map((effect) => {
                const effectClip = scene.composition!.clips.find((candidate) => candidate.id === effect.clip_instance_id)!;
                const start = effectClip.timeline_start_ms + effect.source_in_ms - effectClip.source_in_ms;
                return <button key={effect.id} onClick={(event) => { event.stopPropagation(); setSelectedId(effect.id); }} style={{ position: 'absolute', left: `${start / durationMs * 100}%`, width: `${(effect.source_out_ms - effect.source_in_ms) / durationMs * 100}%`, top: 9, height: 32, background: effect.id === selectedId ? 'var(--accent)' : 'var(--bg-elev)', color: 'var(--fg)', border: `1px solid ${overlapIds.has(effect.id) ? 'var(--warning)' : 'var(--border)'}`, borderRadius: 4, overflow: 'hidden', fontSize: 10 }}>{effect.type}</button>;
              })}
            </div> : <p style={{ color: 'var(--fg-muted)', fontSize: 12 }}>Duration is unavailable. Return to Recordings and prepare the source before placing timed effects.</p>}
            {overlapIds.size > 0 && <p style={{ color: 'var(--warning)', fontSize: 11 }}>Overlapping effects are outlined. Verify their combined readability.</p>}
          </div>
        </div>

        <div>
          <strong style={{ fontSize: 13 }}>Selected inspector</strong>
          {!selected ? <p style={{ color: 'var(--fg-muted)', fontSize: 12 }}>Select an item in the preview or timeline.</p> : <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
            <label>Start (s)<input type="number" step="0.1" value={selected.source_in_ms / 1_000} onChange={(event) => updateSelected({ source_in_ms: Math.round(Number(event.target.value) * 1_000) })} /></label>
            <label>End (s)<input type="number" step="0.1" value={selected.source_out_ms / 1_000} onChange={(event) => updateSelected({ source_out_ms: Math.round(Number(event.target.value) * 1_000) })} /></label>
            {(['x', 'y', 'width', 'height'] as const).map((field) => <label key={field}>{field}<input type="number" min={0} max={1} step={0.01} value={selected.rect[field]} onChange={(event) => updateSelected({ rect: { ...selected.rect, [field]: Number(event.target.value) } })} /></label>)}
            {'text' in selected && <label style={{ gridColumn: '1 / -1' }}>Text<input value={selected.text} onChange={(event) => updateSelected({ text: event.target.value })} /></label>}
            <button style={{ gridColumn: '1 / -1' }} onClick={() => { setEffects(effects.filter((effect) => effect.id !== selected.id)); setSelectedId(null); }}>Remove selected</button>
          </div>}
          <p style={{ color: 'var(--fg-dim)', fontSize: 11 }}>Dragging moves the selected box. Numeric fields provide precise keyboard control. Redaction is opaque only in derived previews/exports; the original remains unredacted. Add masks for every region traversed by moving content.</p>
          {collision && <p style={{ color: 'var(--warning)', fontSize: 11 }}>Camera overlaps the caption safe area. Move it above the bottom 22%.</p>}
        </div>
      </div>

      <div style={{ borderTop: '1px solid var(--border)', marginTop: 18, paddingTop: 16 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><strong>Recorded speech & evidence</strong><button disabled={transcribe.isPending} onClick={() => transcribe.mutate()}>{transcribe.isPending ? 'Transcribing with Gemini…' : evidence.data?.transcript ? 'Refresh transcription' : 'Transcribe English speech'}</button><button disabled={artifact.isPending} onClick={() => artifact.mutate({ kind: 'frame', startMs: currentMs })}>Save frame</button><button disabled={artifact.isPending} onClick={() => artifact.mutate({ kind: 'contact-sheet', startMs: 0, endMs: durationMs, density: 8 })}>Contact sheet</button><button disabled={artifact.isPending} onClick={() => artifact.mutate({ kind: 'excerpt', startMs: currentMs, endMs: Math.min(durationMs, currentMs + 10_000) })}>10s excerpt</button></div>
        {evidence.data?.transcript && <p style={{ fontSize: 11, color: 'var(--fg-muted)' }}>Gemini · {evidence.data.transcript.model} · coverage {evidence.data.transcript.coverage.map((item) => `${(item.start_ms / 1_000).toFixed(1)}–${(item.end_ms / 1_000).toFixed(1)}s`).join(', ')} · cached by source/model/settings</p>}
        <input aria-label="Search transcript" placeholder="Search transcript" value={search} onChange={(event) => setSearch(event.target.value)} style={{ width: '100%', marginTop: 8 }} />
        <div style={{ maxHeight: 180, overflow: 'auto', marginTop: 8 }}>
          {passages.map((passage) => <div key={passage.id} style={{ fontSize: 12, marginBottom: 8 }}><button onClick={() => setCurrentMs(passage.start_ms)}>{(passage.start_ms / 1_000).toFixed(1)}s</button> {passage.word_ids.map((wordId) => { const word = evidence.data!.transcript!.words.find((item) => item.id === wordId)!; return <input key={wordId} defaultValue={word.text} title={`${word.speaker ?? 'Speaker'} · confidence ${word.confidence ?? 'unknown'}`} onBlur={(event) => { if (event.target.value !== word.text) correct.mutate({ wordId, text: event.target.value }); }} style={{ width: `${Math.max(4, word.text.length + 1)}ch`, margin: 2, borderColor: (word.confidence ?? 1) < 0.7 ? 'var(--warning)' : 'var(--border)' }} />; })}</div>)}
        </div>
        <div style={{ display: 'flex', gap: 10, overflowX: 'auto' }}>{(evidence.data?.evidence ?? []).map((item) => item.kind === 'excerpt' ? <video key={item.id} controls src={sourceEvidenceApi.artifactUrl(projectId, scene.id, item.id)} style={{ width: 220 }} /> : <img key={item.id} src={sourceEvidenceApi.artifactUrl(projectId, scene.id, item.id)} alt={`${item.kind} at ${item.source_start_ms} ms`} style={{ width: item.kind === 'contact-sheet' ? 320 : 180, objectFit: 'contain' }} />)}</div>
        {(save.error || transcribe.error || correct.error || artifact.error) && <p role="alert" style={{ color: 'var(--danger)', fontSize: 12 }}>{(save.error ?? transcribe.error ?? correct.error ?? artifact.error) instanceof Error ? (save.error ?? transcribe.error ?? correct.error ?? artifact.error as Error).message : 'Operation failed.'}</p>}
      </div>
    </section>
  );
}
