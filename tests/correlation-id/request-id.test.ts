/**
 * Batch 4: Correlation ID Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PATHS } from '../../config/agent.config.js';
import { initDatabase } from '../../core/memory/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let tmpDir: string;

beforeEach(() => {
  tmpDir = path.join(__dirname, `tmp-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  (PATHS as Record<string, string>).db = path.join(tmpDir, 'test.sqlite');
  (PATHS as Record<string, string>).memory = path.join(tmpDir, 'memory');
  initDatabase();
});

afterEach(() => {
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe('withRequestId and getCurrentRequestId', () => {
  it('getCurrentRequestId returns undefined outside scope', async () => {
    const { getCurrentRequestId } = await import('../../core/transparency.js');
    expect(getCurrentRequestId()).toBeUndefined();
  });

  it('getCurrentRequestId returns the id inside withRequestId scope', async () => {
    const { withRequestId, getCurrentRequestId } = await import('../../core/transparency.js');
    let captured: string | undefined;
    withRequestId(() => {
      captured = getCurrentRequestId();
    }, 'test-req-id');
    expect(captured).toBe('test-req-id');
  });

  it('auto-generates a UUID when no requestId provided', async () => {
    const { withRequestId, getCurrentRequestId } = await import('../../core/transparency.js');
    let captured: string | undefined;
    withRequestId(() => {
      captured = getCurrentRequestId();
    });
    expect(typeof captured).toBe('string');
    expect(captured?.length).toBeGreaterThan(10);
  });

  it('nested withRequestId scopes are independent', async () => {
    const { withRequestId, getCurrentRequestId } = await import('../../core/transparency.js');
    const ids: Array<string | undefined> = [];
    withRequestId(() => {
      ids.push(getCurrentRequestId());
      withRequestId(() => {
        ids.push(getCurrentRequestId());
      }, 'inner-id');
      ids.push(getCurrentRequestId());
    }, 'outer-id');
    expect(ids[0]).toBe('outer-id');
    expect(ids[1]).toBe('inner-id');
    expect(ids[2]).toBe('outer-id');
  });
});

describe('requestId on emitted transparency events', () => {
  it('events emitted inside withRequestId carry requestId', async () => {
    const { transparency, withRequestId } = await import('../../core/transparency.js');
    transparency.enable();
    const events: Array<any> = [];
    const off = transparency.on(e => events.push(e));

    try {
      withRequestId(() => {
        transparency.emit({ type: 'memory_mode', data: { mode: 'enabled' } });
      }, 'req-abc');
      expect(events.length).toBe(1);
      expect(events[0].requestId).toBe('req-abc');
    } finally {
      off();
      transparency.disable();
    }
  });

  it('events emitted outside any scope have requestId undefined', async () => {
    const { transparency } = await import('../../core/transparency.js');
    transparency.enable();
    const events: Array<any> = [];
    const off = transparency.on(e => events.push(e));

    try {
      transparency.emit({ type: 'memory_mode', data: { mode: 'enabled' } });
      expect(events.length).toBe(1);
      expect(events[0].requestId).toBeUndefined();
    } finally {
      off();
      transparency.disable();
    }
  });
});

describe('processMessage correlation ID', () => {
  it('all events within a processMessage call share the same requestId', async () => {
    const { transparency } = await import('../../core/transparency.js');
    transparency.enable();
    const events: Array<any> = [];
    const off = transparency.on(e => events.push(e));

    try {
      const { processMessage } = await import('../../core/agent.js');
      const mockHandler = vi.fn(async () => 'done');
      await processMessage('hello', [], { llmHandler: mockHandler as any });

      const requestIds = events.map(e => e.requestId).filter(Boolean);
      expect(requestIds.length).toBeGreaterThan(0);
      // All events from this call should share the same non-null requestId
      const unique = new Set(requestIds);
      expect(unique.size).toBe(1);
    } finally {
      off();
      transparency.disable();
    }
  });

  it('two concurrent processMessage calls produce different requestIds', async () => {
    const { transparency } = await import('../../core/transparency.js');
    transparency.enable();
    const byRequestId = new Map<string, string[]>();
    const off = transparency.on(e => {
      if (e.requestId) {
        const types = byRequestId.get(e.requestId) ?? [];
        types.push(e.type);
        byRequestId.set(e.requestId, types);
      }
    });

    try {
      const { processMessage } = await import('../../core/agent.js');
      const mockHandler = vi.fn(async () => 'done');
      await Promise.all([
        processMessage('hello', [], { llmHandler: mockHandler as any }),
        processMessage('hi', [], { llmHandler: mockHandler as any }),
      ]);

      expect(byRequestId.size).toBe(2);
    } finally {
      off();
      transparency.disable();
    }
  });
});
