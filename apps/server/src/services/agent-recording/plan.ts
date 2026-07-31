import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentRecordingPlanSchema, AgentRecordingPlanUpdateSchema, type AgentRecordingPlan, type AgentRecordingPlanUpdate, type Project, type Scene } from '@vpa/shared';
import { atomicWriteFile } from '../../lib/fs-atomic.js';

function sourceFingerprint(project: Project, scene: Scene): string {
  return createHash('sha256').update(JSON.stringify({ objective: project.objective, name: scene.name, type: scene.type, intent: scene.intent, description: scene.description, shotPlan: scene.shot_plan })).digest('hex');
}

function planPath(projectPath: string, sceneId: string) {
  return join(projectPath, 'recording-plans', `${sceneId}.json`);
}

export function deriveAgentRecordingPlan(project: Project, scene: Scene): AgentRecordingPlan {
  const steps = (scene.shot_plan?.length ? scene.shot_plan : [{ index: 0, action: scene.intent || scene.description || `Demonstrate ${scene.name}` }])
    .map((step, index) => ({ index, action: step.action, ...(step.note ? { note: step.note } : {}) }));
  return AgentRecordingPlanSchema.parse({
    version: 1,
    projectId: project.id,
    projectName: project.name,
    projectObjective: project.objective,
    sceneId: scene.id,
    sceneName: scene.name,
    sceneType: scene.type,
    sceneIntent: scene.intent,
    sourceFingerprint: sourceFingerprint(project, scene),
    capture: {},
    steps,
    preconditions: ['Use a dedicated demo account or safe fixture.', 'Close notifications and unrelated sensitive applications.', 'Reset the target to the defined starting state.'],
    checkpoints: [],
    rehearseFirst: true,
    leadInSec: 2,
    tailSec: 2,
    failurePolicy: 'stop-and-do-not-attach',
    attachmentEndpoint: `/api/projects/${project.id}/scenes/${scene.id}/recording`,
    updatedAt: new Date().toISOString(),
  });
}

export async function readAgentRecordingPlan(projectPath: string, project: Project, scene: Scene): Promise<AgentRecordingPlan> {
  const derived = deriveAgentRecordingPlan(project, scene);
  try {
    const saved = AgentRecordingPlanSchema.parse(JSON.parse(await readFile(planPath(projectPath, scene.id), 'utf8')));
    return AgentRecordingPlanSchema.parse({ ...saved, stale: saved.sourceFingerprint !== derived.sourceFingerprint });
  } catch {
    return derived;
  }
}

export async function saveAgentRecordingPlan(projectPath: string, project: Project, scene: Scene, update: AgentRecordingPlanUpdate): Promise<AgentRecordingPlan> {
  const editable = AgentRecordingPlanUpdateSchema.parse(update);
  const current = deriveAgentRecordingPlan(project, scene);
  const plan = AgentRecordingPlanSchema.parse({ ...current, ...editable, stale: false, updatedAt: new Date().toISOString() });
  await atomicWriteFile(planPath(projectPath, scene.id), JSON.stringify(plan, null, 2));
  return plan;
}
