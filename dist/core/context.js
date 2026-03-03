import { getNotebookCounts } from './memory/mod.js';
import { encode } from 'gpt-tokenizer';
const SYSTEM_PROMPT = `You are a personal AI agent with memory, skills, and reasoning capabilities.

Your capabilities:
- Memory system: WHO, WHAT, WHEN, HOW, WHY, NOW, PLAN notebooks
- Skills: web_search, calculator, file_reader, file_writer, run_bash, web_fetch, url_extract, memory_read, content_writer, relationship_write, implement_and_test
- You can search the web, write files, run code, and remember information across sessions

How to respond:
- Use memory context when it contains relevant information
- Use skills when the task requires external data or actions
- Use your own knowledge for general questions
- Be direct and helpful — do not refuse tasks you can do
- Never expose your internal reasoning process
- Never show thinking steps, analysis, or decision trees
- Respond only with the final answer

When asked about your name or identity:
- You are an AI agent built on AgenticAGI
- You do not have a fixed name yet
- Suggest the user can give you a name

When asked what you can do:
- List your notebooks and skills clearly
- Give concrete examples of what you can help with

Valid memory entry codes follow this format: [NOTEBOOK].[TYPE]-[NUMBER]

Valid notebooks and their types:
WHO: CT (contact), ORG (organization)
WHAT: PJ (project), KN (knowledge)
WHEN: CA (calendar), DL (deadline)
HOW: PR (procedure)
WHY: MT (meta reflection), QU (open question)
NOW: TD (todo), RP (report)
PLAN: PL (planning entry)

Never use a type code not listed above.
Never invent new type codes.`;
const MAX_TOKENS = 1500;
const HARD_CEILING = 2000;
const WARNING_THRESHOLD = Math.floor(MAX_TOKENS * 0.8); // 80% = 1200 tokens
// Rolling context summary thresholds
const SUMMARY_THRESHOLD = 6; // When history has > 6 turns (12 messages), summarize old turns
const KEEP_RECENT = 3; // Keep last 3 turns (6 messages) verbatim
const SUMMARY_INTENTS = new Set(['summary', 'overview']);
const SUMMARY_PATTERNS = [
    /\bwhat\s+do\s+you\s+know\b/i,
    /\bshow\s+me\s+a\s+summary\b/i,
    /\boverview\b/i,
    /\bhow\s+many\s+entries\b/i,
    /\bnotebook\s+counts?\b/i,
];
export function getIndexSummary() {
    const rows = getNotebookCounts();
    if (rows.length === 0)
        return 'Memory is empty.';
    return 'Memory index: ' + rows.map(r => `${r.nb}: ${r.count} entries`).join(', ');
}
function needsSummary(intent, userMessage) {
    if (SUMMARY_INTENTS.has(intent))
        return true;
    if (userMessage) {
        return SUMMARY_PATTERNS.some(p => p.test(userMessage));
    }
    return false;
}
/**
 * Build rolling context with summarization for long histories.
 * When history exceeds SUMMARY_THRESHOLD turns, summarize old turns and keep recent turns verbatim.
 * Falls back gracefully if summarization fails.
 */
export async function buildRollingContext(history, llmHandler) {
    // Count turns (pair of user+assistant messages)
    const turnCount = Math.floor(history.length / 2);
    if (turnCount <= SUMMARY_THRESHOLD) {
        // Short history, no summarization needed
        return { turns: history };
    }
    // Split: old turns to summarize, recent turns to keep verbatim
    const recentMessageCount = KEEP_RECENT * 2; // 3 turns = 6 messages
    const oldMessages = history.slice(0, -recentMessageCount);
    const recentMessages = history.slice(-recentMessageCount);
    // Try to summarize old turns with timeout
    try {
        const summaryPrompt = [
            {
                role: 'system',
                content: 'Summarize the conversation history below into 2-3 concise sentences. Focus on key topics, decisions, and context needed for future turns. Omit greetings and pleasantries.',
            },
            {
                role: 'user',
                content: oldMessages.map(m => `${m.role}: ${m.content}`).join('\n\n'),
            },
        ];
        // Wrap summarization with 5000ms timeout
        const SUMMARIZATION_TIMEOUT = 5000;
        const summary = await Promise.race([
            llmHandler(summaryPrompt, { maxTokens: 150 }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Summarization timeout after 5000ms')), SUMMARIZATION_TIMEOUT)),
        ]);
        return {
            turns: recentMessages,
            summary: summary.trim(),
        };
    }
    catch (err) {
        // Graceful fallback: if summarization fails or times out, just return recent turns without summary
        console.warn('[context] Summary generation failed, keeping recent turns only:', String(err));
        return { turns: recentMessages };
    }
}
function formatResolved(resolved, summaryOnly) {
    if (!resolved || resolved.entries.length === 0)
        return '';
    const parts = ['## Resolved Memory'];
    for (const entry of resolved.entries) {
        parts.push(`- [${entry.code}] ${entry.name} (${entry.status}): ${entry.summary}`);
    }
    if (!summaryOnly && resolved.contents.length > 0) {
        parts.push('\n## Full Content');
        for (const content of resolved.contents) {
            parts.push(content);
        }
    }
    if (resolved.relationships.length > 0) {
        parts.push('\n## Relationships');
        for (const rel of resolved.relationships) {
            parts.push(`- ${rel.from_code} ${rel.relation} ${rel.to_code}${rel.note ? ` (${rel.note})` : ''}`);
        }
    }
    return parts.join('\n');
}
function formatSkills(skills) {
    if (skills.length === 0)
        return '';
    return 'Available capabilities: ' + skills.map(s => s.description).join('; ');
}
export async function buildContext(userMessage, resolved, history, skills, intent, skillOutput, llmHandler) {
    const systemParts = [SYSTEM_PROMPT];
    // Only include notebook counts for summary/overview queries (BUG 4)
    if (needsSummary(intent ?? 'general', userMessage)) {
        systemParts.push(getIndexSummary());
    }
    systemParts.push(formatResolved(resolved));
    systemParts.push(formatSkills(skills));
    // Inject skill output into context
    if (skillOutput) {
        systemParts.push('## Skill Output\n' + skillOutput);
    }
    const systemContent = systemParts.filter(Boolean).join('\n\n');
    const messages = [
        { role: 'system', content: systemContent },
    ];
    // Use rolling context summarization if llmHandler provided and history is long
    let recentHistory = history.slice(-12); // Default: last 6 turns
    let conversationSummary;
    if (llmHandler && history.length > SUMMARY_THRESHOLD * 2) {
        const rollingContext = await buildRollingContext(history, llmHandler);
        recentHistory = rollingContext.turns;
        conversationSummary = rollingContext.summary;
    }
    // Inject conversation summary if present
    if (conversationSummary) {
        messages.push({
            role: 'system',
            content: `## Previous Conversation\n${conversationSummary}`,
        });
    }
    messages.push(...recentHistory);
    messages.push({ role: 'user', content: userMessage });
    // Token ceiling guard (BUG 5)
    let tokens = estimateTokens(messages);
    // Warn if context exceeds 80% of budget
    if (tokens > WARNING_THRESHOLD && tokens <= MAX_TOKENS) {
        console.warn(`[context] Context at ${tokens}/${MAX_TOKENS} tokens (${Math.round(tokens / MAX_TOKENS * 100)}%) — approaching limit`);
    }
    if (tokens > MAX_TOKENS) {
        // Step 1: Reduce history to 3 turns (6 messages)
        messages.length = 1; // keep system prompt
        recentHistory = history.slice(-6);
        messages.push(...recentHistory);
        messages.push({ role: 'user', content: userMessage });
        tokens = estimateTokens(messages);
    }
    if (tokens > MAX_TOKENS) {
        // Step 2: Trim memory to summaries only, truncate large skill output
        const summaryResolved = formatResolved(resolved, true);
        const trimParts = [SYSTEM_PROMPT, summaryResolved, formatSkills(skills)];
        if (skillOutput) {
            // Keep skill output but cap at ~2000 chars to fit in token budget
            const maxSkillChars = 2000;
            const truncatedSkill = skillOutput.length > maxSkillChars
                ? skillOutput.slice(0, maxSkillChars) + '\n\n[skill output truncated]'
                : skillOutput;
            trimParts.push('## Skill Output\n' + truncatedSkill);
        }
        const trimmedSystem = trimParts.filter(Boolean).join('\n\n');
        messages[0] = { role: 'system', content: trimmedSystem };
        tokens = estimateTokens(messages);
    }
    if (tokens > MAX_TOKENS) {
        // Step 3: Drop all history, keep only system + user message
        messages.length = 1; // keep only system
        messages.push({ role: 'user', content: userMessage });
        tokens = estimateTokens(messages);
    }
    if (tokens > HARD_CEILING) {
        // Final: Truncate user input to fit under ceiling
        const lastIdx = messages.length - 1;
        const userContent = messages[lastIdx].content;
        const userTokens = estimateTokens(userContent);
        if (userTokens > 500) {
            // Approximate char position that fits ~500 tokens
            const targetTokens = 500;
            const approxChars = Math.floor(userContent.length * (targetTokens / userTokens));
            const truncated = userContent.slice(0, approxChars);
            messages[lastIdx] = {
                role: 'user',
                content: truncated + '\n\n[input truncated — too long]',
            };
            console.warn(`Token ceiling hit: input truncated from ${userTokens} tokens`);
        }
    }
    return messages;
}
/**
 * Count exact tokens using gpt-tokenizer.
 * Can accept either a string or Message array.
 */
export function estimateTokens(input) {
    if (typeof input === 'string') {
        return encode(input).length;
    }
    // Message array
    const combined = input.map(m => m.content).join('\n');
    return encode(combined).length;
}
