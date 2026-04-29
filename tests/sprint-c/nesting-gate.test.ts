import { describe, it, expect, afterEach } from 'vitest';
import {
  assertNotNested, setNestingFlag, clearNestingFlag, isNested, NestingViolationError,
} from '../../core/subagents/nesting-gate.js';

afterEach(() => {
  clearNestingFlag();
});

describe('nesting-gate', () => {
  it('assertNotNested passes when not inside a sub-agent', () => {
    expect(() => assertNotNested()).not.toThrow();
  });

  it('assertNotNested throws NestingViolationError when flag is set', () => {
    setNestingFlag();
    expect(() => assertNotNested()).toThrow(NestingViolationError);
  });

  it('clearNestingFlag allows assertNotNested to pass again', () => {
    setNestingFlag();
    clearNestingFlag();
    expect(() => assertNotNested()).not.toThrow();
  });

  it('isNested reflects flag state', () => {
    expect(isNested()).toBe(false);
    setNestingFlag();
    expect(isNested()).toBe(true);
    clearNestingFlag();
    expect(isNested()).toBe(false);
  });
});
