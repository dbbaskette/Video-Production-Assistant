import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  ModelRoutingResponse,
  ModelRoutingUpdate,
  ModelTaskRole,
} from '@vpa/shared';
import type { ModelEntry } from '../lib/api.js';
import {
  assignmentPresentation,
  boundedMessage,
  MODEL_ASSIGNMENT_ROWS,
  optionsForRole,
  resolutionForRole,
  type AssignmentMode,
} from '../lib/model-routing.js';

interface ModelAssignmentsProps {
  mode: AssignmentMode;
  models: ModelEntry[];
  routing: ModelRoutingResponse;
  onUpdate: (update: ModelRoutingUpdate) => Promise<ModelRoutingResponse>;
}

export function ModelAssignments({
  mode,
  models,
  routing,
  onUpdate,
}: ModelAssignmentsProps) {
  const [visibleRouting, setVisibleRouting] = useState(routing);
  const [pendingRole, setPendingRole] = useState<ModelTaskRole | null>(null);
  const [errors, setErrors] = useState<Partial<Record<ModelTaskRole, string>>>({});

  useEffect(() => {
    if (!pendingRole) setVisibleRouting(routing);
  }, [routing, pendingRole]);

  async function changeAssignment(role: ModelTaskRole, value: string) {
    if (pendingRole) return;
    const previous = visibleRouting;
    const assignment = value || null;
    setPendingRole(role);
    setErrors((current) => ({ ...current, [role]: undefined }));
    setVisibleRouting({
      ...previous,
      assignments: {
        ...previous.assignments,
        ...(assignment === null ? {} : { [role]: assignment }),
      },
    });
    if (assignment === null) {
      const assignments = { ...previous.assignments };
      delete assignments[role];
      setVisibleRouting({ ...previous, assignments });
    }

    try {
      const updated = await onUpdate({ assignments: { [role]: assignment } });
      setVisibleRouting(updated);
    } catch (error) {
      setVisibleRouting(previous);
      const reason = error instanceof Error ? error.message : 'The server did not accept the change.';
      setErrors((current) => ({
        ...current,
        [role]: boundedMessage(`Could not save this assignment. The previous setting is restored. ${reason}`),
      }));
    } finally {
      setPendingRole(null);
    }
  }

  return (
    <div className={`model-assignments model-assignments--${mode}`}>
      {MODEL_ASSIGNMENT_ROWS.map(([role, label, helper]) => {
        const resolution = resolutionForRole(visibleRouting.resolved, role);
        const presentation = assignmentPresentation(resolution, mode);
        const value = visibleRouting.assignments[role] ?? '';
        const options = optionsForRole(models, role);
        const selectedModel = value ? models.find((model) => model.id === value) : undefined;
        const selectedIsCompatible = value === '' || options.some((model) => model.id === value);
        const capabilities = 'capabilities' in resolution ? resolution.capabilities : selectedModel?.capabilities;
        const detail = !resolution.ready && selectedModel
          ? `${selectedModel.provider} / ${selectedModel.model} · ${presentation.detail}`
          : presentation.detail;
        const error = errors[role];

        return (
          <div
            className={`model-assignment-row model-assignment-row--${presentation.tone}`}
            key={role}
          >
            <div className="model-assignment-row__job">
              <span className="model-assignment-row__port" aria-hidden />
              <div>
                <label htmlFor={`${mode}-${role}`}>{label}</label>
                <p>{helper}</p>
              </div>
            </div>

            <div className="model-assignment-row__choice">
              <select
                id={`${mode}-${role}`}
                value={value}
                disabled={pendingRole !== null}
                onChange={(event) => void changeAssignment(role, event.target.value)}
                aria-describedby={`${mode}-${role}-status`}
              >
                <option value="">
                  {mode === 'project' ? 'Use global setting' : 'Not assigned'}
                </option>
                {!selectedIsCompatible && value && (
                  <option value={value} disabled>
                    {selectedModel ? `${selectedModel.name} — incompatible` : `Missing model — ${value}`}
                  </option>
                )}
                {options.map((model) => (
                  <option key={model.id} value={model.id}>{model.name}</option>
                ))}
              </select>
              {pendingRole === role && <span className="model-assignment-row__saving">Saving…</span>}
            </div>

            <div
              className="model-assignment-row__signal"
              id={`${mode}-${role}-status`}
              aria-live="polite"
            >
              <div className="model-assignment-row__signal-topline">
                <span className="model-assignment-row__scope">{presentation.scopeLabel}</span>
                {capabilities?.text && <span className="model-capability">Text</span>}
                {capabilities?.video && <span className="model-capability model-capability--video">Video</span>}
              </div>
              <strong>{presentation.label}</strong>
              <span className="model-assignment-row__detail">{boundedMessage(detail)}</span>
              {presentation.remediationHref && (
                <Link to={presentation.remediationHref}>Fix the global setting</Link>
              )}
              {error && <span className="model-assignment-row__error" role="alert">{error}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
