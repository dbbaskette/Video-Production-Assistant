import * as childProcess from 'node:child_process';

// Extraction runs OFF the request path — the source-docs register step defers
// it to a background pass, and brand generation runs it in a job. So a
// generous ceiling is safe; it only guards a genuinely hung process. Large,
// font-heavy PDFs are slow under pdfminer (a 37 MB doc measured ~66 s), and
// the old 60 s limit killed them mid-extraction — surfacing as an opaque
// "Command failed" even though markitdown would have succeeded.
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
// markdown output can be multiple MB for a big manual; keep plenty of headroom
// so a large-but-valid extract isn't killed by a maxBuffer overflow either.
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

export interface RunExecFileOptions {
  timeout?: number;
  maxBuffer?: number;
}

/**
 * Promise wrapper around execFile that returns stdout. Distinguishes a
 * timeout (execFile kills the child with SIGTERM when `timeout` fires and
 * calls back with `err.killed = true`) from a real failure, so a
 * slow-but-successful command reports "timed out" instead of a generic
 * "Command failed". Exported for testing the timeout mapping.
 */
export function runExecFile(
  cmd: string,
  args: string[],
  options: RunExecFileOptions = {},
): Promise<string> {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  return new Promise((resolve, reject) => {
    childProcess.execFile(
      cmd,
      args,
      { timeout, maxBuffer },
      (err: (Error & { killed?: boolean; signal?: string }) | null, stdout: string | Buffer) => {
        if (err) {
          if (err.killed || err.signal === 'SIGTERM') {
            reject(new Error(`timed out after ${Math.round(timeout / 1000)}s`));
          } else {
            reject(err);
          }
          return;
        }
        resolve(typeof stdout === 'string' ? stdout : stdout?.toString() ?? '');
      },
    );
  });
}

export async function extractWithMarkItDown(
  path: string,
  options: RunExecFileOptions = {},
): Promise<string> {
  try {
    return await runExecFile('markitdown', [path], options);
  } catch (err: any) {
    throw new Error(`markitdown failed for ${path}: ${err.message}`);
  }
}
