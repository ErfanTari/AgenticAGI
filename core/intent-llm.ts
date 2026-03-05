/**
 * FIX 5 — LLM Intent Classifier.
 *
 * Hybrid classification architecture:
 * - Regex fast-path (core/intent.ts): handles explicit structured commands with zero latency
 * - LLM classifier (this file): handles free-form natural language when regex returns 'general'
 *
 * The LLM call uses max_tokens=10 and temperature=0 for deterministic one-word output.
 * Output is mapped back to existing Intent types for backwards compatibility.
 */
import type { LLMHandler } from './types.js';
import type { Intent } from './types.js';

const CLASSIFIER_SYSTEM_PROMPT = `You are an intent classifier for a personal AI agent.
Classify the user message into exactly one intent.

Intents:
- planned_workflow: user wants agent to DO something requiring tool use, file creation,
  code execution, web search, or multi-step tasks. Key signals: action verbs targeting
  external state (build, create, run, write, install, search, find, make, set up, execute,
  schedule, send, call, translate, calculate as a task, order, book, implement, develop).
- memory_write: user wants to STORE something in memory. Key signals: remember, note,
  save, add to my list, remind me, log, record, track, "my name is", "call me".
- memory_query: user wants to RETRIEVE something from memory. Key signals: what do I know
  about, show me my, find my, list my, recall, look up my, who is, what is, when is.
- episodic_query: user asking about past agent activity. Key signals: what happened,
  history of, what did you do, why did, last time, previously.
- meeting: user wants a session briefing or standup. Key signals: standup, briefing,
  what's on my plate, catch me up, meeting mode.
- general: everything else — questions, chitchat, opinions, factual queries about the
  world, identity questions, simple calculations phrased as questions.

Reply with ONLY the intent name. No explanation. No punctuation. One word.`;

// Valid intents this classifier can return (maps to existing Intent type values)
const VALID_OUTPUTS: ReadonlyArray<Intent> = [
  'planned_workflow',
  'memory_write',
  'memory_query',
  'episodic_query',
  'meeting',
  'general',
];

/**
 * Classify a message using the LLM.
 * Always returns a valid Intent — falls back to 'general' on any error or unrecognized output.
 * Uses max_tokens=10 for minimal latency (one-word output).
 */
export async function classifyIntentLLM(
  message: string,
  llmHandler: LLMHandler,
): Promise<Intent> {
  try {
    const raw = await llmHandler(
      [
        { role: 'system', content: CLASSIFIER_SYSTEM_PROMPT },
        { role: 'user', content: message },
      ],
      { maxTokens: 10 },
    );

    // Normalize: lowercase, remove all non-letter/underscore chars, trim
    const normalized = raw.trim().toLowerCase().replace(/[^a-z_]/g, '') as Intent;

    // Exact match
    if ((VALID_OUTPUTS as readonly string[]).includes(normalized)) {
      return normalized as Intent;
    }

    // Explicit alias mapping for common LLM variations that don't exactly match
    const ALIASES: Record<string, Intent> = {
      'memory_read':    'memory_query',
      'memory_retrieve': 'memory_query',
      'memory_update':  'memory_write',
      'memory_delete':  'memory_write',
      'memory_store':   'memory_write',
      'workflow':       'planned_workflow',
      'task':           'planned_workflow',
    };
    if (normalized in ALIASES) {
      return ALIASES[normalized];
    }

    // Partial match (handles e.g. "memory" prefix overlap)
    for (const valid of VALID_OUTPUTS) {
      if (normalized.startsWith(valid.split('_')[0]) && valid.startsWith(normalized.split('_')[0])) {
        return valid;
      }
    }

    console.warn(`[intent-llm] unrecognized output: "${raw}" — falling back to general`);
    return 'general';
  } catch (err) {
    console.warn(`[intent-llm] classifier failed: ${err} — falling back to general`);
    return 'general';
  }
}
