import { AlertTriangle, ArrowRight, Check, Circle, RotateCcw } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useWorkflowStatus, workflowActionRoute } from '../lib/pipeline.js';

export function ProjectActionCard({ projectId, onViewIssues }: { projectId: string; onViewIssues?: () => void }) {
  const { data, isLoading, error } = useWorkflowStatus(projectId);
  if (isLoading && !data) return <section className="project-action-card">Loading project status…</section>;
  if (error || !data) return <section className="project-action-card project-action-card--error">Project status is temporarily unavailable.</section>;
  const actionTo = workflowActionRoute(projectId, data.nextAction.key, data.nextAction.sceneId);
  return (
    <section className="project-action-card" aria-label="Project status">
      <div className="project-action-card__header">
        <div>
          <span className="project-action-card__eyebrow">Project progress · {data.progress.percent}%</span>
          <h2>{data.nextAction.label}</h2>
          <p>{data.nextAction.summary}</p>
        </div>
        <Link className="primary project-action-card__cta" to={actionTo}>
          {data.nextAction.key === 'render_again' ? <RotateCcw size={15} /> : null}
          Continue <ArrowRight size={16} />
        </Link>
      </div>
      <ol className="project-action-card__steps">
        {data.steps.map((step, index) => (
          <li key={step.key} title={`${step.label}: ${step.summary}`} className={`project-action-card__step project-action-card__step--${step.state}`}>
            <span>{step.state === 'complete' ? <Check size={12} /> : step.state === 'stale' ? <AlertTriangle size={12} /> : <Circle size={10} />}</span>
            <small>{index + 1}</small>
            <strong>{step.label}{step.state === 'optional' && <span className="workflow-optional">Optional</span>}</strong>
          </li>
        ))}
      </ol>
      <div className="project-action-card__issues">
        <span><strong>{data.counts.blockers}</strong> blockers</span>
        <span><strong>{data.counts.warnings}</strong> warnings</span>
        {data.issues.slice(0, 3).map((item) => (
          <Link key={item.id} to={workflowActionRoute(projectId, item.action, item.sceneId)}>
            {item.sceneName ? `${item.sceneName}: ` : ''}{item.message}
          </Link>
        ))}
        {data.issues.length > 0 && onViewIssues ? <button type="button" onClick={onViewIssues}>View all issues</button> : null}
      </div>
    </section>
  );
}
