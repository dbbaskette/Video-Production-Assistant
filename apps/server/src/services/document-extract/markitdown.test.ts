import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as childProcess from 'node:child_process';
import { extractWithMarkItDown } from './markitdown.js';

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
