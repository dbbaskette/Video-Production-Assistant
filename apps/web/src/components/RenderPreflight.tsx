import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { WorkflowStatus } from '@vpa/shared';
import { workflowActionRoute } from '../lib/pipeline.js';

export function RenderPreflight({ projectId, status }: { projectId: string; status: WorkflowStatus }) {
  const { render } = status;
  return <section className={`render-preflight ${render.ready ? 'render-preflight--ready' : 'render-preflight--blocked'}`} aria-label="Render readiness">
    <div className="render-preflight__summary">
      {render.ready ? <CheckCircle2 size={19} /> : <XCircle size={19} />}
      <div><strong>{render.ready ? 'Ready to render' : 'Not ready to render'}</strong><span>{render.readyScenes} of {render.totalScenes} scenes have usable recordings</span></div>
    </div>
    {render.blockers.length > 0 && <div className="render-preflight__list">
      <h4>Fix before rendering</h4>
      {render.blockers.map((item) => <Link key={item.id} to={workflowActionRoute(projectId, item.action, item.sceneId)}><XCircle size={14} /><span>{item.message}</span><b>Fix →</b></Link>)}
    </div>}
    {render.warnings.length > 0 && <details><summary><AlertTriangle size={14} /> {render.warnings.length} warning{render.warnings.length === 1 ? '' : 's'} to review</summary>
      <div className="render-preflight__list">{render.warnings.map((item) => <Link key={item.id} to={workflowActionRoute(projectId, item.action, item.sceneId)}><AlertTriangle size={14} /><span>{item.message}</span><b>Review →</b></Link>)}</div>
    </details>}
  </section>;
}
