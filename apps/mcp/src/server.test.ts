import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HttpClient } from '@vpa/cli/client';
import { VpaCliError } from '@vpa/cli/client';
import { createVpaMcpServer } from './server.js';

const engines = [{
  id: 'fake', displayName: 'Fake TTS', ready: true as const,
  voices: [{ id: 'default', name: 'Default' }], supportedEmotives: [], expressiveTags: [],
  capabilities: { speed: { min: 0.5, max: 2, default: 1 }, expressiveness: [], multiSpeaker: false, outputFormats: ['mp3'], timings: 'estimated', subtitles: true, maxInputChars: 5_000 },
}];

function fakeClient(json: HttpClient['json']): HttpClient {
  return { json, bytes: async () => new Uint8Array() };
}

async function connect(json: HttpClient['json']) {
  const server = createVpaMcpServer({ httpClient: fakeClient(json) });
  const client = new Client({ name: 'vpa-mcp-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

describe('VPA MCP server', () => {
  const opened: Array<{ client: Client; server: ReturnType<typeof createVpaMcpServer> }> = [];
  afterEach(async () => {
    await Promise.all(opened.splice(0).map(async ({ client, server }) => {
      await client.close();
      await server.close();
    }));
  });

  it('advertises focused tools with accurate annotations and narration schemas', async () => {
    const connection = await connect((async () => engines) as HttpClient['json']);
    opened.push(connection);
    const listed = await connection.client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    expect(names).toContain('list_narration_engines');
    expect(names).toContain('execute_project_commands');
    expect(names).toContain('start_project_render');
    expect(names).toContain('resolve_feedback');
    expect(listed.tools.find((tool) => tool.name === 'list_projects')?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(listed.tools.find((tool) => tool.name === 'start_project_narration')?.inputSchema).toMatchObject({ type: 'object', required: expect.arrayContaining(['engine', 'voice', 'speed', 'expressiveness', 'overwrite', 'idempotencyKey']) });
  });

  it('returns narration discovery as structured content without changing the catalog', async () => {
    const json = vi.fn(async () => engines) as HttpClient['json'];
    const connection = await connect(json);
    opened.push(connection);
    const result = await connection.client.callTool({ name: 'list_narration_engines', arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ ok: true, result: engines });
    expect(json).toHaveBeenCalledWith('GET', '/api/tts/engines');
  });

  it('forwards idempotency to VPA so a duplicate submission reuses its durable job', async () => {
    const submissions = new Map<string, { jobId: string; status: string; reused?: boolean }>();
    const json = vi.fn(async (_method: string, _path: string, _body?: unknown, options?: { headers?: Record<string, string> }) => {
      const key = options?.headers?.['Idempotency-Key'] ?? '';
      const prior = submissions.get(key);
      if (prior) return { ...prior, reused: true };
      const created = { jobId: '11111111-1111-4111-8111-111111111111', status: 'running' };
      submissions.set(key, created);
      return created;
    }) as HttpClient['json'];
    const connection = await connect(json);
    opened.push(connection);
    const args = { projectId: 'project-1', engine: 'fake', voice: 'default', speed: 1, expressiveness: 'medium', overwrite: false, idempotencyKey: 'stable-request-1' };
    const first = await connection.client.callTool({ name: 'start_project_narration', arguments: args });
    const second = await connection.client.callTool({ name: 'start_project_narration', arguments: args });

    expect(first.structuredContent).toMatchObject({ ok: true, result: { jobId: '11111111-1111-4111-8111-111111111111' } });
    expect(second.structuredContent).toMatchObject({ ok: true, result: { reused: true } });
    expect(json).toHaveBeenNthCalledWith(1, 'POST', '/api/projects/project-1/narration/generate-project', expect.any(Object), { headers: { 'Idempotency-Key': 'stable-request-1' } });
    expect(json).toHaveBeenNthCalledWith(2, 'POST', '/api/projects/project-1/narration/generate-project', expect.any(Object), { headers: { 'Idempotency-Key': 'stable-request-1' } });
  });

  it('requires explicit idempotency before a paid narration request reaches VPA', async () => {
    const json = vi.fn(async () => ({ id: 'clip-1' })) as HttpClient['json'];
    const connection = await connect(json);
    opened.push(connection);
    const invalid = await connection.client.callTool({
      name: 'create_standalone_narration',
      arguments: { text: 'Hello', engine: 'fake', voice: 'default' },
    });
    expect(invalid.isError).toBe(true);
    expect(json).not.toHaveBeenCalled();

    const valid = await connection.client.callTool({
      name: 'create_standalone_narration',
      arguments: { text: 'Hello', engine: 'fake', voice: 'default', idempotencyKey: 'standalone-request-1' },
    });
    expect(valid.isError).not.toBe(true);
    expect(json).toHaveBeenCalledWith(
      'POST',
      '/api/tts/scratch',
      { text: 'Hello', engine: 'fake', voice: 'default' },
      { headers: { 'Idempotency-Key': 'standalone-request-1' } },
    );
  });

  it('preserves bounded VPA error codes in tool failures', async () => {
    const connection = await connect((async () => { throw new VpaCliError('Revision 4 is stale', 'stale_revision', 409, { currentRevision: 5 }); }) as HttpClient['json']);
    opened.push(connection);
    const result = await connection.client.callTool({ name: 'get_project_revision', arguments: { projectId: 'project-1' } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ ok: false, error: { code: 'stale_revision', message: 'Revision 4 is stale', status: 409, details: { currentRevision: 5 } } });
  });

  it('publishes live resources and bounded templates backed by VPA reads', async () => {
    const json = vi.fn(async (_method: string, path: string) => path === '/api/projects' ? { projects: [{ id: 'project-1', name: 'Demo' }] } : { revision: 7 }) as HttpClient['json'];
    const connection = await connect(json);
    opened.push(connection);
    const resources = await connection.client.listResources();
    const templates = await connection.client.listResourceTemplates();
    expect(resources.resources.map((resource) => resource.uri)).toContain('vpa://projects');
    expect(templates.resourceTemplates.map((template) => template.uriTemplate)).toContain('vpa://projects/{projectId}/revision');

    const projects = await connection.client.readResource({ uri: 'vpa://projects' });
    const revision = await connection.client.readResource({ uri: 'vpa://projects/project-1/revision' });
    const projectsContent = projects.contents[0]!;
    const revisionContent = revision.contents[0]!;
    expect('text' in projectsContent ? JSON.parse(projectsContent.text) : null).toEqual({ projects: [{ id: 'project-1', name: 'Demo' }] });
    expect('text' in revisionContent ? JSON.parse(revisionContent.text) : null).toEqual({ revision: 7 });
  });
});
