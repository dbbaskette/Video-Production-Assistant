import * as childProcess from 'node:child_process';

export interface MarkItDownStatus {
  available: boolean;
  version?: string;
}

let cache: MarkItDownStatus | null = null;

function detectExecFile(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    // Use 3-arg form so callback is the 3rd parameter — matches Node's
    // execFile(cmd, args, callback) signature and what tests assert against.
    childProcess.execFile(cmd, args, (err: Error | null, stdout: string | Buffer) => {
      if (err) {
        reject(err);
      } else {
        resolve(typeof stdout === 'string' ? stdout : stdout?.toString() ?? '');
      }
    });
  });
}

export async function detectMarkItDown(): Promise<MarkItDownStatus> {
  if (cache) return cache;
  try {
    const stdout = await detectExecFile('markitdown', ['--version']);
    const match = stdout.match(/markitdown\s+(\S+)/i);
    cache = { available: true, version: match ? match[1] : 'unknown' };
  } catch {
    cache = { available: false };
  }
  return cache;
}

export function _resetCache(): void {
  cache = null;
}
