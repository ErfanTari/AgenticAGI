import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { transparency } from '../../core/transparency.js';
import { withRequestId } from '../../core/transparency.js';
import { tryJsonRepair } from '../../core/llm-helpers/json-repair.js';

beforeEach(() => transparency.enable());
afterEach(() => transparency.disable());

function inRequest<T>(fn: () => T): T {
  return withRequestId(fn, 'test-req-1');
}

describe('tryJsonRepair — Layer 2', () => {
  it('already-valid JSON: passes through, bytesChanged 0', () => {
    const result = inRequest(() => tryJsonRepair('{"a":1,"b":"hello"}'));
    expect(result.repaired).toBe(true);
    if (result.repaired) {
      expect(result.bytesChanged).toBe(0);
      expect((result.value as Record<string, unknown>).a).toBe(1);
    }
  });

  it('trailing comma: repaired', () => {
    const result = inRequest(() => tryJsonRepair('{"a":1,"b":2,}'));
    expect(result.repaired).toBe(true);
  });

  it('unquoted keys: repaired', () => {
    const result = inRequest(() => tryJsonRepair('{level: "MEDIUM", reason: "ok"}'));
    expect(result.repaired).toBe(true);
    if (result.repaired) {
      expect((result.value as Record<string, unknown>).level).toBe('MEDIUM');
    }
  });

  it('single quotes: repaired', () => {
    const result = inRequest(() => tryJsonRepair("{'key': 'value'}"));
    expect(result.repaired).toBe(true);
    if (result.repaired) {
      expect((result.value as Record<string, unknown>).key).toBe('value');
    }
  });

  it('markdown fence wrapper: stripped and parsed', () => {
    const result = inRequest(() => tryJsonRepair('```json\n{"x":42}\n```'));
    expect(result.repaired).toBe(true);
    if (result.repaired) {
      expect((result.value as Record<string, unknown>).x).toBe(42);
    }
  });

  it('comment block: repaired (jsonrepair handles // comments)', () => {
    const result = inRequest(() => tryJsonRepair('{\n  // this is a comment\n  "a": 1\n}'));
    expect(result.repaired).toBe(true);
    if (result.repaired) {
      expect((result.value as Record<string, unknown>).a).toBe(1);
    }
  });

  it('truly broken (triple brace): returns repaired: false', () => {
    const result = inRequest(() => tryJsonRepair('{{{'));
    expect(result.repaired).toBe(false);
  });

  it('transparency event emitted on success with correct layer and bytesChanged', () => {
    const events: unknown[] = [];
    const unsub = transparency.on(e => {
      if (e.type === 'json_repair_succeeded') events.push(e.data);
    });

    inRequest(() => tryJsonRepair('{"a":1,}')); // trailing comma
    unsub();

    expect(events).toHaveLength(1);
    const evt = events[0] as Record<string, unknown>;
    expect(evt.layer).toBe(2);
    expect(typeof evt.bytesChanged).toBe('number');
  });
});
