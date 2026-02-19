import fs from 'node:fs';
import { getEntryByCode } from './index.js';
import type { FetchResult } from './types.js';

export function fetchByCode(code: string): FetchResult | undefined {
  const entry = getEntryByCode(code);
  if (!entry) return undefined;

  if (!fs.existsSync(entry.path)) {
    console.warn(`Integrity warning: file missing for ${code} at ${entry.path}`);
    return undefined;
  }

  const content = fs.readFileSync(entry.path, 'utf-8');
  return { entry, content };
}
