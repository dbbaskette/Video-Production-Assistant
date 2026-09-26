import {
  VariantValidationSchema,
  type NormalizedRect,
  type OutputVariant,
  type Project,
  type Storyboard,
  type VariantAspectRatio,
  type VariantValidation,
} from '@vpa/shared';

const DIMENSIONS: Record<VariantAspectRatio, { draft: { width: number; height: number }; '1080p': { width: number; height: number } }> = {
  '16:9': { draft: { width: 1280, height: 720 }, '1080p': { width: 1920, height: 1080 } },
  '1:1': { draft: { width: 720, height: 720 }, '1080p': { width: 1080, height: 1080 } },
  '9:16': { draft: { width: 720, height: 1280 }, '1080p': { width: 1080, height: 1920 } },
};

export function variantDimensions(aspectRatio: VariantAspectRatio, quality: 'draft' | '1080p') {
  return DIMENSIONS[aspectRatio][quality];
}

export function mapRectToVariant(rect: NormalizedRect, variant: OutputVariant): NormalizedRect {
  const source = { width: 16, height: 9 };
  const target = variantDimensions(variant.aspect_ratio, '1080p');
  const scale = variant.crop.mode === 'contain'
    ? Math.min(target.width / source.width, target.height / source.height)
    : Math.max(target.width / source.width, target.height / source.height);
  const displayedWidth = source.width * scale / target.width;
  const displayedHeight = source.height * scale / target.height;
  const offsetX = variant.crop.mode === 'contain' ? (1 - displayedWidth) / 2 : -(displayedWidth - 1) * variant.crop.focus_x;
  const offsetY = variant.crop.mode === 'contain' ? (1 - displayedHeight) / 2 : -(displayedHeight - 1) * variant.crop.focus_y;
  const mapped = {
    x: offsetX + rect.x * displayedWidth,
    y: offsetY + rect.y * displayedHeight,
    width: rect.width * displayedWidth,
    height: rect.height * displayedHeight,
  };
  return {
    x: Math.max(0, Math.min(1, mapped.x)),
    y: Math.max(0, Math.min(1, mapped.y)),
    width: Math.max(0.0001, Math.min(1, mapped.width, 1 - Math.max(0, mapped.x))),
    height: Math.max(0.0001, Math.min(1, mapped.height, 1 - Math.max(0, mapped.y))),
  };
}

export function validateVariant(variant: OutputVariant, storyboard: Storyboard, project: Project, currentRevision: number): VariantValidation {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const stale = variant.source_revision !== currentRevision
    || JSON.stringify(variant.source_brand) !== JSON.stringify(project.brand);
  if (stale) blockers.push('This variant is pinned to an older project or brand revision. Review and explicitly rebase it before rendering.');

  for (const selected of variant.selected_ranges) {
    const scene = storyboard.scenes.find((item) => item.id === selected.scene_id);
    const range = scene?.editorial_ranges?.find((item) => item.id === selected.range_id);
    if (!range) blockers.push(`Selected range ${selected.range_id} is no longer available in ${selected.scene_id}.`);
  }
  if (variant.selected_ranges.length > 0 && storyboard.scenes.some((scene) => scene.narration || (scene.lower_thirds?.length ?? 0) > 0)) {
    warnings.push('Highlight-only variants use the selected source ranges and omit scene-wide narration and lower thirds whose timing no longer matches.');
  }

  const safe = variant.safe_area;
  for (const scene of storyboard.scenes) {
    for (const effect of scene.visual_effects ?? []) {
      const mapped = mapRectToVariant(effect.rect, variant);
      const outside = mapped.x < safe.left || mapped.y < safe.top
        || mapped.x + mapped.width > 1 - safe.right || mapped.y + mapped.height > 1 - safe.bottom;
      if (outside) warnings.push(`${scene.name}: ${effect.type} effect ${effect.id} crosses the variant safe area and needs visual review.`);
    }
    if (scene.composition?.clips.some((clip) => clip.linked_tracks.some((track) => track.role === 'camera'))) {
      warnings.push(`${scene.name}: review camera placement after ${variant.aspect_ratio} reframing.`);
    }
  }

  if (variant.target_language && variant.target_language !== variant.source_language) {
    if (variant.captions.length === 0) blockers.push(`Add source-linked ${variant.target_language} captions before rendering this language variant.`);
    for (const caption of variant.captions) {
      const scene = storyboard.scenes.find((item) => item.id === caption.scene_id);
      const sourceMatches = scene?.composition?.clips.some((clip) => clip.source_asset_id === caption.source_asset_id
        && caption.source_in_ms >= clip.source_in_ms && caption.source_out_ms <= clip.source_out_ms);
      if (!sourceMatches) blockers.push(`Caption ${caption.id} no longer matches its immutable source interval.`);
      if (!caption.accepted) blockers.push(`Caption ${caption.id} still needs acceptance.`);
      if (caption.text.length / Math.max(1, caption.source_text.length) > 1.4) warnings.push(`Caption ${caption.id} expands more than 40%; review reading speed and timing.`);
      if (!caption.pronunciation_notes.trim()) warnings.push(`Caption ${caption.id} has no pronunciation review notes.`);
    }
  }
  if (variant.replace_narration) {
    if (!variant.narration_replacement?.accepted) blockers.push('The localized narration replacement is missing or not accepted.');
    else {
      const sourceDuration = storyboard.scenes.reduce((sum, scene) => sum + Math.round((scene.recording?.duration_sec ?? 0) * 1_000), 0);
      if (sourceDuration > 0 && Math.abs(variant.narration_replacement.duration_ms - sourceDuration) / sourceDuration > 0.15) {
        warnings.push('Localized narration duration differs from the source by more than 15%.');
      }
    }
  }

  return VariantValidationSchema.parse({
    variant,
    current_revision: currentRevision,
    stale,
    dimensions: variantDimensions(variant.aspect_ratio, '1080p'),
    blockers: [...new Set(blockers)],
    warnings: [...new Set(warnings)],
    estimated_cost_usd: variant.captions.reduce((sum, caption) => sum + caption.estimated_cost_usd, 0)
      + (variant.narration_replacement?.estimated_cost_usd ?? 0),
  });
}
