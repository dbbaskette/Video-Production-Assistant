import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

const MAX_EVENTS = 500;
const MAX_STDERR_BYTES = 16 * 1024;
export const MAX_JSONL_FRAME_BYTES = 1024 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 1_000;
const DEFAULT_FORCE_KILL_WAIT_MS = 1_000;

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
  signalProcessTree?: (child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals) => void;
  terminationGraceMs?: number;
  forceKillWaitMs?: number;
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

function defaultSignalProcessTree(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void {
  // Detached POSIX children lead their own process group, so a negative PID
  // reaches the CLI and every subprocess it launched. Fall back to the direct
  // child on platforms without POSIX process groups or before a PID exists.
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    }
  }
  child.kill(signal);
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
  const signalProcessTree = deps.signalProcessTree ?? defaultSignalProcessTree;
  const terminationGraceMs = deps.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
  const forceKillWaitMs = deps.forceKillWaitMs ?? DEFAULT_FORCE_KILL_WAIT_MS;

  return new Promise<JsonlProcessResult>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnProcess(request.executable, request.args, {
        cwd: request.cwd,
        env: request.env,
        detached: process.platform !== 'win32',
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
    let stdoutBufferBytes = 0;
    let stderrBuffer = Buffer.alloc(0);
    let terminationError: Error | undefined;
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let terminationGrace: NodeJS.Timeout | undefined;
    let forceKillWait: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (terminationGrace) clearTimeout(terminationGrace);
      if (forceKillWait) clearTimeout(forceKillWait);
      request.signal?.removeEventListener('abort', abort);
    };

    const finishWithError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const sendSignal = (signal: NodeJS.Signals) => {
      try {
        signalProcessTree(child, signal);
      } catch {
        // Still wait for close and escalate. The bounded final timer prevents
        // a failed signaling attempt from leaving this promise pending.
      }
    };

    const terminate = (error: Error) => {
      if (settled || terminationError) return;
      terminationError = error;
      if (timeout) clearTimeout(timeout);
      request.signal?.removeEventListener('abort', abort);
      terminationGrace = setTimeout(() => {
        if (settled) return;
        forceKillWait = setTimeout(() => {
          finishWithError(new Error(
            `${error.message}; process did not close after SIGKILL`,
          ));
        }, forceKillWaitMs);
        sendSignal('SIGKILL');
      }, terminationGraceMs);
      sendSignal('SIGTERM');
    };

    timeout = setTimeout(() => {
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
      if (!line.trim() || terminationError) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        terminate(malformedOutput(request, line));
        return;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        terminate(malformedOutput(request, line));
        return;
      }
      const event = parsed as Record<string, unknown>;
      events.push(event);
      if (events.length > MAX_EVENTS) events.shift();
      try {
        request.onEvent?.(event);
      } catch (error) {
        terminate(error instanceof Error ? error : new Error(String(error)));
      }
    };

    const consumeChunk = (text: string) => {
      if (terminationError) return;
      let start = 0;
      let newline = text.indexOf('\n', start);
      while (newline !== -1) {
        const fragment = text.slice(start, newline);
        const fragmentBytes = Buffer.byteLength(fragment);
        if (stdoutBufferBytes + fragmentBytes > MAX_JSONL_FRAME_BYTES) {
          terminate(malformedOutput(
            request,
            `JSONL frame exceeded ${MAX_JSONL_FRAME_BYTES} bytes`,
          ));
          return;
        }
        stdoutBuffer += fragment;
        stdoutBufferBytes += fragmentBytes;
        consumeLine(stdoutBuffer.replace(/\r$/, ''));
        stdoutBuffer = '';
        stdoutBufferBytes = 0;
        if (terminationError) return;
        start = newline + 1;
        newline = text.indexOf('\n', start);
      }

      const fragment = text.slice(start);
      const fragmentBytes = Buffer.byteLength(fragment);
      if (stdoutBufferBytes + fragmentBytes > MAX_JSONL_FRAME_BYTES) {
        terminate(malformedOutput(
          request,
          `JSONL frame exceeded ${MAX_JSONL_FRAME_BYTES} bytes`,
        ));
        return;
      }
      stdoutBuffer += fragment;
      stdoutBufferBytes += fragmentBytes;
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
      if (terminationError) {
        finishWithError(terminationError);
        return;
      }
      consumeChunk(decoder.end());
      if (stdoutBuffer.trim()) consumeLine(stdoutBuffer.replace(/\r$/, ''));

      const stderr = stderrBuffer.toString('utf8');
      if (terminationError) {
        finishWithError(terminationError);
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
