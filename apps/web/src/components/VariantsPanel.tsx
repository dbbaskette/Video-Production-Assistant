import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OutputVariant, OutputVariantDraft, Storyboard, VariantValidation } from '@vpa/shared';
import { variantsApi } from '../lib/api.js';

function draftOf(variant: OutputVariant): OutputVariantDraft {
  const { id, name, aspect_ratio, crop, safe_area, selected_ranges, source_language, target_language, captions, replace_narration, narration_replacement } = variant;
  return { id, name, aspect_ratio, crop, safe_area, selected_ranges, source_language, target_language, captions, replace_narration, narration_replacement };
}

export function VariantsPanel({ projectId, storyboard, selectedVariantId, onSelect }: {
  projectId: string;
  storyboard: Storyboard;
  selectedVariantId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('Portrait cut');
  const [aspect, setAspect] = useState<'16:9' | '1:1' | '9:16'>('9:16');
  const [cropMode, setCropMode] = useState<'contain' | 'cover'>('cover');
  const [safePercent, setSafePercent] = useState(5);
  const [targetLanguage, setTargetLanguage] = useState('');
  const [selectedRanges, setSelectedRanges] = useState<string[]>([]);
  const variants = useQuery({ queryKey: ['variants', projectId], queryFn: () => variantsApi.list(projectId) });
  const refresh = async () => { await queryClient.invalidateQueries({ queryKey: ['variants', projectId] }); };
  const create = useMutation({
    mutationFn: () => {
      const language = targetLanguage.trim() || null;
      const captions = language ? storyboard.scenes.flatMap((scene) => (scene.transcript?.passages ?? []).map((passage) => ({
        id: `caption_${crypto.randomUUID()}`,
        scene_id: scene.id,
        source_asset_id: scene.transcript!.source_asset_id,
        source_in_ms: passage.start_ms,
        source_out_ms: passage.end_ms,
        source_text: passage.text,
        text: passage.text,
        source_language: scene.transcript!.language,
        target_language: language,
        provider: 'manual',
        model: 'manual',
        estimated_cost_usd: 0,
        pronunciation_notes: '',
        accepted: false,
      }))) : [];
      const margin = safePercent / 100;
      return variantsApi.create(projectId, {
        id: `variant_${crypto.randomUUID()}`,
        name,
        aspect_ratio: aspect,
        crop: { mode: cropMode, focus_x: 0.5, focus_y: 0.5 },
        safe_area: { top: margin, right: margin, bottom: margin, left: margin },
        selected_ranges: storyboard.scenes.flatMap((scene) => (scene.editorial_ranges ?? []).filter((range) => selectedRanges.includes(range.id)).map((range) => ({ scene_id: scene.id, range_id: range.id }))),
        source_language: 'en',
        target_language: language,
        captions,
        replace_narration: false,
        narration_replacement: null,
      });
    },
    onSuccess: async (created) => { onSelect(created.variant.id); setTargetLanguage(''); await refresh(); },
  });
  const rebase = useMutation({ mutationFn: (variant: OutputVariant) => variantsApi.rebase(projectId, variant.id, variant.updated_at), onSuccess: refresh });
  const remove = useMutation({
    mutationFn: (variant: OutputVariant) => variantsApi.remove(projectId, variant.id, variant.updated_at),
    onSuccess: async () => { onSelect(null); await refresh(); },
  });

  const ranges = storyboard.scenes.flatMap((scene) => (scene.editorial_ranges ?? []).map((range) => ({ scene, range })));
  return <section style={{ padding: 18, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, marginBottom: 20 }} aria-labelledby="variants-title">
    <strong id="variants-title">Output variants</strong>
    <p className="hint">Create square, portrait, highlight or language-specific outputs without changing the accepted base project. Variants stay pinned until you explicitly rebase them.</p>
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(160px, 1.4fr) repeat(4, minmax(100px, .7fr))', gap: 8, alignItems: 'end' }}>
      <label>Name<input aria-label="Variant name" value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>Aspect<select aria-label="Variant aspect ratio" value={aspect} onChange={(event) => setAspect(event.target.value as typeof aspect)}><option>16:9</option><option>1:1</option><option>9:16</option></select></label>
      <label>Fit<select aria-label="Variant crop mode" value={cropMode} onChange={(event) => setCropMode(event.target.value as typeof cropMode)}><option value="cover">Crop to fill</option><option value="contain">Fit with padding</option></select></label>
      <label>Safe area %<input aria-label="Variant safe area" type="number" min={0} max={30} value={safePercent} onChange={(event) => setSafePercent(Number(event.target.value))} /></label>
      <label>Language (optional)<input aria-label="Target language" placeholder="e.g. es" value={targetLanguage} onChange={(event) => setTargetLanguage(event.target.value)} /></label>
    </div>
    {ranges.length > 0 && <details style={{ marginTop: 10 }}><summary style={{ cursor: 'pointer', fontSize: 12 }}>Use only approved highlights ({selectedRanges.length || 'all scenes'})</summary><div style={{ display: 'grid', gap: 5, marginTop: 8 }}>{ranges.map(({ scene, range }) => <label key={range.id} style={{ fontSize: 12 }}><input type="checkbox" checked={selectedRanges.includes(range.id)} onChange={(event) => setSelectedRanges((current) => event.target.checked ? [...current, range.id] : current.filter((id) => id !== range.id))} /> {scene.name}: {range.title} ({(range.source_out_ms - range.source_in_ms) / 1000}s)</label>)}</div></details>}
    <button className="btn--accent" style={{ marginTop: 12 }} disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>{create.isPending ? 'Creating…' : 'Create pinned variant'}</button>
    {create.isError && <p role="alert" style={{ color: 'var(--danger)', fontSize: 12 }}>{create.error instanceof Error ? create.error.message : 'Variant could not be created.'}</p>}

    <div style={{ display: 'grid', gap: 10, marginTop: 16 }}>
      <label style={{ padding: 10, border: `1px solid ${selectedVariantId === null ? 'var(--accent)' : 'var(--border)'}`, borderRadius: 8 }}><input type="radio" name="render-variant" checked={selectedVariantId === null} onChange={() => onSelect(null)} /> Base project · 16:9</label>
      {variants.data?.variants.map((validation) => <VariantCard
        key={`${validation.variant.id}:${validation.variant.updated_at}`}
        projectId={projectId}
        validation={validation}
        selected={selectedVariantId === validation.variant.id}
        onSelect={() => onSelect(validation.variant.id)}
        onRebase={() => rebase.mutate(validation.variant)}
        onRemove={() => { if (window.confirm(`Delete variant “${validation.variant.name}”? Existing render artifacts remain available.`)) remove.mutate(validation.variant); }}
        onSaved={refresh}
      />)}
    </div>
  </section>;
}

function VariantCard({ projectId, validation, selected, onSelect, onRebase, onRemove, onSaved }: {
  projectId: string;
  validation: VariantValidation;
  selected: boolean;
  onSelect: () => void;
  onRebase: () => void;
  onRemove: () => void;
  onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(() => draftOf(validation.variant));
  useEffect(() => setDraft(draftOf(validation.variant)), [validation.variant]);
  const save = useMutation({ mutationFn: () => variantsApi.update(projectId, draft, validation.variant.updated_at), onSuccess: onSaved });
  return <article style={{ padding: 12, border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`, borderRadius: 8 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'start' }}>
      <label><input type="radio" name="render-variant" checked={selected} onChange={onSelect} /> <strong>{validation.variant.name}</strong> · {validation.variant.aspect_ratio} · {validation.dimensions.width}×{validation.dimensions.height}</label>
      <div style={{ display: 'flex', gap: 6 }}>{validation.stale && <button onClick={onRebase}>Review & rebase</button>}<button onClick={onRemove}>Delete</button></div>
    </div>
    <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 5 }}>Pinned to revision {validation.variant.source_revision} · {validation.variant.crop.mode} · safe area {Math.round(validation.variant.safe_area.top * 100)}%{validation.variant.selected_ranges.length ? ` · ${validation.variant.selected_ranges.length} approved ranges` : ''}{validation.variant.target_language ? ` · ${validation.variant.source_language} → ${validation.variant.target_language}` : ''}</div>
    {validation.blockers.map((item) => <div key={item} style={{ color: 'var(--danger)', fontSize: 11, marginTop: 5 }}>{item}</div>)}
    {validation.warnings.map((item) => <div key={item} style={{ color: 'var(--warning)', fontSize: 11, marginTop: 5 }}>{item}</div>)}
    <details style={{ marginTop: 8 }}><summary style={{ cursor: 'pointer', fontSize: 12 }}>Reframe and safe area</summary><div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(100px, 1fr))', gap: 8, marginTop: 8 }}><label>Aspect<select value={draft.aspect_ratio} onChange={(event) => setDraft((current) => ({ ...current, aspect_ratio: event.target.value as OutputVariantDraft['aspect_ratio'] }))}><option>16:9</option><option>1:1</option><option>9:16</option></select></label><label>Fit<select value={draft.crop.mode} onChange={(event) => setDraft((current) => ({ ...current, crop: { ...current.crop, mode: event.target.value as 'contain' | 'cover' } }))}><option value="cover">Crop to fill</option><option value="contain">Fit with padding</option></select></label><label>Horizontal focus<input aria-label="Horizontal crop focus" type="range" min={0} max={1} step={0.05} value={draft.crop.focus_x} onChange={(event) => setDraft((current) => ({ ...current, crop: { ...current.crop, focus_x: Number(event.target.value) } }))} /></label><label>Vertical focus<input aria-label="Vertical crop focus" type="range" min={0} max={1} step={0.05} value={draft.crop.focus_y} onChange={(event) => setDraft((current) => ({ ...current, crop: { ...current.crop, focus_y: Number(event.target.value) } }))} /></label></div><label style={{ display: 'block', marginTop: 8 }}>Safe margin %<input aria-label="Safe margin percent" type="number" min={0} max={30} value={Math.round(draft.safe_area.top * 100)} onChange={(event) => { const margin = Number(event.target.value) / 100; setDraft((current) => ({ ...current, safe_area: { top: margin, right: margin, bottom: margin, left: margin } })); }} /></label><button style={{ marginTop: 8 }} disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save framing'}</button></details>
    {draft.captions.length > 0 && <details style={{ marginTop: 8 }}><summary style={{ cursor: 'pointer', fontSize: 12 }}>Edit localized captions ({draft.captions.filter((caption) => caption.accepted).length}/{draft.captions.length} accepted)</summary><div style={{ display: 'grid', gap: 8, marginTop: 8 }}>{draft.captions.map((caption, index) => <div key={caption.id} style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}><div style={{ color: 'var(--fg-muted)', fontSize: 11 }}>{caption.source_text}</div><textarea aria-label={`Translation ${index + 1}`} value={caption.text} onChange={(event) => setDraft((current) => ({ ...current, captions: current.captions.map((item) => item.id === caption.id ? { ...item, text: event.target.value, accepted: false } : item) }))} style={{ width: '100%', minHeight: 55, marginTop: 4 }} /><label style={{ fontSize: 11 }}><input type="checkbox" checked={caption.accepted} onChange={(event) => setDraft((current) => ({ ...current, captions: current.captions.map((item) => item.id === caption.id ? { ...item, accepted: event.target.checked } : item) }))} /> Translation and timing reviewed</label><input aria-label={`Pronunciation notes ${index + 1}`} placeholder="Pronunciation notes" value={caption.pronunciation_notes} onChange={(event) => setDraft((current) => ({ ...current, captions: current.captions.map((item) => item.id === caption.id ? { ...item, pronunciation_notes: event.target.value } : item) }))} /></div>)}</div><button style={{ marginTop: 8 }} disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save localization review'}</button></details>}
    {save.isError && <p role="alert" style={{ color: 'var(--danger)', fontSize: 11 }}>{save.error instanceof Error ? save.error.message : 'Variant could not be saved.'}</p>}
  </article>;
}
