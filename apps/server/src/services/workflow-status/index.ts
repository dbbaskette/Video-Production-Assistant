import { stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { WorkflowStatusSchema, type Project, type Storyboard, type WorkflowIssue, type WorkflowStatus, type WorkflowStep } from '@vpa/shared';
import { jobQueue } from '../../lib/job-queue.js';
import { buildRenderFingerprint } from './fingerprint.js';
import { getFinalOutputInfo, readRenderManifest } from './render-manifest.js';

const labels = {
  storyboard: 'Storyboard', recordings: 'Recordings', script: 'Script', narration: 'Narration',
  'lower-thirds': 'Lower Thirds', render: 'Render', review: 'Quality Review',
} as const;

function issue(input: Omit<WorkflowIssue, 'id'>): WorkflowIssue {
  return { ...input, id: [input.code, input.sceneId ?? input.phase].join(':') };
}

async function recordingExists(projectPath: string, source: string | undefined): Promise<boolean> {
  if (!source) return false;
  try {
    const info = await stat(isAbsolute(source) ? source : join(projectPath, source));
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

export interface ComputeWorkflowInput {
  projectPath: string;
  project: Project;
  storyboard: Storyboard | null;
  review?: { status?: string | null; summary?: { warn?: number; issue?: number }; inputFingerprint?: string } | null;
}

export async function computeWorkflowStatus(input: ComputeWorkflowInput): Promise<WorkflowStatus> {
  const { projectPath, project, storyboard, review } = input;
  const scenes = storyboard?.scenes ?? [];
  const recordingChecks = await Promise.all(scenes.map((scene) => recordingExists(projectPath, scene.recording?.source)));
  const recorded = recordingChecks.filter(Boolean).length;
  const blockers: WorkflowIssue[] = [];
  const warnings: WorkflowIssue[] = [];

  if (!storyboard || scenes.length === 0) {
    blockers.push(issue({ severity: 'blocker', phase: 'storyboard', code: 'storyboard_missing', message: 'This project has no storyboard scenes.', recommendation: 'Create or import a storyboard before rendering.', action: 'open_storyboard' }));
  }
  scenes.forEach((scene, index) => {
    if (!recordingChecks[index]) blockers.push(issue({
      severity: 'blocker', phase: 'recordings', code: 'recording_missing', sceneId: scene.id, sceneName: scene.name, sceneNumber: index + 1,
      message: scene.recording?.source ? `${scene.name} references a recording that cannot be read.` : `${scene.name} does not have a recording.`,
      recommendation: 'Upload or record this scene.', action: 'open_scene_recording',
    }));
  });

  const activeRender = jobQueue.list({ activeOnly: true, projectId: project.id }).some((job) => job.type === 'render');
  if (activeRender) blockers.push(issue({ severity: 'blocker', phase: 'render', code: 'render_running', message: 'A full-project render is already running.', recommendation: 'Wait for the current render to finish.', action: 'open_render' }));

  const scriptCount = scenes.filter((scene) => !!(scene.narration?.script || scene.narration?.monologueScript || scene.narration?.dialogScript)).length;
  const narrationCount = scenes.filter((scene) => !!scene.narration?.audio).length;
  const lowerThirdCount = scenes.filter((scene) => (scene.lower_thirds?.length ?? 0) > 0).length;
  if (scriptCount > 0 && scriptCount < scenes.length) warnings.push(issue({ severity: 'warning', phase: 'script', code: 'scripts_partial', message: `Scripts exist for ${scriptCount} of ${scenes.length} scenes.`, recommendation: 'Finish the remaining scripts or continue without them.', action: 'open_script' }));
  if (narrationCount > 0 && narrationCount < scenes.length) warnings.push(issue({ severity: 'warning', phase: 'narration', code: 'narration_partial', message: `Narration exists for ${narrationCount} of ${scenes.length} scenes.`, recommendation: 'Generate the remaining narration or render with original audio.', action: 'open_narration' }));
  if (lowerThirdCount > 0 && lowerThirdCount < scenes.length) warnings.push(issue({ severity: 'warning', phase: 'lower-thirds', code: 'lower_thirds_partial', message: `Lower thirds are used in ${lowerThirdCount} of ${scenes.length} scenes.`, recommendation: 'Review whether the remaining scenes need labels.', action: 'open_lower_thirds' }));
  if (!review?.status) warnings.push(issue({ severity: 'warning', phase: 'review', code: 'review_unrun', message: 'Quality Review has not been run.', recommendation: 'Run Quality Review before publishing.', action: 'open_review' }));
  else if ((review.summary?.issue ?? 0) > 0 || (review.summary?.warn ?? 0) > 0) warnings.push(issue({ severity: 'warning', phase: 'review', code: 'review_findings', message: 'Quality Review has findings to inspect.', recommendation: 'Review the findings before publishing.', action: 'open_review' }));

  const outputInfo = await getFinalOutputInfo(projectPath);
  const manifest = outputInfo ? await readRenderManifest(projectPath) : null;
  let output: WorkflowStatus['render']['output'];
  if (activeRender) output = { state: 'in_progress', ...(outputInfo ?? {}) };
  else if (!outputInfo) output = { state: 'missing' };
  else if (!manifest) output = { state: 'stale', reason: 'Rendered before freshness tracking was added.', ...outputInfo };
  else {
    const currentFingerprint = await buildRenderFingerprint(projectPath, project, storyboard, manifest.options);
    output = currentFingerprint === manifest.fingerprint
      ? { state: 'current', completedAt: manifest.completedAt, ...outputInfo }
      : { state: 'stale', reason: 'Project inputs changed after this video was rendered.', completedAt: manifest.completedAt, ...outputInfo };
  }

  const hasStoryboard = scenes.length > 0;
  const recordingsComplete = hasStoryboard && recorded === scenes.length;
  const renderState: WorkflowStep['state'] = activeRender ? 'in_progress' : output.state === 'current' ? 'complete' : output.state === 'stale' ? 'stale' : recordingsComplete ? 'ready' : 'blocked';
  const reviewState: WorkflowStep['state'] = !recordingsComplete ? 'blocked' : review?.status === 'ok' ? 'complete' : review?.status ? 'in_progress' : 'ready';
  const optionalState = (count: number): WorkflowStep['state'] => count === 0 ? 'optional' : count === scenes.length ? 'complete' : 'in_progress';
  const steps: WorkflowStep[] = [
    { key: 'storyboard', label: labels.storyboard, state: hasStoryboard ? 'complete' : 'ready', summary: hasStoryboard ? `${scenes.length} scenes` : 'Create or import', completed: hasStoryboard ? scenes.length : 0, total: scenes.length || 1 },
    { key: 'recordings', label: labels.recordings, state: !hasStoryboard ? 'blocked' : recordingsComplete ? 'complete' : recorded > 0 ? 'in_progress' : 'ready', summary: `${recorded}/${scenes.length} recorded`, completed: recorded, total: scenes.length },
    { key: 'script', label: labels.script, state: optionalState(scriptCount), summary: scriptCount ? `${scriptCount}/${scenes.length}` : 'Optional', completed: scriptCount, total: scenes.length },
    { key: 'narration', label: labels.narration, state: optionalState(narrationCount), summary: narrationCount ? `${narrationCount}/${scenes.length}` : 'Optional', completed: narrationCount, total: scenes.length },
    { key: 'lower-thirds', label: labels['lower-thirds'], state: optionalState(lowerThirdCount), summary: lowerThirdCount ? `${lowerThirdCount}/${scenes.length}` : 'Optional', completed: lowerThirdCount, total: scenes.length },
    { key: 'render', label: labels.render, state: renderState, summary: output.state === 'current' ? 'Current' : output.state === 'stale' ? 'Outdated' : activeRender ? 'Rendering' : 'Not rendered', completed: output.state === 'current' ? 1 : 0, total: 1 },
    { key: 'review', label: labels.review, state: reviewState, summary: review?.status ?? 'Not run', completed: review?.status === 'ok' ? 1 : 0, total: 1 },
  ];

  const firstMissing = scenes.findIndex((_scene, index) => !recordingChecks[index]);
  const nextAction = !hasStoryboard
    ? { key: 'open_storyboard' as const, label: 'Create storyboard', summary: 'Start by defining the scenes in this video.' }
    : !recordingsComplete
      ? { key: 'open_scene_recording' as const, label: 'Add next recording', summary: `${scenes[firstMissing]?.name ?? 'A scene'} needs a recording.`, sceneId: scenes[firstMissing]?.id }
      : output.state !== 'current'
        ? { key: output.state === 'stale' ? 'render_again' as const : 'open_render' as const, label: output.state === 'stale' ? 'Render again' : 'Render project', summary: output.reason ?? 'All required recordings are ready.' }
        : { key: 'open_review' as const, label: review?.status === 'ok' ? 'Review complete' : 'Run quality review', summary: review?.status === 'ok' ? 'The project is ready.' : 'Check the finished project before publishing.' };

  const issues = [...blockers, ...warnings];
  const completed = steps.filter((step) => step.state === 'complete' || step.state === 'optional').length;
  return WorkflowStatusSchema.parse({
    projectId: project.id,
    computedAt: new Date().toISOString(),
    steps,
    nextAction,
    issues,
    counts: { blockers: blockers.length, warnings: warnings.length },
    progress: { completed, total: steps.length, percent: Math.round((completed / steps.length) * 100) },
    render: { ready: blockers.length === 0, readyScenes: recorded, totalScenes: scenes.length, blockers, warnings, output },
  });
}
