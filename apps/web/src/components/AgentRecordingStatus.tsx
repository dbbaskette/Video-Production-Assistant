import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, CircleX, LoaderCircle } from 'lucide-react';
import { agentRecordingApi } from '../lib/api.js';

export function AgentRecordingStatus({ projectId, sceneId }: { projectId: string; sceneId: string }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: agentRecordingApi.sessionQueryKey(projectId, sceneId),
    queryFn: () => agentRecordingApi.currentSession(projectId, sceneId),
    refetchInterval: (query) => query.state.data && !['completed', 'failed', 'interrupted'].includes(query.state.data.state) ? 2000 : false,
  });
  const session = query.data;
  useEffect(() => {
    if (session?.state === 'completed') {
      queryClient.invalidateQueries({ queryKey: ['storyboard', projectId] });
      queryClient.invalidateQueries({ queryKey: ['workflow-status', projectId] });
    }
  }, [session?.state, projectId, queryClient]);
  if (!session) return null;
  const failed = session.state === 'failed' || session.state === 'interrupted';
  const done = session.state === 'completed';
  return <div className={`agent-recording-status agent-recording-status--${failed ? 'failed' : done ? 'done' : 'active'}`}>
    {failed ? <CircleX size={16} /> : done ? <CircleCheck size={16} /> : <LoaderCircle className="spin" size={16} />}
    <div><strong>{statusLabel(session.state)}</strong>{session.message && <span>{session.message}</span>}<small>Session {session.id.slice(0, 8)}</small></div>
  </div>;
}

function statusLabel(state: string) {
  const labels: Record<string, string> = { rehearsing: 'Codex is rehearsing', recording: 'Recording with Cap', exporting: 'Exporting MP4', attaching: 'Attaching to this scene', completed: 'Agent recording attached', failed: 'Agent recording stopped', interrupted: 'Agent recording interrupted' };
  return labels[state] ?? state;
}
