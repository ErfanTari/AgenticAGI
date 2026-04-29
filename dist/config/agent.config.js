import dotenv from 'dotenv';
if (!process.env.VITEST)
    dotenv.config();
// loads .env from project root before anything else (skipped in tests)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Walk up from __dirname until we find a directory containing package.json.
// This ensures ROOT is always the real project root regardless of whether
// we're running from source (config/), dist/config/, or .ui-runtime/config/.
function findProjectRoot(startDir) {
    let current = startDir;
    for (let i = 0; i < 8; i++) {
        if (fs.existsSync(path.join(current, 'package.json')))
            return current;
        const parent = path.dirname(current);
        if (parent === current)
            break;
        current = parent;
    }
    // Fallback: preserve previous behaviour for single-level layouts.
    return path.resolve(startDir, '..');
}
const ROOT = findProjectRoot(__dirname);
export const PATHS = {
    root: ROOT,
    memory: path.join(ROOT, 'memory'),
    index: path.join(ROOT, 'index'),
    db: path.join(ROOT, 'index', 'memory.sqlite'),
    workspace: path.join(ROOT, 'workspace'),
    logs: path.join(ROOT, 'workspace', 'logs'),
    projects: path.join(ROOT, 'workspace', 'projects'),
};
export const TYPE_MAP = {
    'WHO.CT': { notebook: 'WHO', type: 'CT', meaning: 'Contact', subfolder: 'WHO/contacts' },
    'WHO.ORG': { notebook: 'WHO', type: 'ORG', meaning: 'Organization', subfolder: 'WHO/contacts' },
    'WHAT.PJ': { notebook: 'WHAT', type: 'PJ', meaning: 'Project', subfolder: 'WHAT/projects' },
    'WHAT.KN': { notebook: 'WHAT', type: 'KN', meaning: 'Knowledge entry', subfolder: 'WHAT/knowledge' },
    'WHEN.CA': { notebook: 'WHEN', type: 'CA', meaning: 'Calendar event', subfolder: 'WHEN/calendar' },
    'WHEN.DL': { notebook: 'WHEN', type: 'DL', meaning: 'Deadline', subfolder: 'WHEN/deadlines' },
    'WHEN.EV': { notebook: 'WHEN', type: 'EV', meaning: 'Episodic event', subfolder: 'WHEN/events' },
    'WHEN.RF': { notebook: 'WHEN', type: 'RF', meaning: 'Reflection', subfolder: 'WHEN/reflections' },
    'WHEN.HX': { notebook: 'WHEN', type: 'HX', meaning: 'History entry', subfolder: 'WHEN/history' },
    'HOW.PR': { notebook: 'HOW', type: 'PR', meaning: 'Procedure', subfolder: 'HOW/procedures' },
    'HOW.SK': { notebook: 'HOW', type: 'SK', meaning: 'Skill entry', subfolder: 'HOW/skills' },
    'WHY.MT': { notebook: 'WHY', type: 'MT', meaning: 'Meta reflection', subfolder: 'WHY/meta' },
    'WHY.QU': { notebook: 'WHY', type: 'QU', meaning: 'Open question', subfolder: 'WHY/questions' },
    'NOW.TD': { notebook: 'NOW', type: 'TD', meaning: 'Todo item', subfolder: 'NOW/todos' },
    'NOW.RP': { notebook: 'NOW', type: 'RP', meaning: 'Report', subfolder: 'NOW/reports' },
    'NOW.LOG': { notebook: 'NOW', type: 'LOG', meaning: 'Log entry', subfolder: 'NOW/logs' },
    'PLAN.PL': { notebook: 'PLAN', type: 'PL', meaning: 'Planning entry', subfolder: 'PLAN/planning' },
    'PLAN.EX': { notebook: 'PLAN', type: 'EX', meaning: 'Execution state', subfolder: 'PLAN/execution' },
    'PLAN.CT': { notebook: 'PLAN', type: 'CT', meaning: 'Constraint', subfolder: 'PLAN/constraints' },
    'PLAN.MS': { notebook: 'PLAN', type: 'MS', meaning: 'Milestone', subfolder: 'PLAN/milestones' },
    'PLAN.PJ': { notebook: 'PLAN', type: 'PJ', meaning: 'Project brain', subfolder: 'PLAN/projects' },
};
export function resolveTypeKey(nb, type) {
    const key = `${nb}.${type}`;
    return key in TYPE_MAP ? key : undefined;
}
// --- LLM (primary) ---
function getTimeoutForModel(modelName) {
    const lower = modelName.toLowerCase();
    if (/72b|70b|80b|35b|32b|26b|20b/.test(lower))
        return 600000; // 10 minutes for large local models (generates up to ~4.5k tokens)
    if (/7b|8b|13b|14b/.test(lower))
        return 120000; // 2 minutes for medium models
    if (/1b|2b|3b|4b/.test(lower))
        return 60000; // 1 minute for small models
    return 120000;
}
const _llmModel = process.env.LLM_MODEL ?? '';
export const LLM_CONFIG = {
    endpoint: process.env.LLM_ENDPOINT ?? '',
    model: _llmModel,
    maxTokens: 16000,
    temperature: 0.3,
    timeoutMs: getTimeoutForModel(_llmModel),
};
// Extended timeout for LLM-based embeddings (inference can be slow)
// External APIs typically complete in 100-500ms, LLM inference takes 5-30s
export const EMBEDDING_TIMEOUT_MS = 45000;
// --- LLM (fallback) ---
// Supports multiple providers: anthropic, gemini
// API keys are provider-specific
export const LLM_FALLBACK_CONFIG = process.env.LLM_FALLBACK_PROVIDER
    ? {
        provider: process.env.LLM_FALLBACK_PROVIDER,
        model: process.env.LLM_FALLBACK_MODEL ?? '',
        apiKey: process.env.LLM_FALLBACK_PROVIDER === 'gemini'
            ? process.env.GEMINI_API_KEY ?? ''
            : process.env.ANTHROPIC_API_KEY ?? '',
        endpoint: process.env.LLM_FALLBACK_PROVIDER === 'gemini'
            ? 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
            : process.env.ANTHROPIC_ENDPOINT ?? 'https://api.anthropic.com/v1/messages',
    }
    : null;
// --- Anthropic cloud config (independent of fallback, selectable via UI) ---
export const ANTHROPIC_CLOUD_CONFIG = process.env.ANTHROPIC_API_KEY
    ? {
        provider: 'anthropic',
        model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6',
        apiKey: process.env.ANTHROPIC_API_KEY,
        endpoint: process.env.ANTHROPIC_ENDPOINT ?? 'https://api.anthropic.com/v1/messages',
    }
    : null;
// --- Known cloud models (used by UI dropdown) ---
export const KNOWN_CLOUD_MODELS = [
    { id: 'gemini', label: 'Gemini 2.5 Flash', provider: 'gemini' },
    { id: 'claude', label: 'Claude Sonnet 4.6', provider: 'anthropic' },
    { id: 'gemma-4-26b', label: 'Gemma 4 26B', provider: 'gemini' },
    { id: 'gemma-4-31b', label: 'Gemma 4 31B', provider: 'gemini' },
];
// --- Planner + Executor LLM configs ---
const _plannerModel = process.env.PLANNER_MODEL || _llmModel;
const _executorModel = process.env.EXECUTOR_MODEL || _llmModel;
export const PLANNER_CONFIG = {
    endpoint: process.env.LLM_ENDPOINT ?? '',
    model: _plannerModel,
    maxTokens: 8000,
    temperature: 0.2,
    timeoutMs: getTimeoutForModel(_plannerModel),
};
export const EXECUTOR_CONFIG = {
    endpoint: process.env.LLM_ENDPOINT ?? '',
    model: _executorModel,
    maxTokens: 8000,
    temperature: 0.3,
    timeoutMs: getTimeoutForModel(_executorModel),
};
// --- Token Budgets (Phase 18) ---
export const TOKEN_BUDGETS = {
    // Structural LLM calls (JSON output required)
    INTAKE: 600,
    INTAKE_TIMEOUT_MS: 120000, // Increased from 20s to allow local model time for JSON parsing
    DECOMPOSITION: 2000,
    PLANNER: 8192,
    MILESTONE_REVISION: 2000,
    POST_FLIGHT: 3000,
    QUERY_LOOP_ITER: 4096,
    QUERY_LOOP_NARRATE: 800,
    VERIFICATION: 1500,
    // Content generation (these are minimums — callers may request more)
    CONTENT_WRITER_HTML: 16000,
    CONTENT_WRITER_MARKDOWN: 8000,
    CONTENT_WRITER_PLAIN: 6000,
    CONTENT_WRITER_CODE: 8000,
    // File generation (generate_and_save_file direct LLM call)
    GENERATE_FILE_HTML: 16000,
    GENERATE_FILE_MARKDOWN: 8000,
    GENERATE_FILE_PLAIN: 6000,
    // Memory and background ops
    WORKING_MEMORY_SUMMARY: 800,
    RELATIONSHIP_INFER: 600,
};
/**
 * Per-engine hard input-token limits for prompt guardrails (Context Diet sprint, Batch 4).
 * If a built prompt exceeds its limit, a `prompt_budget_exceeded` transparency event fires.
 * These are soft warnings — execution is NOT blocked — but regression tests can assert on them.
 */
export const PROMPT_INPUT_LIMITS = {
    'query-loop': 8_000, // raised from 2500 — memory context (active loops, pointer index) adds 4-6k in practice
    'planner': 12_000, // planner.md alone was ~8,000; allow context headroom
    'decomposition': 3_000,
    'intake': 1_500,
    'router': 4_000,
};
// --- Embedding (Step 5 search only) ---
export const EMBEDDING_CONFIG = process.env.EMBEDDING_ENDPOINT
    ? {
        endpoint: process.env.EMBEDDING_ENDPOINT,
        model: process.env.EMBEDDING_MODEL ?? '',
        dimensions: Number(process.env.EMBEDDING_DIMENSIONS ?? '768'),
    }
    : null;
// Vision pipeline config (Sprint B)
export const VISION_CONFIG = {
    localModel: 'qwen/qwen3-vl-8b',
    cloudFallbackModel: 'gemini-2.5-flash',
    tileSize: 1072,
    maxImageBytes: 20_000_000, // 20 MB
    defaultMimeAllowlist: [
        'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml',
        'application/pdf',
        'text/plain', 'text/markdown', 'text/csv',
        'application/json',
        'application/zip',
    ],
};
