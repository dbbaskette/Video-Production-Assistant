import { createHash } from 'node:crypto';
import {
  AssistanceResponseSchema,
  compositionDurationMs,
  type AssistanceProposal,
  type Scene,
  type Storyboard,
} from '@vpa/shared';

function stable(prefix: 'proposal' | 'effect' | 'range', value: string): string {
  return `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

function sceneDuration(scene: Scene): number {
  return scene.composition ? compositionDurationMs(scene.composition) : Math.round((scene.recording?.duration_sec ?? 0) * 1_000);
}

function transcriptCitation(scene: Scene, start: number, end: number, excerpt: string, confidence = 0.8) {
  const clip = scene.composition!.clips.find((item) => item.source_in_ms <= start && item.source_out_ms >= end) ?? scene.composition!.clips[0]!;
  return {
    scene_id: scene.id,
    source_asset_id: clip.source_asset_id,
    source_in_ms: Math.max(clip.source_in_ms, start),
    source_out_ms: Math.min(clip.source_out_ms, Math.max(start + 1, end)),
    evidence: 'transcript' as const,
    excerpt: excerpt.slice(0, 500),
    confidence,
    provenance: 'observed' as const,
  };
}

export function buildAssistance(storyboard: Storyboard, revision: number, targetDurationMs: number) {
  const currentDurationMs = storyboard.scenes.reduce((sum, scene) => sum + sceneDuration(scene), 0);
  const proposals: AssistanceProposal[] = [];
  const blockers: string[] = [];
  const requestedRatio = currentDurationMs > 0 ? Math.min(1, targetDurationMs / currentDurationMs) : 1;
  let projectedDurationMs = currentDurationMs;

  for (const scene of storyboard.scenes) {
    const composition = scene.composition;
    const transcript = scene.transcript;
    if (!composition) continue;

    if (currentDurationMs > targetDurationMs) {
      for (const clip of composition.clips) {
        const duration = clip.source_out_ms - clip.source_in_ms;
        const desired = Math.max(500, Math.round(duration * requestedRatio));
        const passages = transcript?.source_asset_id === clip.source_asset_id
          ? transcript.passages.filter((passage) => passage.end_ms > clip.source_in_ms && passage.start_ms < clip.source_out_ms)
          : [];
        if (passages.length === 0) {
          blockers.push(`${scene.name}: timed transcript evidence is required before suggesting a cut.`);
          continue;
        }
        const desiredEnd = clip.source_in_ms + desired;
        const boundary = passages.filter((passage) => passage.end_ms <= desiredEnd).at(-1)?.end_ms
          ?? passages.find((passage) => passage.end_ms > clip.source_in_ms)?.end_ms
          ?? clip.source_out_ms;
        const sourceOut = Math.min(clip.source_out_ms, Math.max(clip.source_in_ms + 500, boundary));
        if (sourceOut >= clip.source_out_ms - 100) continue;
        const omitted = passages.filter((passage) => passage.start_ms >= sourceOut).map((passage) => passage.text).join(' ');
        const cited = passages.find((passage) => passage.start_ms < sourceOut && passage.end_ms >= sourceOut) ?? passages.at(-1)!;
        const id = stable('proposal', `trim:${scene.id}:${clip.id}:${sourceOut}:${targetDurationMs}`);
        proposals.push({
          id, kind: 'trim', scene_id: scene.id, clip_id: clip.id,
          title: `Trim ${scene.name} at a transcript boundary`,
          rationale: `Keep a contiguous source-backed range and remove the trailing material to move toward the requested duration without fabricating continuity.`,
          confidence: cited.word_ids.some((wordId) => (transcript?.words.find((word) => word.id === wordId)?.confidence ?? 1) < 0.7) ? 0.65 : 0.85,
          provenance: 'observed', citations: [transcriptCitation(scene, cited.start_ms, cited.end_ms, cited.text)],
          status: 'pending', warnings: ['This is a source-time cut, not a claim of frame-accurate semantic continuity.'],
          source_in_ms: clip.source_in_ms, source_out_ms: sourceOut,
          ...(omitted ? { omitted_text: omitted.slice(0, 2_000) } : {}),
        });
        projectedDurationMs -= clip.source_out_ms - sourceOut;
      }
    }

    const primary = composition.clips[0];
    const passage = transcript?.passages[0];
    if (primary && passage && transcript?.source_asset_id === primary.source_asset_id) {
      const rangeId = stable('range', `highlight:${scene.id}:${primary.id}:${passage.start_ms}:${passage.end_ms}`);
      proposals.push({
        id: stable('proposal', rangeId), kind: 'highlight', scene_id: scene.id,
        title: `Save “${passage.text.slice(0, 60)}${passage.text.length > 60 ? '…' : ''}” as a highlight`,
        rationale: 'This passage is a reusable source-linked range for clips and variants.', confidence: 0.75,
        provenance: 'observed', citations: [transcriptCitation(scene, passage.start_ms, passage.end_ms, passage.text)],
        status: scene.editorial_ranges?.some((range) => range.id === rangeId) ? 'accepted' : 'pending', warnings: [],
        range: { id: rangeId, kind: 'highlight', clip_instance_id: primary.id, source_asset_id: primary.source_asset_id, source_in_ms: passage.start_ms, source_out_ms: passage.end_ms, title: passage.text.slice(0, 120), rationale: 'Accepted from timed transcript evidence.' },
      });

      const effectStart = Math.max(primary.source_in_ms, passage.start_ms);
      const effectEnd = Math.min(primary.source_out_ms, Math.max(effectStart + 500, passage.end_ms));
      const citation = transcriptCitation(scene, effectStart, effectEnd, passage.text);
      const calloutId = stable('effect', `callout:${scene.id}:${effectStart}:${effectEnd}`);
      const calloutRect = { x: 0.08, y: 0.1, width: 0.44, height: 0.16 };
      proposals.push({
        id: stable('proposal', calloutId), kind: 'callout', scene_id: scene.id, title: 'Add an editable callout for the opening statement',
        rationale: 'The timed transcript provides the label and interval; placement is inferred and must be reviewed.', confidence: 0.6, provenance: 'inferred', citations: [citation],
        status: scene.visual_effects?.some((effect) => effect.id === calloutId) ? 'accepted' : 'pending', warnings: ['Placement is inferred; move or resize it after preview.'], suggested_rect: calloutRect,
        effect: { id: calloutId, type: 'text', clip_instance_id: primary.id, source_asset_id: primary.source_asset_id, source_in_ms: effectStart, source_out_ms: effectEnd, rect: calloutRect, text: passage.text.slice(0, 120), color: '#FFFFFF' },
      });

      const focusId = stable('effect', `focus:${scene.id}:${effectStart}:${effectEnd}`);
      const focusRect = { x: 0.2, y: 0.18, width: 0.6, height: 0.55 };
      proposals.push({
        id: stable('proposal', focusId), kind: 'focus', scene_id: scene.id, title: 'Review a gentle focus region',
        rationale: 'Activity timing is grounded in speech evidence, but the region is inferred because no pointer sidecar identifies an exact target.', confidence: 0.35, provenance: 'inferred', citations: [citation],
        status: scene.visual_effects?.some((effect) => effect.id === focusId) ? 'accepted' : 'pending', warnings: ['No exact pointer history is available. Confirm the region before accepting.'], suggested_rect: focusRect,
        effect: { id: focusId, type: 'zoom', clip_instance_id: primary.id, source_asset_id: primary.source_asset_id, source_in_ms: effectStart, source_out_ms: effectEnd, rect: focusRect, scale: 1.35, transition_ms: 300 },
      });
    }

    if (primary && transcript?.source_asset_id === primary.source_asset_id) {
      const filler = transcript.words.find((word) => /^(?:um+|uh+|erm|hmm)$/i.test(word.text));
      const gap = transcript.words.slice(1).map((word, index) => ({ start: transcript.words[index]!.end_ms, end: word.start_ms })).find((item) => item.end - item.start >= 1_200);
      const cleanup = filler ? { start: filler.start_ms, end: filler.end_ms, label: `Filler “${filler.text}”` } : gap ? { start: gap.start, end: gap.end, label: 'Long silence' } : null;
      if (cleanup && cleanup.start > primary.source_in_ms && cleanup.end < primary.source_out_ms) {
        const proposalId = stable('proposal', `cleanup:${scene.id}:${cleanup.start}:${cleanup.end}`);
        const stillPresent = composition.clips.some((clip) => clip.source_asset_id === primary.source_asset_id && clip.source_in_ms < cleanup.end && clip.source_out_ms > cleanup.start);
        proposals.push({
          id: proposalId, kind: 'cleanup', scene_id: scene.id, clip_id: primary.id,
          title: `Review ${cleanup.label.toLowerCase()} removal`, rationale: 'The interval is derived from word timing and will preserve linked tracks through the canonical split/delete commands.',
          confidence: filler ? (filler.confidence ?? 0.7) : 0.8, provenance: 'observed',
          citations: [transcriptCitation(scene, cleanup.start, cleanup.end, cleanup.label)], status: stillPresent ? 'pending' : 'accepted',
          warnings: ['Listen across both edit boundaries before accepting the result.'], remove_in_ms: cleanup.start, remove_out_ms: cleanup.end, label: cleanup.label,
        });
      }

      const sensitive = transcript.passages.find((item) => /\b(?:password|api[-_ ]?key|token|secret|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,})\b/i.test(item.text));
      if (sensitive) {
        const start = Math.max(primary.source_in_ms, sensitive.start_ms);
        const end = Math.min(primary.source_out_ms, Math.max(start + 500, sensitive.end_ms));
        const effectId = stable('effect', `sensitive:${scene.id}:${start}:${end}`);
        const rect = { x: 0, y: 0, width: 1, height: 1 };
        proposals.push({
          id: stable('proposal', effectId), kind: 'sensitive', scene_id: scene.id, title: 'Review possible sensitive content',
          rationale: 'A configurable sensitive-term pattern matched the transcript. Full-frame concealment is the safe default until the visible region is reviewed.', confidence: 0.55, provenance: 'inferred', citations: [transcriptCitation(scene, start, end, sensitive.text, 0.7)],
          status: scene.visual_effects?.some((effect) => effect.id === effectId) ? 'accepted' : 'pending', warnings: ['Transcript coverage does not prove every frame is sanitized. Resize only after visual review.'], suggested_rect: rect,
          effect: { id: effectId, type: 'redaction', clip_instance_id: primary.id, source_asset_id: primary.source_asset_id, source_in_ms: start, source_out_ms: end, rect, opacity: 1 },
        });
      }
    }

    if (primary) {
      const role = primary.linked_tracks.some((track) => track.role === 'microphone') ? 'microphone' as const : composition.audio_mix.music ? 'music' as const : null;
      if (role) {
        const settings = role === 'music'
          ? { gain_db: -20, mute: false, fade_in_ms: 500, fade_out_ms: 1_500 }
          : { gain_db: -2, mute: false, fade_in_ms: 120, fade_out_ms: 120 };
        const current = composition.audio_mix[role];
        proposals.push({
          id: stable('proposal', `audio:${scene.id}:${role}`), kind: 'audio', scene_id: scene.id, title: role === 'music' ? 'Duck music under speech' : 'Smooth microphone boundaries',
          rationale: role === 'music' ? 'A conservative -20 dB bed keeps speech intelligible.' : 'Short fades reduce boundary clicks without replacing the original audio.',
          confidence: 0.9, provenance: 'metadata', citations: [{ scene_id: scene.id, source_asset_id: primary.source_asset_id, source_in_ms: primary.source_in_ms, source_out_ms: primary.source_out_ms, evidence: 'capture-metadata', confidence: 1, provenance: 'metadata' }],
          status: current && JSON.stringify(current) === JSON.stringify(settings) ? 'accepted' : 'pending', warnings: ['Preview the mix before final render.'], role, settings,
        });
      }
    }
  }

  if (currentDurationMs > targetDurationMs && projectedDurationMs > Math.ceil(targetDurationMs * 1.1)) {
    blockers.push('Available transcript-backed boundaries cannot reach the requested duration within 10% without removing uncited material.');
  }
  return AssistanceResponseSchema.parse({
    revision, current_duration_ms: currentDurationMs, target_duration_ms: targetDurationMs,
    projected_duration_ms: projectedDurationMs,
    tolerance_met: projectedDurationMs <= Math.ceil(targetDurationMs * 1.1), proposals, blockers: [...new Set(blockers)],
  });
}
