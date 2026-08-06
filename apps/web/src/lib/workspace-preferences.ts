export const WORKSPACE_PREFERENCE_KEY = 'vpa.workspace.layout.v1';

export interface WorkspacePreferences {
  projectNavCollapsed: boolean;
}

export const DEFAULT_WORKSPACE_PREFERENCES: WorkspacePreferences = {
  projectNavCollapsed: false,
};

function browserStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function readWorkspacePreferences(storage?: Storage): WorkspacePreferences {
  try {
    const value = (storage ?? browserStorage())?.getItem(WORKSPACE_PREFERENCE_KEY);
    const parsed = JSON.parse(value ?? 'null') as unknown;
    if (
      parsed
      && typeof parsed === 'object'
      && Object.keys(parsed).length === 1
      && typeof (parsed as WorkspacePreferences).projectNavCollapsed === 'boolean'
    ) {
      return {
        projectNavCollapsed: (parsed as WorkspacePreferences).projectNavCollapsed,
      };
    }
  } catch {
    // Layout preferences are optional. Storage restrictions must not block work.
  }
  return DEFAULT_WORKSPACE_PREFERENCES;
}

export function writeWorkspacePreferences(
  value: WorkspacePreferences,
  storage?: Storage,
): boolean {
  const target = storage ?? browserStorage();
  try {
    target?.setItem(WORKSPACE_PREFERENCE_KEY, JSON.stringify(value));
    return !!target;
  } catch {
    return false;
  }
}
