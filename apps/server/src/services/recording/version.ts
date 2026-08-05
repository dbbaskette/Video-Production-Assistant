import { join } from 'node:path';
import type { Scene, Storyboard } from '@vpa/shared';
import { loadStoryboard } from '../storyboard/index.js';
import { sha256File } from './metadata.js';

export interface RecordingVersion {
  path: string;
  sha256: string;
}

export interface VersionedSceneRecording {
  storyboard: Storyboard;
  scene: Scene;
  version: RecordingVersion;
}

export class RecordingVersionConflictError extends Error {
  readonly code = 'recording_changed';

  constructor() {
    super('The scene recording changed during the operation.');
    this.name = 'RecordingVersionConflictError';
  }
}

export async function loadVersionedSceneRecording(
  projectPath: string,
  sceneId: string,
  fingerprint: (filePath: string) => Promise<string> = sha256File,
): Promise<VersionedSceneRecording> {
  const storyboard = await loadStoryboard(projectPath);
  const scene = storyboard?.scenes.find((candidate) => candidate.id === sceneId);
  if (!storyboard || !scene?.recording?.source) {
    throw new RecordingVersionConflictError();
  }
  const recordingPath = join(projectPath, scene.recording.source);
  return {
    storyboard,
    scene,
    version: {
      path: recordingPath,
      sha256: await fingerprint(recordingPath),
    },
  };
}

export async function loadSceneAtRecordingVersion(
  projectPath: string,
  sceneId: string,
  expected: RecordingVersion,
  fingerprint: (filePath: string) => Promise<string> = sha256File,
): Promise<VersionedSceneRecording> {
  const current = await loadVersionedSceneRecording(projectPath, sceneId, fingerprint);
  if (
    current.version.path !== expected.path
    || current.version.sha256 !== expected.sha256
  ) {
    throw new RecordingVersionConflictError();
  }
  return current;
}
