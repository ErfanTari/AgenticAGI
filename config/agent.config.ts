import dotenv from 'dotenv';
if (!process.env.VITEST) dotenv.config();
// loads .env from project root before anything else (skipped in tests)
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

export const PATHS = {
  root: ROOT,
  memory: path.join(ROOT, 'memory'),
  index: path.join(ROOT, 'index'),
  db: path.join(ROOT, 'index', 'memory.sqlite'),
} as const;

export const TYPE_MAP = {
  'WHO.CT':   { notebook: 'WHO',  type: 'CT',  meaning: 'Contact',         subfolder: 'WHO/contacts' },
  'WHO.ORG':  { notebook: 'WHO',  type: 'ORG', meaning: 'Organization',    subfolder: 'WHO/contacts' },
  'WHAT.PJ':  { notebook: 'WHAT', type: 'PJ',  meaning: 'Project',         subfolder: 'WHAT/projects' },
  'WHAT.KN':  { notebook: 'WHAT', type: 'KN',  meaning: 'Knowledge entry', subfolder: 'WHAT/knowledge' },
  'WHEN.CA':  { notebook: 'WHEN', type: 'CA',  meaning: 'Calendar event',  subfolder: 'WHEN/calendar' },
  'WHEN.DL':  { notebook: 'WHEN', type: 'DL',  meaning: 'Deadline',        subfolder: 'WHEN/deadlines' },
  'HOW.PR':   { notebook: 'HOW',  type: 'PR',  meaning: 'Procedure',       subfolder: 'HOW/procedures' },
  'WHY.MT':   { notebook: 'WHY',  type: 'MT',  meaning: 'Meta reflection', subfolder: 'WHY/meta' },
  'WHY.QU':   { notebook: 'WHY',  type: 'QU',  meaning: 'Open question',   subfolder: 'WHY/questions' },
  'NOW.TD':   { notebook: 'NOW',  type: 'TD',  meaning: 'Todo item',       subfolder: 'NOW/todos' },
  'NOW.RP':   { notebook: 'NOW',  type: 'RP',  meaning: 'Report',          subfolder: 'NOW/reports' },
  'PLAN.PL':  { notebook: 'PLAN', type: 'PL',  meaning: 'Planning entry',  subfolder: 'PLAN/planning' },
} as const;

export type NotebookType = keyof typeof TYPE_MAP;
export type Notebook = typeof TYPE_MAP[NotebookType]['notebook'];
export type TypeCode = typeof TYPE_MAP[NotebookType]['type'];

export function resolveTypeKey(nb: string, type: string): NotebookType | undefined {
  const key = `${nb}.${type}` as NotebookType;
  return key in TYPE_MAP ? key : undefined;
}

function getTimeoutForModel(modelName: string): number {
  const lower = modelName.toLowerCase();
  if (/pro/.test(lower)) return 90000;
  if (/flash-lite|nano/.test(lower)) return 10000;
  if (/flash/.test(lower)) return 20000;
  return 20000;
}

const _geminiModel = process.env.GEMINI_MODEL ?? 'gemini-2.0-flash';

export const GEMINI_CONFIG = {
  apiKey: process.env.GEMINI_API_KEY ?? '',
  endpoint: process.env.GEMINI_ENDPOINT ?? 'https://generativelanguage.googleapis.com/v1beta',
  model: _geminiModel,
  maxTokens: Number(process.env.LLM_MAX_TOKENS ?? '512'),
  temperature: Number(process.env.LLM_TEMPERATURE ?? '0.3'),
  timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? String(getTimeoutForModel(_geminiModel))),
};

export const EMBEDDING_TIMEOUT_MS = 10000;

export const AUTONOMY_CONFIG = {
  enabled: String(process.env.AUTONOMY_ENABLED ?? 'false').toLowerCase() === 'true',
  intervalMs: Number(process.env.AUTONOMY_INTERVAL_MS ?? '45000'),
  maxTasksPerCycle: Number(process.env.AUTONOMY_MAX_TASKS ?? '2'),
  maxAttemptsPerTask: Number(process.env.AUTONOMY_MAX_ATTEMPTS ?? '4'),
};

// --- LLM fallback (optional) ---
export const LLM_FALLBACK_CONFIG = process.env.LLM_FALLBACK_PROVIDER
  ? {
      provider: process.env.LLM_FALLBACK_PROVIDER,
      model: process.env.LLM_FALLBACK_MODEL ?? '',
      apiKey: process.env.ANTHROPIC_API_KEY ?? '',
      endpoint: process.env.ANTHROPIC_ENDPOINT
        ?? 'https://api.anthropic.com/v1/messages',
    }
  : null;

// --- Embedding (Step 5 search only) ---
export const EMBEDDING_CONFIG = process.env.EMBEDDING_ENDPOINT
  ? {
      endpoint: process.env.EMBEDDING_ENDPOINT,
      model: process.env.EMBEDDING_MODEL ?? '',
      dimensions: Number(process.env.EMBEDDING_DIMENSIONS ?? '768'),
    }
  : null;
