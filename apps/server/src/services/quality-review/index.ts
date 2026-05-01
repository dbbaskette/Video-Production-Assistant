import type { LlmClient } from '../llm/index.js';
import { loadPrompt } from '../llm/prompts.js';
import type { Storyboard } from '@vpa/shared';

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
  const lines: string[] = [
    `Project: ${sb.project.name}`,
    `Objective: ${sb.project.objective ?? 'Not set'}`,
    `Scenes: ${sb.scenes.length}`,
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

    if (scene.narration?.script) {
      const wordCount = scene.narration.script.split(/\s+/).length;
      lines.push(`Script: ${wordCount} words`);
    } else {
      lines.push('Script: none');
    }

    if (scene.narration?.audio) {
      lines.push(`Narration audio: ${scene.narration.audio}`);
      if (scene.narration.subtitles?.srt) lines.push(`Subtitles: SRT + VTT`);
    } else {
      lines.push('Narration audio: none');
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
): Promise<ReviewResult> {
  const systemPrompt = await loadPrompt(workspaceRoot, 'quality-review');
  const userPrompt = buildStoryboardContext(storyboard);

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
