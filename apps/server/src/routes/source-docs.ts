import type { FastifyInstance } from 'fastify';
import type { ProjectStore } from '../services/project/store.js';
import {
  addFile,
  addText,
  addUrl,
  deleteDoc,
  listDocs,
  readExtracted,
  type SourceDoc,
} from '../services/project-source-docs/index.js';

interface Deps {
  store: ProjectStore;
}

async function resolveProjectPath(store: ProjectStore, projectId: string): Promise<string> {
  const tracker = await store.readTracker();
  const entry = tracker.projects.find((p) => p.id === projectId);
  if (!entry) throw { statusCode: 404, message: `Project not found: ${projectId}` };
  return entry.path;
}

export async function registerSourceDocsRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { store } = deps;

  // GET /api/projects/:id/source-docs — list manifest entries
  app.get('/api/projects/:id/source-docs', async (req, reply) => {
    const { id } = req.params as { id: string };
    let projectPath: string;
    try {
      projectPath = await resolveProjectPath(store, id);
    } catch (err) {
      const e = err as { statusCode?: number; message?: string };
      return reply.status(e.statusCode ?? 500).send({ error: e.message, code: 'not_found' });
    }
    return listDocs(projectPath);
  });

  // POST /api/projects/:id/source-docs — multipart file upload, OR
  // JSON body with { url } / { text, name } variants. Each part / field
  // produces one new SourceDoc.
  app.post('/api/projects/:id/source-docs', async (req, reply) => {
    const { id } = req.params as { id: string };
    let projectPath: string;
    try {
      projectPath = await resolveProjectPath(store, id);
    } catch (err) {
      const e = err as { statusCode?: number; message?: string };
      return reply.status(e.statusCode ?? 500).send({ error: e.message, code: 'not_found' });
    }

    const created: SourceDoc[] = [];
    const isMultipart = req.isMultipart?.();

    if (isMultipart) {
      const parts = req.parts();
      const fields: Record<string, string> = {};
      for await (const part of parts) {
        if (part.type === 'file') {
          const buffers: Buffer[] = [];
          for await (const chunk of part.file) buffers.push(chunk as Buffer);
          const buffer = Buffer.concat(buffers);
          if (buffer.length === 0) continue;
          try {
            const doc = await addFile(projectPath, {
              filename: part.filename || 'upload',
              buffer,
            });
            created.push(doc);
          } catch (err) {
            return reply.status(400).send({
              error: err instanceof Error ? err.message : 'Upload failed',
              code: 'extract_failed',
              filename: part.filename,
            });
          }
        } else {
          fields[part.fieldname] = String(part.value ?? '');
        }
      }
      // Multipart can also carry url / text fields alongside files
      if (fields.url) {
        try {
          created.push(await addUrl(projectPath, fields.url, fields.name));
        } catch (err) {
          return reply.status(400).send({ error: err instanceof Error ? err.message : 'URL extract failed', code: 'extract_failed' });
        }
      }
      if (fields.text) {
        created.push(await addText(projectPath, fields.text, fields.name || 'note'));
      }
    } else {
      // JSON payload — { url, name? } | { text, name }
      const body = (req.body ?? {}) as { url?: string; text?: string; name?: string };
      if (body.url) {
        try {
          created.push(await addUrl(projectPath, body.url, body.name));
        } catch (err) {
          return reply.status(400).send({ error: err instanceof Error ? err.message : 'URL extract failed', code: 'extract_failed' });
        }
      } else if (body.text) {
        created.push(await addText(projectPath, body.text, body.name || 'note'));
      } else {
        return reply.status(400).send({
          error: 'Provide a multipart file, url, or text',
          code: 'invalid_request',
        });
      }
    }

    return { created };
  });

  // GET /api/projects/:id/source-docs/:docId — return the extracted
  // markdown for previewing in the UI.
  app.get('/api/projects/:id/source-docs/:docId', async (req, reply) => {
    const { id, docId } = req.params as { id: string; docId: string };
    let projectPath: string;
    try {
      projectPath = await resolveProjectPath(store, id);
    } catch (err) {
      const e = err as { statusCode?: number; message?: string };
      return reply.status(e.statusCode ?? 500).send({ error: e.message, code: 'not_found' });
    }
    const docs = await listDocs(projectPath);
    const doc = docs.find((d) => d.id === docId);
    if (!doc) return reply.status(404).send({ error: 'Doc not found', code: 'not_found' });
    const markdown = await readExtracted(projectPath, doc);
    return { ...doc, markdown };
  });

  // DELETE /api/projects/:id/source-docs/:docId
  app.delete('/api/projects/:id/source-docs/:docId', async (req, reply) => {
    const { id, docId } = req.params as { id: string; docId: string };
    let projectPath: string;
    try {
      projectPath = await resolveProjectPath(store, id);
    } catch (err) {
      const e = err as { statusCode?: number; message?: string };
      return reply.status(e.statusCode ?? 500).send({ error: e.message, code: 'not_found' });
    }
    const ok = await deleteDoc(projectPath, docId);
    if (!ok) return reply.status(404).send({ error: 'Doc not found', code: 'not_found' });
    return { deleted: true };
  });
}
