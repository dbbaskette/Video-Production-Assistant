import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as childProcess from 'node:child_process';
import { detectMarkItDown, _resetCache } from './detect.js';

vi.mock('node:child_process');

describe('detectMarkItDown', () => {
  beforeEach(() => { _resetCache(); vi.resetAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns available + version when markitdown --version succeeds', async () => {
    vi.spyOn(childProcess, 'execFile').mockImplementation(((_cmd: any, _args: any, cb: any) => {
      cb(null, 'markitdown 0.0.1a3\n', '');
      return {} as any;
    }) as any);
    const result = await detectMarkItDown();
    expect(result.available).toBe(true);
    expect(result.version).toBe('0.0.1a3');
  });

  it('returns unavailable when execFile errors', async () => {
    vi.spyOn(childProcess, 'execFile').mockImplementation(((_cmd: any, _args: any, cb: any) => {
      cb(new Error('ENOENT'), '', '');
      return {} as any;
    }) as any);
    const result = await detectMarkItDown();
    expect(result.available).toBe(false);
    expect(result.version).toBeUndefined();
  });

  it('caches the result across calls', async () => {
    const spy = vi.spyOn(childProcess, 'execFile').mockImplementation(((_cmd: any, _args: any, cb: any) => {
      cb(null, 'markitdown 0.0.1\n', '');
      return {} as any;
    }) as any);
    await detectMarkItDown();
    await detectMarkItDown();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
