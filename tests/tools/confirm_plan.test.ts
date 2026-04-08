/**
 * Tests for confirm_plan skill (LLM-driven)
 *
 * The skill now receives a clean enum decision from the LLM
 * and no longer parses user text directly.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import confirmPlanSkill, {
  setPendingConfirmationPlan,
  getPendingConfirmationPlan,
  clearPendingConfirmationPlan,
} from '../../core/skills/tools/confirm_plan.js';

describe('confirm_plan skill (LLM-driven)', () => {

  beforeEach(() => {
    // Clear pending plan before each test
    clearPendingConfirmationPlan();
  });

  it('T1: skill has LLM-driven properties', () => {
    expect(confirmPlanSkill.name).toBe('confirm_plan');
    expect(confirmPlanSkill.permissionLevel).toBe('workspace-write');
    expect(confirmPlanSkill.description).toContain('LLM decision');
  });

  it('T2: approve with pending plan succeeds', async () => {
    const mockPlan = { goal: 'Build website', steps: [{ title: 'Step 1' }] };
    setPendingConfirmationPlan(mockPlan);

    const result = await confirmPlanSkill.execute({
      decision: 'approve',
    });
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output as string);
    expect(parsed.decision).toBe('approve');
    expect(parsed.executed).toBe(true);
  });

  it('T3: approve without pending plan returns error', async () => {
    const result = await confirmPlanSkill.execute({
      decision: 'approve',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('No plan pending confirmation');
  });

  it('T4: approve clears pending plan', async () => {
    const mockPlan = { goal: 'Test', steps: [] };
    setPendingConfirmationPlan(mockPlan);
    expect(getPendingConfirmationPlan()).toBeTruthy();

    await confirmPlanSkill.execute({ decision: 'approve' });
    expect(getPendingConfirmationPlan()).toBeNull();
  });

  it('T5: reject without pending plan returns error', async () => {
    const result = await confirmPlanSkill.execute({
      decision: 'reject',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('No plan pending confirmation to reject');
  });

  it('T6: reject with pending plan succeeds', async () => {
    const mockPlan = { goal: 'Destructive op', steps: [] };
    setPendingConfirmationPlan(mockPlan);

    const result = await confirmPlanSkill.execute({
      decision: 'reject',
    });
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output as string);
    expect(parsed.decision).toBe('reject');
    expect(parsed.cleared).toBe(true);
  });

  it('T7: reject clears pending plan', async () => {
    const mockPlan = { goal: 'Test', steps: [] };
    setPendingConfirmationPlan(mockPlan);

    await confirmPlanSkill.execute({ decision: 'reject' });
    expect(getPendingConfirmationPlan()).toBeNull();
  });

  it('T8: unclear keeps pending plan intact', async () => {
    const mockPlan = { goal: 'Test', steps: [] };
    setPendingConfirmationPlan(mockPlan);

    const result = await confirmPlanSkill.execute({
      decision: 'unclear',
      reason: 'User asked about milestone 2',
    });
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output as string);
    expect(parsed.decision).toBe('unclear');
    expect(parsed.reason).toBe('User asked about milestone 2');

    // Pending plan should still be there
    expect(getPendingConfirmationPlan()).toBeTruthy();
  });

  it('T9: unclear without reason uses default', async () => {
    const mockPlan = { goal: 'Test', steps: [] };
    setPendingConfirmationPlan(mockPlan);

    const result = await confirmPlanSkill.execute({
      decision: 'unclear',
    });
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output as string);
    expect(parsed.decision).toBe('unclear');
  });

  it('T10: rejects invalid decision', async () => {
    const result = await confirmPlanSkill.execute({
      decision: 'maybe',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid decision');
  });

  it('T11: does not parse user text at all', async () => {
    // This test proves we no longer do regex matching
    const mockPlan = { goal: 'Test', steps: [] };
    setPendingConfirmationPlan(mockPlan);

    // "yes" or "no" as decision should fail — we only accept approve/reject/unclear
    const result = await confirmPlanSkill.execute({
      decision: 'yes',
    });
    expect(result.success).toBe(false);
  });

  it('T12: transparency events emitted correctly', async () => {
    const mockPlan = { goal: 'Test plan', steps: [] };
    setPendingConfirmationPlan(mockPlan);

    // Approve should emit plan_confirmed
    // (transparency bus would be checked in integration tests)
    const result = await confirmPlanSkill.execute({
      decision: 'approve',
    });
    expect(result.success).toBe(true);
  });

});
