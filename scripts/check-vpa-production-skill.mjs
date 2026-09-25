import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { HELP } from '../apps/cli/dist/cli.js';

const root = process.cwd();
const skill = await readFile(join(root, '.agents', 'skills', 'vpa-production', 'SKILL.md'), 'utf8');

const commands = [
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
];

const missingFromHelp = commands.filter((command) => !HELP.includes(command));
const missingFromSkill = commands.filter((command) => !skill.includes(command));
const requiredBoundaries = [
  ['overwrite remains explicit', /only then add `--overwrite`/i],
  ['no silent fallback', /never silently substitute/i],
  ['credentials stay in VPA', /never read, print, copy, or pass provider secrets/i],
  ['terminal completion required', /terminal `status` is `completed`/i],
  ['audio artifact verification', /output path exists and is non-empty/i],
];
const missingBoundaries = requiredBoundaries
  .filter(([, pattern]) => !pattern.test(skill))
  .map(([label]) => label);

if (missingFromHelp.length || missingFromSkill.length || missingBoundaries.length) {
  throw new Error(
    [
      missingFromHelp.length ? `Missing CLI help commands: ${missingFromHelp.join(', ')}` : null,
      missingFromSkill.length ? `Missing skill commands: ${missingFromSkill.join(', ')}` : null,
      missingBoundaries.length ? `Missing skill boundaries: ${missingBoundaries.join(', ')}` : null,
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

process.stdout.write('VPA production skill matches the CLI contract.\n');
