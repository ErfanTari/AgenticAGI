import { resolveTypeKey } from '../../config/agent.config.js';
import { getMaxNumber } from './index.js';

const CODE_REGEX = /^([A-Z]+)\.([A-Z]+)-(\d{4,})$/;

export function parseCode(code: string): { nb: string; type: string; number: number } | undefined {
  const match = code.match(CODE_REGEX);
  if (!match) return undefined;
  return { nb: match[1], type: match[2], number: parseInt(match[3], 10) };
}

export function generateCode(nb: string, type: string): string {
  const key = resolveTypeKey(nb, type);
  if (!key) throw new Error(`Invalid notebook+type: ${nb}.${type}`);

  const maxNum = getMaxNumber(nb, type);
  const next = maxNum + 1;
  const padded = String(next).padStart(4, '0');
  return `${nb}.${type}-${padded}`;
}
