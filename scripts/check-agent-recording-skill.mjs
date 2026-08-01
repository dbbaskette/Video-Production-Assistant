import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const responsibilityPatterns = [
  {
    label: 'Cap CLI or lifecycle',
    pattern:
      /\b(?:invoke|execute|run)\b.{0,50}\bcap(?:\s+cli|\s+(?:guide|doctor|targets|record|start|stop|validate|export))?\b/i,
  },
  {
    label: 'Cap lifecycle',
    pattern: /\b(?:start|stop|validate|export|record(?:\s+with)?)\b.{0,60}\bcap\b/i,
  },
  {
    label: 'recording upload or attachment',
    pattern: /\b(?:upload|attach)\b.{0,60}\b(?:mp4|recordings?|takes?|scenes?|files?)\b/i,
  },
  {
    label: 'VPA session mutation',
    pattern: /\b(?:patch|change|mutate|update|set)\b.{0,60}\b(?:vpa\s+)?session(?:\s+state)?\b/i,
  },
  { label: 'another application', pattern: /\boperate\b.{0,30}\banother app(?:lication)?\b/i },
  { label: 'Computer Use driver', pattern: /\bComputer Use\b/i },
  { label: 'plan fetching', pattern: /\bfetch\b.{0,60}\bplan\b/i },
];

const negation = /\b(?:never|do not|don't|must not|may not|cannot|can't|forbidden|refuse)\b/i;

function clauses(text) {
  return text
    .replaceAll('`', '')
    .split(/\r?\n|[.;](?=\s|$)|,\s*(?=(?:but|however)\b)|\b(?:but|however)\b/iu)
    .map((clause) => clause.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim())
    .filter(Boolean);
}

function responsibilityHits(text) {
  const hits = [];
  for (const clause of clauses(text)) {
    for (const responsibility of responsibilityPatterns) {
      const match = responsibility.pattern.exec(clause);
      if (!match) continue;
      const beforeAction = clause.slice(0, match.index);
      hits.push({
        ...responsibility,
        clause,
        prohibited: negation.test(beforeAction),
      });
    }
  }
  return hits;
}

function hasProhibition(text, label) {
  return responsibilityHits(text).some((hit) => hit.label === label && hit.prohibited);
}

export function validateAgentRecordingSkill({ skillText, handoffText }) {
  const required = [
    {
      label: 'trigger-only frontmatter',
      present: /^---\nname: vpa-agent-recording\ndescription: Use when[^\n]+\n---/m.test(skillText),
    },
    {
      label: 'VPA-embedded reviewed plan',
      present:
        /\bplan\b.{0,80}\bembedded by VPA\b/i.test(skillText) ||
        /\bembedded by VPA\b.{0,80}\bplan\b/i.test(skillText),
    },
    {
      label: 'exclusive VPA desktop driver for GUI operations',
      present: /\bonly\b.{0,80}\bscripts\/vpa-desktop-driver\.mjs\b.{0,80}\bGUI operations\b/i.test(
        skillText.replaceAll('`', ''),
      ),
    },
    { label: 'Cap prohibition', present: hasProhibition(skillText, 'Cap CLI or lifecycle') },
    {
      label: 'upload/attachment prohibition',
      present: hasProhibition(skillText, 'recording upload or attachment'),
    },
    {
      label: 'VPA session-state prohibition',
      present: hasProhibition(skillText, 'VPA session mutation'),
    },
    {
      label: 'other-application prohibition',
      present: hasProhibition(skillText, 'another application'),
    },
    { label: 'windowBounds evidence', present: /\bwindowBounds\b/.test(skillText) },
    {
      label: 'completedStepIndexes evidence',
      present: /\bcompletedStepIndexes\b/.test(skillText),
    },
    { label: 'resetConfirmed evidence', present: /\bresetConfirmed\b/.test(skillText) },
    {
      label: 'rehearsed-actions-only resumed turn',
      present: /execute only the rehearsed actions/i.test(skillText),
    },
    { label: 'execution evidence', present: /execution evidence/i.test(skillText) },
  ];

  const missing = required.filter(({ present }) => !present).map(({ label }) => label);
  const assigned = responsibilityHits(skillText)
    .filter(({ prohibited }) => !prohibited)
    .map(({ label, clause }) => `${label}: ${JSON.stringify(clause)}`);

  const handoffIsNonPrimary =
    /\bnon-primary\b/i.test(handoffText) &&
    /\btroubleshoot(?:ing)?\b/i.test(handoffText) &&
    /\bnot\b.{0,40}\b(?:rehearsal|recording)\b.{0,20}\bprompt\b/i.test(handoffText);

  const failures = [
    missing.length ? `Missing required contracts:\n${missing.join('\n')}` : null,
    assigned.length ? `Responsibilities assigned to Codex:\n${assigned.join('\n')}` : null,
    !handoffIsNonPrimary
      ? 'Handoff must be explicitly non-primary troubleshooting and not a rehearsal/recording prompt.'
      : null,
  ].filter(Boolean);

  if (failures.length) {
    throw new Error(`Agent recording skill contract failed:\n${failures.join('\n\n')}`);
  }
}

async function main() {
  const skillRoot = join(process.cwd(), '.agents', 'skills', 'vpa-agent-recording');
  const [skillText, handoffText] = await Promise.all([
    readFile(join(skillRoot, 'SKILL.md'), 'utf8'),
    readFile(join(skillRoot, 'references', 'handoff-template.md'), 'utf8'),
  ]);
  validateAgentRecordingSkill({ skillText, handoffText });
  process.stdout.write('Agent recording skill contract is complete.\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
