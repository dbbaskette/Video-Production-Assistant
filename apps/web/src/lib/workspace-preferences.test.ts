import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKSPACE_PREFERENCES,
  readWorkspacePreferences,
  WORKSPACE_PREFERENCE_KEY,
  writeWorkspacePreferences,
} from './workspace-preferences.js';

describe('workspace preferences', () => {
  it('accepts the current boolean preference shape', () => {
    const storage = memoryStorage();
    storage.setItem(WORKSPACE_PREFERENCE_KEY, JSON.stringify({ projectNavCollapsed: true }));
    expect(readWorkspacePreferences(storage)).toEqual({ projectNavCollapsed: true });
  });

  it.each([
    'not json',
    JSON.stringify(null),
    JSON.stringify({}),
    JSON.stringify({ projectNavCollapsed: 'yes' }),
    JSON.stringify({ version: 0, projectNavCollapsed: true }),
  ])('rejects malformed or stale data: %s', (value) => {
    const storage = memoryStorage();
    storage.setItem(WORKSPACE_PREFERENCE_KEY, value);
    expect(readWorkspacePreferences(storage)).toEqual(DEFAULT_WORKSPACE_PREFERENCES);
  });

  it('writes the versioned preference key', () => {
    const storage = memoryStorage();
    expect(writeWorkspacePreferences({ projectNavCollapsed: true }, storage)).toBe(true);
    expect(storage.getItem(WORKSPACE_PREFERENCE_KEY)).toBe(
      JSON.stringify({ projectNavCollapsed: true }),
    );
  });

  it('falls back when storage reads or writes fail', () => {
    const broken = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    } as unknown as Storage;

    expect(readWorkspacePreferences(broken)).toEqual(DEFAULT_WORKSPACE_PREFERENCES);
    expect(writeWorkspacePreferences({ projectNavCollapsed: true }, broken)).toBe(false);
  });
});

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}
