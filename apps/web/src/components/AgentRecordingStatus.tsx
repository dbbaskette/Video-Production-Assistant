import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, CircleX, LoaderCircle, Square } from 'lucide-react';
import type { AgentRecordingSession } from '@vpa/shared';
import { agentRecordingApi } from '../lib/api.js';

const terminalStates = new Set(['completed', 'failed', 'interrupted']);

export function AgentRecordingStatus({ projectId, sceneId }: { projectId: string; sceneId: string }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: agentRecordingApi.sessionQueryKey(projectId, sceneId),
    queryFn: () => agentRecordingApi.currentSession(projectId, sceneId),
    refetchInterval: (query) => query.state.data && !['completed', 'failed', 'interrupted'].includes(query.state.data.state) ? 2000 : false,
  });
  const session = query.data;
  const cancel = useMutation({
    mutationFn: (sessionId: string) => agentRecordingApi.cancel(projectId, sceneId, sessionId),
    onSuccess: (next) => queryClient.setQueryData(agentRecordingApi.sessionQueryKey(projectId, sceneId), next),
  });
  useEffect(() => {
    if (session?.state === 'completed') {
      queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] });
      queryClient.invalidateQueries({ queryKey: ['workflow-status', projectId] });
      queryClient.invalidateQueries({ queryKey: ['recording-metadata', projectId, sceneId] });
      queryClient.invalidateQueries({ queryKey: ['scene-recording', projectId, sceneId] });
      queryClient.invalidateQueries({ queryKey: agentRecordingApi.sessionQueryKey(projectId, sceneId) });
    }
  }, [session?.state, projectId, queryClient, sceneId]);
  if (!session) return null;
  const failed = session.state === 'failed' || session.state === 'interrupted';
  const done = session.state === 'completed';
  const active = !terminalStates.has(session.state);
  return <div className={`agent-recording-status agent-recording-status--${failed ? 'failed' : done ? 'done' : 'active'}`}>
    {failed ? <CircleX size={16} /> : done ? <CircleCheck size={16} /> : <LoaderCircle className="spin" size={16} />}
    <div><strong>{statusLabel(session.state)}</strong>{session.message && <span>{session.message}</span>}</div>
    {active && <button type="button" className="btn--danger" disabled={cancel.isPending} onClick={() => cancel.mutate(session.id)}><Square size={12} />{cancel.isPending ? 'Stopping…' : 'Stop'}</button>}
    {cancel.error && <span className="agent-recording-status__error" role="alert">{cancel.error.message}</span>}
  </div>;
}

function statusLabel(state: AgentRecordingSession['state']) {
  const labels: Record<AgentRecordingSession['state'], string> = {
    rehearsing: 'Codex is rehearsing',
    awaiting_confirmation: 'Ready for your recording confirmation',
    recording: 'Recording this scene with Cap',
    exporting: 'Validating and exporting the take',
    attaching: 'Attaching the recording',
    completed: 'Recording attached',
    failed: 'Recording stopped',
    interrupted: 'Recording interrupted',
  };
  return labels[state];
}
