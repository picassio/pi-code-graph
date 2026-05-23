import { createMemgraphService, type MemgraphService } from '../../src/lib/graph-service.js';
import { applyProjectScopeToCypher } from '../../src/lib/tools/codebase-query.js';

export async function maybeCreateEvalGraph(): Promise<MemgraphService | null> {
  if (process.env.CGR_EVAL_EXECUTE !== 'true') return null;
  const graph = createMemgraphService({
    host: process.env.CGR_EVAL_MEMGRAPH_HOST || 'localhost',
    port: Number.parseInt(process.env.CGR_EVAL_MEMGRAPH_PORT || '7687', 10),
  }, { logLevel: 'warn' });
  await graph.connect();
  return graph;
}

export async function executeEvalCypher(
  graph: MemgraphService | null,
  cypher: string,
  projectName: string,
): Promise<{ ok: boolean; error?: string; rowCount?: number }> {
  if (!graph || !cypher) return { ok: true };
  try {
    const scoped = applyProjectScopeToCypher(cypher, projectName);
    const rows = await graph.fetchAll(scoped, { project: projectName });
    return { ok: true, rowCount: rows.length };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
