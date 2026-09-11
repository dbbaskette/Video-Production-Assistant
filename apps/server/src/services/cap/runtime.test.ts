import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MockedFunction } from 'vitest';
import { CapLocator } from './locator.js';
import { ManagedCapRuntime } from './runtime.js';
import type { CapProcess, CapProcessRequest, CapProcessResult } from './types.js';

const homes: string[] = [];

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'vpa-cap-runtime-'));
  homes.push(home);
  return home;
}

async function executable(path: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, '#!/bin/sh\nexit 0\n');
  await chmod(path, 0o755);
}

function result(stdout: string): CapProcessResult {
  return { stdout, stderr: '', exitCode: 0 };
}

function processDouble(
  handler: (request: CapProcessRequest) => Promise<CapProcessResult>,
): CapProcess & {
  run: MockedFunction<CapProcess['run']>;
  runJsonl: MockedFunction<CapProcess['runJsonl']>;
} {
  const run = vi.fn(handler) as MockedFunction<CapProcess['run']>;
  const runJsonl = vi.fn(async (request: CapProcessRequest) => {
      const command = await handler(request);
      const events = command.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      for (const event of events) request.onEvent?.(event);
      return {
        events,
        stderr: command.stderr,
        exitCode: command.exitCode,
      };
    }) as MockedFunction<CapProcess['runJsonl']>;
  return { run, runJsonl };
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe('CapLocator', () => {
  it('prefers the last verified path, resolves symlinks, verifies version, and persists only bounded setup data', async () => {
    const home = await tempHome();
    const real = join(home, 'real', 'cap-cli');
    const preferred = join(home, 'preferred', 'cap');
    const managed = join(home, 'bin', 'cap');
    await executable(real);
    await executable(managed);
    await mkdir(join(home, 'preferred'), { recursive: true });
    await import('node:fs/promises').then(({ symlink }) => symlink(real, preferred));
    await mkdir(join(home, 'bin'), { recursive: true });
    await mkdir(join(home, 'setup'), { recursive: true });
    await writeFile(join(home, 'setup', 'cap.json'), JSON.stringify({
      cliPath: preferred,
      version: 'old',
      verifiedAt: new Date(0).toISOString(),
      diagnostic: 'x'.repeat(10_000),
      secret: 'must-not-survive',
    }));
    const run = vi.fn(async () => result(JSON.stringify({ version: '1.2.3' })));

    const located = await new CapLocator({ vpaHome: home, run, env: { PATH: '' } }).locate();

    const resolvedReal = await realpath(real);
    expect(located).toEqual({ cliPath: resolvedReal, version: '1.2.3' });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      executable: resolvedReal,
      args: ['version', '--json'],
    }));
    const persisted = JSON.parse(await readFile(join(home, 'setup', 'cap.json'), 'utf8'));
    expect(Object.keys(persisted).sort()).toEqual(['cliPath', 'diagnostic', 'verifiedAt', 'version']);
    expect(Buffer.byteLength(persisted.diagnostic)).toBeLessThanOrEqual(2_048);
  });

  it('falls back from a stale persisted path to the VPA-managed binary before PATH', async () => {
    const home = await tempHome();
    const managed = join(home, 'bin', 'cap');
    const pathDir = join(home, 'path-bin');
    const fromPath = join(pathDir, 'cap');
    await executable(managed);
    await executable(fromPath);
    await mkdir(join(home, 'setup'), { recursive: true });
    await writeFile(join(home, 'setup', 'cap.json'), JSON.stringify({ cliPath: join(home, 'missing-cap') }));
    const run = vi.fn(async () => result('{"version":"2.0.0"}'));

    const located = await new CapLocator({ vpaHome: home, run, env: { PATH: pathDir } }).locate();

    expect(located?.cliPath).toBe(await realpath(managed));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('returns null when no executable candidate can be verified', async () => {
    const home = await tempHome();
    const run = vi.fn(async () => result('{"version":"never"}'));

    await expect(new CapLocator({
      vpaHome: home,
      run,
      env: { PATH: '' },
      homeDir: join(home, 'user'),
      systemApplicationsDir: join(home, 'Applications'),
    }).locate()).resolves.toBeNull();
    expect(run).not.toHaveBeenCalled();
  });
});

const guide = {
  commands: [
    { command: 'doctor', flags: ['--json'] },
    { command: 'targets', flags: ['--json', '--fps'] },
    {
      command: 'record start',
      flags: [
        '--screen', '--window', '--fps', '--path', '--camera', '--mic',
        '--system-audio', '--detach', '--json',
      ],
    },
    { command: 'record stop', flags: ['--id', '--json'] },
    { command: 'project validate', flags: ['--json'] },
    { command: 'export', flags: ['--output', '--json'] },
  ],
};

describe('CapRuntime', () => {
  it('keeps an active installer status authoritative during forced checks', async () => {
    const home = await tempHome();
    const process = processDouble(async () => result('{}'));
    const runtime = new ManagedCapRuntime({
      vpaHome: home,
      locator: new CapLocator({ vpaHome: home, run: process.run, env: { PATH: '' } }),
      process,
    });
    const installing = {
      state: 'installing' as const,
      installed: false,
      captureReady: false,
      missingPermissions: [],
      targetCount: 0,
      installationId: '64d79770-ee07-4f70-b084-2115dc28e0d3',
      updatedAt: new Date().toISOString(),
    };
    runtime.setInstallationStatus(installing);

    await expect(runtime.getStatus(true)).resolves.toEqual(installing);
    expect(process.run).not.toHaveBeenCalled();
  });

  it('returns a typed not-installed status when discovery finds no binary', async () => {
    const home = await tempHome();
    const process = processDouble(async () => result('{}'));
    const locator = new CapLocator({
      vpaHome: home,
      run: process.run,
      env: { PATH: '' },
      homeDir: join(home, 'user'),
      systemApplicationsDir: join(home, 'Applications'),
    });
    const runtime = new ManagedCapRuntime({ vpaHome: home, locator, process });

    await expect(runtime.getStatus(true)).resolves.toMatchObject({
      state: 'not-installed',
      installed: false,
      captureReady: false,
      targetCount: 0,
    });
  });

  it('reports doctor success separately from capture readiness and flattens typed targets', async () => {
    const home = await tempHome();
    const cliPath = join(home, 'bin', 'cap');
    await executable(cliPath);
    const process = processDouble(async ({ args }) => {
      if (args[0] === 'version') return result('{"version":"1.0.0"}');
      if (args[0] === 'guide') return result(JSON.stringify(guide));
      if (args[0] === 'doctor') return result(JSON.stringify({
        ok: true,
        captureReady: false,
        permissions: { screenRecording: 'denied' },
      }));
      if (args[0] === 'targets') return result(JSON.stringify({
        screens: [{ id: 'screen-1', name: 'Built-in', width: 1920, height: 1080 }],
        windows: [{ id: 'window-9', ownerName: 'MeetingNotes', title: 'Settings', width: 1200, height: 800 }],
        cameras: [],
        mics: [],
      }));
      throw new Error(`unexpected args: ${args.join(' ')}`);
    });
    const runtime = new ManagedCapRuntime({
      vpaHome: home,
      locator: new CapLocator({ vpaHome: home, run: process.run, env: { PATH: '' } }),
      process,
    });

    await expect(runtime.doctor()).resolves.toEqual({
      captureReady: false,
      missingPermissions: ['screen-recording'],
    });
    await expect(runtime.targets()).resolves.toEqual([
      { kind: 'screen', id: 'screen-1', name: 'Built-in', width: 1920, height: 1080 },
      { kind: 'window', id: 'window-9', name: 'Settings', application: 'MeetingNotes', width: 1200, height: 800 },
    ]);
    const status = await runtime.getStatus(true);
    expect(status).toMatchObject({
      state: 'needs-permission',
      installed: true,
      captureReady: false,
      missingPermissions: ['screen-recording'],
      targetCount: 2,
    });
    const firstGuide = process.run.mock.invocationCallOrder.find((_, index) =>
      process.run.mock.calls[index]?.[0].args[0] === 'guide');
    const firstDoctor = process.run.mock.invocationCallOrder.find((_, index) =>
      process.run.mock.calls[index]?.[0].args[0] === 'doctor');
    expect(firstGuide).toBeLessThan(firstDoctor!);
  });

  it('marks an installed runtime unusable when doctor required checks are false', async () => {
    const home = await tempHome();
    const cliPath = join(home, 'bin', 'cap');
    await executable(cliPath);
    const process = processDouble(async ({ args }) => {
      if (args[0] === 'version') return result('{"version":"1.0.0"}');
      if (args[0] === 'guide') return result(JSON.stringify(guide));
      if (args[0] === 'doctor') return result('{"ok":false,"captureReady":false,"permissions":{"screenRecording":"granted"}}');
      if (args[0] === 'targets') return result('{"screens":[],"windows":[]}');
      throw new Error(`unexpected args: ${args.join(' ')}`);
    });
    const runtime = new ManagedCapRuntime({
      vpaHome: home,
      locator: new CapLocator({ vpaHome: home, run: process.run, env: { PATH: '' } }),
      process,
    });

    await expect(runtime.getStatus(true)).resolves.toMatchObject({
      state: 'error',
      installed: true,
      captureReady: false,
      message: expect.stringContaining('required checks failed'),
    });
  });

  it('uses exact guide-backed arguments and rejects incomplete start/stop/validation results', async () => {
    const home = await tempHome();
    const cliPath = join(home, 'bin', 'cap');
    await executable(cliPath);
    let startOutput = '{"type":"started","recordingId":"rec-1","path":"/tmp/take.cap"}';
    let stopOutput = '{"type":"stopped","recordingId":"rec-1","path":"/tmp/take.cap","recordingMetaExists":true}';
    let validateOutput = '{"valid":true}';
    const process = processDouble(async ({ args }) => {
      if (args[0] === 'version') return result('{"version":"1.0.0"}');
      if (args[0] === 'guide') return result(JSON.stringify(guide));
      if (args[0] === 'record' && args[1] === 'start') return result(startOutput);
      if (args[0] === 'record' && args[1] === 'stop') return result(stopOutput);
      if (args[0] === 'project') return result(validateOutput);
      throw new Error(`unexpected args: ${args.join(' ')}`);
    });
    const runtime = new ManagedCapRuntime({
      vpaHome: home,
      locator: new CapLocator({ vpaHome: home, run: process.run, env: { PATH: '' } }),
      process,
    });

    await expect(runtime.startRecording({
      targetKind: 'window',
      targetId: 'window-9',
      fps: 30,
      projectPath: '/tmp/take.cap',
      cameraId: 'camera-2',
      microphoneId: 'Demo Mic',
      systemAudio: true,
    }))
      .resolves.toEqual({ recordingId: 'rec-1', projectPath: '/tmp/take.cap' });
    expect(process.runJsonl).toHaveBeenCalledWith(expect.objectContaining({
      executable: await realpath(cliPath),
      args: [
        'record', 'start', '--window', 'window-9', '--fps', '30',
        '--path', '/tmp/take.cap', '--camera', 'camera-2', '--mic', 'Demo Mic',
        '--system-audio', '--detach', '--json',
      ],
    }));
    await expect(runtime.stopRecording('rec-1')).resolves.toEqual({
      recordingMetaExists: true,
      projectPath: '/tmp/take.cap',
    });
    expect(process.runJsonl).toHaveBeenCalledWith(expect.objectContaining({
      args: ['record', 'stop', '--id', 'rec-1', '--json'],
    }));
    await expect(runtime.validateProject('/tmp/take.cap')).resolves.toBeUndefined();

    startOutput = '{"type":"started","path":"/tmp/take.cap"}';
    await expect(runtime.startRecording({ targetKind: 'screen', targetId: 'screen-1' }))
      .rejects.toThrow('recording ID');
    stopOutput = '{"type":"stopped","path":"/tmp/take.cap","recordingMetaExists":false}';
    await expect(runtime.stopRecording('rec-1')).rejects.toThrow('recording metadata');
    stopOutput = '{"type":"stopped","recordingId":"rec-other","path":"/tmp/take.cap","recordingMetaExists":true}';
    await expect(runtime.stopRecording('rec-1')).rejects.toThrow('recording ID did not match');
    validateOutput = '{"valid":false}';
    await expect(runtime.validateProject('/tmp/take.cap')).rejects.toThrow('invalid');
  });

  it('does not accept a selected flag advertised only by an unrelated guide command', async () => {
    const home = await tempHome();
    const cliPath = join(home, 'bin', 'cap');
    await executable(cliPath);
    const scopedGuide = {
      commands: guide.commands.map((entry) => entry.command === 'record start'
        ? { ...entry, flags: entry.flags.filter((flag) => flag !== '--fps') }
        : entry),
    };
    const process = processDouble(async ({ args }) => {
      if (args[0] === 'version') return result('{"version":"1.0.0"}');
      if (args[0] === 'guide') return result(JSON.stringify(scopedGuide));
      throw new Error(`unexpected args: ${args.join(' ')}`);
    });
    const runtime = new ManagedCapRuntime({
      vpaHome: home,
      locator: new CapLocator({ vpaHome: home, run: process.run, env: { PATH: '' } }),
      process,
    });

    await expect(runtime.startRecording({ targetKind: 'window', targetId: 'window-9', fps: 30 }))
      .rejects.toThrow('record start does not support --fps');
    expect(process.runJsonl).not.toHaveBeenCalled();
  });

  it('uses only exact-command help when the official guide shape omits flag lists', async () => {
    const home = await tempHome();
    const cliPath = join(home, 'bin', 'cap');
    await executable(cliPath);
    const officialGuideShape = {
      outputConvention: { jsonFlag: '--json (global) or a command\'s --format json' },
      commands: [
        { command: 'targets', summary: 'Unrelated --camera token' },
        { command: 'record start', summary: 'Start a recording', notes: 'Use --detach for background work' },
      ],
    };
    const process = processDouble(async ({ args }) => {
      if (args[0] === 'version') return result('{"version":"1.0.0"}');
      if (args[0] === 'guide') return result(JSON.stringify(officialGuideShape));
      if (args.join(' ') === 'record start --help') {
        return result('Usage: cap record start --window <id> --camera <id> --detach --json');
      }
      if (args[0] === 'record') {
        return result('{"type":"started","recordingId":"rec-1","path":"/tmp/take.cap"}');
      }
      throw new Error(`unexpected args: ${args.join(' ')}`);
    });
    const runtime = new ManagedCapRuntime({
      vpaHome: home,
      locator: new CapLocator({ vpaHome: home, run: process.run, env: { PATH: '' } }),
      process,
    });

    await expect(runtime.startRecording({
      targetKind: 'window', targetId: 'window-9', cameraId: 'camera-2',
    })).resolves.toEqual({ recordingId: 'rec-1', projectPath: '/tmp/take.cap' });
    expect(process.run).toHaveBeenCalledWith(expect.objectContaining({
      args: ['record', 'start', '--help'],
    }));
  });

  it('rejects retained and streamed JSONL failures even when a later success event exists', async () => {
    const home = await tempHome();
    const cliPath = join(home, 'bin', 'cap');
    const outputPath = join(home, 'take.mp4');
    await executable(cliPath);
    await writeFile(outputPath, 'mp4-bytes');
    const base = processDouble(async ({ args }) => {
      if (args[0] === 'version') return result('{"version":"1.0.0"}');
      if (args[0] === 'guide') return result(JSON.stringify(guide));
      throw new Error(`unexpected args: ${args.join(' ')}`);
    });
    base.runJsonl.mockImplementation(async (request) => {
      request.onEvent?.({ type: 'error', message: 'early render failure' });
      for (let index = 0; index < 501; index += 1) {
        request.onEvent?.({ type: 'Progress', progress: index / 501 });
      }
      request.onEvent?.({ type: 'Completed', path: outputPath });
      return { events: [{ type: 'Progress' }, { type: 'Completed', path: outputPath }], stderr: '', exitCode: 0 };
    });
    const runtime = new ManagedCapRuntime({
      vpaHome: home,
      locator: new CapLocator({ vpaHome: home, run: base.run, env: { PATH: '' } }),
      process: base,
    });

    await expect(runtime.exportProject('/tmp/take.cap', outputPath))
      .rejects.toThrow('early render failure');

    base.runJsonl.mockImplementationOnce(async (request) => {
      request.onEvent?.({ error: { code: 'renderer-crashed' } });
      request.onEvent?.({ type: 'Completed', path: outputPath });
      return { events: [{ type: 'Completed', path: outputPath }], stderr: '', exitCode: 0 };
    });
    await expect(runtime.exportProject('/tmp/take.cap', outputPath))
      .rejects.toThrow('renderer-crashed');

    base.runJsonl.mockImplementationOnce(async (request) => {
      request.onEvent?.({ type: 'Completed', success: false, message: 'terminal failure' });
      return { events: [{ type: 'Completed', success: false, message: 'terminal failure' }], stderr: '', exitCode: 0 };
    });
    await expect(runtime.exportProject('/tmp/take.cap', outputPath))
      .rejects.toThrow('terminal failure');
  });

  it('reads nested Cap Desktop dimensions and window names without changing output settings', async () => {
    const home = await tempHome();
    await executable(join(home, 'bin', 'cap'));
    const process = processDouble(async ({ args }) => {
      if (args[0] === 'version') return result('{"version":"0.1.0"}');
      if (args[0] === 'guide') return result(JSON.stringify(guide));
      if (args[0] === 'targets') return result(JSON.stringify({
        screens: [{ id: 'display-1', name: 'Display', physicalSize: { width: 3440, height: 1440 }, logicalSize: { width: 1720, height: 720 } }],
        windows: [{ id: 'window-1', name: 'Demo', ownerName: 'Browser', bounds: { x: 0, y: 0, width: 1280, height: 720 } }],
      }));
      throw new Error(`unexpected args: ${args.join(' ')}`);
    });
    const runtime = new ManagedCapRuntime({ vpaHome: home, locator: new CapLocator({ vpaHome: home, run: process.run, env: { PATH: '' } }), process });
    await expect(runtime.targets()).resolves.toEqual([
      { kind: 'screen', id: 'display-1', name: 'Display', width: 3440, height: 1440 },
      { kind: 'window', id: 'window-1', name: 'Demo', application: 'Browser', width: 1280, height: 720 },
    ]);
  });

  it('rejects incomplete target collections and malformed target entries', async () => {
    const invalidTargets: Array<[string, Record<string, unknown>]> = [
      ['screens array', { screens: {}, windows: [] }],
      ['windows array', { screens: [] }],
      ['screen target ID', { screens: [{ id: true, name: 'Built-in', width: 100, height: 100 }], windows: [] }],
      ['screen target width', { screens: [{ id: 1, name: 'Built-in', width: 0, height: 100 }], windows: [] }],
      ['window target ID', { screens: [], windows: [{ id: {}, ownerName: 'MeetingNotes', title: 'Settings', width: 100, height: 100 }] }],
      ['window target title', { screens: [], windows: [{ id: 2, ownerName: 'MeetingNotes', title: 9, width: 100, height: 100 }] }],
    ];

    for (const [message, payload] of invalidTargets) {
      const home = await tempHome();
      const cliPath = join(home, 'bin', 'cap');
      await executable(cliPath);
      const process = processDouble(async ({ args }) => {
        if (args[0] === 'version') return result('{"version":"1.0.0"}');
        if (args[0] === 'guide') return result(JSON.stringify(guide));
        if (args[0] === 'targets') return result(JSON.stringify(payload));
        throw new Error(`unexpected args: ${args.join(' ')}`);
      });
      const runtime = new ManagedCapRuntime({
        vpaHome: home,
        locator: new CapLocator({ vpaHome: home, run: process.run, env: { PATH: '' } }),
        process,
      });

      await expect(runtime.targets()).rejects.toThrow(message);
    }
  });

  it('accepts only a terminal successful export whose MP4 exists and is non-empty', async () => {
    const home = await tempHome();
    const cliPath = join(home, 'bin', 'cap');
    const outputPath = join(home, 'take.mp4');
    await executable(cliPath);
    let exportLines = '{"type":"Progress","progress":0.5}\n{"type":"Completed","path":"' + outputPath + '"}';
    const process = processDouble(async ({ args }) => {
      if (args[0] === 'version') return result('{"version":"1.0.0"}');
      if (args[0] === 'guide') return result(JSON.stringify(guide));
      if (args[0] === 'export') {
        await writeFile(outputPath, 'mp4-bytes');
        return result(exportLines);
      }
      throw new Error(`unexpected args: ${args.join(' ')}`);
    });
    const runtime = new ManagedCapRuntime({
      vpaHome: home,
      locator: new CapLocator({ vpaHome: home, run: process.run, env: { PATH: '' } }),
      process,
    });

    await expect(runtime.exportProject('/tmp/take.cap', outputPath)).resolves.toBeUndefined();
    expect(process.runJsonl).toHaveBeenCalledWith(expect.objectContaining({
      args: ['export', '/tmp/take.cap', '--output', outputPath, '--json'],
    }));

    exportLines = '{"type":"Progress","progress":1}';
    await expect(runtime.exportProject('/tmp/take.cap', outputPath)).rejects.toThrow('terminal success');
    exportLines = '{"type":"Completed","path":"' + outputPath + '"}';
    process.runJsonl.mockImplementationOnce(async () => ({
      events: [{ type: 'Completed', path: outputPath }], stderr: '', exitCode: 0,
    }));
    await writeFile(outputPath, '');
    await expect(runtime.exportProject('/tmp/take.cap', outputPath)).rejects.toThrow('empty');
  });
});
