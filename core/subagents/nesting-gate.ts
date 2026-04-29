const NESTING_FLAG = 'ZARABAN_INSIDE_SUBAGENT';

export class NestingViolationError extends Error {
  constructor() {
    super('Sub-agent nesting depth exceeded (cap: 1). Sub-agents cannot spawn sub-agents.');
  }
}

export function assertNotNested(): void {
  if (process.env[NESTING_FLAG] === '1') throw new NestingViolationError();
}

export function setNestingFlag(): void {
  process.env[NESTING_FLAG] = '1';
}

export function clearNestingFlag(): void {
  delete process.env[NESTING_FLAG];
}

export function isNested(): boolean {
  return process.env[NESTING_FLAG] === '1';
}
