import { describe, it, expect } from 'vitest';
import { detectProcesses } from '../src/lib/process-detector.js';
import type { ResultRow } from '../src/lib/types.js';

interface Edge { s: string; t: string }
interface Node { qn: string; name: string }

class MockGraph {
  writes: Array<{ q: string; p: Record<string, unknown> }> = [];
  processes = new Map<string, Record<string, unknown>>();
  steps: Array<{ id: string; trace: string[] }> = [];

  constructor(private nodes: Node[], private edges: Edge[]) {}

  async executeWrite(q: string, p: Record<string, unknown> = {}): Promise<void> {
    this.writes.push({ q, p });
    if (q.includes('MERGE (p:Process')) {
      this.processes.set(p.id as string, p);
    }
    if (q.includes('HAS_STEP')) {
      this.steps.push({ id: p.id as string, trace: p.trace as string[] });
    }
    if (q.includes('DETACH DELETE p')) {
      this.processes.clear();
      this.steps = [];
    }
  }

  async fetchAll(q: string, _p: Record<string, unknown> = {}): Promise<ResultRow[]> {
    if (q.includes('MATCH (s)-[:CALLS]->(t)')) {
      return this.edges.map((e) => ({ s: e.s, t: e.t })) as unknown as ResultRow[];
    }
    if (q.includes('OPTIONAL MATCH (caller)')) {
      return this.nodes.map((n) => {
        const inCalls = this.edges.filter((e) => e.t === n.qn).length;
        return { qn: n.qn, name: n.name, in_calls: inCalls };
      }) as unknown as ResultRow[];
    }
    return [];
  }
}

describe('detectProcesses', () => {
  it('finds linear traces from entry points (no incoming calls)', async () => {
    // a -> b -> c -> d  (a is entry, has 0 callers; d is terminal)
    const nodes: Node[] = [
      { qn: 'f.ts:a', name: 'a' },
      { qn: 'f.ts:b', name: 'b' },
      { qn: 'f.ts:c', name: 'c' },
      { qn: 'f.ts:d', name: 'd' },
    ];
    const edges: Edge[] = [
      { s: 'f.ts:a', t: 'f.ts:b' },
      { s: 'f.ts:b', t: 'f.ts:c' },
      { s: 'f.ts:c', t: 'f.ts:d' },
    ];
    const g = new MockGraph(nodes, edges);
    const summary = await detectProcesses(g, 'proj');
    expect(summary.processCount).toBe(1);
    expect(summary.entryPointCount).toBeGreaterThanOrEqual(1);
    const proc = Array.from(g.processes.values())[0]!;
    expect(proc.entryQn).toBe('f.ts:a');
    expect(proc.terminalQn).toBe('f.ts:d');
    expect(proc.name).toBe('a_to_d');
    expect(proc.stepCount).toBe(4);
  });

  it('respects minSteps and skips short traces', async () => {
    const nodes: Node[] = [
      { qn: 'f.ts:a', name: 'a' },
      { qn: 'f.ts:b', name: 'b' },
    ];
    const edges: Edge[] = [{ s: 'f.ts:a', t: 'f.ts:b' }];
    const g = new MockGraph(nodes, edges);
    const summary = await detectProcesses(g, 'proj', { minSteps: 3 });
    expect(summary.processCount).toBe(0);
  });

  it('treats name-pattern entry points (e.g. main, handleX) as entries', async () => {
    // main -> step1 -> step2  (main has zero callers anyway, but use handleClick variant)
    const nodes: Node[] = [
      { qn: 'f.ts:caller', name: 'caller' },
      { qn: 'f.ts:handleClick', name: 'handleClick' },
      { qn: 'f.ts:s1', name: 's1' },
      { qn: 'f.ts:s2', name: 's2' },
    ];
    const edges: Edge[] = [
      { s: 'f.ts:caller', t: 'f.ts:handleClick' }, // gives handleClick incoming
      { s: 'f.ts:handleClick', t: 'f.ts:s1' },
      { s: 'f.ts:s1', t: 'f.ts:s2' },
    ];
    const g = new MockGraph(nodes, edges);
    const summary = await detectProcesses(g, 'proj', { minSteps: 3 });
    // caller (no incoming) and handleClick (name pattern) are both entries.
    // caller -> handleClick -> s1 -> s2 (4 steps) is one trace.
    // handleClick -> s1 -> s2 (3 steps) is another.
    expect(summary.processCount).toBeGreaterThanOrEqual(2);
    const names = Array.from(g.processes.values()).map((p) => p.name);
    expect(names.some((n) => String(n).startsWith('handleClick_to_'))).toBe(true);
  });

  it('handles cycles without infinite loops', async () => {
    const nodes: Node[] = [
      { qn: 'f.ts:a', name: 'a' },
      { qn: 'f.ts:b', name: 'b' },
      { qn: 'f.ts:c', name: 'c' },
    ];
    const edges: Edge[] = [
      { s: 'f.ts:a', t: 'f.ts:b' },
      { s: 'f.ts:b', t: 'f.ts:c' },
      { s: 'f.ts:c', t: 'f.ts:b' }, // cycle
    ];
    const g = new MockGraph(nodes, edges);
    const summary = await detectProcesses(g, 'proj', { minSteps: 3 });
    expect(summary.processCount).toBeGreaterThanOrEqual(1);
  });

  it('returns zero when no entry points', async () => {
    const g = new MockGraph([], []);
    const summary = await detectProcesses(g, 'proj');
    expect(summary.processCount).toBe(0);
    expect(summary.entryPointCount).toBe(0);
  });
});
