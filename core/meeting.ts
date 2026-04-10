/**
 * P7: Meeting Mode — structured briefing and updates capture.
 */
import type { LLMHandler, Message } from './types.js';
import { queryEntries } from './memory/index.js';
import { upsertEntry } from './memory/write.js';
import { transparency } from './transparency.js';
import { localDateString } from './utils/date.js';
import { createLMStudioChatSessionHandler } from './llm.js';

export interface MeetingBriefing {
  prompt: string;
  context: string;
  suggestedUpdates: string[];
}

/**
 * Run meeting mode — generates a structured briefing from current memory state
 * and prompts the user for updates.
 */
export async function runMeetingMode(
  _history: Message[],
  llmHandler: LLMHandler,
): Promise<MeetingBriefing> {
  const sessionLLM = createLMStudioChatSessionHandler(llmHandler);
  // Gather relevant memory for the meeting
  const todos = queryEntries({ nb: 'NOW', type: 'TD', status: 'open' }).slice(0, 5);
  const planProjects = queryEntries({ nb: 'PLAN', type: 'PJ', status: 'active' }).slice(0, 5);
  const upcoming = queryEntries({ nb: 'WHEN', status: 'upcoming' }).slice(0, 5);

  const contextParts: string[] = [];

  if (planProjects.length > 0) {
    contextParts.push('## Project Brain Entries\n' + planProjects.map(e => `- [${e.code}] ${e.name}: ${e.summary}`).join('\n'));
  }
  if (todos.length > 0) {
    contextParts.push('## Open Todos\n' + todos.map(e => `- [${e.code}] ${e.name}`).join('\n'));
  }
  if (upcoming.length > 0) {
    contextParts.push('## Upcoming Events\n' + upcoming.map(e => `- [${e.code}] ${e.name} (${e.due_date ?? e.updated})`).join('\n'));
  }

  const context = contextParts.join('\n\n') || 'No active memory entries found.';

  // Generate a structured briefing prompt
  const suggestedUpdates: string[] = [];
  for (const entry of planProjects) {
    suggestedUpdates.push(`Update status of "${entry.name}" (${entry.code})`);
  }
  for (const todo of todos) {
    suggestedUpdates.push(`Mark todo as done: "${todo.name}" (${todo.code})`);
  }

  let briefingText = '';
  try {
    const messages: Message[] = [
      {
        role: 'system',
        content: `You are a meeting facilitator. Generate a structured meeting briefing with EXACTLY these 5 sections:

## 1. Status Summary
Brief overview of current project state.

## 2. Priorities
Top 3 items ranked by urgency, with project names sorted by priority number.

## 3. Open Risks or Blockers
Any known blockers, risks, or overdue items.

## 4. Key Questions
2-3 questions that need answering today.

## 5. Suggested Next Actions
Concrete actions for each active project.

End with a single clarifying question like "Review projects or proceed with [next action]?". Keep the entire briefing under 400 words.`,
      },
      {
        role: 'user',
        content: `Current state:\n${context}`,
      },
    ];

    briefingText = await sessionLLM(messages, { maxTokens: 400, disableThinking: true });
    briefingText = briefingText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  } catch {
    briefingText = `Meeting Mode started.\n\n${context}\n\nWhat would you like to update?`;
  }

  const prompt = `## Meeting Briefing\n\n${briefingText}\n\n---\nPlease provide updates or say "done" to finish the meeting.`;

  return { prompt, context, suggestedUpdates };
}

/**
 * Process a user's meeting response and write updates to memory.
 */
export async function processMeetingResponse(
  response: string,
  briefing: MeetingBriefing,
  llmHandler: LLMHandler,
): Promise<{ updatesWritten: string[]; nextStep: string }> {
  const sessionLLM = createLMStudioChatSessionHandler(llmHandler);
  const updatesWritten: string[] = [];

  if (/^\s*(done|finish|end|complete)\s*$/i.test(response)) {
    // Meeting complete
    transparency.emit({ type: 'meeting_complete', data: { updatesWritten } });
    return { updatesWritten, nextStep: 'Meeting complete. Memory updated.' };
  }

  // Try to parse updates from the response
  try {
    const messages: Message[] = [
      {
        role: 'system',
        content: `Extract memory updates from the user's meeting response. Return JSON array of updates:
[{"action": "update|create|complete", "type": "todo|project|note", "name": "entry name", "content": "update text"}]`,
      },
      {
        role: 'user',
        content: `Extract memory updates from the following meeting response.\n\nContext:\n${briefing.context}\n\nUser response:\n${response}`,
      },
    ];

    const extracted = await sessionLLM(messages, { maxTokens: 400, disableThinking: true });
    const cleaned = extracted.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const jsonMatch = cleaned.match(/\[[\s\S]*\]/);

    if (jsonMatch) {
      const updates = JSON.parse(jsonMatch[0]) as Array<{
        action: string;
        type: string;
        name: string;
        content: string;
      }>;

      for (const update of updates) {
        try {
          if (update.action === 'complete' && update.type === 'todo') {
            // Mark todo as done via upsert
            const { code } = upsertEntry({
              nb: 'NOW',
              type: 'TD',
              name: update.name,
              status: 'closed',
              summary: `Completed in meeting: ${update.content?.slice(0, 60)}`,
              body: update.content ?? '',
            });
            updatesWritten.push(code);
          } else {
            // Create a log entry
            const { code } = upsertEntry({
              nb: 'NOW',
              type: 'LOG',
              name: `Meeting Update: ${update.name}`,
              status: 'active',
              summary: update.content?.slice(0, 80) ?? '',
              body: `## ${update.name}\n${update.content ?? response}`,
            });
            updatesWritten.push(code);
          }
        } catch (err) {
          console.warn('[meeting] Failed to write update:', err);
        }
      }
    }
  } catch {
    // If extraction fails, write the whole response as a log
    try {
      const { code } = upsertEntry({
        nb: 'NOW',
        type: 'LOG',
        name: `Meeting Notes: ${localDateString()}`,
        status: 'active',
        summary: response.slice(0, 80),
        body: response,
      });
      updatesWritten.push(code);
    } catch { /* non-fatal */ }
  }

  transparency.emit({ type: 'meeting_complete', data: { updatesWritten } });

  return {
    updatesWritten,
    nextStep: updatesWritten.length > 0
      ? `Updated ${updatesWritten.length} entries. Continue or say "done" to finish.`
      : 'No updates extracted. Continue or say "done" to finish.',
  };
}
