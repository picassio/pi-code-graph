/**
 * Process detection via BFS over the CALLS graph from entry points.
 *
 * An "entry point" is a Function/Method node in the project that either:
 *  - has zero incoming :CALLS edges, OR
 *  - matches a heuristic name pattern (main, run, handle*, on*, register*).
 *
 * From each entry point we BFS forward through :CALLS with bounded depth and
 * branching, recording linear traces. Each leaf path becomes a Process node
 * with HAS_STEP edges (carrying step_index) to its member nodes.
 */

import { logger } from './logger.js';
import type { ResultRow } from './types.js';
import { CYPHER_DELETE_PROCESSES } from './cypher-queries.js';

export interface ProcessDetectorService {
  executeWrite(query: string, params?: Record<string, unknown>): Promise<void>;
  fetchAll(query: string, params?: Record<string, unknown>): Promise<ResultRow[]>;
}

export interface DetectProcessesOptions {
  maxDepth?: number;       // default 10
  maxBranching?: number;   // default 4
  minSteps?: number;       // default 3
  maxProcesses?: number;   // safety cap, default 500
}

export interface DetectProcessesSummary {
  processCount: number;
  stepCount: number;
  entryPointCount: number;
}

const ENTRY_NAME_RE = /^(main|run|handle.*|on[A-Z_].*|register.*)$/;

interface NodeInfo {
  qn: string;
  name: string;
}

/**
 * Detect processes for the given project.
 */
export async function detectProcesses(
  graph: ProcessDetectorService,
  projectName: string,
  options: DetectProcessesOptions = {},
): Promise<DetectProcessesSummary> {
  const maxDepth = options.maxDepth ?? 10;
  const maxBranching = options.maxBranching ?? 4;
  const minSteps = options.minSteps ?? 3;
  const maxProcesses = options.maxProcesses ?? 500;

  // Wipe previous processes for this project.
  await graph.executeWrite(CYPHER_DELETE_PROCESSES, { project: projectName });

  // 1. Build adjacency: qn -> sorted list of callee qns (limited per source).
  const adjRows = await graph.fetchAll(
    `
    MATCH (s)-[:CALLS]->(t)
    WHERE s.project = $project AND t.project = $project
      AND (s:Function OR s:Method) AND (t:Function OR t:Method)
    RETURN s.qualified_name AS s, t.qualified_name AS t
    `,
    { project: projectName },
  );
  const adj = new Map<string, string[]>();
  for (const row of adjRows) {
    const s = row.s as string | undefined;
    const t = row.t as string | undefined;
    if (!s || !t || s === t) continue;
    let arr = adj.get(s);
    if (!arr) {
      arr = [];
      adj.set(s, arr);
    }
    if (!arr.includes(t)) arr.push(t);
  }

  // 2. Fetch candidate nodes (functions / methods) with name + incoming-call count.
  const nodeRows = await graph.fetchAll(
    `
    MATCH (n)
    WHERE n.project = $project AND (n:Function OR n:Method)
    OPTIONAL MATCH (caller)-[:CALLS]->(n)
    WHERE caller.project = $project
    WITH n, count(caller) AS in_calls
    RETURN n.qualified_name AS qn, n.name AS name, in_calls AS in_calls
    `,
    { project: projectName },
  );
  const nodeInfo = new Map<string, NodeInfo>();
  const entryPoints: string[] = [];
  for (const row of nodeRows) {
    const qn = row.qn as string | undefined;
    if (!qn) continue;
    const name = (row.name as string | undefined) ?? qn;
    nodeInfo.set(qn, { qn, name });
    const raw = row.in_calls;
    const inCalls =
      typeof raw === 'number' ? raw : Number((raw as { toNumber?: () => number })?.toNumber?.() ?? raw ?? 0);
    if (inCalls === 0 || ENTRY_NAME_RE.test(name)) {
      entryPoints.push(qn);
    }
  }

  if (entryPoints.length === 0) {
    logger.info('[process-detector] No entry points found');
    return { processCount: 0, stepCount: 0, entryPointCount: 0 };
  }

  // 3. BFS forward from each entry point, collecting traces.
  // We collect a path each time we hit a leaf (no callees, max depth, or cycle stop).
  const traces: string[][] = [];

  for (const ep of entryPoints) {
    if (traces.length >= maxProcesses) break;
    bfsCollect(ep, adj, maxDepth, maxBranching, (path) => {
      if (path.length >= minSteps) traces.push([...path]);
      return traces.length < maxProcesses;
    });
  }

  // Dedupe identical traces.
  const seen = new Set<string>();
  const uniqueTraces: string[][] = [];
  for (const t of traces) {
    const key = t.join('>');
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueTraces.push(t);
  }

  let totalSteps = 0;
  let persisted = 0;
  for (let i = 0; i < uniqueTraces.length; i++) {
    const trace = uniqueTraces[i]!;
    const entryQn = trace[0]!;
    const terminalQn = trace[trace.length - 1]!;
    const entryName = nodeInfo.get(entryQn)?.name ?? entryQn;
    const terminalName = nodeInfo.get(terminalQn)?.name ?? terminalQn;
    const id = `${projectName}::process::${i}`;
    const name = `${entryName}_to_${terminalName}`;

    await graph.executeWrite(
      `
      MERGE (p:Process {id: $id})
      SET p.project = $project,
          p.name = $name,
          p.entry_point_qn = $entryQn,
          p.terminal_qn = $terminalQn,
          p.step_count = $stepCount,
          p.trace = $trace
      `,
      {
        id,
        project: projectName,
        name,
        entryQn,
        terminalQn,
        stepCount: trace.length,
        trace,
      },
    );

    await graph.executeWrite(
      `
      UNWIND range(0, size($trace) - 1) AS idx
      WITH idx, $trace[idx] AS qn
      MATCH (p:Process {id: $id})
      MATCH (n {qualified_name: qn, project: $project})
      MERGE (p)-[r:HAS_STEP]->(n)
      SET r.step_index = idx
      `,
      { id, project: projectName, trace },
    );

    persisted++;
    totalSteps += trace.length;
  }

  logger.info(
    `[process-detector] Created ${persisted} processes (${totalSteps} steps) from ${entryPoints.length} entry points`,
  );

  return { processCount: persisted, stepCount: totalSteps, entryPointCount: entryPoints.length };
}

/**
 * Iterative BFS that yields linear paths whenever it reaches a leaf
 * (no callees, max depth, branching exhausted, or cycle).
 *
 * Branching limit: at each node we only follow up to maxBranching successors
 * (sorted lexicographically for determinism).
 */
function bfsCollect(
  start: string,
  adj: Map<string, string[]>,
  maxDepth: number,
  maxBranching: number,
  onPath: (path: string[]) => boolean,
): void {
  type Frame = { path: string[]; visited: Set<string> };
  const queue: Frame[] = [{ path: [start], visited: new Set([start]) }];

  while (queue.length > 0) {
    const frame = queue.shift()!;
    const head = frame.path[frame.path.length - 1]!;
    const callees = (adj.get(head) ?? []).slice().sort().slice(0, maxBranching);
    const fresh = callees.filter((c) => !frame.visited.has(c));

    // Leaf: no fresh callees OR reached max depth.
    if (fresh.length === 0 || frame.path.length >= maxDepth) {
      if (!onPath(frame.path)) return;
      continue;
    }

    for (const next of fresh) {
      const visited = new Set(frame.visited);
      visited.add(next);
      queue.push({ path: [...frame.path, next], visited });
    }
  }
}
