import type { Message, LLMHandler, AgentResponse, Classification } from './types.js';
import type { IndexEntry } from './memory/types.js';
import { classifyIntent } from './intent.js';
import { resolveQuery } from './resolver.js';
import { buildContext, estimateTokens } from './context.js';
import { callLLM } from './llm.js';
import { getSkillsForIntent } from './skills/registry.js';
import { createEntry } from './memory/mod.js';
import { addRelationship } from './memory/relationships.js';
import { parseCode } from './memory/codegen.js';

const WRITE_SYSTEM_PROMPT = `You are a memory writing assistant. Extract structured data from the user's request and return ONLY valid JSON.
Return a JSON object with these fields:
{
  "nb": "WHO|WHAT|WHEN|HOW|WHY|NOW|PLAN",
  "type": "CT|ORG|PJ|KN|CA|DL|PR|MT|QU|TD|RP|PL",
  "name": "entry name",
  "status": "active|open|upcoming",
  "summary": "one-line summary",
  "body": "markdown body content",
  "relationships": [{"relation": "works_for|owns|supplies|blocks|refers", "to_code": "CODE"}]
}
Only include "relationships" if the user mentions a connection to an existing entry by code.
Respond with ONLY the JSON object, no extra text.`;

function inferWriteData(message: string, classification: Classification): {
  nb: string; type: string; name: string; status: string; summary: string; body: string;
} | null {
  const lower = message.toLowerCase();

  // Determine notebook + type from classification or message content
  let nb = classification.nb;
  let type = classification.type;

  if (!nb || !type) {
    if (/\bcontact\b/i.test(message) || /\bperson\b/i.test(message)) { nb = 'WHO'; type = 'CT'; }
    else if (/\borganization\b|\bcompany\b/i.test(message)) { nb = 'WHO'; type = 'ORG'; }
    else if (/\bproject\b/i.test(message)) { nb = 'WHAT'; type = 'PJ'; }
    else if (/\bknowledge\b/i.test(message)) { nb = 'WHAT'; type = 'KN'; }
    else if (/\bmeeting\b|\bcalendar\b|\bevent\b/i.test(message)) { nb = 'WHEN'; type = 'CA'; }
    else if (/\bdeadline\b/i.test(message)) { nb = 'WHEN'; type = 'DL'; }
    else if (/\bremind\b|\btodo\b|\btask\b/i.test(message)) { nb = 'NOW'; type = 'TD'; }
    else if (/\bprocedure\b|\bhow to\b/i.test(message)) { nb = 'HOW'; type = 'PR'; }
    else if (/\bplan\b/i.test(message)) { nb = 'PLAN'; type = 'PL'; }
    else if (/\bschedule\b/i.test(message)) { nb = 'WHEN'; type = 'CA'; }
    else { nb = 'WHAT'; type = 'KN'; } // fallback
  }

  // Extract name from classification or message
  let name = classification.name;
  if (!name) {
    // Try "named/called/for X" patterns
    const namedMatch = message.match(
      /(?:named|called|for|contact)\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*)/
    );
    if (namedMatch) name = namedMatch[1];
  }
  if (!name) return null;

  // Extract role/context for summary
  let summary = name;
  const roleMatch = message.match(/(?:assistant|manager|developer|engineer|designer|lead|director|specialist|consultant|intern)\s+(?:at|for|of)\s+\w+/i);
  if (roleMatch) summary = roleMatch[0];
  else {
    const atMatch = message.match(/(?:at|for|of)\s+([A-Z][A-Za-z]+(?:\s+[A-Za-z]+)*)/);
    if (atMatch) summary = `${name}, ${atMatch[0]}`;
  }

  const status = /\b(upcoming|open|closed|archived)\b/i.test(message)
    ? message.match(/\b(upcoming|open|closed|archived)\b/i)![1].toLowerCase()
    : (nb === 'NOW' ? 'open' : 'active');

  // Build body from remaining context
  const body = message;

  return { nb, type, name, status, summary, body };
}

function parseLLMWriteResponse(response: string): {
  nb?: string; type?: string; name?: string; status?: string;
  summary?: string; body?: string;
  relationships?: Array<{ relation: string; to_code: string }>;
} | null {
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
}

export async function processMessage(
  message: string,
  history: Message[],
  options?: { llmHandler?: LLMHandler },
): Promise<AgentResponse> {
  // 1. Classify intent
  const classification = classifyIntent(message);

  // 2. Greeting — no memory, no LLM
  if (classification.intent === 'greeting') {
    return { reply: 'Hello! How can I help you today?', intent: 'greeting', resolved: null };
  }

  // 3. Memory write — extract data and write to memory
  if (classification.intent === 'memory_write') {
    const handler = options?.llmHandler ?? callLLM;

    // Try LLM extraction first, fall back to rule-based
    let writeData: {
      nb: string; type: string; name: string; status: string; summary: string; body: string;
      relationships?: Array<{ relation: string; to_code: string }>;
    } | null = null;

    try {
      const writeMessages: Message[] = [
        { role: 'system', content: WRITE_SYSTEM_PROMPT },
        { role: 'user', content: message },
      ];
      const llmResponse = await handler(writeMessages);
      const parsed = parseLLMWriteResponse(llmResponse);
      if (parsed?.nb && parsed?.type && parsed?.name) {
        writeData = {
          nb: parsed.nb,
          type: parsed.type,
          name: parsed.name,
          status: parsed.status ?? 'active',
          summary: parsed.summary ?? parsed.name,
          body: parsed.body ?? message,
          relationships: parsed.relationships,
        };
      }
    } catch {
      // LLM unavailable — fall through to rule-based
    }

    // Fall back to rule-based inference
    if (!writeData) {
      const inferred = inferWriteData(message, classification);
      if (!inferred) {
        return {
          reply: 'I could not determine what to create. Please specify a name and type (e.g., "create a contact named John Smith").',
          intent: 'memory_write',
          resolved: null,
        };
      }
      writeData = inferred;
    }

    try {
      const entry = createEntry({
        nb: writeData.nb,
        type: writeData.type,
        name: writeData.name,
        status: writeData.status,
        summary: writeData.summary,
        body: writeData.body,
      });

      // Add relationships if present
      if (writeData.relationships) {
        for (const rel of writeData.relationships) {
          try {
            addRelationship({ from_code: entry.code, relation: rel.relation, to_code: rel.to_code });
          } catch {
            // relationship target may not exist — skip silently
          }
        }
      }

      return {
        reply: `Created ${entry.code} — ${entry.name} (${writeData.nb}.${writeData.type})`,
        intent: 'memory_write',
        resolved: { step: 0, entries: [entry], contents: [], relationships: [] },
        created: entry,
      };
    } catch (err) {
      return {
        reply: `Failed to create entry: ${String(err)}`,
        intent: 'memory_write',
        resolved: null,
        error: String(err),
      };
    }
  }

  // 4. Web search — not yet implemented
  if (classification.intent === 'web_search') {
    return { reply: 'Web search not yet implemented.', intent: 'web_search', resolved: null };
  }

  // 5. Resolve memory (5-step query flow)
  const resolved = resolveQuery(classification);

  // 6. Deterministic not-found guard
  if (resolved === null) {
    if (classification.intent === 'code_fetch') {
      return { reply: 'Entry not found.', intent: classification.intent, resolved: null };
    }
    if ((classification.intent === 'memory_query' || classification.intent === 'relationship_query') && classification.nb) {
      return { reply: `No entries found in ${classification.nb} notebook.`, intent: classification.intent, resolved: null };
    }
    if (classification.intent === 'memory_query' || classification.intent === 'relationship_query') {
      return { reply: 'No matching entries found.', intent: classification.intent, resolved: null };
    }
    // 'general' intent — allowed to pass to LLM without resolved memory
  }

  // 7. Load relevant skills
  const skills = getSkillsForIntent(classification.intent);

  // 8. Build lean context
  const messages = buildContext(message, resolved, history, skills, classification.intent);

  // 9. Call LLM with error handling (BUG 6)
  try {
    const handler = options?.llmHandler ?? callLLM;
    const reply = await handler(messages);
    return { reply, intent: classification.intent, resolved };
  } catch (error) {
    return {
      reply: 'I could not reach the language model. Please check that it is running.',
      intent: classification.intent,
      resolved,
      error: String(error),
    };
  }
}
