import type { Message, LLMHandler, AgentResponse, Classification } from './types.js';
import { classifyIntent } from './intent.js';
import { resolveQuery } from './resolver.js';
import { buildContext } from './context.js';
import { callLLM } from './llm.js';
import { getSkillsForIntent } from './skills/registry.js';
import { runWithRetry } from './react.js';
import { createEntry, upsertEntry, hybridSearch, getEntryByCode } from './memory/mod.js';
import { addRelationship } from './memory/relationships.js';
import { fetchByCode } from './memory/mod.js';
import { startHeartbeat, stopHeartbeat } from './heartbeat.js';
import { getDb } from './memory/index.js';
import { WriteEntrySchema, writeEntryJsonSchema } from './schemas.js';
import { isComplexTask, decomposeTask } from './planner.js';
import { executePlan, verifyExecution, buildUserReport, writeEpisodicMemory, classifyFailure } from './executor.js';
import { writeEpisodicEvent, writeReflection } from './memory/episodic.js';
import { extractMemoryMetadata } from './memory/lifecycle.js';
import { getSkillDescriptions } from './skills/registry.js';
import { transparency } from './transparency.js';

// FIX 1: Processing flag — heartbeat checks this to skip when agent is busy
export let isProcessingMessage = false;

// FIX 1: Agent lifecycle
export function startAgent(): void {
  startHeartbeat();
  // Keep agent card skills in sync
  import('./agent-card.js').then(m => m.updateAgentCard()).catch(() => {});
}

export function stopAgent(): void {
  stopHeartbeat();
}

const WRITE_SYSTEM_PROMPT = `You are a memory writing assistant. Extract structured data from the user's request and return ONLY valid JSON.
Return a JSON object with these fields:
{
  "nb": "WHO|WHAT|WHEN|HOW|WHY|NOW|PLAN",
  "type": "(see valid types below)",
  "name": "entry name",
  "status": "active|open|upcoming",
  "summary": "one-line summary",
  "body": "markdown body content",
  "relationships": [{"relation": "works_for|owns|supplies|blocks|refers", "to_code": "CODE"}]
}

Valid notebook + type combinations (use ONLY these):
  WHO: CT (contact), ORG (organization)
  WHAT: PJ (project), KN (knowledge)
  WHEN: CA (calendar), DL (deadline), EV (episodic event), RF (reflection), HX (history)
  HOW: PR (procedure), SK (skill)
  WHY: MT (meta), QU (question)
  NOW: TD (todo), RP (report), LOG (log entry)
  PLAN: PL (planning), EX (execution state), CT (constraint), MS (milestone), PJ (project brain)

CONSTRAINT EXAMPLES — use PLAN.CT for system rules and constraints:
- "add a constraint: never use Python 2" → {"nb":"PLAN","type":"CT","name":"Python Version Constraint","status":"active","summary":"Never use Python 2, always use Python 3","body":"Source: user. Enforce Python 3 only."}
- "system rule: always use TypeScript" → {"nb":"PLAN","type":"CT","name":"TypeScript Constraint","status":"active","summary":"Always use TypeScript","body":"Source: user."}

Never invent type codes outside this list.
If uncertain, use the closest valid type.
Only include "relationships" if the user mentions a connection to an existing entry by code.
Respond with ONLY the JSON object, no extra text.`;

function inferWriteData(message: string, classification: Classification): {
  nb: string; type: string; name: string; status: string; summary: string; body: string;
} | null {
  // Handle /log prefix — extract log content and use ISO date as name
  if (message.startsWith('/log ')) {
    const logContent = message.slice(5).trim();
    const isoDate = new Date().toISOString().slice(0, 16).replace('T', ' ');
    return {
      nb: 'NOW',
      type: 'LOG',
      name: `Log ${isoDate}`,
      status: 'active',
      summary: logContent.slice(0, 80),
      body: logContent,
    };
  }

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
  isProcessingMessage = true;
  try {
    return await _processMessage(message, history, options);
  } finally {
    isProcessingMessage = false;
  }
}

async function _processMessage(
  message: string,
  history: Message[],
  options?: { llmHandler?: LLMHandler },
): Promise<AgentResponse> {
  // FIX 3: Drain heartbeat_queue — surface findings to user
  let findingsPrefix = '';
  try {
    const d = getDb();
    const unseen = d.prepare(
      'SELECT * FROM heartbeat_queue WHERE seen = 0'
    ).all() as Array<{ id: number; code: string; message: string; seen: number; created: string }>;

    if (unseen.length > 0) {
      findingsPrefix = '\u{1F4CB} While you were away:\n' + unseen.map(r => r.message).join('\n') + '\n\n';
      d.prepare('UPDATE heartbeat_queue SET seen = 1').run();
    }
  } catch {
    // Queue not available yet — ignore
  }

  // 1. Classify intent
  const classification = classifyIntent(message);
  transparency.emit({ type: 'intent', data: classification });

  // 2. Greeting — no memory, no LLM
  if (classification.intent === 'greeting') {
    return { reply: findingsPrefix + 'Hello! How can I help you today?', intent: 'greeting', resolved: null };
  }

  // 2b-episodic: Episodic query intent
  if (classification.intent === 'episodic_query') {
    // Route to memory_query on WHEN notebook
    const resolved = resolveQuery({ ...classification, intent: 'memory_query', nb: 'WHEN' });
    const handler = options?.llmHandler ?? callLLM;
    const messages = await buildContext(message, resolved, history, [], 'episodic_query', undefined, handler);
    try {
      const reply = await handler(messages);
      const cleanReply = reply.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      return { reply: findingsPrefix + cleanReply, intent: 'episodic_query', resolved };
    } catch {
      return { reply: findingsPrefix + 'Could not retrieve episodic history.', intent: 'episodic_query', resolved: null };
    }
  }

  // 2b-meeting: Meeting mode intent
  if (classification.intent === 'meeting') {
    const handler = options?.llmHandler ?? callLLM;
    try {
      const { runMeetingMode } = await import('./meeting.js');
      const briefing = await runMeetingMode(history, handler);
      return {
        reply: findingsPrefix + briefing.prompt,
        intent: 'meeting',
        resolved: null,
      };
    } catch (err) {
      return {
        reply: findingsPrefix + 'Could not start meeting mode. Please try again.',
        intent: 'meeting',
        resolved: null,
        error: String(err),
      };
    }
  }

  // 2b. Synthesis query — always complex, bypass isComplexTask(), go straight to planner
  if (classification.intent === 'synthesis_query') {
    const plannerHandler = options?.llmHandler ?? callLLM;
    try {
      const skillDescs = getSkillDescriptions();
      const plan = await decomposeTask(message, { skills: skillDescs }, plannerHandler);
      const execResult = await executePlan(plan, plannerHandler);
      const verification = await verifyExecution(plan, execResult, plannerHandler);
      const report = buildUserReport(plan, execResult, verification);
      const cleanReport = report.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      writeEpisodicMemory(plan, execResult, verification).catch(err => console.warn('[agent] writeEpisodicMemory failed:', err));
      // Write WHEN.EV episodic event (fire-and-forget)
      writeEpisodicEvent({
        trigger: message,
        task_name: plan.goal,
        skill_sequence: [...execResult.completed.map(s => s.skill), ...execResult.failed.map(s => s.skill)],
        outcome: execResult.success ? 'success' : (execResult.completed.length > 0 ? 'partial' : 'failure'),
        failure_reason: execResult.abortReason,
        linked_codes: [],
        session_id: plan.createdAt,
      }).then(evCode => {
        const plannerHandler2 = options?.llmHandler ?? callLLM;
        const ev = { code: evCode, trigger: message, task_name: plan.goal, skill_sequence: [...execResult.completed.map(s => s.skill), ...execResult.failed.map(s => s.skill)], outcome: execResult.success ? 'success' as const : (execResult.completed.length > 0 ? 'partial' as const : 'failure' as const), failure_reason: execResult.abortReason, linked_codes: [], session_id: plan.createdAt };
        writeReflection(evCode, ev, plannerHandler2).catch(() => {});
      }).catch(err => console.warn('[agent] writeEpisodicEvent failed:', err));
      return {
        reply: findingsPrefix + cleanReport,
        intent: 'synthesis_query',
        resolved: null,
      };
    } catch (err) {
      return {
        reply: findingsPrefix + 'I could not generate the synthesis report. No changes were made. Please retry.',
        intent: 'synthesis_query',
        resolved: null,
        error: String(err),
      };
    }
  }

  // 2c. Complex task detection → planner/executor pipeline
  // Skip if intent classifier already identified a direct, single-step skill call.
  // Multi-step messages return null from detectSkill() so they fall through here correctly.
  if (classification.intent !== 'skill') try {
    const plannerHandler = options?.llmHandler ?? callLLM;
    const complexity = await isComplexTask(message, classification, plannerHandler);

    if (process.env.DEBUG_PLANNER === 'true') {
      console.log('[planner] Complexity check:', {
        isComplex: complexity.isComplex,
        reason: complexity.reason,
        estimatedSteps: complexity.estimatedSteps,
        requiresSkills: complexity.requiresSkills,
      });
    }

    if (complexity.isComplex) {
      try {
        const skillDescs = getSkillDescriptions();
        const plan = await decomposeTask(message, { skills: skillDescs }, plannerHandler);
        const execResult = await executePlan(plan, plannerHandler);
        const verification = await verifyExecution(plan, execResult, plannerHandler);
        const report = buildUserReport(plan, execResult, verification);

        // Strip <think> tags from Kimi/reasoning models
        const cleanReport = report.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

        // Write episodic HOW.PR — fire-and-forget
        writeEpisodicMemory(plan, execResult, verification).catch(err => console.warn('[agent] writeEpisodicMemory failed:', err));
        // Write WHEN.EV episodic event for ALL outcomes (including failures) — fire-and-forget
        const _skillSeq = [...execResult.completed.map(s => s.skill), ...execResult.failed.map(s => s.skill)];
        const _outcome = execResult.success ? 'success' as const : (execResult.completed.length > 0 ? 'partial' as const : 'failure' as const);
        writeEpisodicEvent({
          trigger: message,
          task_name: plan.goal,
          skill_sequence: _skillSeq,
          outcome: _outcome,
          failure_reason: execResult.abortReason,
          linked_codes: [],
          session_id: plan.createdAt,
        }).then(evCode => {
          const _handler = options?.llmHandler ?? callLLM;
          const _ev = { code: evCode, trigger: message, task_name: plan.goal, skill_sequence: _skillSeq, outcome: _outcome, failure_reason: execResult.abortReason, linked_codes: [], session_id: plan.createdAt };
          writeReflection(evCode, _ev, _handler).catch(() => {});
        }).catch(err => console.warn('[agent] writeEpisodicEvent failed:', err));

        return {
          reply: findingsPrefix + cleanReport,
          intent: 'planned_workflow',
          resolved: null,
        };
      } catch (err) {
        if (process.env.DEBUG_PLANNER === 'true') {
          console.log('[planner] Planning failed:', err);
        }
        // Architecture guard: do not fall through into unrelated write/query paths.
        // A failed complex plan must fail safely without side effects.
        return {
          reply: findingsPrefix + 'I could not produce a valid execution plan for this multi-step task. No changes were made. Please retry or simplify one requirement at a time.',
          intent: 'planned_workflow',
          resolved: null,
          error: String(err),
        };
      }
    }
  } catch (err) {
    if (process.env.DEBUG_PLANNER === 'true') {
      console.log('[planner] Complexity detection failed:', err);
    }
    // Complexity detection failed — fall through to normal flow
  }

  // 3. Relationship write — natural language ownership
  if (classification.intent === 'relationship_write') {
    try {
      const { getDb } = await import('./memory/index.js');
      const db = getDb();

      // Extract subject (usually "I/me" → current user)
      let fromCode: string | undefined;
      const userEntry = db.prepare('SELECT code FROM index_entries WHERE nb = ? AND type = ? AND name LIKE ? ORDER BY updated DESC LIMIT 1')
        .get('WHO', 'CT', '%Erfan%') as { code: string } | undefined;
      if (userEntry) fromCode = userEntry.code;

      // Extract object from message (project name, org name, etc.)
      const objectName = classification.name;
      let toCode: string | undefined;

      if (objectName && fromCode && classification.relation) {
        // Look up object by name
        const objectEntry = db.prepare('SELECT code FROM index_entries WHERE name LIKE ? LIMIT 1')
          .get(`%${objectName}%`) as { code: string } | undefined;

        if (objectEntry) {
          toCode = objectEntry.code;
        } else {
          // Create the object entry first
          const nb = classification.nb || 'WHAT';
          const type = classification.type || 'PJ';
          try {
            const created = createEntry({
              nb,
              type,
              name: objectName,
              status: 'active',
              summary: objectName,
              body: `Referenced in relationship: ${message}`,
            });
            toCode = created.code;
          } catch {
            // Creation failed
          }
        }

        if (toCode) {
          addRelationship({
            from_code: fromCode,
            relation: classification.relation as 'owns' | 'works_for' | 'supplies' | 'blocks' | 'refers',
            to_code: toCode,
          });
          return {
            reply: findingsPrefix + `Relationship created: ${fromCode} ${classification.relation} ${toCode}`,
            intent: 'relationship_write',
            resolved: null,
          };
        }
      }

      return {
        reply: findingsPrefix + 'Could not create relationship. Please specify both subject and object clearly.',
        intent: 'relationship_write',
        resolved: null,
      };
    } catch (err) {
      return {
        reply: findingsPrefix + `Failed to create relationship: ${String(err)}`,
        intent: 'relationship_write',
        resolved: null,
        error: String(err),
      };
    }
  }

  // 4. Memory write — extract data and write to memory
  if (classification.intent === 'memory_write') {
    const handler = options?.llmHandler ?? callLLM;

    // /log entries: skip LLM entirely — use rule-based inference directly
    if (message.startsWith('/log ')) {
      const logData = inferWriteData(message, classification);
      if (!logData) {
        return { reply: findingsPrefix + 'Logged.', intent: 'memory_write', resolved: null };
      }
      try {
        upsertEntry({
          nb: logData.nb,
          type: logData.type,
          name: logData.name,
          status: logData.status,
          summary: logData.summary,
          body: logData.body,
        });
        return { reply: findingsPrefix + 'Logged.', intent: 'memory_write', resolved: null };
      } catch {
        return { reply: findingsPrefix + 'Logged.', intent: 'memory_write', resolved: null };
      }
    }

    // Try LLM extraction first, fall back to rule-based (with retry on invalid JSON)
    let writeData: {
      nb: string; type: string; name: string; status: string; summary: string; body: string;
      relationships?: Array<{ relation: string; to_code: string }>;
      due_date?: string;
    } | null = null;
    let lastLLMResponse: string | undefined;

    const MAX_WRITE_RETRIES = 2;
    for (let writeAttempt = 0; writeAttempt <= MAX_WRITE_RETRIES; writeAttempt++) {
      try {
        const writeMessages: Message[] = writeAttempt === 0
          ? [
              { role: 'system', content: WRITE_SYSTEM_PROMPT },
              { role: 'user', content: message },
            ]
          : [
              { role: 'system', content: WRITE_SYSTEM_PROMPT },
              { role: 'user', content: message },
              { role: 'assistant', content: lastLLMResponse! },
              { role: 'user', content: `Your response was invalid JSON or missing required fields (nb, type, name). Please return ONLY a valid JSON object with all required fields.` },
            ];
        const llmResponse = await handler(writeMessages, { responseSchema: writeEntryJsonSchema });
        lastLLMResponse = llmResponse;

        // Try Zod validation first (structured output path)
        const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            const raw = JSON.parse(jsonMatch[0]);
            const zodResult = WriteEntrySchema.safeParse(raw);
            if (zodResult.success) {
              writeData = {
                nb: zodResult.data.nb,
                type: zodResult.data.type,
                name: zodResult.data.name,
                status: zodResult.data.status,
                summary: zodResult.data.summary,
                body: zodResult.data.body,
                relationships: zodResult.data.relationships,
                // BUG-M6 fix: propagate due_date from Zod-parsed LLM response
                due_date: zodResult.data.due_date,
              };
              break; // Schema-validated success
            }
          } catch {
            // JSON parse failed — fall through to regex extraction
          }
        }

        // Fallback: rule-based regex extraction (existing parseLLMWriteResponse)
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
          break; // Regex-extracted success
        }
        // Missing fields — retry if attempts remain
      } catch {
        // LLM unavailable — fall through to rule-based
        break;
      }
    }

    // Fall back to rule-based inference
    if (!writeData) {
      const inferred = inferWriteData(message, classification);
      if (!inferred) {
        return {
          reply: findingsPrefix + 'I could not determine what to create. Please specify a name and type (e.g., "create a contact named John Smith").',
          intent: 'memory_write',
          resolved: null,
        };
      }
      writeData = inferred;
    }

    try {
      // due_date from LLM response, classification, or undefined
      const due_date = (writeData as Record<string, unknown>).due_date as string | undefined
        ?? classification.due_date;

      const { code, created } = upsertEntry({
        nb: writeData.nb,
        type: writeData.type,
        name: writeData.name,
        status: writeData.status,
        summary: writeData.summary,
        body: writeData.body,
        due_date,
      });

      const action = created ? 'Created' : 'Updated';
      const entry = getEntryByCode(code);

      // Extract importance_score and atomic_facts — fire-and-forget (on create and update)
      if (entry) {
        const metaHandler = options?.llmHandler ?? callLLM;
        extractMemoryMetadata(code, writeData.body, writeData.summary, metaHandler)
          .catch(err => console.warn('[agent] extractMemoryMetadata failed:', err));
      }

      // Add relationships if present (only on new entries to avoid duplicate links)
      if (created && writeData.relationships) {
        for (const rel of writeData.relationships) {
          try {
            addRelationship({ from_code: code, relation: rel.relation, to_code: rel.to_code });
          } catch {
            // relationship target may not exist — skip silently
          }
        }
      }

      return {
        reply: findingsPrefix + `${action} ${code} — ${writeData.name} (${writeData.nb}.${writeData.type})`,
        intent: 'memory_write',
        resolved: entry ? { step: 0, entries: [entry], contents: [], relationships: [] } : null,
        created: entry ?? undefined,
      };
    } catch (err) {
      return {
        reply: findingsPrefix + `Failed to create entry: ${String(err)}`,
        intent: 'memory_write',
        resolved: null,
        error: String(err),
      };
    }
  }

  // 4. Skill execution — routed via registry + runner (with ReAct retry)
  if (classification.intent === 'skill' && classification.skill) {
    const handler = options?.llmHandler ?? callLLM;
    const skillResult = await runWithRetry(classification.skill, classification.skillInput ?? {}, handler);

    if (!skillResult.success) {
      const errorMsg = skillResult.error ?? '';
      // Emit failure_classified for skill failures (consistent with executePlan)
      transparency.emit({ type: 'failure_classified', data: { error: errorMsg, class: classifyFailure(errorMsg) } });
      // Write WHEN.EV for skill failures — fire-and-forget (survivorship bias fix)
      writeEpisodicEvent({
        trigger: message,
        task_name: `Skill: ${classification.skill} — ${message.slice(0, 60)}`,
        skill_sequence: [classification.skill!],
        outcome: 'failure',
        failure_reason: errorMsg,
        linked_codes: [],
        session_id: new Date().toISOString(),
      }).catch(() => {});
      // Surface security/access errors inline; generic message for everything else
      const reply = /access denied|not allowed|outside workspace|invalid path/i.test(errorMsg)
        ? findingsPrefix + `I couldn't complete that: ${errorMsg}`
        : findingsPrefix + `I couldn't complete that. Please try again or rephrase your request.`;
      return {
        reply,
        intent: 'skill',
        resolved: null,
        error: skillResult.error,
        retries: skillResult.retries,
      };
    }

    // Pass skill output through context builder and LLM
    const skillContext = await buildContext(
      message, null, history, [],
      'skill',
      skillResult.output,
      options?.llmHandler ?? callLLM,
    );

    try {
      const reply = await handler(skillContext);
      return { reply: findingsPrefix + reply, intent: 'skill', resolved: null, retries: skillResult.retries };
    } catch (error) {
      // If LLM fails, return raw skill output
      return { reply: findingsPrefix + skillResult.output, intent: 'skill', resolved: null, retries: skillResult.retries };
    }
  }

  // 5. Resolve memory (5-step query flow)
  let resolved = resolveQuery(classification);

  // 5b. Step 5: Hybrid search fallback for vague queries
  // At this point, only code_fetch, memory_query, relationship_query, general remain
  if (resolved === null && classification.intent !== 'code_fetch') {
    try {
      const searchResults = await hybridSearch(message, { nb: classification.nb });
      if (searchResults.length > 0) {
        const entries = searchResults.map(r => r.entry);
        const contents: string[] = [];
        for (const entry of entries) {
          const fetched = fetchByCode(entry.code);
          if (fetched) contents.push(fetched.content);
        }
        resolved = { step: 5, entries, contents, relationships: [] };
      }
    } catch {
      // Search failed — fall through to not-found guard
    }
  }

  // 6. Deterministic not-found guard
  if (resolved === null) {
    if (classification.intent === 'code_fetch') {
      return { reply: findingsPrefix + 'Entry not found.', intent: classification.intent, resolved: null };
    }
    if ((classification.intent === 'memory_query' || classification.intent === 'relationship_query') && classification.nb) {
      return { reply: findingsPrefix + `No entries found in ${classification.nb} notebook.`, intent: classification.intent, resolved: null };
    }
    if (classification.intent === 'memory_query' || classification.intent === 'relationship_query') {
      return { reply: findingsPrefix + 'No matching entries found.', intent: classification.intent, resolved: null };
    }
    // 'general' intent — allowed to pass to LLM without resolved memory
  }

  // 7. Load relevant skills
  const skills = getSkillsForIntent(classification.intent);

  // 8. Build lean context with rolling summarization
  const handler = options?.llmHandler ?? callLLM;
  const messages = await buildContext(message, resolved, history, skills, classification.intent, undefined, handler);

  // 9. Call LLM with error handling (BUG 6)
  try {
    const reply = await handler(messages);
    // Strip <think> tags from reasoning models (Kimi, DeepSeek R1, etc.)
    const cleanReply = reply.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    return { reply: findingsPrefix + cleanReply, intent: classification.intent, resolved };
  } catch (error) {
    return {
      reply: findingsPrefix + 'I could not reach the language model. Please check that it is running.',
      intent: classification.intent,
      resolved,
      error: String(error),
    };
  }
}
