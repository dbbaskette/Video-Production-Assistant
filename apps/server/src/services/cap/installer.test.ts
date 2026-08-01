import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CapInstaller, OFFICIAL_CAP_INSTALLER_URL } from './installer.js';
import type { CapProcessRequest } from './types.js';

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function home(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'vpa-cap-installer-'));
  homes.push(value);
  return value;
}

describe('CapInstaller', () => {
  it('requires explicit confirmation and rejects a concurrent install', async () => {
    const vpaHome = await home();
    let releaseDownload!: () => void;
    const downloader = vi.fn((_url: string, _destination: string) => new Promise<void>((resolve) => { releaseDownload = resolve; }));
    const installer = new CapInstaller({
      vpaHome,
      downloader,
      runInstaller: vi.fn(async (_request: CapProcessRequest) => ({ stdout: '', stderr: '', exitCode: 0 })),
      verify: vi.fn(async () => ({ cliPath: join(vpaHome, 'bin', 'cap'), version: '1.0.0' })),
    });

    await expect(installer.start({ confirmed: false as true })).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    const first = await installer.start({ confirmed: true });
    expect(first).toMatchObject({ state: 'installing' });
    await expect(installer.start({ confirmed: true })).rejects.toMatchObject({ code: 'INSTALL_IN_PROGRESS' });
    await vi.waitFor(() => expect(downloader).toHaveBeenCalledOnce());
    releaseDownload();
    await installer.waitForIdle();
  });

  it('downloads only the fixed URL, runs the concrete temp file with safe env, cleans up, and independently verifies', async () => {
    const vpaHome = await home();
    const downloader = vi.fn(async (_url: string, _destination: string) => undefined);
    const runInstaller = vi.fn(async (_request: CapProcessRequest) => ({ stdout: 'installed', stderr: '', exitCode: 0 }));
    const verify = vi.fn(async () => ({ cliPath: join(vpaHome, 'bin', 'cap'), version: '1.4.0' }));
    const statuses: string[] = [];
    const installer = new CapInstaller({
      vpaHome,
      downloader,
      runInstaller,
      verify,
      onState: (state) => { statuses.push(state.state); },
    });

    const started = await installer.start({ confirmed: true });
    await installer.waitForIdle();

    expect(started.installationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(downloader).toHaveBeenCalledOnce();
    const [url, destination] = downloader.mock.calls[0]!;
    expect(url).toBe(OFFICIAL_CAP_INSTALLER_URL);
    expect(destination).toMatch(/cap-install-[^/]+\/install-cli\.sh$/);
    expect(runInstaller).toHaveBeenCalledWith(expect.objectContaining({
      executable: '/bin/sh',
      args: [destination],
      env: expect.objectContaining({
        CAP_CLI_INSTALL_DIR: join(vpaHome, 'bin'),
        CAP_NO_MODIFY_PATH: '1',
      }),
    }));
    const env = runInstaller.mock.calls[0]![0]!.env as NodeJS.ProcessEnv;
    expect(env.CAP_API_KEY).toBeUndefined();
    expect(env.CAP_SERVER_URL).toBeUndefined();
    expect(Object.keys(env).filter((key) => key.startsWith('CAP_')).sort()).toEqual([
      'CAP_CLI_INSTALL_DIR',
      'CAP_NO_MODIFY_PATH',
    ]);
    expect(verify).toHaveBeenCalledOnce();
    expect(statuses).toEqual(['installing', 'ready']);
    await expect(import('node:fs/promises').then(({ stat }) => stat(join(destination, '..')))).rejects.toThrow();
  });

  it('publishes a bounded error when the installer fails and does not claim readiness', async () => {
    const vpaHome = await home();
    const statuses: Array<{ state: string; message?: string }> = [];
    const verify = vi.fn(async () => null);
    const installer = new CapInstaller({
      vpaHome,
      downloader: vi.fn(async (_url: string, _destination: string) => undefined),
      runInstaller: vi.fn(async (_request: CapProcessRequest) => ({ stdout: '', stderr: 'bad'.repeat(2_000), exitCode: 7 })),
      verify,
      onState: (state) => { statuses.push(state); },
    });

    await installer.start({ confirmed: true });
    await installer.waitForIdle();

    expect(verify).toHaveBeenCalledOnce();
    expect(statuses.at(-1)?.state).toBe('error');
    expect(Buffer.byteLength(statuses.at(-1)?.message ?? '')).toBeLessThanOrEqual(2_048);
  });
});
