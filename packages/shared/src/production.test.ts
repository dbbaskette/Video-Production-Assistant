import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { DEFAULT_PRODUCTION_BRIEF, ProductionBriefSchema } from './project.js';
import { PilotCaseSchema, PilotEvaluationSchema, ProductionRecipeInspectionSchema, ProposalOperationSchema } from './production.js';

describe('production orchestration contracts', () => {
  it('provides explicit bounded brief defaults', () => {
    expect(ProductionBriefSchema.parse({})).toEqual(DEFAULT_PRODUCTION_BRIEF);
    expect(DEFAULT_PRODUCTION_BRIEF).toMatchObject({ target_duration_sec: 180, aspect_ratio: '16:9', tone: 'clear' });
  });

  it('validates proposal operations, recipe inspections, and all five pilot kinds', () => {
    expect(ProposalOperationSchema.safeParse({ type: 'delete', sceneId: 'scene-01' }).success).toBe(true);
    expect(ProductionRecipeInspectionSchema.safeParse({ recipe: 'feature-demo', revision: 2, supported: true, sources: [], blockers: [], effects: [] }).success).toBe(true);
    for (const kind of ['narrated-walkthrough', 'screen-only-feature-demo', 'webcam-demo', 'imported-take', 'multi-clip-redaction']) {
      expect(PilotCaseSchema.safeParse({ id: `pilot-${kind}`, kind, requiredRecipe: kind === 'screen-only-feature-demo' ? 'feature-demo' : kind === 'multi-clip-redaction' ? 'revise-this-draft' : 'clean-walkthrough', requiresFeedbackRevision: true, requiresSourceRestore: true, requiresPlayableExport: true }).success).toBe(true);
    }
  });

  it('requires one completed evidence record for every pilot case', () => {
    const cases = ['narrated-walkthrough', 'screen-only-feature-demo', 'webcam-demo', 'imported-take', 'multi-clip-redaction'].map((kind, index) => ({ id: `pilot-${index}`, kind, requiredRecipe: kind === 'screen-only-feature-demo' ? 'feature-demo' : kind === 'multi-clip-redaction' ? 'revise-this-draft' : 'clean-walkthrough', requiresFeedbackRevision: true, requiresSourceRestore: true, requiresPlayableExport: true }));
    const result = (caseId: string) => ({ caseId, hands_on_minutes: 0, editorial_accuracy: 1, target_length_tradeoffs: 'Automated qualification fixture.', omissions: [], browser_version: 'jsdom', device_version: 'synthetic', codex_draft_revision: 1, feedback_revision: 3, restore_revision: 4, artifact_id: `artifact-${caseId}`, evidence: { automated_test: 'production-pilot.test.ts', playable_probe: 'ffprobe', source_preserved: true } });
    expect(PilotEvaluationSchema.safeParse({ version: 1, verified_at: '2026-09-25T12:00:00.000Z', fields: ['hands_on_minutes'], cases, results: cases.map((pilot) => result(pilot.id)) }).success).toBe(true);
    expect(PilotEvaluationSchema.safeParse({ version: 1, verified_at: '2026-09-25T12:00:00.000Z', fields: [], cases, results: cases.map(() => result(cases[0]!.id)) }).success).toBe(false);
  });

  it('validates the checked-in completed pilot evidence', async () => {
    const raw = await readFile(new URL('../../../docs/pilots/production-pilot.json', import.meta.url), 'utf8');
    expect(PilotEvaluationSchema.parse(JSON.parse(raw)).results.map((result) => result.caseId)).toEqual([
      'pilot-narrated',
      'pilot-screen',
      'pilot-webcam',
      'pilot-import',
      'pilot-multiclip',
    ]);
  });
});
