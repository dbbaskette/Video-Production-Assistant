import type { LlmClient } from '../llm/index.js';
import { DesignMdFrontMatter } from '@vpa/shared';

export interface ExtractTokensInput {
  systemPrompt: string;
  sourceMarkdown: string;
  brandName: string;
}

export interface ExtractTokensResult {
  frontMatter: DesignMdFrontMatter;
  rawResponse: string;
}

// ---------------------------------------------------------------------------
// Pass-2 conformance prompt — fixes whatever the first LLM mangled
// ---------------------------------------------------------------------------

const CONFORM_SYSTEM = `You are a JSON conformance assistant. You will receive a rough JSON object representing design tokens and a target schema. Your job is to produce a CLEAN, VALID JSON object that:

1. Preserves all the design intent and values from the input
2. Fixes any syntax errors, markdown artifacts, or malformed references
3. Ensures token references use the exact format {colors.name} or {rounded.name} — NOT markdown links, NOT raw values
4. Ensures all hex colors are #RRGGBB format (6 digits)
5. Ensures version is the string "alpha"
6. Ensures typography levels use fontFamily (string), fontSize (CSS like "16px"), fontWeight (number), lineHeight (number or CSS)
7. Ensures rounded and spacing values are CSS dimension strings like "4px", "8px"
8. Ensures component sub-tokens use recognized names: backgroundColor, textColor, typography, rounded, padding, size, height, width

Output ONLY the corrected JSON object. No commentary, no code fences, no explanation.`;

// ---------------------------------------------------------------------------
// Main extraction pipeline
// ---------------------------------------------------------------------------

export async function extractTokens(
  llm: LlmClient,
  input: ExtractTokensInput,
): Promise<ExtractTokensResult> {
  const userPrompt = `<<NAME=${input.brandName}>>\n\n${input.sourceMarkdown}`;

  // ── Pass 1: raw extraction ───────────────────────────────────────
  const out = await llm.complete({
    systemPrompt: input.systemPrompt,
    userPrompt,
    responseFormat: 'json',
    temperature: 0.2,
  });

  const rawText = out.text;
  const cleaned = stripFences(rawText);

  // Try parsing directly — if it works and validates, skip pass 2
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
    const validated = DesignMdFrontMatter.safeParse(parsed);
    if (validated.success) {
      return { frontMatter: validated.data, rawResponse: rawText };
    }
    // Valid JSON but bad schema — fall through to pass 2
  } catch {
    // Invalid JSON — fall through to pass 2
  }

  // ── Pass 2: conformance ──────────────────────────────────────────
  // Send the raw LLM output back through for cleanup
  const conformPrompt = `Here is the rough design token JSON to clean up:\n\n${cleaned}\n\nFix any issues and return valid JSON conforming to the Google design.md schema.`;

  const pass2 = await llm.complete({
    systemPrompt: CONFORM_SYSTEM,
    userPrompt: conformPrompt,
    responseFormat: 'json',
    temperature: 0,
  });

  const pass2Text = stripFences(pass2.text);
  let pass2Parsed: unknown;
  try {
    pass2Parsed = JSON.parse(pass2Text);
  } catch {
    throw new Error(
      `LLM conformance pass returned invalid JSON.\nPass 1 raw: ${rawText}\nPass 2 raw: ${pass2.text}`,
    );
  }

  const validated = DesignMdFrontMatter.safeParse(pass2Parsed);
  if (!validated.success) {
    throw new Error(
      `LLM conformance pass returned JSON that still fails schema validation: ${validated.error.message}\nraw response: ${pass2.text}`,
    );
  }

  return { frontMatter: validated.data, rawResponse: pass2.text };
}

function stripFences(s: string): string {
  return s.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
}
