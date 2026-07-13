import type { LlmClient } from '../llm/index.js';
import { loadPrompt } from '../llm/prompts.js';
import type { Storyboard } from '@vpa/shared';
import { computeProjectWpm } from '../script/wpm.js';

export interface ReviewItem {
  sceneId: string;
  severity: 'info' | 'warn' | 'issue';
  category: string;
  message: string;
}

export interface ReviewResult {
  items: ReviewItem[];
  summary: {
    total: number;
    info: number;
    warn: number;
    issue: number;
  };
  status: 'ok' | 'warnings' | 'issues';
  reviewedAt: string;
}

function buildStoryboardContext(sb: Storyboard): string {
  // Empirical TTS rate — measured from existing chunks. Falls back to 150 wpm
  // when no narration has been generated yet. Both the per-scene script
  // verdict (below) and the Tighten action read from the same source.
  const wpmInfo = computeProjectWpm(sb);
  const lines: string[] = [
    `Project: ${sb.project.name}`,
    `Objective: ${sb.project.objective ?? 'Not set'}`,
    `Scenes: ${sb.scenes.length}`,
    `Narration rate: ${wpmInfo.wpm} wpm` +
      (wpmInfo.isMeasured
        ? ` (measured from ${wpmInfo.sampleChunks} generated chunk${wpmInfo.sampleChunks === 1 ? '' : 's'})`
        : ` (default — no narration generated yet)`),
    '',
  ];

  for (const scene of sb.scenes) {
    lines.push(`## ${scene.id}: ${scene.name}`);
    lines.push(`Type: ${scene.type}`);
    lines.push(`Description: ${scene.description}`);

    if (scene.recording) {
      lines.push(`Recording: ${scene.recording.source} (${scene.recording.duration_sec ?? '?'}s)`);
    } else {
      lines.push('Recording: none');
    }

    // Script + narration status. We emit clear signals so the prompt's
    // "optional-feature rule" can trust the data:
    //   • "Script: none (optional, not in use)" → don't warn
    //   • "Narration audio: none (script absent — narration not in use)"
    //     → skip the narration check entirely
    //   • "Narration audio: none (script present)" → warn (TTS missing)
    const hasScript = !!(scene.narration?.script || scene.narration?.monologueScript || scene.narration?.dialogScript);
    if (hasScript) {
      const text = scene.narration?.script ?? scene.narration?.monologueScript ?? scene.narration?.dialogScript ?? '';
      const wordCount = text.split(/\s+/).filter(Boolean).length;
      // Pre-compute the target word count at the project's canonical 150 wpm
      // (same rate `prompts/narration-writer.md` and the Tighten action use).
      // Surfacing the math here keeps the LLM from inventing its own slower
      // rate — earlier the model defaulted to ~80 wpm and warned about
      // scripts that were actually well under target.
      const durSec = scene.recording?.duration_sec;
      if (durSec && durSec > 0) {
        const targetWords = Math.round((durSec / 60) * wpmInfo.wpm);
        const ratio = wordCount / targetWords;
        let verdict: string;
        if (ratio > 1.15) verdict = `TOO LONG (over target by ${wordCount - targetWords} words)`;
        else if (ratio < 0.5) verdict = `unusually short (well under target)`;
        else verdict = 'within target';
        lines.push(
          `Script: ${wordCount} words ` +
          `(target ≤${targetWords} at ${wpmInfo.wpm} wpm for ${durSec.toFixed(0)}s; ${verdict}). ` +
          `Only warn about narration length when verdict says TOO LONG.`,
        );
      } else {
        lines.push(`Script: ${wordCount} words (no recording duration available — skip length check)`);
      }
    } else {
      lines.push('Script: none (optional, not in use)');
    }

    const hasNarrationAudio = !!scene.narration?.audio || (scene.narration?.chunks?.some((c) => !!c.audio) ?? false);
    if (hasNarrationAudio) {
      lines.push(`Narration audio: ${scene.narration?.audio ?? `${scene.narration?.chunks?.length} chunks`}`);
      if (scene.narration?.subtitles?.srt) lines.push('Subtitles: SRT + VTT');
      // Pacing signal: spoken audio (incl. any [pause] gaps) vs recording. A
      // big shortfall = dead air the author could pace with [pause Xs] beats.
      const chunks = scene.narration?.chunks ?? [];
      const spokenSec = chunks.reduce((a, c) => a + (c.durationSec ?? 0), 0);
      const gapSec = chunks.reduce((a, c) => a + (c.gapSec ?? 0), 0);
      const recSec = scene.recording?.duration_sec;
      if (recSec && spokenSec > 0) {
        const deadAir = recSec - (spokenSec + gapSec);
        lines.push(
          `Narration timing: ${spokenSec.toFixed(0)}s spoken + ${gapSec.toFixed(1)}s pauses ` +
            `vs ${recSec.toFixed(0)}s recording (dead air ${deadAir.toFixed(0)}s). ` +
            `If dead air is large, suggest pacing with [pause Xs] beats (see pacing rule).`,
        );
      }
    } else if (hasScript) {
      // Script written but not synthesised — this is genuinely worth a warn.
      lines.push('Narration audio: none (script present — TTS not yet generated)');
    } else {
      // No script either — narration is intentionally off for this scene.
      lines.push('Narration audio: none (script absent — narration not in use)');
    }

    const ltCount = scene.lower_thirds?.length ?? 0;
    lines.push(`Lower thirds: ${ltCount}`);
    if (scene.lower_thirds) {
      for (const lt of scene.lower_thirds) {
        lines.push(`  - "${lt.title}" ${lt.style} ${lt.in_sec}s–${lt.out_sec}s`);
      }
    }

    lines.push('');
  }

  return lines.join('\n');
}

export async function runQualityReview(
  storyboard: Storyboard,
  llm: LlmClient,
  workspaceRoot: string,
  /** Optional — project path is needed to inject source-docs reference. */
  projectPath?: string,
): Promise<ReviewResult> {
  const systemPrompt = await loadPrompt(workspaceRoot, 'quality-review');
  const baseUserPrompt = buildStoryboardContext(storyboard);
  const { withReferenceContext } = await import('../project-source-docs/inject.js');
  const userPrompt = await withReferenceContext(baseUserPrompt, {
    projectPath,
    summarize: true,
    llm,
  });

  const result = await llm.complete({
    systemPrompt,
    userPrompt,
    responseFormat: 'json',
    temperature: 0.3,
  });

  const text = result.text.trim();
  const jsonStr = text.startsWith('[')
    ? text
    : text.replace(/^```json\s*/, '').replace(/```\s*$/, '');
  const items = JSON.parse(jsonStr) as ReviewItem[];

  const info = items.filter((i) => i.severity === 'info').length;
  const warn = items.filter((i) => i.severity === 'warn').length;
  const issue = items.filter((i) => i.severity === 'issue').length;

  const status: 'ok' | 'warnings' | 'issues' =
    issue > 0 ? 'issues' : warn > 0 ? 'warnings' : 'ok';

  return {
    items,
    summary: { total: items.length, info, warn, issue },
    status,
    reviewedAt: new Date().toISOString(),
  };
}
