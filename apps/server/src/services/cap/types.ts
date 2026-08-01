import type { JsonlProcessResult } from '../process/jsonl-process.js';

export interface CapProcessRequest {
  executable: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CapProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CapProcess {
  run(request: CapProcessRequest): Promise<CapProcessResult>;
  runJsonl(request: CapProcessRequest): Promise<JsonlProcessResult>;
}

export interface LocatedCap {
  cliPath: string;
  version: string;
}

export interface CapTarget {
  kind: 'screen' | 'window';
  id: string;
  name: string;
  application?: string;
  width?: number;
  height?: number;
}

export interface CapStartInput {
  targetKind: 'screen' | 'window';
  targetId: string;
  fps?: number;
  projectPath?: string;
  cameraId?: string;
  microphoneId?: string;
  systemAudio?: boolean;
}

export interface CapDoctorResult {
  captureReady: boolean;
  missingPermissions: Array<'screen-recording' | 'accessibility'>;
}
