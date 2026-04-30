import type { FastifyInstance } from 'fastify';
import { jobQueue } from '../lib/job-queue.js';

export async function registerJobRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>('/api/jobs/:id', async (req, reply) => {
    const job = jobQueue.get(req.params.id);
    if (!job) return reply.code(404).send({ error: 'Job not found' });
    return job;
  });

  app.get<{ Params: { id: string } }>('/api/jobs/:id/stream', async (req, reply) => {
    const job = jobQueue.get(req.params.id);
    if (!job) return reply.code(404).send({ error: 'Job not found' });

    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.flushHeaders();

    const write = (event: { type: string; timestamp: string; data?: unknown }) => {
      reply.raw.write(`event: ${event.type}\n`);
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const unsubscribe = jobQueue.subscribe(req.params.id, write, { replay: true });

    const checkTerminal = () => {
      const j = jobQueue.get(req.params.id)!;
      if (j.status === 'completed' || j.status === 'failed' || j.status === 'cancelled') {
        unsubscribe();
        reply.raw.end();
      }
    };
    const interval = setInterval(checkTerminal, 500);

    req.raw.on('close', () => {
      clearInterval(interval);
      unsubscribe();
    });
  });
}
