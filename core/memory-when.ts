/**
 * memoryWhen — declarative memory-read gate predicates (Context Diet sprint, Batch 2)
 *
 * Every site that reads memory declares WHY via a predicate here.
 * Each decision is logged as a transparency event.
 * If a gate opens without a matching signal, that is a bug.
 */

import type { IntakeSignals } from './intake.js';
import { transparency } from './transparency.js';
import { isMemoryFullyDisabled } from './memory-mode.js';

export const memoryWhen = {
  /**
   * Returns true if there is a non-null personSignal AND memory is enabled.
   * Use to gate WHO.CT entry fetches.
   */
  personSignal(signals: IntakeSignals | null | undefined): boolean {
    if (isMemoryFullyDisabled()) {
      transparency.emit({ type: 'memory_gate_skipped', data: { gate: 'personSignal', reason: 'memory disabled' } });
      return false;
    }
    const ok = signals?.personSignal != null;
    if (ok) {
      transparency.emit({ type: 'memory_gate_opened', data: { gate: 'personSignal', signal: signals!.personSignal!, reason: 'personSignal present' } });
    } else {
      transparency.emit({ type: 'memory_gate_skipped', data: { gate: 'personSignal', reason: 'no personSignal' } });
    }
    return ok;
  },

  /**
   * Returns true if there is a non-null projectSignal AND memory is enabled.
   * Use to gate PLAN.PJ / WHAT.PJ entry fetches.
   */
  projectSignal(signals: IntakeSignals | null | undefined): boolean {
    if (isMemoryFullyDisabled()) {
      transparency.emit({ type: 'memory_gate_skipped', data: { gate: 'projectSignal', reason: 'memory disabled' } });
      return false;
    }
    const ok = signals?.projectSignal != null;
    if (ok) {
      transparency.emit({ type: 'memory_gate_opened', data: { gate: 'projectSignal', signal: signals!.projectSignal!, reason: 'projectSignal present' } });
    } else {
      transparency.emit({ type: 'memory_gate_skipped', data: { gate: 'projectSignal', reason: 'no projectSignal' } });
    }
    return ok;
  },

  /**
   * Returns true if the unit explicitly signals a memory query.
   * Use to gate hybrid search / episodic reads.
   */
  querySignal(signals: IntakeSignals | null | undefined): boolean {
    if (isMemoryFullyDisabled()) {
      transparency.emit({ type: 'memory_gate_skipped', data: { gate: 'querySignal', reason: 'memory disabled' } });
      return false;
    }
    const ok = signals?.querySignal === true;
    if (ok) {
      transparency.emit({ type: 'memory_gate_opened', data: { gate: 'querySignal', signal: 'true', reason: 'querySignal=true' } });
    } else {
      transparency.emit({ type: 'memory_gate_skipped', data: { gate: 'querySignal', reason: 'querySignal=false or missing' } });
    }
    return ok;
  },

  /**
   * Raw gate: checks a named condition and logs the decision.
   * Use for ad-hoc gates not covered by the named predicates above.
   */
  check(gate: string, condition: boolean, signal: string, reason: string): boolean {
    if (isMemoryFullyDisabled()) {
      transparency.emit({ type: 'memory_gate_skipped', data: { gate, reason: 'memory disabled' } });
      return false;
    }
    if (condition) {
      transparency.emit({ type: 'memory_gate_opened', data: { gate, signal, reason } });
    } else {
      transparency.emit({ type: 'memory_gate_skipped', data: { gate, reason } });
    }
    return condition;
  },
};
