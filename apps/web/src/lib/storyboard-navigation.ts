import type { Scene, SceneType } from '@vpa/shared';

export type SceneReadiness =
  | 'all'
  | 'needs-recording'
  | 'needs-script'
  | 'needs-narration';

export interface SceneFilters {
  query: string;
  type: 'all' | SceneType;
  readiness: SceneReadiness;
}

export const DEFAULT_SCENE_FILTERS: SceneFilters = {
  query: '',
  type: 'all',
  readiness: 'all',
};

export function sceneHasScript(scene: Scene): boolean {
  const narration = scene.narration;
  return [narration?.script, narration?.monologueScript, narration?.dialogScript]
    .some((value) => !!value?.trim());
}

export function sceneHasNarrationAudio(scene: Scene): boolean {
  return !!scene.narration?.audio
    || !!scene.narration?.chunks?.some((chunk) => !!chunk.audio);
}

export function filterStoryboardScenes(
  scenes: readonly Scene[],
  filters: SceneFilters,
): Scene[] {
  const query = filters.query.trim().toLocaleLowerCase();

  return scenes.filter((scene) => {
    const matchesText = query.length === 0
      || `${scene.name}\n${scene.description}`.toLocaleLowerCase().includes(query);
    const matchesType = filters.type === 'all' || scene.type === filters.type;
    const matchesReadiness = filters.readiness === 'all'
      || (filters.readiness === 'needs-recording' && !scene.recording)
      || (filters.readiness === 'needs-script' && !sceneHasScript(scene))
      || (
        filters.readiness === 'needs-narration'
        && sceneHasScript(scene)
        && !sceneHasNarrationAudio(scene)
      );
    return matchesText && matchesType && matchesReadiness;
  });
}

export function displayedSceneOrder(
  scenes: readonly Scene[],
  selectedId: string | null,
  filters: SceneFilters,
): Scene[] {
  const matching = filterStoryboardScenes(scenes, filters);
  if (!selectedId || matching.some((scene) => scene.id === selectedId)) return matching;

  const selected = scenes.find((scene) => scene.id === selectedId);
  return selected ? [selected, ...matching] : matching;
}

export function sceneNeighbor(
  displayedScenes: readonly { id: string }[],
  selectedId: string | null,
  direction: -1 | 1,
): string | null {
  if (!selectedId) return null;
  const index = displayedScenes.findIndex((scene) => scene.id === selectedId);
  if (index < 0) return null;
  return displayedScenes[index + direction]?.id ?? null;
}

type SceneShortcutEvent = Pick<
  KeyboardEvent,
  'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'target'
>;

export function canUseSceneShortcut(event: SceneShortcutEvent): boolean {
  if (event.key !== '[' && event.key !== ']') return false;
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  if (typeof document !== 'undefined' && document.querySelector('dialog[open], [role="dialog"]')) {
    return false;
  }

  const target = event.target;
  if (!(target instanceof Element)) return true;
  return !target.closest([
    'input',
    'textarea',
    'select',
    'button',
    'a',
    '[contenteditable="true"]',
    '[role="menu"]',
    '[role="dialog"]',
  ].join(','));
}

export function sceneSelectionAfterRemoval(
  previousScenes: readonly { id: string }[],
  nextScenes: readonly { id: string }[],
  selectedId: string | null,
): string | null {
  if (selectedId && nextScenes.some((scene) => scene.id === selectedId)) return selectedId;

  const previousIndex = selectedId
    ? previousScenes.findIndex((scene) => scene.id === selectedId)
    : 0;
  const safeIndex = previousIndex >= 0 ? previousIndex : 0;
  return nextScenes[safeIndex]?.id
    ?? nextScenes[safeIndex - 1]?.id
    ?? nextScenes[0]?.id
    ?? null;
}
