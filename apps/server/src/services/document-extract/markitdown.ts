import * as childProcess from 'node:child_process';

const TIMEOUT_MS = 60_000;
const MAX_BUFFER = 25 * 1024 * 1024;

function runExecFile(
  cmd: string,
  args: string[],
  options: { timeout: number; maxBuffer: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    childProcess.execFile(cmd, args, options, (err: Error | null, stdout: string | Buffer) => {
      if (err) {
        reject(err);
      } else {
        resolve(typeof stdout === 'string' ? stdout : stdout?.toString() ?? '');
      }
    });
  });
}

export async function extractWithMarkItDown(path: string): Promise<string> {
  try {
    return await runExecFile('markitdown', [path], {
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
  } catch (err: any) {
    throw new Error(`markitdown failed for ${path}: ${err.message}`);
  }
}
