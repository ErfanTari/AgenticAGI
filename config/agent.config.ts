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
