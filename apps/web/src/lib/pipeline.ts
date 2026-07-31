import { useQuery } from '@tanstack/react-query';
import type { WorkflowActionKey, WorkflowStepKey, WorkflowStepState } from '@vpa/shared';
import { workflowStatusApi } from './api.js';

export type PipelineStepStatus = 'done' | 'next' | 'todo' | 'stale';

export interface PipelineStep {
  key: WorkflowStepKey;
  label: string;
  to: string;
  status: PipelineStepStatus;
  state: WorkflowStepState;
  detail?: string;
}

export function workflowActionRoute(projectId: string, action: WorkflowActionKey, sceneId?: string): string {
  if (action === 'open_storyboard') return `/project/${projectId}/storyboard`;
  if (action === 'open_recordings') return `/project/${projectId}/recordings`;
  if (action === 'open_script') return `/project/${projectId}/script`;
  if (action === 'open_narration') return `/project/${projectId}/narration`;
  if (action === 'open_lower_thirds') return `/project/${projectId}/lower-thirds`;
  if (action === 'open_review') return `/project/${projectId}/review`;
  if (action === 'open_scene_recording' && sceneId) {
    return `/project/${projectId}/storyboard?scene=${encodeURIComponent(sceneId)}&tab=Recording`;
  }
  return `/project/${projectId}/render`;
}

function stepRoute(projectId: string, key: WorkflowStepKey): string {
  const actionByStep: Record<WorkflowStepKey, WorkflowActionKey> = {
    storyboard: 'open_storyboard', recordings: 'open_recordings', script: 'open_script',
    narration: 'open_narration', 'lower-thirds': 'open_lower_thirds', render: 'open_render', review: 'open_review',
  };
  return workflowActionRoute(projectId, actionByStep[key]);
}

export function useWorkflowStatus(projectId: string | undefined) {
  return useQuery({
    queryKey: workflowStatusApi.queryKey(projectId),
    queryFn: () => workflowStatusApi.get(projectId!),
    enabled: !!projectId,
    placeholderData: (previous) => previous,
    refetchInterval: (query) => query.state.data?.render.output.state === 'in_progress' ? 1500 : 5000,
  });
}

export function usePipelineSteps(projectId: string | undefined) {
  const query = useWorkflowStatus(projectId);
  const data = query.data;
  const nextRoute = data && projectId ? workflowActionRoute(projectId, data.nextAction.key, data.nextAction.sceneId) : null;
  const nextStepKey = data?.nextAction.key === 'open_scene_recording' ? 'recordings'
    : data?.nextAction.key === 'render_again' ? 'render'
      : data?.nextAction.key.replace(/^open_/, '').replace('_', '-') as WorkflowStepKey | undefined;
  const steps: PipelineStep[] = !data || !projectId ? [] : data.steps.map((step) => ({
    key: step.key,
    label: step.label,
    detail: step.summary,
    state: step.state,
    to: step.key === nextStepKey && nextRoute ? nextRoute : stepRoute(projectId, step.key),
    status: step.key === nextStepKey ? 'next' : step.state === 'complete' || step.state === 'optional' ? 'done' : step.state === 'stale' ? 'stale' : 'todo',
  }));
  return {
    ...query,
    steps,
    next: steps.find((step) => step.status === 'next'),
    allDone: !!data && data.steps.every((step) => step.state === 'complete' || step.state === 'optional'),
  };
}
