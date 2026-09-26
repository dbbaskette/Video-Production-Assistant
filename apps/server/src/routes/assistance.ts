import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ProjectCommand } from '@vpa/shared';
import type { ProjectStore } from '../services/project/store.js';
import { loadStoryboard } from '../services/storyboard/index.js';
import { RevisionError, RevisionStore } from '../services/revisions/store.js';
import { buildAssistance } from '../services/assistance/index.js';

const ApplyBody = z.object({
  expectedRevision: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(8).max(120),
  targetDurationSec: z.number().int().min(15).max(3_600).optional(),
}).strict();

export async function registerAssistanceRoutes(app: FastifyInstance, deps: { store: ProjectStore }) {
  const context = async (projectId: string, targetDurationSec?: number) => {
    const project = await deps.store.readProject(projectId);
    const storyboard = await loadStoryboard(project.path);
    if (!storyboard) throw Object.assign(new Error('Storyboard not found.'), { statusCode: 404 });
    const revisions = new RevisionStore(project.path);
    const revision = await revisions.currentRevision();
    const target = targetDurationSec ?? project.production_brief?.target_duration_sec ?? 180;
    return { project, storyboard, revisions, response: buildAssistance(storyboard, revision, target * 1_000) };
  };

  app.get<{ Params: { id: string }; Querystring: { targetDurationSec?: string } }>('/api/projects/:id/assistance', async (request, reply) => {
    const target = request.query.targetDurationSec === undefined ? undefined : Number(request.query.targetDurationSec);
    if (target !== undefined && (!Number.isInteger(target) || target < 15 || target > 3_600)) return reply.status(400).send({ error: 'Target duration must be 15–3600 seconds.', code: 'invalid_request' });
    try { return (await context(request.params.id, target)).response; }
    catch (error) { return reply.status((error as { statusCode?: number }).statusCode ?? 404).send({ error: error instanceof Error ? error.message : 'Assistance unavailable.', code: 'not_found' }); }
  });

  app.post<{ Params: { id: string; proposalId: string } }>('/api/projects/:id/assistance/:proposalId/apply', async (request, reply) => {
    const parsed = ApplyBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Apply request is invalid.', code: 'invalid_request' });
    try {
      const value = await context(request.params.id, parsed.data.targetDurationSec);
      const prior = (await value.revisions.listRevisions()).find((record) => record.idempotencyKey === parsed.data.idempotencyKey);
      if (prior) return { revision: prior.revision, reused: true };
      const proposal = value.response.proposals.find((candidate) => candidate.id === request.params.proposalId);
      if (!proposal) return reply.status(404).send({ error: 'Proposal is unavailable or stale. Refresh suggestions.', code: 'proposal_not_found' });
      if (proposal.status === 'accepted') return { revision: value.response.revision, reused: true };
      let commands: ProjectCommand[];
      if (proposal.kind === 'trim') {
        commands = [{ type: 'clip.trim', sceneId: proposal.scene_id, clipId: proposal.clip_id, sourceInMs: proposal.source_in_ms, sourceOutMs: proposal.source_out_ms }];
      } else if (proposal.kind === 'cleanup') {
        const scene = value.storyboard.scenes.find((candidate) => candidate.id === proposal.scene_id)!;
        const clip = scene.composition!.clips.find((candidate) => candidate.id === proposal.clip_id)!;
        const token = proposal.id.replace(/^proposal_/, '').slice(0, 16);
        if (proposal.remove_in_ms <= clip.source_in_ms) {
          commands = [{ type: 'clip.trim', sceneId: scene.id, clipId: clip.id, sourceInMs: proposal.remove_out_ms, sourceOutMs: clip.source_out_ms }];
        } else if (proposal.remove_out_ms >= clip.source_out_ms) {
          commands = [{ type: 'clip.trim', sceneId: scene.id, clipId: clip.id, sourceInMs: clip.source_in_ms, sourceOutMs: proposal.remove_in_ms }];
        } else {
          const left = `clip_${token}-left`;
          const remainder = `clip_${token}-remainder`;
          const removed = `clip_${token}-removed`;
          const right = `clip_${token}-right`;
          commands = [
            { type: 'clip.split', sceneId: scene.id, clipId: clip.id, splitSourceMs: proposal.remove_in_ms, leftClipId: left, rightClipId: remainder },
            { type: 'clip.split', sceneId: scene.id, clipId: remainder, splitSourceMs: proposal.remove_out_ms, leftClipId: removed, rightClipId: right },
            { type: 'clip.delete', sceneId: scene.id, clipId: removed },
          ];
        }
      } else if (proposal.kind === 'audio') {
        commands = [{ type: 'audio.mix.set', sceneId: proposal.scene_id, role: proposal.role, settings: proposal.settings }];
      } else if (proposal.kind === 'highlight') {
        commands = [{ type: 'editorial.range.set', sceneId: proposal.scene_id, range: { ...proposal.range, accepted_at: new Date().toISOString() } }];
      } else {
        const scene = value.storyboard.scenes.find((candidate) => candidate.id === proposal.scene_id)!;
        commands = [{ type: 'visual.effects.set', sceneId: proposal.scene_id, effects: [...(scene.visual_effects ?? []).filter((effect) => effect.id !== proposal.effect.id), proposal.effect] }];
      }
      return await value.revisions.execute({ expectedRevision: parsed.data.expectedRevision, idempotencyKey: parsed.data.idempotencyKey, targetState: 'draft', commands });
    } catch (error) {
      if (error instanceof RevisionError) return reply.status(error.code === 'stale_revision' ? 409 : 400).send({ error: error.message, code: error.code, currentRevision: error.currentRevision });
      return reply.status((error as { statusCode?: number }).statusCode ?? 404).send({ error: error instanceof Error ? error.message : 'Assistance unavailable.', code: 'not_found' });
    }
  });
}
