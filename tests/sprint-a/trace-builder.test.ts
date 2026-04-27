import { describe, it, expect } from 'vitest';

// Inline TraceNode and TraceBuilder to test server-side logic without importing the full server.
// The real TraceBuilder lives in server/ui-server.ts — this mirrors it exactly.

interface TraceNode {
  spanId: string;
  label: string;
  parentSpanId?: string;
  startedAt: number;
  durationMs?: number;
  status?: 'ok' | 'error' | 'aborted';
  children: TraceNode[];
}

type FakeEnvelope = { type: string; requestId?: string; data: Record<string, unknown> };

class TraceBuilder {
  private nodes = new Map<string, TraceNode>();
  private rootId: string | undefined;

  ingest(event: FakeEnvelope): void {
    if (event.type === 'span_start') {
      const d = event.data as { spanId: string; parentSpanId?: string; label: string; ts: number };
      const node: TraceNode = {
        spanId: d.spanId,
        label: d.label,
        parentSpanId: d.parentSpanId,
        startedAt: d.ts,
        children: [],
      };
      this.nodes.set(d.spanId, node);
      if (!d.parentSpanId) this.rootId = d.spanId;
    } else if (event.type === 'span_end') {
      const d = event.data as { spanId: string; durationMs: number; status: 'ok' | 'error' | 'aborted' };
      const node = this.nodes.get(d.spanId);
      if (node) {
        node.durationMs = d.durationMs;
        node.status = d.status;
      }
    }
  }

  buildTree(): TraceNode | undefined {
    if (!this.rootId) return undefined;
    for (const node of this.nodes.values()) {
      if (node.parentSpanId) {
        const parent = this.nodes.get(node.parentSpanId);
        if (parent && !parent.children.find(c => c.spanId === node.spanId)) {
          parent.children.push(node);
        }
      }
    }
    return this.nodes.get(this.rootId);
  }

  reset(): void {
    this.nodes.clear();
    this.rootId = undefined;
  }
}

function makeStart(spanId: string, label: string, parentSpanId?: string): FakeEnvelope {
  return { type: 'span_start', data: { spanId, label, ts: Date.now(), parentSpanId } };
}

function makeEnd(spanId: string, durationMs = 10, status: 'ok' | 'error' | 'aborted' = 'ok'): FakeEnvelope {
  return { type: 'span_end', data: { spanId, durationMs, status } };
}

describe('TraceBuilder', () => {
  it('buildTree returns undefined when no spans ingested', () => {
    const tb = new TraceBuilder();
    expect(tb.buildTree()).toBeUndefined();
  });

  it('single root span builds a tree with no children', () => {
    const tb = new TraceBuilder();
    tb.ingest(makeStart('root', 'Root span'));
    tb.ingest(makeEnd('root', 50, 'ok'));
    const tree = tb.buildTree();
    expect(tree).toBeDefined();
    expect(tree!.spanId).toBe('root');
    expect(tree!.label).toBe('Root span');
    expect(tree!.durationMs).toBe(50);
    expect(tree!.status).toBe('ok');
    expect(tree!.children).toHaveLength(0);
  });

  it('child span is nested under parent in tree', () => {
    const tb = new TraceBuilder();
    tb.ingest(makeStart('root', 'Root'));
    tb.ingest(makeStart('child', 'Child', 'root'));
    tb.ingest(makeEnd('child', 5));
    tb.ingest(makeEnd('root', 20));
    const tree = tb.buildTree();
    expect(tree!.children).toHaveLength(1);
    expect(tree!.children[0].spanId).toBe('child');
  });

  it('three-level nesting produces correct hierarchy', () => {
    const tb = new TraceBuilder();
    tb.ingest(makeStart('a', 'A'));
    tb.ingest(makeStart('b', 'B', 'a'));
    tb.ingest(makeStart('c', 'C', 'b'));
    tb.ingest(makeEnd('c'));
    tb.ingest(makeEnd('b'));
    tb.ingest(makeEnd('a'));
    const tree = tb.buildTree()!;
    expect(tree.children[0].children[0].spanId).toBe('c');
  });

  it('reset clears state and buildTree returns undefined', () => {
    const tb = new TraceBuilder();
    tb.ingest(makeStart('root', 'Root'));
    tb.reset();
    expect(tb.buildTree()).toBeUndefined();
  });

  it('span_end with error status propagates into tree node', () => {
    const tb = new TraceBuilder();
    tb.ingest(makeStart('root', 'Root'));
    tb.ingest(makeEnd('root', 30, 'error'));
    expect(tb.buildTree()!.status).toBe('error');
  });
});
