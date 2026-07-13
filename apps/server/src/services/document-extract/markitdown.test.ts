import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as childProcess from 'node:child_process';
import { extractWithMarkItDown, runExecFile } from './markitdown.js';

vi.mock('node:child_process');

describe('extractWithMarkItDown', () => {
  beforeEach(() => { vi.resetAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('runs markitdown <path> and returns stdout', async () => {
    vi.spyOn(childProcess, 'execFile').mockImplementation(((_cmd: any, args: any, _opts: any, cb: any) => {
      expect(args[0]).toBe('/tmp/brand.pdf');
      cb(null, '# Brand Guide\n\nPrimary color: #0091DA', '');
      return {} as any;
    }) as any);
    const out = await extractWithMarkItDown('/tmp/brand.pdf');
    expect(out).toContain('# Brand Guide');
    expect(out).toContain('#0091DA');
  });

  it('throws on subprocess error', async () => {
    vi.spyOn(childProcess, 'execFile').mockImplementation(((_cmd: any, _args: any, _opts: any, cb: any) => {
      cb(new Error('exit 1'), '', 'failed to parse');
      return {} as any;
    }) as any);
    await expect(extractWithMarkItDown('/tmp/bad.pdf')).rejects.toThrow(/markitdown failed/);
  });
});

describe('runExecFile timeout handling', () => {
  beforeEach(() => { vi.resetAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('maps a killed (SIGTERM) subprocess to a clear "timed out" error', async () => {
    // This is exactly what execFile does when the `timeout` fires: it kills
    // the child with SIGTERM and calls back with err.killed = true. The old
    // code surfaced that as an opaque "Command failed", which made a
    // slow-but-successful markitdown look like a crash.
    vi.spyOn(childProcess, 'execFile').mockImplementation(((_cmd: any, _args: any, _opts: any, cb: any) => {
      const err: any = new Error('Command failed: markitdown /tmp/big.pdf');
      err.killed = true;
      err.signal = 'SIGTERM';
      cb(err, '', 'Could not get FontBBox…');
      return {} as any;
    }) as any);
    await expect(
      runExecFile('markitdown', ['/tmp/big.pdf'], { timeout: 60_000 }),
    ).rejects.toThrow(/timed out/i);
  });

  it('passes non-timeout errors through unchanged', async () => {
    vi.spyOn(childProcess, 'execFile').mockImplementation(((_cmd: any, _args: any, _opts: any, cb: any) => {
      cb(new Error('spawn ENOENT'), '', '');
      return {} as any;
    }) as any);
    await expect(runExecFile('markitdown', ['/tmp/x.pdf'])).rejects.toThrow(/ENOENT/);
  });
});
