import { homedir } from 'node:os';
import path from 'node:path';

function expandHome(p: string): string {
  if (p.startsWith('~')) return path.join(homedir(), p.slice(1));
  return p;
}

export interface LlmConfig {
  provider: 'fake' | 'gemini' | 'anthropic' | 'claude-code';
  apiKey?: string;
  model?: string;
}

export interface ServerConfig {
  port: number;
  host: string;
  vpaHome: string;       // expanded absolute path
  projectsDefault: string; // expanded absolute path
  webOrigin: string;
  llm: LlmConfig;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const vpaHome = expandHome(env.VPA_HOME ?? '~/.vpa');
  const projectsDefault = expandHome(env.VPA_PROJECTS_DEFAULT ?? '~/Movies/VPA');
  const port = Number(env.VPA_SERVER_PORT ?? 3000);
  const host = env.VPA_SERVER_HOST ?? '127.0.0.1';
  const webOrigin = env.VPA_WEB_ORIGIN ?? 'http://localhost:5173';

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid VPA_SERVER_PORT: ${env.VPA_SERVER_PORT}`);
  }
  const validProviders = ['fake', 'claude-code', 'gemini', 'anthropic'] as const;
  const rawProvider = env.VPA_LLM_PROVIDER ?? 'fake';
  if (!validProviders.includes(rawProvider as typeof validProviders[number])) {
    throw new Error(`Invalid VPA_LLM_PROVIDER="${rawProvider}". Valid: ${validProviders.join(', ')}`);
  }
  const llmProvider = rawProvider as LlmConfig['provider'];
  let llmApiKey: string | undefined;
  if (llmProvider === 'gemini') {
    llmApiKey = env.GEMINI_API_KEY;
  } else if (llmProvider === 'anthropic') {
    // Direct Anthropic REST API — requires an API key
    llmApiKey = env.ANTHROPIC_API_KEY;
  }
  // 'claude-code' uses `claude -p` subprocess — no API key needed
  const llmModel = env.VPA_LLM_MODEL || undefined;

  const llm: LlmConfig = { provider: llmProvider, apiKey: llmApiKey, model: llmModel };

  return { port, host, vpaHome, projectsDefault, webOrigin, llm };
}
