import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const skillPath = join(process.cwd(), '.agents', 'skills', 'vpa-agent-recording', 'SKILL.md');
const text = await readFile(skillPath, 'utf8');
const required = [
  /^---\nname: vpa-agent-recording\ndescription: Use when/m,
  /cap guide --json/,
  /cap doctor --json/,
  /cap targets --json/,
  /rehears/i,
  /explicit confirmation/i,
  /exact recording ID/i,
  /validate/i,
  /export/i,
  /do not attach/i,
  /Cap Cloud/i,
  /terminal/i,
  /ChatGPT/i,
];

const missing = required.filter((pattern) => !pattern.test(text)).map(String);
if (missing.length) {
  throw new Error(`Agent recording skill is missing required contracts:\n${missing.join('\n')}`);
}
console.log('Agent recording skill contract is complete.');
