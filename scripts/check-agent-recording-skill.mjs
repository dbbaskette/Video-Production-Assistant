import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

const skillPath = join(process.cwd(), '.agents', 'skills', 'vpa-agent-recording', 'SKILL.md');
const text = await readFile(skillPath, 'utf8');
const required = [
  /^---\nname: vpa-agent-recording\ndescription: Use when/m,
  /plan embedded by VPA/i,
  /only [`']?scripts\/vpa-desktop-driver\.mjs[`']? for (?:all )?GUI operations/i,
  /never run [`']?cap[`']?/i,
  /never (?:upload|attach)/i,
  /never (?:change|patch|update).*VPA session state/i,
  /never operate another app/i,
  /completedStepIndexes/,
  /resetConfirmed/,
  /windowBounds/,
  /execute only the rehearsed actions/i,
  /execution evidence/i,
];

const missing = required.filter((pattern) => !pattern.test(text)).map(String);
const obsoleteResponsibilities = [
  {
    pattern: /cap (?:guide|doctor|targets|record|export|validate)/i,
    label: 'direct Cap CLI responsibility',
  },
  { pattern: /(?:start|stop|validate|export).*Cap/i, label: 'Cap lifecycle responsibility' },
  {
    pattern: /(?:upload|attach) (?:the )?MP4/i,
    label: 'recording upload/attachment responsibility',
  },
  { pattern: /PATCH.*session/i, label: 'VPA session mutation responsibility' },
  { pattern: /Computer Use/i, label: 'obsolete Computer Use driver' },
  {
    pattern: /Fetch (?:and validate )?(?:the )?(?:exact )?(?:reviewed )?plan/i,
    label: 'obsolete plan fetching responsibility',
  },
];

const obsolete = obsoleteResponsibilities
  .filter(({ pattern }) => pattern.test(text))
  .map(({ label, pattern }) => `${label}: ${pattern}`);

if (missing.length || obsolete.length) {
  const failures = [
    missing.length ? `Missing required contracts:\n${missing.join('\n')}` : null,
    obsolete.length ? `Obsolete Codex responsibilities:\n${obsolete.join('\n')}` : null,
  ].filter(Boolean);
  throw new Error(`Agent recording skill contract failed:\n${failures.join('\n\n')}`);
}
process.stdout.write('Agent recording skill contract is complete.\n');
