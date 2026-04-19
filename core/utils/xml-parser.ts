/**
 * parseXmlAction — Phase 24
 *
 * Parses XML tags from LLM output at the tool-call boundary.
 *
 * Expected format:
 *   <action>skill_name</action>
 *   <key>value</key>
 *   <multiline_key>
 *   content here
 *   </multiline_key>
 *
 * Rules:
 * - Extracts all <tag>value</tag> pairs (including multiline values)
 * - Values are preserved as-is (no trimming of internal whitespace)
 * - Unknown tags included as-is (forward compatible)
 * - Never throws; returns {} on total failure
 * - Does NOT parse nested XML — flat key/value only
 *
 * Replaces extractFirstJsonObject + applyRepairPasses + flattenSingleKeyObjects
 * for the query-loop tool-call boundary only.
 */
export function parseXmlAction(text: string): Record<string, string> {
  if (!text) return {};

  const firstAction = text.match(/<action>([\s\S]*?)<\/action>/i);
  if (!firstAction || firstAction.index === undefined) return {};

  const result: Record<string, string> = {
    action: firstAction[1],
  };

  const thought = text.slice(0, firstAction.index).trim();
  if (thought) {
    result.thought = thought;
  }

  const paramsStart = firstAction.index + firstAction[0].length;
  const nextActionOffset = text.slice(paramsStart).search(/<action>/i);
  const paramsEnd = nextActionOffset === -1 ? text.length : paramsStart + nextActionOffset;
  const paramsText = text.slice(paramsStart, paramsEnd);

  const childTag = /<([a-zA-Z_][a-zA-Z0-9_]*)>([\s\S]*?)<\/\1>/g;
  let match: RegExpExecArray | null;
  while ((match = childTag.exec(paramsText)) !== null) {
    const tagName = match[1];
    if (tagName === 'action') continue;
    result[tagName] = match[2];
  }

  return result;
}

/**
 * Returns true if text contains at least an <action> tag with a non-empty value.
 */
export function looksLikeXmlToolCall(text: string): boolean {
  return /<action>[^<\s][^<]*<\/action>/i.test(text);
}

/**
 * Returns true if text has an opening <action> tag but no matching closing tag —
 * i.e. the LLM started an XML block but truncated.
 */
export function looksLikeIncompleteXmlToolCall(text: string): boolean {
  if (!/<action>/i.test(text)) return false;
  return !/<\/action>/i.test(text);
}

// ─── Plan XML parser (Phase 24B) ─────────────────────────────────────────────

export interface ParsedPlanStep {
  id: string;
  description: string;
  skill: string;
  input: Record<string, string>;
  dependsOn: string[];
  storeResultAs: string | null;
  optional: boolean;
  confidence_score: number;
  risk_level: string;
}

export interface ParsedPlanMilestone {
  id: string;
  title: string;
  description: string;
  completionCriteria: string;
  goalIds: string[];
  steps: ParsedPlanStep[];
}

export interface ParsedPlan {
  goal: string;
  complexity: string;
  needsConfirmation: boolean;
  estimatedDuration: string;
  milestones: ParsedPlanMilestone[];
  /** Flat step list derived from milestones — same order */
  steps: ParsedPlanStep[];
}

/**
 * Extract the raw content between two XML tags.
 * Returns null if the tag pair is not found.
 * Uses indexOf so it handles multiline content naturally.
 */
function extractTagContent(text: string, tag: string, fromIndex = 0): { value: string; end: number } | null {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const start = text.indexOf(open, fromIndex);
  if (start === -1) return null;
  const valueStart = start + open.length;
  const end = text.indexOf(close, valueStart);
  if (end === -1) return null;
  return { value: text.slice(valueStart, end), end: end + close.length };
}

/**
 * Extract attribute value from an opening tag string like:
 *   <milestone id="m1" title="Generate file">
 */
function extractAttr(tag: string, attr: string): string {
  const re = new RegExp(`${attr}="([^"]*)"`, 'i');
  const m = tag.match(re);
  return m ? m[1] : '';
}

/**
 * Extract all occurrences of <tag ...>content</tag> blocks from text,
 * returning an array of { attrs: string (raw opening tag), content: string }.
 */
export function extractBlocks(text: string, tag: string): Array<{ attrs: string; content: string }> {
  const results: Array<{ attrs: string; content: string }> = [];
  // Opening tag may have attributes: <milestone id="m1" title="...">
  const openRe = new RegExp(`<${tag}(\\s[^>]*)?>`, 'gi');
  const closeTag = `</${tag}>`;
  let m: RegExpExecArray | null;

  while ((m = openRe.exec(text)) !== null) {
    const fullOpen = m[0];
    const contentStart = m.index + fullOpen.length;
    const closeIndex = text.indexOf(closeTag, contentStart);
    if (closeIndex === -1) continue;
    results.push({
      attrs: fullOpen,
      content: text.slice(contentStart, closeIndex),
    });
    openRe.lastIndex = closeIndex + closeTag.length;
  }

  return results;
}

/**
 * Parse a <step> block into a ParsedPlanStep.
 * Never throws — missing fields get safe defaults.
 */
function parseStep(stepContent: string, stepAttrs: string): ParsedPlanStep {
  const id = extractAttr(stepAttrs, 'id') || extractTagContent(stepContent, 'id')?.value.trim() || '';
  const description = extractTagContent(stepContent, 'description')?.value.trim() ?? '';
  const skill = extractTagContent(stepContent, 'skill')?.value.trim() ?? '';
  const storeResultAsRaw = extractTagContent(stepContent, 'storeResultAs')?.value.trim() ?? null;
  const storeResultAs = storeResultAsRaw === '' || storeResultAsRaw === 'null' ? null : storeResultAsRaw;
  const optionalRaw = extractTagContent(stepContent, 'optional')?.value.trim() ?? 'false';
  const optional = optionalRaw === 'true';
  const confidenceRaw = extractTagContent(stepContent, 'confidence_score')?.value.trim() ?? '0.8';
  const confidence_score = Math.min(1, Math.max(0, parseFloat(confidenceRaw) || 0.8));
  const risk_level = extractTagContent(stepContent, 'risk_level')?.value.trim() ?? 'LOW';

  // Parse <dependsOn> — space or comma separated IDs, or repeated <dep> children
  const dependsOnRaw = extractTagContent(stepContent, 'dependsOn')?.value.trim() ?? '';
  const dependsOn = dependsOnRaw
    ? dependsOnRaw.split(/[\s,]+/).map(s => s.trim()).filter(Boolean)
    : [];

  // Parse <input> children as key-value pairs
  const inputBlock = extractBlocks(stepContent, 'input');
  const input: Record<string, string> = {};
  if (inputBlock.length > 0) {
    const inputContent = inputBlock[0].content;
    // Each child tag inside <input> is a parameter
    const childRe = /<([a-zA-Z_][a-zA-Z0-9_]*)>([\s\S]*?)<\/\1>/g;
    let cm: RegExpExecArray | null;
    while ((cm = childRe.exec(inputContent)) !== null) {
      input[cm[1]] = cm[2];
    }
  }

  return { id, description, skill, input, dependsOn, storeResultAs, optional, confidence_score, risk_level };
}

/**
 * parsePlanXml — Phase 24B
 *
 * Parses a <plan>...</plan> XML block produced by the LLM planner into a
 * ParsedPlan object. Replaces sanitizePlannerJson + extractFirstJsonObject +
 * flattenSingleKeyObjects + JSON.parse at the planner boundary.
 *
 * Rules:
 * - Strips <think>/<thought> blocks before parsing
 * - Returns null if no <plan>...</plan> pair found (truncated output)
 * - Never throws — malformed fields get safe defaults
 * - input values inside steps are raw strings (no JSON escaping issues)
 * - Multi-line body/content fields work natively
 */
export function parsePlanXml(raw: string): ParsedPlan | null {
  if (!raw) return null;

  // Strip thinking blocks before searching for <plan>
  const stripped = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
    .replace(/<\|im_start\|>[\s\S]*?<\|im_end\|>/g, '')
    .trim();

  const planBlock = extractTagContent(stripped, 'plan');
  if (!planBlock) return null;

  const body = planBlock.value;

  const goal = extractTagContent(body, 'goal')?.value.trim() ?? '';
  const complexity = extractTagContent(body, 'complexity')?.value.trim() ?? 'LOW';
  const needsConfirmationRaw = extractTagContent(body, 'needsConfirmation')?.value.trim() ?? 'false';
  const needsConfirmation = needsConfirmationRaw === 'true';
  const estimatedDuration = extractTagContent(body, 'estimatedDuration')?.value.trim() ?? '';

  // Parse milestones
  const milestoneBlocks = extractBlocks(body, 'milestone');
  const milestones: ParsedPlanMilestone[] = milestoneBlocks.map(mb => {
    const id = extractAttr(mb.attrs, 'id') || extractTagContent(mb.content, 'id')?.value.trim() || '';
    const title = extractAttr(mb.attrs, 'title') || extractTagContent(mb.content, 'title')?.value.trim() || '';
    const description = extractTagContent(mb.content, 'description')?.value.trim() ?? '';
    const completionCriteria = extractTagContent(mb.content, 'completionCriteria')?.value.trim() ?? '';
    const goalIdsRaw = extractTagContent(mb.content, 'goalIds')?.value.trim() ?? '';
    const goalIds = goalIdsRaw ? goalIdsRaw.split(/[\s,]+/).map(s => s.trim()).filter(Boolean) : [];

    const stepBlocks = extractBlocks(mb.content, 'step');
    const steps = stepBlocks.map(sb => parseStep(sb.content, sb.attrs));

    return { id, title, description, completionCriteria, goalIds, steps };
  });

  // Derive flat steps list from milestones (preserving order)
  const steps: ParsedPlanStep[] = milestones.flatMap(m => m.steps);

  // Fallback: if no milestones found, try top-level <step> blocks
  if (steps.length === 0) {
    const topStepBlocks = extractBlocks(body, 'step');
    steps.push(...topStepBlocks.map(sb => parseStep(sb.content, sb.attrs)));
  }

  return { goal, complexity, needsConfirmation, estimatedDuration, milestones, steps };
}

/**
 * Returns true if the text contains a complete <plan>...</plan> block.
 */
export function looksLikeCompletePlanXml(text: string): boolean {
  return /<plan[\s>]/i.test(text) && /<\/plan>/i.test(text);
}

/**
 * Returns true if the text has an opening <plan> but no closing </plan> —
 * i.e. the LLM started a plan block but was truncated.
 */
export function looksLikeIncompletePlanXml(text: string): boolean {
  if (!/<plan[\s>]/i.test(text)) return false;
  return !/<\/plan>/i.test(text);
}
