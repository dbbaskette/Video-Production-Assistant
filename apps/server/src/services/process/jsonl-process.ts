import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

const MAX_EVENTS = 500;
const MAX_STDERR_BYTES = 16 * 1024;

export interface JsonlProcessRequest {
  executable: string;
  args: string[];
  cwd: string;
  stdin: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  onEvent?: (event: Record<string, unknown>) => void;
}

export interface JsonlProcessResult {
  events: Array<Record<string, unknown>>;
  stderr: string;
  exitCode: number;
}

export interface JsonlProcessDeps {
  spawn?: typeof spawn;
}

function describeExit(request: JsonlProcessRequest, code: number, stderr: string): Error {
  const diagnostic = stderr.trim();
  return new Error(
    `${request.executable} exited with code ${code}${diagnostic ? `: ${diagnostic}` : ''}`,
  );
}

function malformedOutput(request: JsonlProcessRequest, line: string): Error {
  const preview = line.length > 200 ? `${line.slice(0, 200)}...` : line;
  return new Error(`Malformed JSONL output from ${request.executable}: ${preview}`);
}

/**
 * Run a process that emits one JSON object per stdout line.
 *
 * The process is always spawned directly (never through a shell). Output is
 * bounded so an unexpectedly chatty child cannot grow server memory without
 * limit.
 */
export async function runJsonlProcess(
  request: JsonlProcessRequest,
  deps: JsonlProcessDeps = {},
): Promise<JsonlProcessResult> {
  if (request.signal?.aborted) {
    throw new Error(`${request.executable} process aborted`);
  }

  const spawnProcess = deps.spawn ?? spawn;

  return new Promise<JsonlProcessResult>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnProcess(request.executable, request.args, {
        cwd: request.cwd,
        env: request.env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reject(new Error(`Failed to spawn ${request.executable}: ${message}`));
      return;
    }

    const events: Array<Record<string, unknown>> = [];
    const decoder = new StringDecoder('utf8');
    let stdoutBuffer = '';
    let stderrBuffer = Buffer.alloc(0);
    let parseError: Error | undefined;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeout);
      request.signal?.removeEventListener('abort', abort);
    };

    const finishWithError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const terminate = (error: Error) => {
      if (settled) return;
      child.kill('SIGTERM');
      finishWithError(error);
    };

    const timeout = setTimeout(() => {
      terminate(new Error(`${request.executable} timed out after ${request.timeoutMs}ms`));
    }, request.timeoutMs);

    const abort = () => {
      terminate(new Error(`${request.executable} process aborted`));
    };
    request.signal?.addEventListener('abort', abort, { once: true });
    // Close the small race between the pre-spawn check and listener setup.
    if (request.signal?.aborted) {
      abort();
      return;
    }

    const consumeLine = (line: string) => {
      if (!line.trim() || parseError) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        parseError = malformedOutput(request, line);
        return;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        parseError = malformedOutput(request, line);
        return;
      }
      const event = parsed as Record<string, unknown>;
      events.push(event);
      if (events.length > MAX_EVENTS) events.shift();
      try {
        request.onEvent?.(event);
      } catch (error) {
        parseError = error instanceof Error ? error : new Error(String(error));
      }
    };

    const consumeChunk = (text: string) => {
      stdoutBuffer += text;
      let newline = stdoutBuffer.indexOf('\n');
      while (newline !== -1) {
        const line = stdoutBuffer.slice(0, newline).replace(/\r$/, '');
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        consumeLine(line);
        newline = stdoutBuffer.indexOf('\n');
      }
    };

    child.stdout.on('data', (chunk: Buffer | string) => {
      consumeChunk(typeof chunk === 'string' ? chunk : decoder.write(chunk));
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      if (stderrBuffer.length >= MAX_STDERR_BYTES) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = MAX_STDERR_BYTES - stderrBuffer.length;
      stderrBuffer = Buffer.concat([stderrBuffer, bytes.subarray(0, remaining)]);
    });

    child.once('error', (error) => {
      finishWithError(new Error(
        `Failed to spawn ${request.executable}: ${error.message}`,
      ));
    });

    child.once('close', (code) => {
      if (settled) return;
      consumeChunk(decoder.end());
      if (stdoutBuffer.trim()) consumeLine(stdoutBuffer.replace(/\r$/, ''));

      const stderr = stderrBuffer.toString('utf8');
      if (parseError) {
        finishWithError(parseError);
        return;
      }
      if (typeof code !== 'number') {
        finishWithError(new Error(`${request.executable} terminated without an exit code`));
        return;
      }
      if (code !== 0) {
        finishWithError(describeExit(request, code, stderr));
        return;
      }

      settled = true;
      cleanup();
      resolve({ events, stderr, exitCode: code });
    });

    child.stdin.once('error', () => {
      // The close/error event supplies the useful process diagnostic. This
      // listener prevents an early EPIPE from becoming an unhandled event.
    });
    child.stdin.end(request.stdin);
  });
}
