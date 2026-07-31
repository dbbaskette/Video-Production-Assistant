import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Clipboard, X } from 'lucide-react';
import type { AgentRecordingPlan, AgentRecordingPlanUpdate } from '@vpa/shared';
import { agentRecordingApi, BASE } from '../lib/api.js';

export function AgentRecordingDialog({ projectId, sceneId, open, onClose, onManualUpload }: { projectId: string; sceneId: string; open: boolean; onClose: () => void; onManualUpload: () => void }) {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: agentRecordingApi.queryKey(projectId, sceneId), queryFn: () => agentRecordingApi.getPlan(projectId, sceneId), enabled: open });
  const [draft, setDraft] = useState<AgentRecordingPlanUpdate | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (query.data) setDraft(editable(query.data)); }, [query.data]);
  const save = useMutation({
    mutationFn: (value: AgentRecordingPlanUpdate) => agentRecordingApi.savePlan(projectId, sceneId, value),
    onSuccess: (plan) => queryClient.setQueryData(agentRecordingApi.queryKey(projectId, sceneId), plan),
  });
  if (!open) return null;
  const unsupported = query.data?.sceneType === 'terminal' || /^(terminal|chatgpt)$/i.test(draft?.capture.targetApplication.trim() ?? '');

  const copyHandoff = async () => {
    if (!draft) return;
    const plan = await save.mutateAsync(draft);
    const planUrl = `${BASE}/api/projects/${projectId}/scenes/${sceneId}/agent-recording/plan`;
    await navigator.clipboard.writeText([
      'Use $vpa-agent-recording in this repository.',
      `Fetch and follow this reviewed plan exactly: ${planUrl}`,
      `Project: ${plan.projectId}`,
      `Scene: ${plan.sceneId}`,
      'Rehearse first. Do not begin recording until you show me the target and capture settings and I explicitly confirm.',
    ].join('\n'));
    setCopied(true);
  };

  return <div className="agent-recording-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="agent-recording-dialog" role="dialog" aria-modal="true" aria-labelledby="agent-recording-title">
      <header><div><span>Cap + Codex</span><h2 id="agent-recording-title">Prepare agent recording</h2></div><button onClick={onClose} aria-label="Close"><X size={18} /></button></header>
      {query.isLoading || !draft ? <div className="agent-recording-dialog__body">Building the scene plan…</div> : <>
        <div className="agent-recording-dialog__body">
          {query.data?.stale && <p className="agent-recording-notice">The scene changed after this plan was saved. Review and save it again.</p>}
          <div className="agent-recording-grid">
            <label>Target application<input value={draft.capture.targetApplication} placeholder="Safari, Chrome, Figma…" onChange={(event) => setDraft({ ...draft, capture: { ...draft.capture, targetApplication: event.target.value } })} /></label>
            <label>Starting URL<input type="url" value={draft.capture.startingUrl} placeholder="https://…" onChange={(event) => setDraft({ ...draft, capture: { ...draft.capture, startingUrl: event.target.value } })} /></label>
            <label>Capture target<select value={draft.capture.targetKind} onChange={(event) => setDraft({ ...draft, capture: { ...draft.capture, targetKind: event.target.value as 'window' | 'screen' } })}><option value="window">Application window</option><option value="screen">Entire screen</option></select></label>
            <label>Frame rate<select value={draft.capture.fps} onChange={(event) => setDraft({ ...draft, capture: { ...draft.capture, fps: Number(event.target.value) } })}><option value="30">30 fps</option><option value="60">60 fps</option></select></label>
          </div>
          <fieldset><legend>Capture</legend>{(['cursor', 'microphone', 'camera', 'systemAudio'] as const).map((key) => <label className="agent-recording-check" key={key}><input type="checkbox" checked={draft.capture[key]} onChange={(event) => setDraft({ ...draft, capture: { ...draft.capture, [key]: event.target.checked } })} />{label(key)}</label>)}</fieldset>
          <div className="agent-recording-plan"><h3>Actions</h3>{draft.steps.map((step, index) => <label key={index}><span>{index + 1}</span><input value={step.action} onChange={(event) => setDraft({ ...draft, steps: draft.steps.map((item, itemIndex) => itemIndex === index ? { ...item, action: event.target.value } : item) })} /></label>)}</div>
          <div className="agent-recording-readiness"><h3>Readiness</h3>{draft.preconditions.map((item) => <p key={item}><Check size={13} />{item}</p>)}<p><Check size={13} />Rehearse first is required.</p></div>
          <p className={unsupported ? 'agent-recording-warning' : 'agent-recording-note'}>{unsupported ? 'Terminal and ChatGPT targets cannot be driven with Computer Use. Choose a supported browser or desktop application, or upload manually.' : 'VPA prepares the instructions. Copying them does not launch Codex or start recording.'}</p>
          {save.error && <p className="agent-recording-warning">{save.error instanceof Error ? save.error.message : 'Could not save the plan.'}</p>}
        </div>
        <footer><button type="button" onClick={onManualUpload}>Upload manually</button><button className="primary" disabled={unsupported || save.isPending || !draft.capture.targetApplication.trim()} onClick={copyHandoff}><Clipboard size={14} />{copied ? 'Copied Codex handoff' : save.isPending ? 'Saving…' : 'Save & copy Codex handoff'}</button></footer>
      </>}
    </section>
  </div>;
}

function editable(plan: AgentRecordingPlan): AgentRecordingPlanUpdate {
  return { capture: plan.capture, steps: plan.steps, preconditions: plan.preconditions, checkpoints: plan.checkpoints, rehearseFirst: true, leadInSec: plan.leadInSec, tailSec: plan.tailSec };
}
function label(value: string) { return value.replace(/([A-Z])/g, ' $1').replace(/^./, (letter) => letter.toUpperCase()); }
