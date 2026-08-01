import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { URL } from 'node:url';
import { validateAgentRecordingSkill } from './check-agent-recording-skill.mjs';

const skillPath = new URL('../.agents/skills/vpa-agent-recording/SKILL.md', import.meta.url);
const handoffPath = new URL(
  '../.agents/skills/vpa-agent-recording/references/handoff-template.md',
  import.meta.url,
);
const [validSkill, validHandoff] = await Promise.all([
  readFile(skillPath, 'utf8'),
  readFile(handoffPath, 'utf8'),
]);

test('accepts the repository contract and reinforcing Cap prohibitions', () => {
  assert.doesNotThrow(() =>
    validateAgentRecordingSkill({
      skillText: `${validSkill}\nNever run cap record. Never start Cap.`,
      handoffText: validHandoff,
    }),
  );
});

for (const assignedResponsibility of [
  'After rehearsal, invoke the Cap CLI.',
  'After confirmation, run cap record.',
  'Start Cap after the user confirms.',
  'Record with Cap once rehearsal passes.',
  'Export the take using Cap.',
  'Upload the MP4 to the scene endpoint.',
  'PATCH the VPA session to completed.',
  'Never run cap record; however, start Cap after confirmation.',
]) {
  test(`rejects assigned responsibility: ${assignedResponsibility}`, () => {
    assert.throws(
      () =>
        validateAgentRecordingSkill({
          skillText: `${validSkill}\n${assignedResponsibility}`,
          handoffText: validHandoff,
        }),
      /assigned to Codex/i,
    );
  });
}

test('rejects a handoff that is presented as the primary recording workflow', () => {
  assert.throws(
    () =>
      validateAgentRecordingSkill({
        skillText: validSkill,
        handoffText: `# VPA recording handoff\n\nUse this as the primary recording workflow.\nFetch the plan and record the scene.`,
      }),
    /non-primary troubleshooting/i,
  );
});
