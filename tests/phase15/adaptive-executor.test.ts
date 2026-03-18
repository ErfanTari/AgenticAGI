import { describe, it, expect } from 'vitest';
import {
  classifyFailureResponse,
  classifyFailure,
  type StepFailure,
  type SubGoalAttempt,
  type FailureResponse,
} from '../../core/executor.js';

function makeFailure(overrides: Partial<StepFailure> = {}): StepFailure {
  return {
    stepId: 'step-1',
    skill: 'run_bash',
    error: 'Generic error',
    attempt: 1,
    ...overrides,
  };
}

function makeAttempts(stepRetries = 0, milestoneRevisions = 0): Map<string, SubGoalAttempt> {
  const map = new Map<string, SubGoalAttempt>();
  map.set('step-1', { milestoneId: 'milestone-1', retries: stepRetries, revisions: 0 });
  map.set('milestone-1', { milestoneId: 'milestone-1', retries: 0, revisions: milestoneRevisions });
  return map;
}

describe('Phase 15: Adaptive Executor — classifyFailureResponse()', () => {
  it('returns RETRY for a syntax error on first attempt', () => {
    const failure = makeFailure({ error: 'SyntaxError: unexpected token' });
    const result = classifyFailureResponse(failure, { goal: 'test' }, makeAttempts(0, 0));
    expect(result).toBe('RETRY');
  });

  it('returns RETRY for a state error on first attempt', () => {
    const failure = makeFailure({ error: 'File not found' });
    const result = classifyFailureResponse(failure, { goal: 'test' }, makeAttempts(0, 0));
    expect(result).toBe('RETRY');
  });

  it('returns REVISE for a capability error', () => {
    const failure = makeFailure({ error: 'cannot complete this operation' });
    const result = classifyFailureResponse(failure, { goal: 'test' }, makeAttempts(0, 0));
    expect(result).toBe('REVISE');
  });

  it('returns REVISE when retries are exhausted (>= 2)', () => {
    const failure = makeFailure({ error: 'connection refused' });
    const result = classifyFailureResponse(failure, { goal: 'test' }, makeAttempts(2, 0));
    expect(result).toBe('REVISE');
  });

  it('returns ESCALATE when revisions are exhausted (>= 3)', () => {
    const failure = makeFailure({ error: 'cannot complete this operation', milestoneId: 'milestone-1' });
    const result = classifyFailureResponse(failure, { goal: 'test' }, makeAttempts(2, 3));
    expect(result).toBe('ESCALATE');
  });

  it('returns ESCALATE when both retries and revisions exhausted', () => {
    const failure = makeFailure({ error: 'fatal error', milestoneId: 'milestone-1' });
    const result = classifyFailureResponse(failure, { goal: 'test' }, makeAttempts(5, 5));
    expect(result).toBe('ESCALATE');
  });

  it('handles null workingMemory gracefully', () => {
    const failure = makeFailure({ error: 'SyntaxError: parse failed' });
    const result = classifyFailureResponse(failure, null, makeAttempts(0, 0));
    expect(result).toBe('RETRY');
  });

  it('classifyFailure correctly identifies SYNTAX_ERROR', () => {
    expect(classifyFailure('SyntaxError: unexpected token')).toBe('SYNTAX_ERROR');
    expect(classifyFailure('invalid JSON response')).toBe('SYNTAX_ERROR');
    expect(classifyFailure('parse error on line 3')).toBe('SYNTAX_ERROR');
  });

  it('classifyFailure correctly identifies STATE_ERROR', () => {
    expect(classifyFailure('file not found')).toBe('STATE_ERROR');
    expect(classifyFailure('entry does not exist')).toBe('STATE_ERROR');
    expect(classifyFailure('missing required field')).toBe('STATE_ERROR');
  });

  it('classifyFailure defaults to CAPABILITY_ERROR', () => {
    expect(classifyFailure('network timeout exceeded')).toBe('CAPABILITY_ERROR');
    expect(classifyFailure('permission denied for operation')).toBe('CAPABILITY_ERROR');
  });
});
