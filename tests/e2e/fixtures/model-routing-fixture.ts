import { readFile, writeFile } from 'node:fs/promises';

export const MODEL_ROUTING_E2E_HOME = '/tmp/vpa-model-routing-e2e-home';
export const MODEL_ROUTING_E2E_PROJECTS = '/tmp/vpa-model-routing-e2e-projects';
export const MODEL_ROUTING_E2E_CALLS = `${MODEL_ROUTING_E2E_HOME}/provider-calls.jsonl`;

export const MODEL_IDS = {
  primaryVideo: 'e2e-gemini-primary',
  secondaryVideo: 'e2e-gemini-secondary',
  writer: 'codex-cli',
  projectWriter: 'claude-code',
  unavailableWriter: 'e2e-unavailable-writer',
} as const;

export interface ModelRoutingE2eCall {
  kind: 'video.upload' | 'video.wait' | 'video.generate' | 'video.delete' | 'text.complete';
  entryId?: string;
  provider?: string;
  model?: string;
  inputPath?: string;
  fileName?: string;
  userPrompt?: string;
  systemPrompt?: string;
  responseFormat?: string;
}

export async function readModelRoutingE2eCalls(): Promise<ModelRoutingE2eCall[]> {
  let raw: string;
  try {
    raw = await readFile(MODEL_ROUTING_E2E_CALLS, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ModelRoutingE2eCall);
}

export async function clearModelRoutingE2eCalls(): Promise<void> {
  await writeFile(MODEL_ROUTING_E2E_CALLS, '', 'utf8');
}
