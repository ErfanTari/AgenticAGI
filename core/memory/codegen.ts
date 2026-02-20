import { resolveTypeKey } from '../../config/agent.config.js';
import { nextCounter } from './index.js';

const CODE_REGEX = /^([A-Z]+)\.([A-Z]+)-(\d{6,})$/;

export function parseCode(code: string): { nb: string; type: string; number: number } | undefined {
  const match = code.match(CODE_REGEX);
  if (!match) return undefined;
  return { nb: match[1], type: match[2], number: parseInt(match[3], 10) };
}

export function generateCode(nb: string, type: string): string {
  const key = resolveTypeKey(nb, type);
  if (!key) throw new Error(`Invalid notebook+type: ${nb}.${type}`);

  const next = nextCounter(key);
  const padded = String(next).padStart(6, '0');
  return `${nb}.${type}-${padded}`;
}
