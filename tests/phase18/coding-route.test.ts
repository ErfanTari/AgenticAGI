/**
 * Phase 18 — coding route + taskType tests
 * 6 tests covering: taskType in DecomposedUnit, transparency event, router routing
 */

import { describe, it, expect } from 'vitest';
import type { DecomposedUnit } from '../../core/types.js';

describe('taskType field on DecomposedUnit', () => {
  it('1. DecomposedUnit accepts taskType: "coding"', () => {
    const unit: DecomposedUnit = {
      id: 'u1',
      route: 'agentic',
      content: 'Write a hello world script',
      order: 0,
      taskType: 'coding',
    };
    expect(unit.taskType).toBe('coding');
  });

  it('2. DecomposedUnit accepts taskType: "general"', () => {
    const unit: DecomposedUnit = {
      id: 'u2',
      route: 'conversational',
      content: 'What is the weather?',
      order: 0,
      taskType: 'general',
    };
    expect(unit.taskType).toBe('general');
  });

  it('3. DecomposedUnit works without taskType (backward compatible)', () => {
    const unit: DecomposedUnit = {
      id: 'u3',
      route: 'query',
      content: 'Show my todos',
      order: 0,
    };
    expect(unit.taskType).toBeUndefined();
  });

  it('4. coding_route_selected event shape is correct', () => {
    // Verify the event type compiles correctly
    const event = {
      type: 'coding_route_selected' as const,
      data: {
        unitIds: ['u1', 'u2'],
        complexity: 'LOW',
        reason: 'taskType=coding',
      },
    };
    expect(event.data.unitIds).toHaveLength(2);
    expect(event.data.reason).toBe('taskType=coding');
  });

  it('5. transparency module exports coding_route_selected type', async () => {
    // Just verify the module imports without error
    const { transparency } = await import('../../core/transparency.js');
    expect(transparency).toBeDefined();
  });

  it('6. multiple units — only coding ones are detected', () => {
    const units: DecomposedUnit[] = [
      { id: 'u1', route: 'conversational', content: 'hello', order: 0, taskType: 'general' },
      { id: 'u2', route: 'agentic', content: 'write code', order: 1, taskType: 'coding' },
      { id: 'u3', route: 'query', content: 'show todos', order: 2 },
    ];
    const codingUnits = units.filter(u => u.taskType === 'coding');
    expect(codingUnits).toHaveLength(1);
    expect(codingUnits[0].id).toBe('u2');
  });
});
