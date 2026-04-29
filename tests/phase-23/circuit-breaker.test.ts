import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { transparency } from '../../core/transparency.js';
import {
  checkCircuitBreaker, recordCallFailure, recordCallSuccess, notifyRequestEnd,
} from '../../core/skills/circuit-breaker.js';

beforeEach(() => transparency.enable());
afterEach(() => transparency.disable());

const REQ = 'test-cb-req';
const SKILL = 'run_bash';
const ARGS = { command: 'curl https://example.com', description: 'test' };

afterEach(() => notifyRequestEnd(REQ));

describe('circuit-breaker', () => {
  it('first failure: not tripped', () => {
    recordCallFailure(REQ, SKILL, ARGS);
    const result = checkCircuitBreaker(REQ, SKILL, ARGS);
    expect(result.tripped).toBe(false);
  });

  it('second consecutive failure same args: tripped + transparency event emitted', () => {
    const events: unknown[] = [];
    const unsub = transparency.on(e => {
      if (e.type === 'circuit_breaker_tripped') events.push(e.data);
    });

    recordCallFailure(REQ, SKILL, ARGS);
    recordCallFailure(REQ, SKILL, ARGS);
    const result = checkCircuitBreaker(REQ, SKILL, ARGS);
    unsub();

    expect(result.tripped).toBe(true);
    expect(result.reason).toContain('run_bash');
    expect(events).toHaveLength(1);
  });

  it('failure → success → failure: success clears state, not tripped', () => {
    recordCallFailure(REQ, SKILL, ARGS);
    recordCallSuccess(REQ, SKILL, ARGS);
    recordCallFailure(REQ, SKILL, ARGS);
    const result = checkCircuitBreaker(REQ, SKILL, ARGS);
    expect(result.tripped).toBe(false);
  });

  it('different args tracked separately, neither trips alone', () => {
    const args2 = { command: 'curl https://other.com', description: 'other' };
    recordCallFailure(REQ, SKILL, ARGS);
    recordCallFailure(REQ, SKILL, args2);
    expect(checkCircuitBreaker(REQ, SKILL, ARGS).tripped).toBe(false);
    expect(checkCircuitBreaker(REQ, SKILL, args2).tripped).toBe(false);
  });

  it('notifyRequestEnd: prior failures forgotten', () => {
    recordCallFailure(REQ, SKILL, ARGS);
    recordCallFailure(REQ, SKILL, ARGS);
    notifyRequestEnd(REQ);
    const result = checkCircuitBreaker(REQ, SKILL, ARGS);
    expect(result.tripped).toBe(false);
  });
});
