import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  DesktopDriverError,
  type DesktopDriverSessionManager,
} from '../services/desktop-driver/session.js';
import { DESKTOP_DRIVER_MAX_TEXT_LENGTH } from '../services/desktop-driver/types.js';

const ParamsSchema = z.object({ sessionId: z.string().uuid() }).strict();
const ActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('click'), elementIndex: z.number().int().nonnegative() }).strict(),
  z.object({
    kind: z.literal('set-value'),
    elementIndex: z.number().int().nonnegative(),
    value: z.string().max(DESKTOP_DRIVER_MAX_TEXT_LENGTH),
  }).strict(),
  z.object({ kind: z.literal('type-text'), value: z.string().max(DESKTOP_DRIVER_MAX_TEXT_LENGTH) }).strict(),
  z.object({
    kind: z.literal('press-key'),
    key: z.enum(['Tab', 'Return', 'Escape', 'Left', 'Right', 'Up', 'Down', 'space']),
  }).strict(),
]);

interface AgentDesktopRouteDeps {
  desktop: Pick<DesktopDriverSessionManager, 'inspect' | 'screenshot' | 'act'>;
}

function isLoopback(address: string): boolean {
  return address === '::1'
    || address === 'localhost'
    || address.startsWith('127.')
    || address.startsWith('::ffff:127.');
}

function bearerToken(request: FastifyRequest): string | null {
  const value = request.headers.authorization;
  if (!value || !value.startsWith('Bearer ')) return null;
  const token = value.slice('Bearer '.length);
  if (!token || token.length > 200 || /\s/.test(token)) return null;
  return token;
}

function statusFor(error: DesktopDriverError): number {
  switch (error.code) {
    case 'UNAUTHORIZED': return 401;
    case 'FORBIDDEN_TARGET':
    case 'OPERATION_NOT_ALLOWED': return 403;
    case 'STALE_SNAPSHOT':
    case 'TARGET_CHANGED': return 409;
    case 'INVALID_REQUEST': return 400;
  }
}

function sendError(reply: FastifyReply, error: unknown, token?: string): FastifyReply {
  if (error instanceof DesktopDriverError) {
    const message = token ? error.message.replaceAll(token, '[REDACTED]') : error.message;
    return reply.code(statusFor(error)).send({ error: message, code: error.code });
  }
  // Platform diagnostics are deliberately not reflected to this token-bearing
  // internal client, so an unexpected adapter or OS message cannot copy
  // capability material into a response.
  return reply.code(500).send({ error: 'Desktop driver operation failed' });
}

function authorizeRequest(request: FastifyRequest, reply: FastifyReply): string | null {
  if (!isLoopback(request.ip)) {
    reply.code(403).send({ error: 'Desktop driver is available only on loopback' });
    return null;
  }
  const token = bearerToken(request);
  if (!token) {
    reply.code(401).send({ error: 'A valid desktop capability is required' });
    return null;
  }
  return token;
}

export async function registerAgentDesktopRoutes(
  app: FastifyInstance,
  deps: AgentDesktopRouteDeps,
): Promise<void> {
  app.get('/internal/agent-recording/driver/:sessionId/inspect', async (request, reply) => {
    const token = authorizeRequest(request, reply);
    if (!token) return;
    const params = ParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Desktop session ID is invalid' });
    try {
      return await deps.desktop.inspect(params.data.sessionId, token);
    } catch (error) {
      return sendError(reply, error, token);
    }
  });

  app.post('/internal/agent-recording/driver/:sessionId/screenshot', {
    bodyLimit: 1_024,
  }, async (request, reply) => {
    const token = authorizeRequest(request, reply);
    if (!token) return;
    const params = ParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Desktop session ID is invalid' });
    try {
      return await deps.desktop.screenshot(params.data.sessionId, token);
    } catch (error) {
      return sendError(reply, error, token);
    }
  });

  app.post('/internal/agent-recording/driver/:sessionId/action', {
    bodyLimit: 8 * 1_024,
  }, async (request, reply) => {
    const token = authorizeRequest(request, reply);
    if (!token) return;
    const params = ParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Desktop session ID is invalid' });
    const action = ActionSchema.safeParse(request.body);
    if (!action.success) return reply.code(400).send({ error: 'Desktop action is invalid' });
    try {
      return await deps.desktop.act(params.data.sessionId, token, action.data);
    } catch (error) {
      return sendError(reply, error, token);
    }
  });
}
