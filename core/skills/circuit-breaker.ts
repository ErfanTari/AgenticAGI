/**
 * Tool-level circuit breaker.
 * When the same skill is called with identical args and fails consecutively,
 * subsequent calls are rejected pre-dispatch to prevent death spirals.
 */
import { transparency } from '../transparency.js';

const CIRCUIT_BREAKER_THRESHOLD = 2;

type CallSignature = string;

type CallRecord = {
  failedAttempts: number;
  lastFailureAt: number;
};

// requestId → (signature → record)
const breakerState = new Map<string, Map<CallSignature, CallRecord>>();

function hashCall(skillName: string, args: unknown): CallSignature {
  return `${skillName}::${JSON.stringify(args ?? {})}`;
}

export function checkCircuitBreaker(
  requestId: string,
  skillName: string,
  args: unknown,
): { tripped: boolean; reason?: string } {
  const reqState = breakerState.get(requestId);
  if (!reqState) return { tripped: false };

  const signature = hashCall(skillName, args);
  const record = reqState.get(signature);
  if (!record) return { tripped: false };

  if (record.failedAttempts >= CIRCUIT_BREAKER_THRESHOLD) {
    return {
      tripped: true,
      reason: `Skill '${skillName}' with identical args has failed ${record.failedAttempts} consecutive times. Circuit breaker tripped — try a different approach.`,
    };
  }

  return { tripped: false };
}

export function recordCallFailure(requestId: string, skillName: string, args: unknown): void {
  let reqState = breakerState.get(requestId);
  if (!reqState) {
    reqState = new Map();
    breakerState.set(requestId, reqState);
  }

  const signature = hashCall(skillName, args);
  const existing = reqState.get(signature);

  if (existing) {
    existing.failedAttempts++;
    existing.lastFailureAt = Date.now();
    if (existing.failedAttempts === CIRCUIT_BREAKER_THRESHOLD) {
      transparency.emit({
        type: 'circuit_breaker_tripped',
        data: {
          requestId,
          skillName,
          argsSignature: signature.slice(0, 200),
          failedAttempts: existing.failedAttempts,
        },
      });
    }
  } else {
    reqState.set(signature, { failedAttempts: 1, lastFailureAt: Date.now() });
  }
}

export function recordCallSuccess(requestId: string, skillName: string, args: unknown): void {
  const reqState = breakerState.get(requestId);
  if (!reqState) return;
  reqState.delete(hashCall(skillName, args));
}

/** Call at request completion to free per-request state. */
export function notifyRequestEnd(requestId: string): void {
  breakerState.delete(requestId);
}
