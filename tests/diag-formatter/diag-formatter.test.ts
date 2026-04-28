import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { transparency, withRequestId } from '../../core/transparency.js';
import { startDiagSession, getDiagPath, _setDiagBaseDir } from '../../core/diag-formatter.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'diag-test-'));
  _setDiagBaseDir(tmpDir);
  transparency.enable();
});

afterEach(async () => {
  transparency.disable();
  _setDiagBaseDir(null);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Emit events inside the correct requestId scope so the handler filter passes. */
function emit(requestId: string, fn: () => void): void {
  withRequestId(fn, requestId);
}

describe('diag-formatter', () => {
  it('startDiagSession returns a flush function', () => {
    const requestId = randomUUID();
    const flush = startDiagSession(requestId);
    expect(typeof flush).toBe('function');
    // clean up without writing
    flush().catch(() => {});
  });

  it('emitting query_loop_start sets goal in state (verified via flush output)', async () => {
    const requestId = randomUUID();
    const flush = startDiagSession(requestId);
    emit(requestId, () => {
      transparency.emit({ type: 'query_loop_start', data: { goal: 'download catalogs for brand A' } });
    });
    await flush();
    const text = readFileSync(getDiagPath(requestId), 'utf-8');
    expect(text).toContain('download catalogs for brand A');
  });

  it('query_loop_skill_call + skill_result ok=true records iter with ok=true', async () => {
    const requestId = randomUUID();
    const flush = startDiagSession(requestId);
    emit(requestId, () => {
      transparency.emit({ type: 'query_loop_iteration', data: { iteration: 1, reply: '{"action":"web_search"}' } });
      transparency.emit({ type: 'query_loop_skill_call', data: { skill: 'web_search', input: { query: 'test' } } });
      transparency.emit({ type: 'query_loop_skill_result', data: { skill: 'web_search', success: true } });
    });
    await flush();
    const text = readFileSync(getDiagPath(requestId), 'utf-8');
    expect(text).toContain('[OK]');
  });

  it('query_loop_skill_result ok=false records iter with FAIL and error', async () => {
    const requestId = randomUUID();
    const flush = startDiagSession(requestId);
    emit(requestId, () => {
      transparency.emit({ type: 'query_loop_iteration', data: { iteration: 1, reply: '{"action":"run_bash"}' } });
      transparency.emit({ type: 'query_loop_skill_call', data: { skill: 'run_bash', input: { command: 'curl ...' } } });
      transparency.emit({ type: 'query_loop_skill_result', data: { skill: 'run_bash', success: false, error: 'HTTP 404: Not Found' } });
    });
    await flush();
    const text = readFileSync(getDiagPath(requestId), 'utf-8');
    expect(text).toContain('[FAIL: HTTP 404: Not Found]');
  });

  it('second token_usage emission overwrites first (cumulative overwrite)', async () => {
    const requestId = randomUUID();
    const flush = startDiagSession(requestId);
    emit(requestId, () => {
      transparency.emit({ type: 'token_usage', data: { inputTokens: 100, outputTokens: 50, estimatedCostUSD: 0.001 } });
      transparency.emit({ type: 'token_usage', data: { inputTokens: 92193, outputTokens: 1234, estimatedCostUSD: 1.0600 } });
    });
    await flush();
    const text = readFileSync(getDiagPath(requestId), 'utf-8');
    expect(text).toContain('in=92193');
    expect(text).toContain('out=1234');
    expect(text).not.toContain('in=100');
  });

  it('query_loop_narration with json-repair tag sets repairNote on last iter', async () => {
    const requestId = randomUUID();
    const flush = startDiagSession(requestId);
    emit(requestId, () => {
      transparency.emit({ type: 'query_loop_iteration', data: { iteration: 7, reply: 'partial...' } });
      transparency.emit({ type: 'query_loop_narration', data: { narration: '[json-repair 3/2] incomplete tool call detected', iteration: 7 } });
    });
    await flush();
    const text = readFileSync(getDiagPath(requestId), 'utf-8');
    expect(text).toContain('json-repair 3/2');
  });

  it('query_loop_repair_loop_detected is recorded in repairEvents', async () => {
    const requestId = randomUUID();
    const flush = startDiagSession(requestId);
    emit(requestId, () => {
      transparency.emit({ type: 'query_loop_repair_loop_detected', data: { consecutiveRepairCount: 3, action: 'run_bash' } });
    });
    await flush();
    const text = readFileSync(getDiagPath(requestId), 'utf-8');
    expect(text).toContain('repair-loop: run_bash ×3');
  });

  it('flush writes file to correct path', async () => {
    const requestId = randomUUID();
    const flush = startDiagSession(requestId);
    await flush();
    const expectedPath = getDiagPath(requestId);
    expect(existsSync(expectedPath)).toBe(true);
  });

  it('written file starts with ZARABAN DIAG v1', async () => {
    const requestId = randomUUID();
    const flush = startDiagSession(requestId);
    await flush();
    const text = readFileSync(getDiagPath(requestId), 'utf-8');
    expect(text.startsWith('ZARABAN DIAG v1')).toBe(true);
  });

  it('written file contains goal string', async () => {
    const requestId = randomUUID();
    const flush = startDiagSession(requestId);
    emit(requestId, () => {
      transparency.emit({ type: 'query_loop_start', data: { goal: 'search for neolith catalogs' } });
    });
    await flush();
    const text = readFileSync(getDiagPath(requestId), 'utf-8');
    expect(text).toContain('search for neolith catalogs');
  });
});
