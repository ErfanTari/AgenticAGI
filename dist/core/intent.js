import { getSkillDescriptions } from './skills/registry.js';
const CODE_REGEX = /\b([A-Z]+\.[A-Z]+-\d{6,})\b/g;
const GREETING_REGEX = /^\s*(hi|hello|hey|good\s+(morning|afternoon|evening)|howdy|greetings)\b/i;
// --- Write patterns (order matters: checked before read patterns) ---
const WRITE_PATTERNS = [
    /\b(create|add|new|write|save|store|remember)\b/i,
    /\bremind\s+me\b/i,
    /\bschedule\b/i,
    /\bnew\s+(contact|project|todo|task|event|deadline|procedure|plan)\b/i,
    /\bmy\s+(?:north\s+star\s+)?(?:vision|mission|north\s+star)\s*(?:is|:)/i,
    /\bset\s+my\s+(vision|north\s+star|mission)\b/i,
];
// --- Web/file action exclusions — prevent WRITE_PATTERNS from mis-classifying action tasks ---
// e.g. "download it, save it in a folder" is NOT a memory write
const WEB_FILE_ACTION_PATTERNS = [
    /\b(go\s+(to|through)|visit|browse|navigate)\b.*\b(website|site|page)\b/i,
    /\bdownload\b/i,
    /\bsave\s+(it|th(is|e)\s+\w+)\s+(in|to|into)\s+(a\s+)?(folder|directory|workspace|disk|path)\b/i,
    /\bsave\b.*\b(folder|directory|workspace)\b/i,
];
// --- Web search patterns (now routes to skill) ---
const WEB_SEARCH_PATTERNS = [
    /\bsearch\s+(the\s+)?web\b/i,
    /\blook\s+up\b/i,
    /\bfind\s+online\b/i,
    /\bsearch\s+.*(for|online|internet)\b/i, // "search X for", "search X internet", etc.
    /\bsearch\s+online\b/i,
    /\bweb\s+search\b/i,
    /\bgoogle\b/i,
    /\blatest\s+news\b/i,
    /\bcurrent\s+info\b/i,
    /\bfind\s+online\s+resources?\b/i,
    /\bbrowse\s+(the\s+)?internet\b/i,
    /\bget\s+information\s+about\b/i,
];
// --- Calculator patterns ---
const CALCULATOR_PATTERNS = [
    /\bcalculat/i,
    /\bcompute\b/i,
    /\bwhat\s+is\s+[\d(]/i,
    /\bhow\s+much\s+is\b/i,
    /\d+\s*[\+\-\*\/]\s*\d/,
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
// --- File reader patterns ---
const FILE_READER_PATTERNS = [
    /\bread\s+(the\s+)?file\b/i,
    /\bopen\s+(the\s+)?file\b/i,
    /\bload\s+(the\s+)?(file|contents?\s+of)\b/i,
    /\bshow\s+(me\s+)?the\s+file\b/i,
    /\bshow\s+(me\s+)?(the\s+)?(contents?\s+of\s+)?\/[\w.\-/]+/i,
    /\bread\s+\/[\w.\-/]+/i,
    /\bcat\s+\/[\w.\-/]+/i,
];
// --- Bash runner patterns ---
const RUN_BASH_PATTERNS = [
    /\brun\s+(the\s+)?(command|cmd)\b/i,
    /\brun\s+(a\s+)?bash\b/i,
    /\bexecute\s+(the\s+)?(command|script)\b/i,
    /\b(bash|shell)\s+(command|script)\b/i,
    // Match "run [common_unix_command]"
    /\brun\s+(?:echo|ls|cat|pwd|grep|find|mkdir|cp|mv|rm|chmod|curl|wget|git|python3?|node|npm|npx|yarn|sh|touch)\b/i,
];
// Messages with explicit multi-step language should not be short-circuited to a single skill
const MULTI_STEP_LANGUAGE = /\b(then\s+|after\s+that\s+|first\s+.{3,}\s+then\s+|followed\s+by\s+|and\s+then\s+)\b/i;
// --- File writer patterns ---
const FILE_WRITER_PATTERNS = [
    /\bwrite\s+(a\s+|to\s+)?file\b/i,
    /\bwrite\s+\w+\.\w+\b/i, // "write a notes.txt file"
    /\bcreate\s+(a\s+)?file\b/i, // "create a file summary.txt"
    /\bcreate\s+(a\s+)?\w+\.(txt|md|json|sh|html|css|js|ts|py|yaml|yml|csv|log)\b/i,
    /\bsave\s+(it\s+)?(to|as|into)\s+(a\s+)?file\b/i,
    /\bsave\s+to\s+file\b/i,
    /\bmake\s+(a\s+)?(text\s+)?(file|document)\b/i,
];
// --- Synthesis patterns — cross-notebook queries that span multiple notebooks ---
const SYNTHESIS_PATTERNS = [
    /\bweekly\s+(status\s+)?report\b/i,
    /\bstatus\s+report\b/i,
    /\bbased\s+on\s+everything\s+you\s+know\b/i,
    /\bsummar(?:y|ize)\s+(all|my|everything)\b/i,
    /\boverview\s+of\s+(all|my)\b/i,
    /\bwhat\s+(?:do\s+I\s+have|is\s+going\s+on)\b/i,
    /\bbriefing\b/i,
    /\bfull\s+picture\b/i,
    /\bwrap\s+up\b/i,
    /\bcatch\s+me\s+up\b/i,
];
// --- WHO patterns ---
const WHO_PATTERNS = [
    /\bwho\s+is\b/i,
    /\bcontacts?\b/i,
    /\bperson\b|\bpeople\b/i,
    /\bworks?\s+for\b/i,
    /\borganizations?\b|\bcompan(?:y|ies)\b/i,
    /\bfind\s+[A-Z][a-z]/, // "find Reza" — capitalized name after "find"
];
// --- WHAT patterns ---
const WHAT_PATTERNS = [
    /\bprojects?\b/i,
    /\bstatus\s+of\b/i,
    /\bwhat\s+is\s+the\s+status\b/i,
    /\bwhat\s+is\s+(?:project|entry|knowledge)\b/i,
    /\bknowledge\b/i,
];
// --- WHEN patterns ---
const WHEN_PATTERNS = [
    /\bwhen\s+is\b/i,
    /\bmeeting\b/i,
    /\bcalendar\b/i,
    /\bdeadlines?\b/i,
    /\bevents?\b/i,
    /\bnext\s+meeting\b/i,
];
// --- HOW patterns ---
const HOW_PATTERNS = [
    /\bhow\s+do\s+I\b/i,
    /\bhow\s+to\b/i,
    /\bprocedures?\b/i,
    /\bsteps?\s+to\b/i,
];
// --- WHY patterns ---
const WHY_PATTERNS = [
    /\breflections?\b/i,
    /\bquestions?\b/i,
    /\bwhy\s+did\b/i,
    /\bopen\s+questions?\b/i,
    /\bnorth\s+star\b/i,
    /\bvision\s+is\b/i,
    /\bmy\s+mission\b/i,
];
// --- NOW patterns ---
const NOW_PATTERNS = [
    /\btodos?\b/i,
    /\btasks?\b/i,
    /\breports?\b/i,
    /\boverdue\b/i,
];
// --- PLAN patterns ---
const PLAN_PATTERNS = [
    /\bplanning\b|\bplans?\b/i,
];
// Notebook type mappings for pattern-based detection
const NOTEBOOK_PATTERNS = [
    { pattern: /\bcontacts?\b/i, nb: 'WHO', type: 'CT' },
    { pattern: /\borganizations?\b|\bcompan(?:y|ies)\b/i, nb: 'WHO', type: 'ORG' },
    { pattern: /\bprojects?\b/i, nb: 'WHAT', type: 'PJ' },
    { pattern: /\bknowledge\b/i, nb: 'WHAT', type: 'KN' },
    { pattern: /\bcalendar\b|\bevents?\b|\bmeeting\b/i, nb: 'WHEN', type: 'CA' },
    { pattern: /\bdeadlines?\b/i, nb: 'WHEN', type: 'DL' },
    { pattern: /\bprocedures?\b|\bhow\s+to\b/i, nb: 'HOW', type: 'PR' },
    { pattern: /\breflections?\b/i, nb: 'WHY', type: 'MT' },
    { pattern: /\bquestions?\b/i, nb: 'WHY', type: 'QU' },
    { pattern: /\btodos?\b|\btasks?\b/i, nb: 'NOW', type: 'TD' },
    { pattern: /\breports?\b/i, nb: 'NOW', type: 'RP' },
    { pattern: /\bplanning\b|\bplans?\b/i, nb: 'PLAN', type: 'PL' },
    { pattern: /\bnorth\s+star\b|\bmy\s+vision\b/i, nb: 'WHY', type: 'MT' },
];
const RELATION_PATTERNS = [
    { pattern: /\bowns?\b/i, relation: 'owns' },
    { pattern: /\bworks?\s+for\b/i, relation: 'works_for' },
    { pattern: /\bsuppl(?:y|ies)\b/i, relation: 'supplies' },
    { pattern: /\bblocks?\b/i, relation: 'blocks' },
    { pattern: /\brefers?\s+to\b/i, relation: 'refers' },
];
const STATUS_REGEX = /\b(active|archived|open|closed|upcoming)\b/i;
function matchesAny(message, patterns) {
    return patterns.some(p => p.test(message));
}
function extractCodes(message) {
    return [...message.matchAll(CODE_REGEX)].map(m => m[1]);
}
function extractNotebookType(message) {
    for (const { pattern, nb, type } of NOTEBOOK_PATTERNS) {
        if (pattern.test(message))
            return { nb, type };
    }
    return {};
}
function detectNotebook(message) {
    // Check specific notebook patterns in priority order
    if (matchesAny(message, WHO_PATTERNS)) {
        // Determine sub-type
        if (/\borganizations?\b|\bcompan(?:y|ies)\b/i.test(message))
            return { nb: 'WHO', type: 'ORG' };
        return { nb: 'WHO', type: 'CT' };
    }
    if (matchesAny(message, WHEN_PATTERNS)) {
        if (/\bdeadlines?\b/i.test(message))
            return { nb: 'WHEN', type: 'DL' };
        return { nb: 'WHEN', type: 'CA' };
    }
    if (matchesAny(message, HOW_PATTERNS))
        return { nb: 'HOW', type: 'PR' };
    if (matchesAny(message, WHY_PATTERNS)) {
        if (/\b(north\s+star|vision|mission)\b/i.test(message))
            return { nb: 'WHY', type: 'MT' };
        return { nb: 'WHY', type: 'QU' };
    }
    if (matchesAny(message, NOW_PATTERNS)) {
        if (/\breports?\b/i.test(message))
            return { nb: 'NOW', type: 'RP' };
        return { nb: 'NOW', type: 'TD' };
    }
    if (matchesAny(message, PLAN_PATTERNS))
        return { nb: 'PLAN', type: 'PL' };
    if (matchesAny(message, WHAT_PATTERNS)) {
        if (/\bknowledge\b/i.test(message))
            return { nb: 'WHAT', type: 'KN' };
        return { nb: 'WHAT', type: 'PJ' };
    }
    // Fall back to keyword-based notebook detection
    return extractNotebookType(message);
}
function extractRelation(message) {
    for (const { pattern, relation } of RELATION_PATTERNS) {
        if (pattern.test(message))
            return relation;
    }
    return undefined;
}
function extractStatus(message) {
    const match = message.match(STATUS_REGEX);
    return match ? match[1].toLowerCase() : undefined;
}
function extractDueDate(message) {
    // ISO date: "due 2025-03-15"
    const isoMatch = message.match(/\bdue\s+(\d{4}-\d{2}-\d{2})\b/i);
    if (isoMatch)
        return isoMatch[1];
    // "due tomorrow" or "due by tomorrow"
    if (/\bdue\s+(?:by\s+)?tomorrow\b/i.test(message)) {
        const d = new Date();
        d.setDate(d.getDate() + 1);
        return d.toISOString().slice(0, 10);
    }
    // "due next week" or "due by next week"
    if (/\bdue\s+(?:by\s+)?next\s+week\b/i.test(message)) {
        const d = new Date();
        d.setDate(d.getDate() + 7);
        return d.toISOString().slice(0, 10);
    }
    return undefined;
}
function extractName(message) {
    // Quoted strings
    const quoted = message.match(/"([^"]+)"|'([^']+)'/);
    if (quoted)
        return quoted[1] ?? quoted[2];
    // "of/about/called/named [optional type word] Name"
    const namedMatch = message.match(/(?:of|about|called|named|for)\s+(?:project|contact|person|organization|todo|procedure|deadline|event|report|plan)?\s*([A-Z][A-Za-z0-9_-]+(?:\s+[A-Z][A-Za-z0-9_-]+)*)/);
    if (namedMatch)
        return namedMatch[1].replace(/[?.!,;:]+$/, '');
    // "who is [Name]" pattern
    const whoIsMatch = message.match(/\bwho\s+is\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*)/);
    if (whoIsMatch)
        return whoIsMatch[1].replace(/[?.!,;:]+$/, '');
    // "find [Name]" pattern (capitalized)
    const findMatch = message.match(/\bfind\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*)/);
    if (findMatch)
        return findMatch[1].replace(/[?.!,;:]+$/, '');
    return undefined;
}
// --- Skill detection ---
function detectSkill(message) {
    // If the message describes multiple sequential steps, don't short-circuit to a single skill —
    // let the complexity check route it to the planner for decomposition.
    if (MULTI_STEP_LANGUAGE.test(message))
        return null;
    // Bash runner detection — before file patterns to avoid overlap
    if (matchesAny(message, RUN_BASH_PATTERNS)) {
        // Extract command: text after keyword "command/cmd/bash/execute", or after "run " for direct commands
        const cmdMatch = message.match(/(?:command|cmd|bash|execute(?:\s+the\s+command)?)\s+(.+)/i) ??
            message.match(/\brun\s+(.+?)(?:\s+and\s+(?:tell|show|report)\s+me\b|$)/i);
        const command = cmdMatch
            ? cmdMatch[1].replace(/\bin\s+the\s+workspace\b.*/i, '').trim()
            : message.trim();
        return { skill: 'run_bash', skillInput: { command } };
    }
    // Web search detection — highest priority among skills (replaces old web_search intent)
    if (matchesAny(message, WEB_SEARCH_PATTERNS)) {
        const query = extractSearchQuery(message);
        return { skill: 'web_search', skillInput: { query } };
    }
    // File writer detection — before file_reader to avoid overlap on "write...file" phrases
    if (matchesAny(message, FILE_WRITER_PATTERNS)) {
        // Extract the filename from the message
        const fileNameMatch = message.match(/\b([\w.\-/]+\.\w+)\b/);
        const filePath = fileNameMatch ? fileNameMatch[1] : 'output.txt';
        // Extract content hint (everything after "with content" or similar)
        const contentMatch = message.match(/(?:with\s+(?:content|text)\s+)(.+)$/i);
        const content = contentMatch ? contentMatch[1].trim() : '';
        return { skill: 'file_writer', skillInput: { path: filePath, content } };
    }
    // File reader detection — before calculator to avoid path numbers matching math
    if (matchesAny(message, FILE_READER_PATTERNS)) {
        const filePath = extractFilePath(message);
        if (filePath) {
            return { skill: 'file_reader', skillInput: { path: filePath } };
        }
    }
    // Calculator detection
    if (matchesAny(message, CALCULATOR_PATTERNS)) {
        const expression = extractMathExpression(message);
        if (expression) {
            return { skill: 'calculator', skillInput: { expression } };
        }
    }
    return null;
}
function extractMathExpression(message) {
    // "X percent of Y" → "X / 100 * Y"
    const percentOf = message.match(/(\d+(?:\.\d+)?)\s+percent\s+of\s+(\d+(?:\.\d+)?)/i);
    if (percentOf)
        return `${percentOf[1]} / 100 * ${percentOf[2]}`;
    // "X% of Y" → "X / 100 * Y"
    const pctMatch = message.match(/(\d+(?:\.\d+)?)\s*%\s*of\s*(\d+(?:\.\d+)?)/i);
    if (pctMatch)
        return `${pctMatch[1]} / 100 * ${pctMatch[2]}`;
    // "what is X divided by Y" → "X / Y" (check word-form FIRST, most specific)
    const wordMath = message.match(/(?:(?:what|how\s+much)\s+is\s+)?(\d+(?:\.\d+)?)\s+(plus|minus|times|divided\s+by|multiplied\s+by)\s+(\d+(?:\.\d+)?)/i);
    if (wordMath) {
        const ops = {
            'plus': '+', 'minus': '-', 'times': '*',
            'divided by': '/', 'multiplied by': '*',
        };
        const op = ops[wordMath[2].toLowerCase()] ?? wordMath[2];
        return `${wordMath[1]} ${op} ${wordMath[3]}`;
    }
    // "square root of X"
    const sqrtMatch = message.match(/square\s+root\s+of\s+(\d+(?:\.\d+)?)/i);
    if (sqrtMatch)
        return `sqrt(${sqrtMatch[1]})`;
    // "calculate X" or "compute X"
    const calcMatch = message.match(/(?:calculate|compute)\s+(.+)/i);
    if (calcMatch)
        return calcMatch[1].trim();
    // Direct math expression with explicit operator: "2 + 2", "144 / 12"
    const directMath = message.match(/(\d+(?:\.\d+)?\s*[\+\-\*\/\^%]\s*\d+(?:\.\d+)?(?:\s*[\+\-\*\/\^%]\s*\d+(?:\.\d+)?)*)/);
    if (directMath)
        return directMath[1].trim();
    return null;
}
function extractFilePath(message) {
    // Absolute path
    const absPath = message.match(/(\/[\w.\-/]+)/);
    if (absPath)
        return absPath[1];
    // Relative path with extension (strip surrounding quotes)
    const relPath = message.match(/["']?([\w.\-/]+\.\w+)["']?/);
    if (relPath)
        return relPath[1];
    return null;
}
function extractSearchQuery(message) {
    // Strip politeness prefix: "can you", "please", "could you", etc.
    let query = message.replace(/^(can\s+you|could\s+you|would\s+you|please|can\s+i|could\s+i)\s+/i, '');
    // Strip search trigger phrases, keep the rest as query
    query = query
        // "search internet for X" or "search web for X" → "X"
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
    // If query is empty after stripping, try to get anything after "news" keyword
    if (!query && message.match(/latest\s+news/i)) {
        const newsMatch = message.match(/(?:latest\s+news\s+(?:on|about)?\s*)?([^?!.]+?)(?:\?|!|\.|$)/i);
        query = newsMatch ? newsMatch[1].trim() : message.trim();
    }
    return query || message.trim();
}
// Expose getSkillDescriptions for external use (e.g., tests verifying registry awareness)
export { getSkillDescriptions };
export function classifyIntent(message) {
    const codes = extractCodes(message);
    let relation = extractRelation(message);
    const status = extractStatus(message);
    const name = extractName(message);
    const due_date = extractDueDate(message);
    let intent;
    let nb;
    let type;
    let skill;
    let skillInput;
    // Priority 0: Natural language ownership without explicit codes
    const naturalRelation = extractRelation(message);
    const subjectIsUser = /\b(i|me|my|erfan|tari)\b/i.test(message);
    const hasRelationVerb = naturalRelation !== undefined;
    if (hasRelationVerb && subjectIsUser && !matchesAny(message, WRITE_PATTERNS)) {
        intent = 'relationship_write';
        relation = naturalRelation;
        const detected = detectNotebook(message);
        nb = detected.nb;
        type = detected.type;
    }
    // Priority 1: Contains a valid code
    else if (codes.length > 0 && relation) {
        intent = 'relationship_query';
        const detected = detectNotebook(message);
        nb = detected.nb;
        type = detected.type;
    }
    else if (codes.length > 0 && !matchesAny(message, WRITE_PATTERNS)) {
        intent = 'code_fetch';
        const detected = detectNotebook(message);
        nb = detected.nb;
        type = detected.type;
    }
    // Priority 2: Greeting — only if no codes AND no write intent follows
    // e.g. "Hey, add a contact for Reza" must NOT be classified as greeting
    else if (GREETING_REGEX.test(message) && codes.length === 0 && !matchesAny(message, WRITE_PATTERNS)) {
        intent = 'greeting';
    }
    // Priority 3: Write patterns — but NOT if this is a web/file action task or explicit file write
    else if (matchesAny(message, WRITE_PATTERNS) && !matchesAny(message, WEB_FILE_ACTION_PATTERNS) && !matchesAny(message, FILE_WRITER_PATTERNS)) {
        intent = 'memory_write';
        const detected = detectNotebook(message);
        nb = detected.nb;
        type = detected.type;
    }
    // Priority 3b: Synthesis query — cross-notebook read+generate+save tasks
    // Checked after write patterns so "save" doesn't short-circuit to memory_write
    else if (matchesAny(message, SYNTHESIS_PATTERNS)) {
        intent = 'synthesis_query';
        // nb intentionally undefined — reads all notebooks
    }
    // Priority 4: Skill detection (web_search, calculator, file_reader)
    // Checked BEFORE notebook patterns — same priority position web_search had before
    else {
        const skillMatch = detectSkill(message);
        if (skillMatch) {
            intent = 'skill';
            skill = skillMatch.skill;
            skillInput = skillMatch.skillInput;
        }
        else {
            // Priority 5: Notebook-specific read patterns
            const detected = detectNotebook(message);
            nb = detected.nb;
            type = detected.type;
            if (nb || type || status || name) {
                intent = 'memory_query';
            }
            else {
                intent = 'general';
            }
        }
    }
    return { intent, codes, nb, type, status, name, relation, skill, skillInput, due_date };
}
