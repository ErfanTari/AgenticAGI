import { classifyIntent } from './intent.js';
import { resolveQuery } from './resolver.js';
import { buildContext } from './context.js';
import { callLLM } from './llm.js';
import { getSkillsForIntent } from './skills/registry.js';
import { runSkill } from './skills/runner.js';
import { createEntry, hybridSearch } from './memory/mod.js';
import { addRelationship } from './memory/relationships.js';
import { fetchByCode } from './memory/mod.js';
import { startHeartbeat, stopHeartbeat } from './heartbeat.js';
import { getDb } from './memory/index.js';
// FIX 1: Processing flag — heartbeat checks this to skip when agent is busy
export let isProcessingMessage = false;
// FIX 1: Agent lifecycle
export function startAgent() {
    startHeartbeat();
}
export function stopAgent() {
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
  WHEN: CA (calendar), DL (deadline)
  HOW: PR (procedure)
  WHY: MT (meta), QU (question)
  NOW: TD (todo), RP (report)
  PLAN: PL (planning)

Never invent type codes outside this list.
If uncertain, use the closest valid type.
Only include "relationships" if the user mentions a connection to an existing entry by code.
Respond with ONLY the JSON object, no extra text.`;
function inferWriteData(message, classification) {
    // Determine notebook + type from classification or message content
    let nb = classification.nb;
    let type = classification.type;
    if (!nb || !type) {
        if (/\bcontact\b/i.test(message) || /\bperson\b/i.test(message)) {
            nb = 'WHO';
            type = 'CT';
        }
        else if (/\borganization\b|\bcompany\b/i.test(message)) {
            nb = 'WHO';
            type = 'ORG';
        }
        else if (/\bproject\b/i.test(message)) {
            nb = 'WHAT';
            type = 'PJ';
        }
        else if (/\bknowledge\b/i.test(message)) {
            nb = 'WHAT';
            type = 'KN';
        }
        else if (/\bmeeting\b|\bcalendar\b|\bevent\b/i.test(message)) {
            nb = 'WHEN';
            type = 'CA';
        }
        else if (/\bdeadline\b/i.test(message)) {
            nb = 'WHEN';
            type = 'DL';
        }
        else if (/\bremind\b|\btodo\b|\btask\b/i.test(message)) {
            nb = 'NOW';
            type = 'TD';
        }
        else if (/\bprocedure\b|\bhow to\b/i.test(message)) {
            nb = 'HOW';
            type = 'PR';
        }
        else if (/\bplan\b/i.test(message)) {
            nb = 'PLAN';
            type = 'PL';
        }
        else if (/\bschedule\b/i.test(message)) {
            nb = 'WHEN';
            type = 'CA';
        }
        else {
            nb = 'WHAT';
            type = 'KN';
        } // fallback
    }
    // Extract name from classification or message
    let name = classification.name;
    if (!name) {
        // Try "named/called/for X" patterns
        const namedMatch = message.match(/(?:named|called|for|contact)\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*)/);
        if (namedMatch)
            name = namedMatch[1];
    }
    if (!name)
        return null;
    // Extract role/context for summary
    let summary = name;
    const roleMatch = message.match(/(?:assistant|manager|developer|engineer|designer|lead|director|specialist|consultant|intern)\s+(?:at|for|of)\s+\w+/i);
    if (roleMatch)
        summary = roleMatch[0];
    else {
        const atMatch = message.match(/(?:at|for|of)\s+([A-Z][A-Za-z]+(?:\s+[A-Za-z]+)*)/);
        if (atMatch)
            summary = `${name}, ${atMatch[0]}`;
    }
    const status = /\b(upcoming|open|closed|archived)\b/i.test(message)
        ? message.match(/\b(upcoming|open|closed|archived)\b/i)[1].toLowerCase()
        : (nb === 'NOW' ? 'open' : 'active');
    // Build body from remaining context
    const body = message;
    return { nb, type, name, status, summary, body };
}
function parseLLMWriteResponse(response) {
    try {
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (!jsonMatch)
            return null;
        return JSON.parse(jsonMatch[0]);
    }
    catch {
        return null;
    }
}
export async function processMessage(message, history, options) {
    isProcessingMessage = true;
    try {
        return await _processMessage(message, history, options);
    }
    finally {
        isProcessingMessage = false;
    }
}
async function _processMessage(message, history, options) {
    // FIX 3: Drain heartbeat_queue — surface findings to user
    let findingsPrefix = '';
    try {
        const d = getDb();
        const unseen = d.prepare('SELECT * FROM heartbeat_queue WHERE seen = 0').all();
        if (unseen.length > 0) {
            findingsPrefix = '\u{1F4CB} While you were away:\n' + unseen.map(r => r.message).join('\n') + '\n\n';
            d.prepare('UPDATE heartbeat_queue SET seen = 1').run();
        }
    }
    catch {
        // Queue not available yet — ignore
    }
    // 1. Classify intent
    const classification = classifyIntent(message);
    // 2. Greeting — no memory, no LLM
    if (classification.intent === 'greeting') {
        return { reply: findingsPrefix + 'Hello! How can I help you today?', intent: 'greeting', resolved: null };
    }
    // 3. Memory write — extract data and write to memory
    if (classification.intent === 'memory_write') {
        const handler = options?.llmHandler ?? callLLM;
        // Try LLM extraction first, fall back to rule-based
        let writeData = null;
        try {
            const writeMessages = [
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
        }
        catch {
            // LLM unavailable — fall through to rule-based
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
                    }
                    catch {
                        // relationship target may not exist — skip silently
                    }
                }
            }
            return {
                reply: findingsPrefix + `Created ${entry.code} — ${entry.name} (${writeData.nb}.${writeData.type})`,
                intent: 'memory_write',
                resolved: { step: 0, entries: [entry], contents: [], relationships: [] },
                created: entry,
            };
        }
        catch (err) {
            return {
                reply: findingsPrefix + `Failed to create entry: ${String(err)}`,
                intent: 'memory_write',
                resolved: null,
                error: String(err),
            };
        }
    }
    // 4. Skill execution — routed via registry + runner
    if (classification.intent === 'skill' && classification.skill) {
        const skillResult = await runSkill(classification.skill, classification.skillInput ?? {});
        if (!skillResult.success) {
            return {
                reply: findingsPrefix + `I couldn't complete that: ${skillResult.error}`,
                intent: 'skill',
                resolved: null,
                error: skillResult.error,
            };
        }
        // Pass skill output through context builder and LLM
        const skillContext = buildContext(message, null, history, [], 'skill', skillResult.output);
        try {
            const handler = options?.llmHandler ?? callLLM;
            const reply = await handler(skillContext);
            return { reply: findingsPrefix + reply, intent: 'skill', resolved: null };
        }
        catch (error) {
            // If LLM fails, return raw skill output
            return { reply: findingsPrefix + skillResult.output, intent: 'skill', resolved: null };
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
                const contents = [];
                for (const entry of entries) {
                    const fetched = fetchByCode(entry.code);
                    if (fetched)
                        contents.push(fetched.content);
                }
                resolved = { step: 5, entries, contents, relationships: [] };
            }
        }
        catch {
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
    // 8. Build lean context
    const messages = buildContext(message, resolved, history, skills, classification.intent);
    // 9. Call LLM with error handling (BUG 6)
    try {
        const handler = options?.llmHandler ?? callLLM;
        const reply = await handler(messages);
        return { reply: findingsPrefix + reply, intent: classification.intent, resolved };
    }
    catch (error) {
        return {
            reply: findingsPrefix + 'I could not reach the language model. Please check that it is running.',
            intent: classification.intent,
            resolved,
            error: String(error),
        };
    }
}
