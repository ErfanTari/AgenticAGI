import { describe, it, expect } from 'vitest';
import { classifyIntent } from '../../core/intent.js';

describe('phase11 intent validity checks', () => {
  it('routes create-app-in-folder prompt to planned_workflow (not memory_write)', () => {
    const res = classifyIntent('create a calculator app and put it in a folder named X in your working space');
    expect(res.intent).toBe('planned_workflow');
  });

  it('routes create-software prompt to planned_workflow (not memory_write)', () => {
    const res = classifyIntent('create a software that does math');
    expect(res.intent).toBe('planned_workflow');
  });

  it('keeps explicit memory writes as memory_write', () => {
    const res = classifyIntent('remember that I need to buy milk tomorrow');
    expect(res.intent).toBe('memory_write');
  });

  it('keeps assistant identity questions as general', () => {
    const res = classifyIntent('what should i refer to you as');
    expect(res.intent).toBe('general');
  });

  it('avoids false memory_query for generic how-to question', () => {
    const res = classifyIntent('how do i jump start my vehicle');
    expect(res.intent).toBe('general');
  });

  it('routes todo retrieval to memory_query', () => {
    const res = classifyIntent('show me my todo list');
    expect(res.intent).toBe('memory_query');
  });

  it('routes write-weekly-status prompt to synthesis_query (not memory_write)', () => {
    const res = classifyIntent('write a weekly status report based on everything you know');
    expect(res.intent).toBe('synthesis_query');
  });
});
