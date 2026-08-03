const SAFE_DIAGNOSTIC_IDENTIFIER = /^[A-Za-z0-9_-]{1,120}$/;
const SECRET_LIKE_IDENTIFIER =
  /(?:api[_-]?key|authorization|bearer|credential|password|secret|token)/i;

export function safeSceneDiagnosticFields(
  sceneId: unknown,
): { sceneId?: string } {
  if (
    typeof sceneId !== 'string'
    || !SAFE_DIAGNOSTIC_IDENTIFIER.test(sceneId)
    || SECRET_LIKE_IDENTIFIER.test(sceneId)
  ) {
    return {};
  }
  return { sceneId };
}
