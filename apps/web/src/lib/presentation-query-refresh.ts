import type { QueryClient } from '@tanstack/react-query';
import type { Scene } from '@vpa/shared';

export async function invalidatePresentationSceneQueries(
  queryClient: QueryClient,
  projectId: string,
  presentationId: string,
  scenes: readonly Pick<Scene, 'id' | 'presentation_source'>[],
): Promise<void> {
  const sceneIds = scenes
    .filter((scene) => scene.presentation_source?.presentation_id === presentationId)
    .map((scene) => scene.id);
  await Promise.all(sceneIds.flatMap((sceneId) => [
    queryClient.invalidateQueries({ queryKey: ['script', projectId, sceneId] }),
    queryClient.invalidateQueries({ queryKey: ['narration', projectId, sceneId] }),
  ]));
}
