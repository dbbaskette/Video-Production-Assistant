import { useEffect, useRef } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { WorkflowIssue } from '@vpa/shared';
import { useWorkflowStatus, workflowActionRoute } from '../lib/pipeline.js';

export function ProjectIssuesControl({ projectId }: { projectId: string }) {
  const { data } = useWorkflowStatus(projectId);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const issues = data?.issues ?? [];

  const close = () => {
    dialogRef.current?.close();
    triggerRef.current?.focus();
  };
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const onCancel = (event: Event) => { event.preventDefault(); close(); };
    dialog.addEventListener('cancel', onCancel);
    return () => dialog.removeEventListener('cancel', onCancel);
  }, []);
  useEffect(() => {
    const open = () => { if (issues.length) dialogRef.current?.showModal(); };
    window.addEventListener('vpa:open-project-issues', open);
    return () => window.removeEventListener('vpa:open-project-issues', open);
  }, [issues.length]);

  return (
    <>
      <button ref={triggerRef} type="button" className={`project-issues-trigger${issues.length ? ' project-issues-trigger--active' : ''}`} disabled={!issues.length} onClick={() => dialogRef.current?.showModal()}>
        <AlertTriangle size={14} />
        {issues.length ? `Project issues · ${data?.counts.blockers ?? 0} blockers · ${data?.counts.warnings ?? 0} warnings` : 'Project ready'}
      </button>
      <dialog ref={dialogRef} className="project-issues-drawer" aria-labelledby="project-issues-title">
        <div className="project-issues-drawer__header">
          <div><span>Project health</span><h2 id="project-issues-title">Project issues</h2></div>
          <button type="button" onClick={close} aria-label="Close project issues"><X size={18} /></button>
        </div>
        <div className="project-issues-drawer__body">
          {(['blocker', 'warning'] as const).map((severity) => {
            const rows = issues.filter((item) => item.severity === severity);
            if (!rows.length) return null;
            return <section key={severity}>
              <h3>{severity === 'blocker' ? 'Blockers' : 'Warnings'} <span>{rows.length}</span></h3>
              {groupByPhase(rows).map(([phase, grouped]) => <div className="project-issues-group" key={phase}>
                <h4>{phaseLabel(phase)}</h4>
                {grouped.map((item) => <IssueRow key={item.id} item={item} projectId={projectId} onNavigate={close} />)}
              </div>)}
            </section>;
          })}
        </div>
      </dialog>
    </>
  );
}

function IssueRow({ item, projectId, onNavigate }: { item: WorkflowIssue; projectId: string; onNavigate: () => void }) {
  return <article className={`project-issue project-issue--${item.severity}`}>
    <div><strong>{item.sceneNumber ? `Scene ${item.sceneNumber} · ` : ''}{item.sceneName ?? item.message}</strong>{item.sceneName ? <p>{item.message}</p> : null}</div>
    <p>{item.recommendation}</p>
    <Link to={workflowActionRoute(projectId, item.action, item.sceneId)} onClick={onNavigate}>Fix this <span aria-hidden>→</span></Link>
  </article>;
}

function groupByPhase(issues: WorkflowIssue[]): Array<[string, WorkflowIssue[]]> {
  const groups = new Map<string, WorkflowIssue[]>();
  for (const item of issues) groups.set(item.phase, [...(groups.get(item.phase) ?? []), item]);
  return [...groups.entries()];
}

function phaseLabel(phase: string) {
  return phase.split('-').map((part) => part[0]?.toUpperCase() + part.slice(1)).join(' ');
}
