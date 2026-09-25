import { describe, expect, it, vi } from 'vitest';
import { runCli, HELP } from './cli.js';
import { VpaCliError, VpaHttpClient, type HttpClient } from './client.js';

const engines = [
  {
    id: 'fake',
    displayName: 'Fake TTS',
    ready: true as const,
    voices: [{ id: 'default', name: 'Default' }],
    supportedEmotives: [],
    expressiveTags: [],
    capabilities: {
      speed: { min: 0.5, max: 2, default: 1 },
      expressiveness: [] as string[],
      multiSpeaker: false,
      outputFormats: ['mp3'],
      timings: 'estimated',
      subtitles: true,
      maxInputChars: 5_000,
    },
  },
];

function harness(client: HttpClient) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    dependencies: {
      client,
      stdout: (line: string) => stdout.push(line),
      stderr: (line: string) => stderr.push(line),
      sleep: vi.fn(async () => undefined),
    },
    stdout,
    stderr,
  };
}

function clientWith(
  json: HttpClient['json'],
  bytes: HttpClient['bytes'] = async () => new Uint8Array([1]),
): HttpClient {
  return { json, bytes };
}

describe('VPA CLI', () => {
  it('documents every public command in help', async () => {
    for (const command of [
      'narration engines list',
      'narration voices list',
      'narration profiles list',
      'narration options describe',
      'narration create',
      'narration project',
      'projects list',
      'projects show',
      'jobs show',
      'jobs wait',
    ]) {
      expect(HELP).toContain(command);
    }
  });

  it('emits engine discovery as one JSON document', async () => {
    const json = vi.fn(async () => engines) as HttpClient['json'];
    const h = harness(clientWith(json));
    expect(await runCli(['narration', 'engines', 'list', '--json'], h.dependencies)).toBe(0);
    expect(h.stderr).toEqual([]);
    expect(h.stdout).toHaveLength(1);
    expect(JSON.parse(h.stdout[0]!)).toEqual(engines);
  });

  it('creates and downloads standalone narration', async () => {
    const json = vi.fn(async () => ({
      id: 'clip-1',
      engine: 'fake',
      voice: 'default',
      audioUrl: '/api/tts/scratch/clip-1/audio',
    })) as HttpClient['json'];
    const bytes = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const writeBytes = vi.fn(async () => undefined);
    const h = harness(clientWith(json, bytes));

    expect(
      await runCli(
        [
          'narration',
          'create',
          '--text',
          'Hello',
          '--engine',
          'fake',
          '--voice',
          'default',
          '--output',
          'out/test.mp3',
          '--json',
        ],
        { ...h.dependencies, writeBytes },
      ),
    ).toBe(0);

    expect(json).toHaveBeenCalledWith('POST', '/api/tts/scratch', {
      text: 'Hello',
      engine: 'fake',
      voice: 'default',
    });
    expect(bytes).toHaveBeenCalledWith('/api/tts/scratch/clip-1/audio');
    expect(writeBytes).toHaveBeenCalledWith(
      expect.stringMatching(/\/out\/test\.mp3$/),
      new Uint8Array([1, 2, 3]),
    );
    expect(JSON.parse(h.stdout[0]!).output).toMatch(/\/out\/test\.mp3$/);
  });

  it('resolves a profile before starting project narration and waits for completion', async () => {
    const requests: Array<[string, string, unknown?]> = [];
    let jobReads = 0;
    const json = vi.fn(async (method: string, path: string, body?: unknown) => {
      requests.push([method, path, body]);
      if (path === '/api/voices')
        return [{ id: 'demo', name: 'Demo', engine: 'fake', voice: 'default', speed: 1.25 }];
      if (path === '/api/tts/engines') return engines;
      if (path.endsWith('/narration/generate-project'))
        return { jobId: 'job-1', status: 'running' };
      if (path === '/api/jobs/job-1') {
        jobReads += 1;
        return {
          id: 'job-1',
          type: 'narration-generate-project',
          status: jobReads === 1 ? 'running' : 'completed',
        };
      }
      throw new Error(`Unexpected ${path}`);
    }) as HttpClient['json'];
    const h = harness(clientWith(json));

    expect(
      await runCli(
        [
          'narration',
          'project',
          'project-1',
          '--profile',
          'demo',
          '--overwrite',
          '--wait',
          '--json',
        ],
        h.dependencies,
      ),
    ).toBe(0);

    expect(requests).toContainEqual([
      'POST',
      '/api/projects/project-1/narration/generate-project',
      {
        engine: 'fake',
        voice: 'default',
        speed: 1.25,
        expressiveness: 'medium',
        overwrite: true,
      },
    ]);
    expect(JSON.parse(h.stdout[0]!).status).toBe('completed');
  });

  it('rejects invalid selection arguments without making an API request', async () => {
    const json = vi.fn() as HttpClient['json'];
    const h = harness(clientWith(json));
    expect(
      await runCli(
        [
          'narration',
          'create',
          '--text',
          'Hello',
          '--profile',
          'demo',
          '--engine',
          'fake',
          '--voice',
          'default',
          '--json',
        ],
        h.dependencies,
      ),
    ).toBe(1);
    expect(json).not.toHaveBeenCalled();
    expect(JSON.parse(h.stderr[0]!)).toMatchObject({ code: 'invalid_request' });
  });

  it('passes through structured API errors', async () => {
    const client = clientWith(async () => {
      throw new VpaCliError('No such project', 'not_found', 404);
    });
    const h = harness(client);
    expect(await runCli(['projects', 'show', 'missing', '--json'], h.dependencies)).toBe(1);
    expect(JSON.parse(h.stderr[0]!)).toEqual({
      error: 'No such project',
      code: 'not_found',
      status: 404,
    });
  });

  it('reports connection failures with the configured URL', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('connect refused');
    }) as unknown as typeof fetch;
    const h = harness(new VpaHttpClient('http://127.0.0.1:3999', fetchImpl));
    expect(await runCli(['projects', 'list', '--json'], h.dependencies)).toBe(1);
    expect(JSON.parse(h.stderr[0]!)).toMatchObject({ code: 'vpa_unavailable' });
    expect(h.stderr[0]).toContain('http://127.0.0.1:3999');
  });

  it('returns nonzero for a failed terminal job without a second JSON document', async () => {
    const json = (async () => ({
      id: 'job-1',
      type: 'narration',
      status: 'failed',
      error: 'No audio',
    })) as HttpClient['json'];
    const h = harness(clientWith(json));
    expect(await runCli(['jobs', 'wait', 'job-1', '--json'], h.dependencies)).toBe(1);
    expect(h.stdout).toHaveLength(1);
    expect(h.stderr).toEqual([]);
    expect(JSON.parse(h.stdout[0]!)).toMatchObject({ status: 'failed', error: 'No audio' });
  });
});
