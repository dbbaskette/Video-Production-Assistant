import { homedir } from 'node:os';
import path from 'node:path';

function expandHome(p: string): string {
  if (p.startsWith('~')) return path.join(homedir(), p.slice(1));
  return p;
}

export interface ServerConfig {
  port: number;
  host: string;
  vpaHome: string;       // expanded absolute path
  projectsDefault: string; // expanded absolute path
  webOrigin: string;
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
  return { port, host, vpaHome, projectsDefault, webOrigin };
}
