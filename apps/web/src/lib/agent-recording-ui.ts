import { AgentReviewedCaptureSchema, type AgentRecordingSession } from '@vpa/shared';

const TERMINAL_STATES = new Set<AgentRecordingSession['state']>(['completed', 'failed', 'interrupted']);

export function isActiveAgentRecordingSession(session: AgentRecordingSession | null | undefined): boolean {
  return Boolean(session && !TERMINAL_STATES.has(session.state));
}

export function hasSessionBoundConfirmationEvidence(session: AgentRecordingSession | null | undefined): boolean {
  if (session?.state !== 'awaiting_confirmation' || !session.planFingerprint || !session.rehearsal) return false;
  const evidence = session.rehearsal;
  if (!evidence.success || !evidence.resetConfirmed || !evidence.reviewedCapture || !evidence.reviewedSteps) return false;
  const reviewedCapture = AgentReviewedCaptureSchema.safeParse(evidence.reviewedCapture);
  if (!reviewedCapture.success) return false;
  if (evidence.targetApplication.trim().toLocaleLowerCase() !== reviewedCapture.data.targetApplication.trim().toLocaleLowerCase()) return false;
  const expected = evidence.reviewedSteps.map((step) => step.index).sort((left, right) => left - right);
  const completed = [...evidence.completedStepIndexes].sort((left, right) => left - right);
  return expected.length === completed.length
    && new Set(expected).size === expected.length
    && new Set(completed).size === completed.length
    && expected.every((value, index) => value === completed[index])
    && evidence.checkpoints.every((checkpoint) => checkpoint.passed);
}

export function shouldCloseAfterObservedCompletion(
  observedActiveSessionId: string | null,
  session: AgentRecordingSession | null | undefined,
): boolean {
  return Boolean(
    observedActiveSessionId
    && session?.id === observedActiveSessionId
    && session.state === 'completed',
  );
}
