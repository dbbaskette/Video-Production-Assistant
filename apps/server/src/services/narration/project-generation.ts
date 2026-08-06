import type { Expressiveness, Scene } from '@vpa/shared';
import type { LlmClient } from '../llm/index.js';
import { loadStoryboard } from '../storyboard/index.js';
import {
  inspectNarrationBatch,
  type BatchInput,
  type BatchProgress,
  type BatchVoiceSelection,
} from './index.js';

export interface ProjectNarrationInput {
  projectPath: string;
  scenes: Array<{ id: string; name: string }>;
  engine: string;
  voice: string;
  speed: number;
  expressiveness: Expressiveness;
  overwrite: boolean;
}

export interface ProjectNarrationFailure {
  sceneId: string;
  sceneName: string;
  code: 'scene_generation_failed';
}

export interface ProjectNarrationResult {
  totalScenes: number;
  generatedScenes: number;
  generatedChunks: number;
  preservedScenes: number;
  noScriptScenes: number;
  removedScenes: number;
  failedScenes: number;
  cancelled: boolean;
  failures: ProjectNarrationFailure[];
}

export interface ProjectNarrationProgress {
  type: 'scene-start' | 'scene-complete' | 'scene-skipped' | 'scene-failed' | 'cancelled' | 'done';
  sceneId?: string;
  sceneName?: string;
  totalScenes: number;
  processedScenes: number;
  generatedScenes: number;
  generatedChunks: number;
  failedScenes: number;
  message: string;
}

export interface ProjectNarrationDependencies {
  loadStoryboard: typeof loadStoryboard;
  inspectBatch: typeof inspectNarrationBatch;
  resolveWriter: (
    scene: Scene,
    selection: BatchVoiceSelection,
  ) => Promise<LlmClient | undefined>;
  generateScene: (
    input: BatchInput,
    writer: LlmClient | undefined,
    onProgress: (progress: BatchProgress) => void,
    isCancelled: () => boolean,
  ) => Promise<{ total: number; completed: number; failed: number }>;
  onProgress: (progress: ProjectNarrationProgress) => void;
  isCancelled: () => boolean;
}

const MAX_PUBLIC_FAILURES = 20;

export async function generateProjectNarration(
  input: ProjectNarrationInput,
  dependencies: ProjectNarrationDependencies,
): Promise<ProjectNarrationResult> {
  const result: ProjectNarrationResult = {
    totalScenes: input.scenes.length,
    generatedScenes: 0,
    generatedChunks: 0,
    preservedScenes: 0,
    noScriptScenes: 0,
    removedScenes: 0,
    failedScenes: 0,
    cancelled: false,
    failures: [],
  };
  let processedScenes = 0;

  const emit = (
    type: ProjectNarrationProgress['type'],
    message: string,
    current?: { id: string; name: string },
  ) => dependencies.onProgress({
    type,
    sceneId: current?.id,
    sceneName: current?.name,
    totalScenes: result.totalScenes,
    processedScenes,
    generatedScenes: result.generatedScenes,
    generatedChunks: result.generatedChunks,
    failedScenes: result.failedScenes,
    message,
  });

  for (const snapshot of input.scenes) {
    if (dependencies.isCancelled()) {
      result.cancelled = true;
      emit('cancelled', 'Project narration cancelled');
      break;
    }

    const storyboard = await dependencies.loadStoryboard(input.projectPath);
    const scene = storyboard?.scenes.find((candidate) => candidate.id === snapshot.id);
    if (!scene) {
      result.removedScenes += 1;
      processedScenes += 1;
      emit('scene-skipped', 'Scene no longer exists', snapshot);
      continue;
    }

    const script = scene.narration?.script?.trim() ?? '';
    if (!script) {
      result.noScriptScenes += 1;
      processedScenes += 1;
      emit('scene-skipped', 'No script; skipped', snapshot);
      continue;
    }

    const selection: BatchVoiceSelection = {
      engine: input.engine,
      voice: input.voice,
      speed: input.speed,
      selector: input.overwrite ? 'all' : 'missing',
    };
    const inspection = dependencies.inspectBatch(scene, selection);
    if (inspection.targetCount === 0) {
      result.preservedScenes += 1;
      processedScenes += 1;
      emit('scene-skipped', 'Existing narration preserved', snapshot);
      continue;
    }

    emit('scene-start', 'Generating narration', snapshot);
    try {
      const writer = inspection.requiresWriting
        ? await dependencies.resolveWriter(scene, selection)
        : undefined;
      const generated = await dependencies.generateScene(
        {
          projectPath: input.projectPath,
          sceneId: snapshot.id,
          engine: input.engine,
          voice: input.voice,
          speed: input.speed,
          expressiveness: input.expressiveness,
          selector: selection.selector,
        },
        writer,
        () => {},
        dependencies.isCancelled,
      );
      result.generatedChunks += generated.completed;
      if (generated.completed > 0) result.generatedScenes += 1;
      if (generated.failed > 0) {
        result.failedScenes += 1;
        if (result.failures.length < MAX_PUBLIC_FAILURES) {
          result.failures.push({
            sceneId: snapshot.id,
            sceneName: snapshot.name,
            code: 'scene_generation_failed',
          });
        }
      }
      processedScenes += 1;
      emit(generated.failed > 0 ? 'scene-failed' : 'scene-complete', 'Scene processed', snapshot);
    } catch {
      result.failedScenes += 1;
      if (result.failures.length < MAX_PUBLIC_FAILURES) {
        result.failures.push({
          sceneId: snapshot.id,
          sceneName: snapshot.name,
          code: 'scene_generation_failed',
        });
      }
      processedScenes += 1;
      emit('scene-failed', 'Scene narration failed', snapshot);
    }
  }

  if (!result.cancelled) emit('done', 'Project narration complete');
  return result;
}
