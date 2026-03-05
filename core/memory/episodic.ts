/**
 * P3: WHEN.EV + WHEN.RF + WHEN.HX — Episodic memory system.
 */
import { createEntry } from './write.js';
import { queryEntries } from './index.js';
import type { LLMHandler } from '../types.js';

export interface EpisodicEvent {
  code: string;
  trigger: string;
  task_name: string;
  skill_sequence: string[];
  outcome: 'success' | 'failure' | 'partial';
  failure_reason?: string;
  linked_codes: string[];
  session_id: string;
}

/**
 * Write a WHEN.EV episodic event entry.
 */
export async function writeEpisodicEvent(
  event: Omit<EpisodicEvent, 'code'>,
): Promise<string> {
  const body = `## Trigger
${event.trigger}

## Outcome
${event.outcome}${event.failure_reason ? `\n\n### Failure Reason\n${event.failure_reason}` : ''}

## Skill Sequence
${event.skill_sequence.join(' → ') || 'None'}

## Linked Entries
${event.linked_codes.join(', ') || 'None'}

## Session
${event.session_id}
`;

  const entry = createEntry({
    nb: 'WHEN',
    type: 'EV',
    name: event.task_name,
    status: 'active',
    summary: `${event.outcome} — ${event.task_name.slice(0, 60)}`,
    body,
  });

  return entry.code;
}

/**
 * Write a WHEN.RF reflection on a task event.
 */
export async function writeReflection(
  taskCode: string,
  event: EpisodicEvent,
  llmHandler: LLMHandler,
): Promise<string> {
  let reflectionText = '';

  try {
    const messages = [
      {
        role: 'system' as const,
        content: 'You are a reflective agent. Given a completed task event, write a brief 2-3 sentence reflection on what went well, what could be improved, and what was learned. Be concise.',
      },
      {
        role: 'user' as const,
        content: `Task: ${event.task_name}\nOutcome: ${event.outcome}\nSkills used: ${event.skill_sequence.join(' → ')}\n${event.failure_reason ? `Failure reason: ${event.failure_reason}` : ''}`,
      },
    ];

    reflectionText = await llmHandler(messages, { maxTokens: 200 });
    // Strip thinking tags
    reflectionText = reflectionText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  } catch {
    reflectionText = `Completed task "${event.task_name}" with outcome: ${event.outcome}.`;
  }

  const body = `## Reflection on ${taskCode}
${reflectionText}

## Event Reference
${taskCode}

## Session
${event.session_id}
`;

  const entry = createEntry({
    nb: 'WHEN',
    type: 'RF',
    name: `Reflection: ${event.task_name.slice(0, 50)}`,
    status: 'active',
    summary: reflectionText.slice(0, 100),
    body,
  });

  return entry.code;
}

/**
 * Compact older episodic events into a WHEN.HX history summary.
 * Fire-and-forget — only runs when there are > 20 WHEN.EV entries.
 */
export async function compactEpisodicHistory(llmHandler: LLMHandler): Promise<void> {
  try {
    const events = queryEntries({ nb: 'WHEN', type: 'EV' });
    if (events.length <= 20) return;

    // Take oldest 10 to compact
    const oldest = events
      .sort((a, b) => a.updated.localeCompare(b.updated))
      .slice(0, 10);

    const summaryText = oldest.map(e => `- ${e.name}: ${e.summary}`).join('\n');

    let compacted = '';
    try {
      const messages = [
        {
          role: 'system' as const,
          content: 'Summarize these past episodic events into a compact 3-5 sentence history. Focus on patterns and outcomes.',
        },
        { role: 'user' as const, content: summaryText },
      ];
      compacted = await llmHandler(messages, { maxTokens: 300 });
      compacted = compacted.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    } catch {
      compacted = summaryText;
    }

    createEntry({
      nb: 'WHEN',
      type: 'HX',
      name: `History: ${new Date().toISOString().slice(0, 10)}`,
      status: 'active',
      summary: 'Compacted episodic history',
      body: compacted,
    });
  } catch (err) {
    console.warn('[episodic] compactEpisodicHistory failed:', err);
  }
}

/**
 * Detect macro-skill patterns from episodic events and save as HOW.SK entries.
 */
export async function detectMacroSkills(llmHandler: LLMHandler): Promise<void> {
  try {
    const events = queryEntries({ nb: 'WHEN', type: 'EV', status: 'active' });
    if (events.length < 5) return;

    const successEvents = events.filter(e => e.summary?.startsWith('success'));
    if (successEvents.length < 3) return;

    const patterns = successEvents.map(e => e.summary).join('\n');

    let skill = '';
    try {
      const messages = [
        {
          role: 'system' as const,
          content: 'Given these successful task outcomes, identify a reusable skill or pattern. Return a JSON object: {"name": "skill name", "description": "brief description", "trigger": "when to use this"}',
        },
        { role: 'user' as const, content: patterns },
      ];
      const response = await llmHandler(messages, { maxTokens: 200 });
      const cleaned = response.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        skill = `${parsed.name}: ${parsed.description}\nTrigger: ${parsed.trigger}`;

        createEntry({
          nb: 'HOW',
          type: 'SK',
          name: parsed.name ?? 'Detected Macro Skill',
          status: 'active',
          summary: parsed.description ?? 'Auto-detected from episodic events',
          body: skill,
        });
      }
    } catch { /* non-fatal */ }
  } catch (err) {
    console.warn('[episodic] detectMacroSkills failed:', err);
  }
}
