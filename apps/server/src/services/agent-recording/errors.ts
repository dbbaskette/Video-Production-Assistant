export type AgentRecordingDomainErrorCode =
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INVALID_PLAN'
  | 'INVALID_CONFIRMATION';

/**
 * Expected failures at the coordinator/session boundary. The message is for
 * private diagnostics and tests; HTTP routes map only the code to fixed copy.
 */
export class AgentRecordingDomainError extends Error {
  constructor(
    public readonly code: AgentRecordingDomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentRecordingDomainError';
  }
}

export function isAgentRecordingDomainError(
  error: unknown,
): error is AgentRecordingDomainError {
  return error instanceof AgentRecordingDomainError;
}
