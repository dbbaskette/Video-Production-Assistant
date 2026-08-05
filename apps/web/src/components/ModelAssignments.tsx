import { useEffect, useRef, useState } from 'react';
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
  mergePendingRouting,
  MODEL_ASSIGNMENT_ROWS,
  optionsForRole,
  resolutionForRole,
  roleIsPending,
  routingWithAssignment,
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
  const visibleRoutingRef = useRef(routing);
  const serverRoutingRef = useRef(routing);
  const pendingRolesRef = useRef<Set<ModelTaskRole>>(new Set());
  const mutationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [pendingRoles, setPendingRoles] = useState<Set<ModelTaskRole>>(new Set());
  const [errors, setErrors] = useState<Partial<Record<ModelTaskRole, string>>>({});

  useEffect(() => {
    serverRoutingRef.current = routing;
    const merged = mergePendingRouting(routing, visibleRoutingRef.current, pendingRolesRef.current);
    visibleRoutingRef.current = merged;
    setVisibleRouting(merged);
  }, [routing]);

  function showRouting(next: ModelRoutingResponse) {
    visibleRoutingRef.current = next;
    setVisibleRouting(next);
  }

  function setRolePending(role: ModelTaskRole, pending: boolean): Set<ModelTaskRole> {
    const next = new Set(pendingRolesRef.current);
    if (pending) next.add(role);
    else next.delete(role);
    pendingRolesRef.current = next;
    setPendingRoles(next);
    return next;
  }

  async function changeAssignment(role: ModelTaskRole, value: string) {
    if (pendingRolesRef.current.has(role)) return;
    const assignment = value || null;
    setRolePending(role, true);
    setErrors((current) => ({ ...current, [role]: undefined }));
    showRouting(routingWithAssignment(visibleRoutingRef.current, role, assignment));

    const mutation = async () => {
      try {
        const updated = await onUpdate({ assignments: { [role]: assignment } });
        serverRoutingRef.current = updated;
        const remaining = setRolePending(role, false);
        showRouting(mergePendingRouting(updated, visibleRoutingRef.current, remaining));
      } catch (error) {
        const remaining = setRolePending(role, false);
        showRouting(mergePendingRouting(
          serverRoutingRef.current,
          visibleRoutingRef.current,
          remaining,
        ));
        const reason = error instanceof Error ? error.message : 'The server did not accept the change.';
        setErrors((current) => ({
          ...current,
          [role]: boundedMessage(`Could not save this assignment. The previous setting is restored. ${reason}`),
        }));
      }
    };

    const queued = mutationQueueRef.current.then(mutation, mutation);
    mutationQueueRef.current = queued.then(() => undefined, () => undefined);
    await queued;
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
                disabled={roleIsPending(pendingRoles, role)}
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
              {roleIsPending(pendingRoles, role) && (
                <span className="model-assignment-row__saving">Saving…</span>
              )}
            </div>

            <div
              className="model-assignment-row__signal"
              id={`${mode}-${role}-status`}
              aria-live="polite"
            >
              <div className="model-assignment-row__signal-topline">
                <span className="model-assignment-row__scope">{presentation.scopeLabel}</span>
                {capabilities?.text && <span className="model-capability">Text</span>}
                {capabilities?.image && <span className="model-capability">Image</span>}
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
