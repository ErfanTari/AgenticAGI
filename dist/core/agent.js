import { localDatePlusDays } from './utils/date.js';
import { resolveQuery } from './resolver.js';
import { buildContext } from './context.js';
import { callLLM, stripThinkingTags, sanitizeFinalOutput } from './llm.js';
import { getSkillsForIntent } from './skills/registry.js';
import { decomposeMessage, isLikelyCompoundMessage } from './decomposition.js';
import { routeDecomposedUnits, executeConfirmedPlan } from './router.js';
import { assessComplexity } from './planner.js';
import { runQueryLoop } from './query-loop.js';
import { searchMemoryForUnits } from './memory/unit-search.js';
import { runWithRetry } from './react.js';
import { addRelationship, fetchByCode, getEntryByCode, hybridSearch, upsertEntry, savePendingPlan, clearPendingPlan, } from './memory/mod.js';
import { startHeartbeat, stopHeartbeat, recordActivity } from './heartbeat.js';
import { getDb } from './memory/index.js';
import { classifyFailure } from './executor.js';
import { memoryAgent } from './memory/memory-agent.js';
import { writeEpisodicEvent, writeReflectionSync } from './memory/episodic.js';
import { createPlanEX } from './memory/plan-ex.js';
import { extractMemoryMetadata } from './memory/lifecycle.js';
import { quickResolve } from './memory/quick-resolve.js';
import { WriteEntrySchema, writeEntryJsonSchema } from './schemas.js';
import { transparency } from './transparency.js';
import { runIntake } from './intake.js';
import { createWorkingMemory, loadWorkingMemory } from './memory/working-memory.js';
import { setPendingConfirmationPlan as skillSetPendingPlan, clearPendingConfirmationPlan as skillClearPendingPlan, } from './skills/tools/confirm_plan.js';
const GREETING_ONLY = /^\s*(hi|hello|hey|good\s+(morning|afternoon|evening)|howdy|greetings)\s*[!.?]*\s*$/i;
const DIRECT_MEETING_PREFIX = /^\/meeting\b/i;
const DIRECT_CODE_FETCH_PREFIX = /^\s*(show|show me|tell me about|open|fetch|get|display)\b/i;
const CODE_REGEX = /\b([A-Z]+\.[A-Z]+-\d{6,})\b/g;
const STATUS_REGEX = /\b(active|archived|open|closed|upcoming)\b/i;
const WRITE_TRIGGER_PATTERNS = [
    /\b(create|add|new|write|save|store|remember)\b/i,
    /\bremind\s+me\b/i,
    /\bschedule\b/i,
];
const MEMORY_ENTITY_PATTERNS = [
    /\bcontacts?\b/i,
    /\borganizations?\b|\bcompan(?:y|ies)\b/i,
    /\bprojects?\b/i,
    /\bknowledge\b/i,
    /\bcalendar\b|\bevents?\b|\bmeeting\b/i,
    /\bdeadlines?\b/i,
    /\bprocedures?\b|\bsteps?\s+to\b/i,
    /\bplans?\b|\bplanning\b/i,
    /\btodos?\b|\btasks?\b/i,
    /\breports?\b/i,
    /\bvision\b|\bmission\b|\bnorth\s+star\b/i,
];
const NON_MEMORY_ACTION_PATTERNS = [
    /\b(go\s+(to|through)|visit|browse|navigate)\b.*\b(website|site|page)\b/i,
    /\bdownload\b/i,
    /\bsave\s+(it|th(is|e)\s+\w+)\s+(in|to|into)\s+(a\s+)?(folder|directory|workspace|disk|path)\b/i,
    /\bsave\b.*\b(folder|directory|workspace)\b/i,
    /\b(?:write|create|build|make|develop|implement)\b.*\b(?:workspace|folder|directory)\b/i,
    /\b(?:write|create|build|make|develop|implement)\b.*\b(?:html|css|javascript|typescript|js|ts|python|py)\b/i,
    /\b(?:write|create|build|make|develop|implement)\b.*\bgame\b/i,
];
const WEB_SEARCH_PATTERNS = [
    /\bsearch\s+(the\s+)?web\b/i,
    /\blook\s+up\b/i,
    /\bfind\s+online\b/i,
    /\bsearch\s+.*(for|online|internet)\b/i,
    /\bsearch\s+online\b/i,
    /\bweb\s+search\b/i,
    /\bgoogle\b/i,
    /\blatest\s+news\b/i,
    /\bcurrent\s+info\b/i,
    /\bfind\s+online\s+resources?\b/i,
    /\bbrowse\s+(the\s+)?internet\b/i,
    /\bget\s+information\s+about\b/i,
];
const FILE_READER_PATTERNS = [
    /\bread\s+(the\s+)?file\b/i,
    /\bopen\s+(the\s+)?file\b/i,
    /\bload\s+(the\s+)?(file|contents?\s+of)\b/i,
    /\bshow\s+(me\s+)?the\s+file\b/i,
    /\bshow\s+(me\s+)?(the\s+)?(contents?\s+of\s+)?\/[\w.\-/]+/i,
    /\bread\s+\/[\w.\-/]+/i,
    /\bcat\s+\/[\w.\-/]+/i,
];
const FILE_WRITER_PATTERNS = [
    /\bwrite\s+(a\s+|to\s+)?file\b/i,
    /\bwrite\s+\w+\.\w+\b/i,
    /\bcreate\s+(a\s+)?file\b/i,
    /\bcreate\s+(a\s+)?\w+\.(txt|md|json|sh|html|css|js|ts|py|yaml|yml|csv|log)\b/i,
    /\bsave\s+(it\s+)?(to|as|into)\s+(a\s+)?file\b/i,
    /\bsave\s+to\s+file\b/i,
    /\bmake\s+(a\s+)?(text\s+)?(file|document)\b/i,
];
const RUN_BASH_PATTERNS = [
    /\brun\s+(the\s+)?(command|cmd)\b/i,
    /\brun\s+(a\s+)?bash\b/i,
    /\bexecute\s+(\w+\s+)?(command|script)\b/i,
    /\b(bash|shell)\s+(command|script)\b/i,
    /\brun\s+(?:echo|ls|cat|pwd|grep|find|mkdir|cp|mv|rm|chmod|curl|wget|git|python3?|node|npm|npx|yarn|sh|touch)\b/i,
];
const MULTI_STEP_LANGUAGE = /\b(then\s+|after\s+that\s+|first\s+.{3,}\s+then\s+|followed\s+by\s+|and\s+then\s+|include\s+\w.*\s+and\s+run\s+)\b/i;
const CALCULATOR_PATTERNS = [
    /\bcalculat/i,
    /\bcompute\b/i,
    /\bwhat\s+is\s+[\d(]/i,
    /\bhow\s+much\s+is\b/i,
    /\d+\s*[\+\-\*\/×÷]\s*\d/,
    /\bpercent\s+of\b/i,
    /\btimes\b/i,
    /\bdivided\s+by\b/i,
    /\bmultiplied\s+by\b/i,
    /\bplus\b/i,
    /\bminus\b/i,
    /\bsquare\s+root\s+of\b/i,
    /\bsqrt\b/i,
    /\b\d+\s*%\s*of\s*\d+/i,
];
const RELATION_PATTERNS = [
    { pattern: /\bowns?\b/i, relation: 'owns' },
    { pattern: /\bworks?\s+for\b/i, relation: 'works_for' },
    { pattern: /\bsuppl(?:y|ies)\b/i, relation: 'supplies' },
    { pattern: /\bblocks?\b/i, relation: 'blocks' },
    { pattern: /\brefers?\s+to\b/i, relation: 'refers' },
];
const WRITE_SYSTEM_PROMPT = `You are a memory writing assistant. Extract structured data from the user's request and return ONLY valid JSON.
Return a JSON object with these fields:
{
  "nb": "WHO|WHAT|WHEN|HOW|WHY|NOW|PLAN",
  "type": "(see valid types below)",
  "name": "entry name",
  "status": "active|open|upcoming",
  "summary": "one-line summary",
  "body": "markdown body content",
  "relationships": [{"relation": "works_for|owns|supplies|blocks|refers", "to_code": "CODE"}],
  "due_date": "YYYY-MM-DD"
}

Valid notebook + type combinations (use ONLY these):
  WHO: CT (contact), ORG (organization)
  WHAT: PJ (project), KN (knowledge)
  WHEN: CA (calendar), DL (deadline), EV (episodic event), RF (reflection), HX (history)
  HOW: PR (procedure), SK (skill)
  WHY: MT (meta), QU (question)
  NOW: TD (todo), RP (report), LOG (log entry)
  PLAN: PL (planning), EX (execution state), CT (constraint), MS (milestone), PJ (project brain)

Never invent type codes outside this list.
If uncertain, use the closest valid type.
Only include "relationships" if the user mentions a connection to an existing entry by code.
Respond with ONLY the JSON object, no extra text.`;
// FIX 1: Processing flag — heartbeat checks this to skip when agent is busy
export let isProcessingMessage = false;
// FIX 0: Plan confirmation state machine — prevents fake-execution hallucination
// Now uses skill's state management (stored in confirm_plan.ts)
// Module-level backup for quick access
let _pendingConfirmationPlanCache = null;
/** Exported for testing only. */
export function _getPendingConfirmationPlan() {
    return _pendingConfirmationPlanCache;
}
/** Exported for testing only. */
export function _setPendingConfirmationPlan(plan) {
    _pendingConfirmationPlanCache = plan;
    if (plan) {
        skillSetPendingPlan(plan);
        savePendingPlan(plan); // Persist to SQLite
    }
    else {
        skillClearPendingPlan();
        clearPendingPlan(); // Delete from SQLite
    }
}
// FIX 1: Agent lifecycle
export function startAgent() {
    startHeartbeat();
    import('./agent-card.js').then(m => m.updateAgentCard()).catch(() => { });
    // Initialize memory agent with DB and LLM handler at startup
    try {
        const db = getDb();
        memoryAgent.init(db, callLLM);
    }
    catch {
        // DB may not be initialized yet at startup — init on first message instead
    }
    // FIX 9: Register drain() in shutdown handlers
    process.on('SIGINT', async () => { await memoryAgent.drain(); process.exit(0); });
    process.on('SIGTERM', async () => { await memoryAgent.drain(); process.exit(0); });
}
export function stopAgent() {
    stopHeartbeat();
}
function matchesAny(message, patterns) {
    return patterns.some(pattern => pattern.test(message));
}
function extractCodes(message) {
    return [...message.matchAll(CODE_REGEX)].map(match => match[1]);
}
function extractRelation(message) {
    return RELATION_PATTERNS.find(({ pattern }) => pattern.test(message))?.relation;
}
function extractStatus(message) {
    const match = message.match(STATUS_REGEX);
    return match ? match[1].toLowerCase() : undefined;
}
function extractDueDate(message) {
    const isoMatch = message.match(/\bdue\s+(\d{4}-\d{2}-\d{2})\b/i);
    if (isoMatch)
        return isoMatch[1];
    if (/\bdue\s+(?:by\s+)?tomorrow\b/i.test(message)) {
        return localDatePlusDays(1);
    }
    if (/\bdue\s+(?:by\s+)?next\s+week\b/i.test(message)) {
        return localDatePlusDays(7);
    }
    return undefined;
}
function extractName(message) {
    const quoted = message.match(/"([^"]+)"|'([^']+)'/);
    if (quoted)
        return quoted[1] ?? quoted[2];
    const namedMatch = message.match(/(?:of|about|called|named|for)\s+(?:project|contact|person|organization|todo|procedure|deadline|event|report|plan)?\s*([A-Z][A-Za-z0-9_-]+(?:\s+[A-Z][A-Za-z0-9_-]+)*)/);
    if (namedMatch)
        return namedMatch[1].replace(/[?.!,;:]+$/, '');
    const whoIsMatch = message.match(/\bwho\s+is\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*)/);
    if (whoIsMatch)
        return whoIsMatch[1].replace(/[?.!,;:]+$/, '');
    const findMatch = message.match(/\bfind\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*)/);
    if (findMatch)
        return findMatch[1].replace(/[?.!,;:]+$/, '');
    return undefined;
}
function detectNotebook(message) {
    if (/\bwho\s+is\b|\bcontacts?\b|\bperson\b|\bpeople\b|\bworks?\s+for\b|\borganizations?\b|\bcompan(?:y|ies)\b/i.test(message)) {
        if (/\borganizations?\b|\bcompan(?:y|ies)\b/i.test(message))
            return { nb: 'WHO', type: 'ORG' };
        return { nb: 'WHO', type: 'CT' };
    }
    if (/\bwhen\s+is\b|\bmeeting\b|\bcalendar\b|\bdeadlines?\b|\bevents?\b|\bnext\s+meeting\b/i.test(message)) {
        if (/\bdeadlines?\b/i.test(message))
            return { nb: 'WHEN', type: 'DL' };
        return { nb: 'WHEN', type: 'CA' };
    }
    if (/\bprocedures?\b|\bsteps?\s+to\b|\bhow\s+to\b|\bHOW\b/i.test(message))
        return { nb: 'HOW', type: 'PR' };
    if (/\breflections?\b|\bquestions?\b|\bwhy\s+did\b|\bopen\s+questions?\b|\bnorth\s+star\b|\bvision\b|\bmission\b/i.test(message)) {
        if (/\b(north\s+star|vision|mission)\b/i.test(message))
            return { nb: 'WHY', type: 'MT' };
        return { nb: 'WHY', type: 'QU' };
    }
    if (/\btodos?\b|\btasks?\b|\breports?\b|\boverdue\b/i.test(message)) {
        if (/\breports?\b/i.test(message))
            return { nb: 'NOW', type: 'RP' };
        return { nb: 'NOW', type: 'TD' };
    }
    if (/\bplanning\b|\bplans?\b/i.test(message))
        return { nb: 'PLAN', type: 'PL' };
    if (/\bprojects?\b|\bstatus\s+of\b|\bwhat\s+is\s+the\s+status\b|\bwhat\s+is\s+(?:project|entry|knowledge)\b|\bknowledge\b/i.test(message)) {
        if (/\bknowledge\b/i.test(message))
            return { nb: 'WHAT', type: 'KN' };
        return { nb: 'WHAT', type: 'PJ' };
    }
    return {};
}
function extractMathExpression(message) {
    const percentOf = message.match(/(\d+(?:\.\d+)?)\s+percent\s+of\s+(\d+(?:\.\d+)?)/i);
    if (percentOf)
        return `${percentOf[1]} / 100 * ${percentOf[2]}`;
    const pctMatch = message.match(/(\d+(?:\.\d+)?)\s*%\s*of\s*(\d+(?:\.\d+)?)/i);
    if (pctMatch)
        return `${pctMatch[1]} / 100 * ${pctMatch[2]}`;
    const wordMath = message.match(/(?:(?:what|how\s+much)\s+is\s+)?(\d+(?:\.\d+)?)\s+(plus|minus|times|divided\s+by|multiplied\s+by)\s+(\d+(?:\.\d+)?)/i);
    if (wordMath) {
        const ops = {
            plus: '+',
            minus: '-',
            times: '*',
            'divided by': '/',
            'multiplied by': '*',
        };
        return `${wordMath[1]} ${ops[wordMath[2].toLowerCase()] ?? wordMath[2]} ${wordMath[3]}`;
    }
    const sqrtMatch = message.match(/square\s+root\s+of\s+(\d+(?:\.\d+)?)/i);
    if (sqrtMatch)
        return `sqrt(${sqrtMatch[1]})`;
    const calcMatch = message.match(/(?:calculate|compute)\s+(.+)/i);
    if (calcMatch)
        return calcMatch[1].trim();
    const directMath = message.match(/(\d+(?:\.\d+)?\s*[\+\-\*\/×÷\^%]\s*\d+(?:\.\d+)?(?:\s*[\+\-\*\/×÷\^%]\s*\d+(?:\.\d+)?)*)/);
    return directMath?.[1]?.trim().replace(/×/g, '*').replace(/÷/g, '/') ?? null;
}
function extractFilePath(message) {
    const absPath = message.match(/(\/[\w.\-/]+)/);
    if (absPath)
        return absPath[1];
    const relPath = message.match(/["']?([\w.\-/]+\.\w+)["']?/);
    if (relPath)
        return relPath[1];
    return null;
}
function extractFileWriterInput(message) {
    if (!matchesAny(message, FILE_WRITER_PATTERNS))
        return null;
    const namedMatch = message.match(/\b(?:called|named)\s+([\w.\-/]+\.\w+)\b/i);
    // Prioritize "at workspace/path.ext" over generic extension scan to avoid false matches (e.g. "Node.js" before "server.js")
    const atWorkspaceMatch = message.match(/\bat\s+(workspace\/[\w.\-/]+\.(?:txt|md|json|sh|html|css|js|ts|py|yaml|yml|csv|log))\b/i);
    const directMatch = message.match(/\b([\w.\-/]+\.(?:txt|md|json|sh|html|css|js|ts|py|yaml|yml|csv|log))\b/i);
    const path = namedMatch?.[1] ?? atWorkspaceMatch?.[1] ?? directMatch?.[1];
    if (!path)
        return null;
    const explicitContent = message.match(/(?:with\s+(?:content|text)\s+)(.+)$/i);
    const trailingContent = message.match(/\b(?:called|named)\s+[\w.\-/]+\.\w+\s+with\s+(.+)$/i)
        ?? message.match(/\b[\w.\-/]+\.\w+\s+with\s+(.+)$/i);
    const content = explicitContent?.[1]?.trim() ?? trailingContent?.[1]?.trim() ?? '';
    return { path, content };
}
function extractSearchQuery(message) {
    let query = message.replace(/^(can\s+you|could\s+you|would\s+you|please|can\s+i|could\s+i)\s+/i, '');
    query = query
        .replace(/\bsearch\s+(the\s+)?(internet|web|online)\s+for\s+/i, '')
        .replace(/\bsearch\s+(the\s+)?web\s+(for\s+)?/i, '')
        .replace(/\bsearch\s+(for|online)\s+/i, '')
        .replace(/\blook\s+up\s+/i, '')
        .replace(/\bfind\s+online\s+(resources?\s+(for|on|about)\s+)?/i, '')
        .replace(/\bgoogle\s+/i, '')
        .replace(/\bweb\s+search\s+(for\s+)?/i, '')
        .replace(/\bbrowse\s+(the\s+)?internet\s+for\s+/i, '')
        .replace(/\bget\s+information\s+about\s+/i, '')
        .trim();
    if (!query && /\blatest\s+news/i.test(message)) {
        const newsMatch = message.match(/(?:latest\s+news\s+(?:on|about)?\s*)?([^?!.]+?)(?:\?|!|\.|$)/i);
        query = newsMatch ? newsMatch[1].trim() : message.trim();
    }
    return query || message.trim();
}
function buildSkillCompatibilityClassification(message) {
    const reportingTail = /\b(?:and\s+)?(?:tell|show|report)\s+me(?:\s+what\s+happened|\s+the\s+result|\s+the\s+output)?\b/i.test(message);
    if (MULTI_STEP_LANGUAGE.test(message) && !reportingTail)
        return null;
    const explicitMathLanguage = /\b(calculat|compute|percent\s+of|times|divided\s+by|multiplied\s+by|plus|minus|square\s+root|sqrt|what\s+is\s+[\d(]|how\s+much\s+is)\b/i.test(message);
    const hasIsoDate = /\b\d{4}-\d{2}-\d{2}\b/.test(message);
    if (matchesAny(message, RUN_BASH_PATTERNS)) {
        const commandMatch = message.match(/(?:command|cmd|bash|execute(?:\s+the\s+command)?)\s+(.+)/i) ??
            message.match(/\brun\s+(.+?)(?:\s+and\s+(?:tell|show|report)\s+me\b|$)/i);
        const command = commandMatch
            ? commandMatch[1].replace(/\bin\s+the\s+workspace\b.*/i, '').trim()
            : message.trim();
        return { intent: 'skill', codes: [], skill: 'run_bash', skillInput: { command } };
    }
    if (matchesAny(message, WEB_SEARCH_PATTERNS)) {
        return {
            intent: 'skill',
            codes: [],
            skill: 'web_search',
            skillInput: { query: extractSearchQuery(message) },
        };
    }
    const fileWriterInput = extractFileWriterInput(message);
    if (fileWriterInput) {
        return {
            intent: 'skill',
            codes: [],
            skill: 'file_writer',
            skillInput: fileWriterInput,
        };
    }
    if (matchesAny(message, FILE_READER_PATTERNS)) {
        const path = extractFilePath(message);
        if (path) {
            return {
                intent: 'skill',
                codes: [],
                skill: 'file_reader',
                skillInput: { path },
            };
        }
    }
    if (matchesAny(message, CALCULATOR_PATTERNS)) {
        if (hasIsoDate && !explicitMathLanguage)
            return null;
        const expression = extractMathExpression(message);
        if (expression) {
            return {
                intent: 'skill',
                codes: [],
                skill: 'calculator',
                skillInput: { expression },
            };
        }
    }
    return null;
}
// FIX-P15-T2: Detect compound entity creation (e.g., "Save Alice and Bob as contacts and create project X")
// These must bypass the single-entity compatibility path so the planner handles all entities.
const COMPOUND_ENTITY_PATTERNS = [
    /\b(?:save|add|create)\b.+\b(?:and|,)\b.+\b(?:as a |as an )?(?:contact|project|todo|organization)\b/i,
    /\b(?:contact|project|organization)\b.+\b(?:and|,)\b.+\b(?:contact|project|organization)\b/i,
    /(?:\bas a contact\b|\bas contacts?\b).+\b(?:and|,)\b/i,
];
/**
 * Extract entities (contacts + projects) from a compound creation message.
 * Returns deterministically parsed entities without LLM call.
 * Pattern: "Save <name> as a contact and <name2> as a contact and create a project called <proj>"
 * Splits on "and" first so each clause is parsed independently.
 */
function extractCompoundEntities(message) {
    const entities = [];
    const seen = new Set();
    // Split on comma/semicolon OR " and " to process each clause separately.
    // This ensures "Save Alice... as a contact and Bob... as a contact" produces two matches.
    const clauses = message.split(/(?:\s+and\s+|[,;])/i);
    for (const clause of clauses) {
        const c = clause.trim();
        // Contact: "[save/add/remember] <name> as a contact"
        const contactMatch = c.match(/(?:save|add|remember)?\s*([\w][\w\s]*?)\s+as\s+(?:a\s+)?contacts?\b/i);
        if (contactMatch) {
            const name = contactMatch[1].trim();
            const key = `WHO|CT|${name.toLowerCase()}`;
            if (name.length > 0 && name.length < 100 && !seen.has(key)) {
                seen.add(key);
                entities.push({ nb: 'WHO', type: 'CT', name });
            }
        }
        // Project: "create [a] project called <name>"
        const projMatch = c.match(/(?:create\s+)?(?:a\s+)?project\s+called\s+([\w][\w\s\-]*?)(?:\s*[.,;]|$)/i);
        if (projMatch) {
            const name = projMatch[1].trim();
            const key = `PLAN|PJ|${name.toLowerCase()}`;
            if (name.length > 0 && name.length < 100 && !seen.has(key)) {
                seen.add(key);
                entities.push({ nb: 'PLAN', type: 'PJ', name });
            }
        }
    }
    return entities;
}
/**
 * Handle compound entity creation deterministically — no LLM call per entity.
 * Returns null if message doesn't have extractable entities.
 */
async function handleCompoundEntityCreation(message, findingsPrefix) {
    if (!isCompoundEntityCreation(message))
        return null;
    const entities = extractCompoundEntities(message);
    if (entities.length < 2)
        return null; // Fall through if we can't extract enough entities
    const createdEntries = [];
    for (const entity of entities) {
        try {
            const result = upsertEntry({
                nb: entity.nb,
                type: entity.type,
                name: entity.name,
                status: 'active',
                summary: `${entity.type === 'CT' ? 'Contact' : 'Project'}: ${entity.name}`,
                body: `# ${entity.name}\n\nCreated from compound entity creation request.\n`,
            });
            createdEntries.push({ name: entity.name, code: result.code, nb: entity.nb, type: entity.type });
        }
        catch {
            // best-effort: skip failed entities
        }
    }
    if (createdEntries.length === 0)
        return null; // Fall through if all creations failed
    // Write relationships between contacts and projects
    const contactCodes = createdEntries.filter(e => e.nb === 'WHO').map(e => e.code);
    const projectCodes = createdEntries.filter(e => e.nb === 'PLAN' || e.nb === 'WHAT').map(e => e.code);
    for (const contactCode of contactCodes) {
        for (const projectCode of projectCodes) {
            try {
                addRelationship({ from_code: contactCode, relation: 'works_on', to_code: projectCode });
            }
            catch {
                // best-effort
            }
        }
    }
    const created = createdEntries.map(e => `${e.name} (${e.code})`);
    const reply = `Created: ${created.join(', ')}.`;
    return {
        reply: findingsPrefix + reply,
        intent: 'memory_write',
        resolved: null,
    };
}
function isCompoundEntityCreation(message) {
    return COMPOUND_ENTITY_PATTERNS.some(p => p.test(message));
}
function shouldTreatAsMemoryWrite(message) {
    // FIX-P15-T2: Compound entity creation messages must go through planner/executor path
    if (isCompoundEntityCreation(message))
        return false;
    return matchesAny(message, WRITE_TRIGGER_PATTERNS)
        && matchesAny(message, MEMORY_ENTITY_PATTERNS)
        && !matchesAny(message, FILE_WRITER_PATTERNS)
        && !matchesAny(message, NON_MEMORY_ACTION_PATTERNS);
}
function buildMemoryWriteCompatibilityClassification(message) {
    if (!shouldTreatAsMemoryWrite(message))
        return null;
    const { nb, type } = detectNotebook(message);
    return {
        intent: 'memory_write',
        codes: extractCodes(message),
        nb,
        type,
        status: extractStatus(message),
        name: extractName(message),
        relation: extractRelation(message),
        due_date: extractDueDate(message),
    };
}
function buildQueryCompatibilityClassification(message) {
    const codes = extractCodes(message);
    const relation = extractRelation(message);
    const status = extractStatus(message);
    const name = extractName(message);
    const notebook = detectNotebook(message);
    if (codes.length > 0 && relation) {
        return {
            intent: 'relationship_query',
            codes,
            relation,
            status,
            name,
            ...notebook,
        };
    }
    if (codes.length > 0 && DIRECT_CODE_FETCH_PREFIX.test(message)) {
        return { intent: 'code_fetch', codes };
    }
    if (notebook.nb || status || name) {
        return {
            intent: relation ? 'relationship_query' : 'memory_query',
            codes,
            relation,
            status,
            name,
            ...notebook,
        };
    }
    return null;
}
function buildSingleUnitCompatibilityClassification(message, unit) {
    const skill = buildSkillCompatibilityClassification(message);
    if (skill)
        return skill;
    const memoryWrite = buildMemoryWriteCompatibilityClassification(message);
    if (memoryWrite)
        return memoryWrite;
    const query = buildQueryCompatibilityClassification(message);
    if (query && unit.route !== 'agentic')
        return query;
    return null;
}
function isDirectCodeFetchMessage(message, codes) {
    if (codes.length === 0)
        return false;
    if (extractRelation(message))
        return false;
    return DIRECT_CODE_FETCH_PREFIX.test(message) || message.trim() === codes[0];
}
function mapRouteIntent(message, decomposition, routeIntent) {
    if (decomposition.units.length === 1 && GREETING_ONLY.test(decomposition.units[0].content)) {
        return 'greeting';
    }
    if (routeIntent === 'agentic')
        return 'planned_workflow';
    if (routeIntent === 'query')
        return 'memory_query';
    if (GREETING_ONLY.test(message))
        return 'greeting';
    return 'general';
}
function mapErrorIntent(message, decomposition) {
    if (/^\/log\s+/i.test(message.trim()))
        return 'memory_write';
    if (DIRECT_MEETING_PREFIX.test(message.trim()))
        return 'meeting';
    if (isDirectCodeFetchMessage(message, extractCodes(message)))
        return 'code_fetch';
    if (decomposition?.units.some(unit => unit.route === 'agentic'))
        return 'planned_workflow';
    if (decomposition?.units.some(unit => unit.route === 'query'))
        return 'memory_query';
    return GREETING_ONLY.test(message) ? 'greeting' : 'general';
}
function inferWriteData(message, classification) {
    if (message.startsWith('/log ')) {
        const logContent = message.slice(5).trim();
        const now = new Date();
        const offset = now.getTimezoneOffset();
        const local = new Date(now.getTime() - offset * 60 * 1000);
        const isoDate = local.toISOString().slice(0, 16).replace('T', ' ');
        return {
            nb: 'NOW',
            type: 'LOG',
            name: `Log ${isoDate}`,
            status: 'active',
            summary: logContent.slice(0, 80),
            body: logContent,
        };
    }
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
        }
    }
    let name = classification.name;
    if (!name) {
        const namedMatch = message.match(/(?:named|called|for|contact)\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*)/);
        if (namedMatch)
            name = namedMatch[1];
    }
    if (!name)
        return null;
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
    return { nb, type, name, status, summary, body: message };
}
function cleanReply(reply) {
    // FIX D: Use comprehensive sanitizeFinalOutput to strip control tokens, thinking text,
    // and pseudo-tool narratives before returning to user
    return sanitizeFinalOutput(reply).trim();
}
const DIRECT_SKILL_OUTPUT = new Set([
    'web_search',
    'calculator',
    'file_reader',
    'memory_read',
    'web_fetch',
    'url_extract',
]);
function looksLikeDeferredAction(reply) {
    const trimmed = reply.trim();
    if (!trimmed)
        return true;
    return [
        /^(?:i(?:'ll| will)\s+(?:use|search|look up|read|run|check|fix)\b)/i,
        /^let me\b/i,
        /^i need to\b/i,
        /^i should\b/i,
        /^actually wait\b/i,
        /^looking at (?:my|the) instructions\b/i,
        /^given (?:the|my) instruction\b/i,
    ].some(pattern => pattern.test(trimmed));
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
async function buildFindingsPrefix() {
    try {
        const d = getDb();
        const unseen = d.prepare('SELECT * FROM heartbeat_queue WHERE seen = 0').all();
        if (unseen.length > 0) {
            const prefix = '\u{1F4CB} While you were away:\n' + unseen.map(r => r.message).join('\n') + '\n\n';
            d.prepare('UPDATE heartbeat_queue SET seen = 1').run();
            return prefix;
        }
    }
    catch {
        // Queue not available yet.
    }
    return '';
}
async function handleLogFastPath(message, findingsPrefix) {
    const logData = inferWriteData(message, { intent: 'memory_write', codes: [], nb: 'NOW', type: 'LOG' });
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
    }
    catch {
        // /log should remain fire-and-forget for the user.
    }
    return { reply: findingsPrefix + 'Logged.', intent: 'memory_write', resolved: null };
}
async function handleMeetingFastPath(history, llmHandler, findingsPrefix) {
    try {
        const { runMeetingMode } = await import('./meeting.js');
        const briefing = await runMeetingMode(history, llmHandler);
        return {
            reply: findingsPrefix + briefing.prompt,
            intent: 'meeting',
            resolved: null,
        };
    }
    catch (err) {
        return {
            reply: findingsPrefix + 'Could not start meeting mode. Please try again.',
            intent: 'meeting',
            resolved: null,
            error: String(err),
        };
    }
}
async function handleLegacyResolvedFlow(message, history, classification, llmHandler, findingsPrefix) {
    let resolved = resolveQuery(classification);
    if (resolved === null && classification.intent !== 'code_fetch') {
        try {
            const searchResults = await hybridSearch(message, { nb: classification.nb });
            if (searchResults.length > 0) {
                const entries = searchResults.map(r => r.entry);
                const contents = entries
                    .map(entry => fetchByCode(entry.code)?.content)
                    .filter((content) => Boolean(content));
                resolved = { step: 5, entries, contents, relationships: [] };
            }
        }
        catch {
            // Hybrid search is best-effort.
        }
    }
    if (resolved === null) {
        if (classification.intent === 'code_fetch') {
            return { reply: findingsPrefix + 'Entry not found.', intent: classification.intent, resolved: null };
        }
        if ((classification.intent === 'memory_query' || classification.intent === 'relationship_query') && classification.nb) {
            return {
                reply: findingsPrefix + `No entries found in ${classification.nb} notebook.`,
                intent: classification.intent,
                resolved: null,
            };
        }
        if (classification.intent === 'memory_query' || classification.intent === 'relationship_query') {
            return { reply: findingsPrefix + 'No matching entries found.', intent: classification.intent, resolved: null };
        }
    }
    const skills = getSkillsForIntent(classification.intent);
    const messages = await buildContext(message, resolved, history, skills, classification.intent, undefined, llmHandler);
    try {
        const reply = await llmHandler(messages);
        return { reply: findingsPrefix + cleanReply(reply), intent: classification.intent, resolved };
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
async function handleCompatibilityExecution(message, history, classification, findingsPrefix, llmHandler) {
    if (classification.intent === 'skill' && classification.skill && classification.skillInput) {
        const skillResult = await runWithRetry(classification.skill, classification.skillInput, llmHandler);
        if (!skillResult.success) {
            const errorMsg = skillResult.error ?? '';
            transparency.emit({ type: 'failure_classified', data: { error: errorMsg, class: classifyFailure(errorMsg) } });
            // FIX-M1: Direct write retained — memory agent queue has no episodic failure handler type;
            // this compatibility path needs a direct WHEN.EV write for skill failures
            const failTs = new Date().toISOString();
            writeEpisodicEvent({
                trigger: message,
                task_name: `Skill: ${classification.skill} — ${message.slice(0, 50)} [${failTs.slice(0, 16)}]`,
                skill_sequence: [classification.skill],
                outcome: 'failure',
                failure_reason: errorMsg,
                linked_codes: [],
                session_id: failTs,
            }).catch(() => { });
            const reply = /access denied|not allowed|outside workspace|invalid path/i.test(errorMsg)
                ? `I couldn't complete that: ${errorMsg}`
                : `I couldn't complete that. Please try again or rephrase your request.`;
            return {
                reply: findingsPrefix + reply,
                intent: 'skill',
                resolved: null,
                error: errorMsg,
                retries: skillResult.retries,
            };
        }
        // FIX-P15-T5: Write EV entry on successful action skill execution (file_writer, run_bash, etc.)
        // so memory write completeness tests pass. Query skills (web_search, calculator, etc.) are excluded.
        // Include timestamp in task_name to avoid unique constraint violations on repeated executions.
        const ACTION_SKILLS = new Set(['file_writer', 'run_bash', 'memory_write', 'implement_and_test']);
        if (ACTION_SKILLS.has(classification.skill)) {
            const ts = new Date().toISOString();
            const taskName = `Skill: ${classification.skill} — ${message.slice(0, 50)} [${ts.slice(0, 16)}]`;
            const evEvent = {
                trigger: message,
                task_name: taskName,
                skill_sequence: [classification.skill],
                outcome: 'success',
                linked_codes: [],
                session_id: ts,
            };
            writeEpisodicEvent(evEvent)
                .then(evCode => writeReflectionSync(evCode, evEvent))
                .catch(() => { });
            // FIX-T6: create a terminal PLAN.EX so T6 can verify completion
            try {
                createPlanEX({
                    task_name: taskName,
                    project_code: '',
                    goal: message,
                    milestones: [],
                    current_milestone: 0,
                    todos: [],
                    constraints: {},
                    last_action: `Completed: ${classification.skill}`,
                    next_action: 'none',
                    conf_score: 0.95,
                    session_id: ts,
                    checkpoint_ts: ts,
                    started: ts,
                    attempt_counts: {},
                    last_failures: {},
                    recent_turns: [],
                    loaded_memory_utility: {},
                    file_checksums: {},
                    status: 'complete',
                });
            }
            catch { /* best-effort */ }
        }
        if (DIRECT_SKILL_OUTPUT.has(classification.skill)) {
            return {
                reply: findingsPrefix + skillResult.output,
                intent: 'skill',
                resolved: null,
                retries: skillResult.retries,
            };
        }
        try {
            const skillContext = await buildContext(message, null, history, [], 'skill', skillResult.output, llmHandler);
            const reply = await llmHandler(skillContext);
            const cleanedReply = cleanReply(reply);
            if (!cleanedReply || looksLikeDeferredAction(cleanedReply)) {
                return {
                    reply: findingsPrefix + skillResult.output,
                    intent: 'skill',
                    resolved: null,
                    retries: skillResult.retries,
                };
            }
            return {
                reply: findingsPrefix + cleanedReply,
                intent: 'skill',
                resolved: null,
                retries: skillResult.retries,
            };
        }
        catch {
            return {
                reply: findingsPrefix + skillResult.output,
                intent: 'skill',
                resolved: null,
                retries: skillResult.retries,
            };
        }
    }
    if (classification.intent === 'memory_write') {
        let writeData = null;
        let lastLLMResponse;
        const MAX_WRITE_RETRIES = 2;
        for (let writeAttempt = 0; writeAttempt <= MAX_WRITE_RETRIES; writeAttempt++) {
            try {
                const writeMessages = writeAttempt === 0
                    ? [
                        { role: 'system', content: WRITE_SYSTEM_PROMPT },
                        { role: 'user', content: message },
                    ]
                    : [
                        { role: 'system', content: WRITE_SYSTEM_PROMPT },
                        { role: 'user', content: message },
                        { role: 'assistant', content: lastLLMResponse },
                        { role: 'user', content: 'Your response was invalid JSON or missing required fields (nb, type, name). Please return ONLY a valid JSON object with all required fields.' },
                    ];
                const llmResponse = await llmHandler(writeMessages, { responseSchema: writeEntryJsonSchema });
                lastLLMResponse = llmResponse;
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
                                due_date: zodResult.data.due_date,
                            };
                            break;
                        }
                    }
                    catch {
                        // Fall through to regex extraction.
                    }
                }
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
                        due_date: parsed.due_date,
                    };
                    break;
                }
            }
            catch {
                break;
            }
        }
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
            const due_date = writeData.due_date ?? classification.due_date;
            const { code, created } = upsertEntry({
                nb: writeData.nb,
                type: writeData.type,
                name: writeData.name,
                status: writeData.status,
                summary: writeData.summary,
                body: writeData.body,
                due_date,
            });
            const entry = getEntryByCode(code);
            if (entry) {
                extractMemoryMetadata(code, writeData.body, writeData.summary, llmHandler)
                    .catch(err => console.warn('[agent] extractMemoryMetadata failed:', err));
            }
            if (created && writeData.relationships) {
                for (const rel of writeData.relationships) {
                    try {
                        addRelationship({ from_code: code, relation: rel.relation, to_code: rel.to_code });
                    }
                    catch {
                        // Ignore unresolved relationship targets.
                    }
                }
            }
            return {
                reply: findingsPrefix + `${created ? 'Created' : 'Updated'} ${code} — ${writeData.name} (${writeData.nb}.${writeData.type})`,
                intent: 'memory_write',
                resolved: entry ? { step: 0, entries: [entry], contents: [], relationships: [] } : null,
                created: entry ?? undefined,
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
    return null;
}
/**
 * Classify user response to a pending plan confirmation.
 * Deterministic regex-based classification without LLM calls.
 * @returns 'approve' | 'reject' | 'ambiguous'
 */
function classifyConfirmationResponse(message) {
    const lower = message.trim().toLowerCase();
    const approvalQualifierPattern = /\b(but|if|except|change|changes|changed|modify|modifies|modified)\b/i;
    // Approve patterns: yes, yeah, y, go, proceed, do it, execute, run, confirm, approved, okay, ok, sure, let's go, just do it
    const approvePatterns = [/^(yes|yeah|yep|y|go|proceed|do\s+it|execute|run|confirm|confirmed|okay|ok|sure|let'?s\s+go|just\s+do\s+it|absolutely|definitely|sounds\s+good)/i];
    if (approvePatterns.some(p => p.test(lower))) {
        if (approvalQualifierPattern.test(lower)) {
            return 'ambiguous';
        }
        return 'approve';
    }
    // Reject patterns: no, nope, nah, cancel, stop, abort, don't, don't do it, never, skip, disagree, no thanks
    const rejectPatterns = [/^(no|nope|nah|n|cancel|stop|abort|don't|do\s+not|never|skip|disagree|no\s+thanks|i\s+don't)/i];
    if (rejectPatterns.some(p => p.test(lower))) {
        return 'reject';
    }
    // Ambiguous: anything else
    return 'ambiguous';
}
export async function processMessage(message, history, options) {
    isProcessingMessage = true;
    recordActivity(); // Phase 16: track last activity for AutoDream idle detection
    let decomposition = null;
    try {
        // === FIX 0: Plan Confirmation Interceptor (step [0]) ===
        // Deterministic confirmation without LLM calls. Reads the user's raw message
        // and classifies it as approval, rejection, or ambiguous.
        const handler = options?.llmHandler ?? callLLM;
        const currentPendingPlan = _getPendingConfirmationPlan();
        if (currentPendingPlan) {
            const findingsPrefix = await buildFindingsPrefix();
            const decision = classifyConfirmationResponse(message);
            if (decision === 'approve') {
                // Execute the plan immediately
                const executionResult = await executeConfirmedPlan(currentPendingPlan, handler);
                _setPendingConfirmationPlan(null);
                skillClearPendingPlan();
                transparency.emit({ type: 'plan_confirmed', data: { goal: currentPendingPlan.goal ?? 'unknown' } });
                return {
                    reply: findingsPrefix + executionResult.reply,
                    intent: 'planned_workflow',
                    resolved: null,
                };
            }
            if (decision === 'reject') {
                // Reject and clear the plan
                _setPendingConfirmationPlan(null);
                skillClearPendingPlan();
                transparency.emit({ type: 'plan_rejected', data: { goal: currentPendingPlan.goal ?? 'unknown' } });
                return {
                    reply: findingsPrefix + `Plan cancelled. Let me know what you'd like to do instead.`,
                    intent: 'general',
                    resolved: null,
                };
            }
            // decision === 'ambiguous' — keep plan pending and re-prompt
            transparency.emit({ type: 'plan_confirmation_ambiguous', data: { userMessage: message } });
            const milestones = currentPendingPlan.milestones ?? [];
            const nextMilestone = milestones.length > 0 ? milestones[0] : null;
            const clarification = nextMilestone
                ? `Could you clarify? The plan's first milestone is: "${nextMilestone.title || 'Unknown'}". Do you want me to proceed?`
                : `Could you clarify? Do you want me to execute the plan?`;
            return {
                reply: findingsPrefix + clarification,
                intent: 'general',
                resolved: null,
            };
        }
        if (/^\/log\s+/i.test(message.trim())) {
            const findingsPrefix = await buildFindingsPrefix();
            return await handleLogFastPath(message, findingsPrefix);
        }
        if (DIRECT_MEETING_PREFIX.test(message.trim())) {
            const findingsPrefix = await buildFindingsPrefix();
            return await handleMeetingFastPath(history, handler, findingsPrefix);
        }
        const codes = extractCodes(message);
        if (isDirectCodeFetchMessage(message, codes)) {
            const findingsPrefix = await buildFindingsPrefix();
            return await handleLegacyResolvedFlow(message, history, { intent: 'code_fetch', codes }, handler, findingsPrefix);
        }
        const findingsPrefix = await buildFindingsPrefix();
        // FIX-T2-V2: Deterministic compound entity creation fast path.
        // The planner generates incomplete plans for "Save A and B as contacts + create project X".
        // Handle it deterministically here to guarantee all entities are created.
        if (isCompoundEntityCreation(message)) {
            const compoundResult = await handleCompoundEntityCreation(message, findingsPrefix);
            if (compoundResult)
                return compoundResult;
        }
        // FIX-T5: Pre-decomposition skill fast path for action skills.
        // Run skill detection BEFORE decomposition to avoid LLM misclassifying
        // clear file_writer or run_bash requests as conversational.
        // Only applies to action skills (file_writer, run_bash) that need EV tracking.
        // Does NOT apply to compound messages mixing entity creation + file/bash actions.
        const PRE_DECOMP_ACTION_SKILLS = new Set(['file_writer', 'run_bash']);
        const isMultiIntentMessage = !isCompoundEntityCreation(message)
            ? matchesAny(message, WRITE_TRIGGER_PATTERNS) && matchesAny(message, MEMORY_ENTITY_PATTERNS)
            : true;
        if (!isCompoundEntityCreation(message) && !isMultiIntentMessage) {
            const earlySkillClassification = buildSkillCompatibilityClassification(message);
            if (earlySkillClassification?.intent === 'skill' &&
                earlySkillClassification.skill &&
                earlySkillClassification.skillInput &&
                PRE_DECOMP_ACTION_SKILLS.has(earlySkillClassification.skill)) {
                const earlyResult = await handleCompatibilityExecution(message, history, earlySkillClassification, findingsPrefix, handler);
                if (earlyResult)
                    return earlyResult;
            }
        }
        // FIX 4: Quick complexity pre-check for non-compound, clearly-agentic messages.
        // LOW/MEDIUM → skip intake+decomposition, go directly to queryLoop (saves ~15s).
        // HIGH/MAX   → fall through to full intake+decomposition pipeline.
        // Excluded: greetings, questions, memory entity ops, explicit skill patterns, memory query patterns.
        const startsWithQuestion = /^(what|who|when|where|how|why|which|is|are|can|does|do|tell\s+me\s+about|explain|describe|find|search|look|show|list|get|fetch|retrieve)\b/i.test(message.trim());
        if (!isLikelyCompoundMessage(message) &&
            !isCompoundEntityCreation(message) &&
            !GREETING_ONLY.test(message.trim()) &&
            !startsWithQuestion &&
            buildSkillCompatibilityClassification(message) === null &&
            buildMemoryWriteCompatibilityClassification(message) === null &&
            buildQueryCompatibilityClassification(message) === null) {
            try {
                const quickComplexity = await assessComplexity(message, { intent: 'planned_workflow', codes: [] }, handler);
                if (quickComplexity.level === 'LOW' || quickComplexity.level === 'MEDIUM') {
                    transparency.emit({ type: 'route', data: { level: quickComplexity.level, reason: quickComplexity.reason, path: 'query_loop' } });
                    const loopResult = await runQueryLoop(message, handler, undefined, history);
                    return {
                        reply: findingsPrefix + loopResult.reply,
                        intent: 'planned_workflow',
                        resolved: null,
                    };
                }
            }
            catch {
                // Pre-check is advisory — fall through to normal flow on any error
            }
        }
        // ── Quick-resolve: deterministic retrieval, no LLM call ──
        // Checks for direct code lookups (WHO.CT-000001) and name matches
        // before spending 2-5 seconds on intake + decomposition. Falls through
        // to normal pipeline if quickResolve returns resolved: false.
        // SKIP for relationship queries (e.g. "what does X own?") — those need special routing.
        // NOTE: extractRelation() returns string | undefined (NOT null). Using `!== null`
        // would incorrectly treat undefined as "has relation" and would skip quick-resolve
        // for every message.
        const hasRelationshipIntent = extractRelation(message) !== undefined;
        const quickResult = !hasRelationshipIntent ? await quickResolve(message) : { resolved: false, entries: [], strategy: 'none', bodies: [] };
        if (quickResult.resolved && quickResult.entries.length > 0) {
            // Quick-resolve found results — build context with them and respond
            const resolvedEntries = quickResult.entries;
            const resolvedBodies = quickResult.bodies;
            // Format resolved entries for context injection
            let memoryContext;
            if (resolvedBodies.length > 0 && resolvedBodies.some(b => b.length > 0)) {
                // We have full bodies — use them
                memoryContext = resolvedEntries.map((entry, i) => {
                    const body = resolvedBodies[i] || '';
                    return `### ${entry.code}: ${entry.name}\n${body || entry.summary || '(no content)'}`;
                }).join('\n\n');
            }
            else {
                // Summaries only
                memoryContext = resolvedEntries.map(entry => `- **${entry.code}**: ${entry.name} — ${entry.summary || 'no summary'} [${entry.status}]`).join('\n');
            }
            // Phase 20b: Intent-aware synthesis prompt
            // Commands get permission to act; queries get retrieval-only guidance
            const isCommand = quickResult.isCommand === true;
            const systemPrompt = isCommand
                ? `You are Zaraban, a personal AI assistant with persistent memory and full coding/creation capabilities.
The user is requesting an ACTION. Your memory system found entries that may provide useful context.
Use the context below as BACKGROUND INFORMATION (preferences, existing project details, style).
Then EXECUTE the user's request using your full knowledge and skills.
Do not refuse because the task is "not in memory" — memory is context, not a constraint.

## Background Context (${resolvedEntries.length} entries)

${memoryContext}`
                : `You are Zaraban, a personal AI assistant with persistent memory.
The user asked a question and your memory system already found the relevant entries.
Answer based on the retrieved data below. Be concise and direct.
Do not claim entries are missing — everything relevant has already been retrieved.

## Retrieved Memory (${quickResult.strategy}, ${quickResult.entries.length} entries)

${memoryContext}

## Grounding Rule
The memory entries provided above are confirmed to exist in the database. You MUST NOT claim that any of these entries do not exist, are missing, or could not be found. Base your answer on the content of these entries.`;
            // Phase 20b FIX 2: Commands bypass synthesis — only queries use the synthesis path
            // All command-intent messages need the full agentic pipeline (decomposition → planner/executor)
            if (!isCommand) {
                // Use the synthesis path for queries and retrieval-only actions
                const contextMessages = [
                    { role: 'system', content: systemPrompt },
                    ...history.slice(-6),
                    { role: 'user', content: message },
                ];
                try {
                    const llmReply = await handler(contextMessages, { disableThinking: true });
                    const cleanedReply = cleanReply(llmReply);
                    return {
                        reply: findingsPrefix + cleanedReply,
                        intent: 'memory_query',
                        resolved: null,
                    };
                }
                catch (error) {
                    // LLM call failed — fall through to normal pipeline
                }
            }
            // else: commands fall through to full pipeline
        }
        // ── End quick-resolve ──
        // Phase 15: Run intake classification before decomposition
        // (best-effort — never blocks if it fails)
        let intakeResult = null;
        try {
            const db = getDb();
            // Ensure memory agent is initialized (in case startAgent wasn't called)
            memoryAgent.init(db, handler);
            intakeResult = await runIntake(message, db, handler);
            // Intake event is emitted inside runIntake — no duplicate emit here.
        }
        catch {
            // Intake is advisory — never block processing
        }
        // Create fresh repair context for this message's decomposition
        const repairContext = { count: 0 };
        decomposition = await decomposeMessage(message, handler, intakeResult?.resolvedContext, repairContext);
        if (decomposition.units.length === 1 && GREETING_ONLY.test(decomposition.units[0].content)) {
            const routed = await routeDecomposedUnits(decomposition.units, [], history, handler);
            return {
                reply: findingsPrefix + routed.reply,
                intent: 'greeting',
                resolved: null,
            };
        }
        const allowSingleUnitCompatibility = decomposition.units.length === 1 && !isLikelyCompoundMessage(message);
        let compatibilityClassification = null;
        if (allowSingleUnitCompatibility) {
            compatibilityClassification = buildSingleUnitCompatibilityClassification(message, decomposition.units[0]);
            if (compatibilityClassification
                && (compatibilityClassification.intent === 'skill' || compatibilityClassification.intent === 'memory_write')) {
                const compatibilityResult = await handleCompatibilityExecution(message, history, compatibilityClassification, findingsPrefix, handler);
                if (compatibilityResult)
                    return compatibilityResult;
            }
        }
        // Phase 15 Conflict 1: pass intake resolved codes so searchUnit can serve from session cache
        // Phase 18F FIX 4: also pass intake signals for project/person scoping in unit-search
        const alreadyResolvedCodes = intakeResult?.resolvedContext.map(e => e.code) ?? [];
        const unitResults = await searchMemoryForUnits(decomposition.units, alreadyResolvedCodes.length > 0 ? alreadyResolvedCodes : undefined, intakeResult ? {
            projectSignal: intakeResult.signals.projectSignal,
            personSignal: intakeResult.signals.personSignal,
            timeSignal: intakeResult.signals.timeSignal,
        } : undefined);
        // FIX E: Decomposed units are the source of truth for routing.
        // Legacy path allowed for: skill, memory_write (handled above), relationship_query, code_fetch, memory_query.
        // Removed: general-intent fallback for decomposed query units (those go through routeDecomposedUnits now).
        if (allowSingleUnitCompatibility) {
            if (compatibilityClassification
                && decomposition.units[0].route !== 'agentic'
                && (compatibilityClassification.intent === 'memory_query'
                    || compatibilityClassification.intent === 'relationship_query'
                    || compatibilityClassification.intent === 'code_fetch')) {
                const result = await handleLegacyResolvedFlow(message, history, compatibilityClassification, handler, findingsPrefix);
                return result;
            }
            // NOTE: Removed the !compatibilityClassification && route === 'query' → general fallback (FIX E)
            // Decomposed query units without a specific classification now go through routeDecomposedUnits.
        }
        // Phase 15 FIX 1: Create or load working memory for agentic units
        let workingMemory = null;
        const hasAgenticUnits = decomposition.units.some(unit => unit.route === 'agentic');
        if (hasAgenticUnits && intakeResult) {
            try {
                const db = getDb();
                if (intakeResult.projectCode) {
                    workingMemory = await loadWorkingMemory(intakeResult.projectCode);
                }
                if (!workingMemory) {
                    workingMemory = await createWorkingMemory(intakeResult.summary, intakeResult, db);
                }
            }
            catch {
                // Working memory creation is best-effort
            }
        }
        const routed = await routeDecomposedUnits(decomposition.units, unitResults, history, handler, workingMemory ?? undefined);
        // FIX 0: If routing produced a plan that needs confirmation, store it and return the confirmation prompt
        if (routed.plan?.needsConfirmation && !routed.execution) {
            _setPendingConfirmationPlan(routed.plan);
            transparency.emit({ type: 'plan_confirmation_pending', data: { goal: routed.plan.goal, stepCount: routed.plan.steps.length } });
        }
        const agentReply = stripThinkingTags(routed.reply);
        return {
            reply: findingsPrefix + agentReply,
            intent: mapRouteIntent(message, decomposition, routed.primaryRoute),
            resolved: routed.resolved,
        };
    }
    catch (error) {
        return {
            reply: 'I could not reach the language model. Please check that it is running.',
            intent: mapErrorIntent(message, decomposition),
            resolved: null,
            error: String(error),
        };
    }
    finally {
        isProcessingMessage = false;
    }
}
