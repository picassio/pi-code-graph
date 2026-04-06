/**
 * Community detection via Memgraph MAGE Leiden algorithm.
 *
 * Runs Leiden over the CALLS subgraph for a given project, creates Community
 * nodes and MEMBER_OF relationships from code nodes to their community.
 *
 * Falls back to a simple "group by parent directory" heuristic if Leiden
 * is unavailable or fails.
 */

import { logger } from './logger.js';
import type { ResultRow } from './types.js';

export interface CommunityDetectorService {
  executeWrite(query: string, params?: Record<string, unknown>): Promise<void>;
  fetchAll(query: string, params?: Record<string, unknown>): Promise<ResultRow[]>;
}

export interface DetectCommunitiesOptions {
  /** Minimum members for a community to be persisted (default 2) */
  minSize?: number;
  /** Force fallback strategy (skip Leiden) — useful for tests */
  fallback?: boolean;
}

export interface CommunityResult {
  id: string;
  name: string;
  symbol_count: number;
  cohesion: number;
  heuristic_label: string;
  members: string[];
}

export interface DetectCommunitiesSummary {
  communityCount: number;
  memberCount: number;
  strategy: 'leiden' | 'fallback-directory';
}

/**
 * Common path-prefix heuristic label.
 */
function commonPrefixLabel(filePaths: string[]): string {
  if (filePaths.length === 0) return 'unknown';
  if (filePaths.length === 1) {
    const fp = filePaths[0]!;
    const idx = fp.lastIndexOf('/');
    return idx >= 0 ? fp.slice(0, idx) : fp;
  }
  const split = filePaths.map((fp) => fp.split('/'));
  const minLen = Math.min(...split.map((p) => p.length));
  const prefix: string[] = [];
  for (let i = 0; i < minLen; i++) {
    const seg = split[0]![i]!;
    if (split.every((p) => p[i] === seg)) prefix.push(seg);
    else break;
  }
  if (prefix.length === 0) return 'mixed';
  // Drop trailing filename if present (has a dot)
  const last = prefix[prefix.length - 1]!;
  if (last.includes('.')) prefix.pop();
  return prefix.join('/') || 'mixed';
}

/**
 * Detect communities for the given project.
 */
export async function detectCommunities(
  graph: CommunityDetectorService,
  projectName: string,
  options: DetectCommunitiesOptions = {},
): Promise<DetectCommunitiesSummary> {
  const minSize = options.minSize ?? 2;

  // Always clear previous communities for this project first.
  await graph.executeWrite(CYPHER_DELETE_COMMUNITIES, { project: projectName });

  let strategy: DetectCommunitiesSummary['strategy'] = 'leiden';
  // qn -> communityId
  let assignment = new Map<string, number>();

  if (!options.fallback) {
    try {
      // Pull subgraph + run Leiden via get_subgraph (so we can constrain to project).
      const rows = await graph.fetchAll(
        `
        MATCH (s)-[:CALLS]->(t)
        WHERE s.project = $project AND t.project = $project
        WITH collect(DISTINCT s) + collect(DISTINCT t) AS allNodes
        WITH [n IN allNodes WHERE n IS NOT NULL] AS nodes
        MATCH (a)-[r:CALLS]->(b)
        WHERE a.project = $project AND b.project = $project
        WITH nodes, collect(r) AS rels
        CALL leiden_community_detection.get_subgraph(nodes, rels)
        YIELD node, community_id
        RETURN node.qualified_name AS qn, community_id AS cid
        `,
        { project: projectName },
      );
      for (const row of rows) {
        const qn = row.qn as string | undefined;
        const cid = row.cid;
        if (!qn || cid == null) continue;
        const cidNum = typeof cid === 'number' ? cid : Number((cid as { toNumber?: () => number }).toNumber?.() ?? cid);
        if (Number.isFinite(cidNum)) assignment.set(qn, cidNum);
      }
      if (assignment.size === 0) {
        logger.info('[community-detector] Leiden returned no assignments, falling back to directory grouping');
        strategy = 'fallback-directory';
      }
    } catch (err) {
      logger.warn(`[community-detector] Leiden failed (${(err as Error).message}), falling back to directory grouping`);
      strategy = 'fallback-directory';
      assignment = new Map();
    }
  } else {
    strategy = 'fallback-directory';
  }

  if (strategy === 'fallback-directory') {
    // Group by parent directory of file_path.
    const rows = await graph.fetchAll(
      `
      MATCH (n)
      WHERE n.project = $project AND n.file_path IS NOT NULL
        AND (n:Function OR n:Method OR n:Class OR n:Module)
      RETURN n.qualified_name AS qn, n.file_path AS file_path
      `,
      { project: projectName },
    );
    const dirToId = new Map<string, number>();
    let next = 0;
    for (const row of rows) {
      const qn = row.qn as string | undefined;
      const fp = row.file_path as string | undefined;
      if (!qn || !fp) continue;
      const idx = fp.lastIndexOf('/');
      const dir = idx >= 0 ? fp.slice(0, idx) : '.';
      let cid = dirToId.get(dir);
      if (cid == null) {
        cid = next++;
        dirToId.set(dir, cid);
      }
      assignment.set(qn, cid);
    }
  }

  if (assignment.size === 0) {
    logger.info('[community-detector] No nodes to cluster');
    return { communityCount: 0, memberCount: 0, strategy };
  }

  // Group members by community id, fetch file_paths for labels.
  const groups = new Map<number, string[]>();
  for (const [qn, cid] of assignment) {
    let arr = groups.get(cid);
    if (!arr) {
      arr = [];
      groups.set(cid, arr);
    }
    arr.push(qn);
  }

  // Fetch file_paths for naming. One round-trip.
  const allQns = Array.from(assignment.keys());
  const fpRows = await graph.fetchAll(
    `
    MATCH (n) WHERE n.project = $project AND n.qualified_name IN $qns
    RETURN n.qualified_name AS qn, n.file_path AS file_path
    `,
    { project: projectName, qns: allQns },
  );
  const qnToFp = new Map<string, string>();
  for (const row of fpRows) {
    const qn = row.qn as string | undefined;
    const fp = row.file_path as string | undefined;
    if (qn && fp) qnToFp.set(qn, fp);
  }

  // Cohesion: avg internal calls per node within a community (computed via one query).
  const cohesionRows = await graph.fetchAll(
    `
    MATCH (s)-[r:CALLS]->(t)
    WHERE s.project = $project AND t.project = $project
      AND s.qualified_name IN $qns AND t.qualified_name IN $qns
    RETURN s.qualified_name AS s, t.qualified_name AS t
    `,
    { project: projectName, qns: allQns },
  );
  const internalEdges = new Map<number, number>();
  for (const row of cohesionRows) {
    const s = row.s as string;
    const t = row.t as string;
    const cs = assignment.get(s);
    const ct = assignment.get(t);
    if (cs != null && cs === ct) {
      internalEdges.set(cs, (internalEdges.get(cs) ?? 0) + 1);
    }
  }

  let persistedCommunities = 0;
  let persistedMembers = 0;
  for (const [cid, members] of groups) {
    if (members.length < minSize) continue;
    const filePaths = members.map((m) => qnToFp.get(m)).filter((x): x is string => !!x);
    const label = commonPrefixLabel(filePaths);
    const internal = internalEdges.get(cid) ?? 0;
    const cohesion = members.length > 0 ? internal / members.length : 0;
    const id = `${projectName}::community::${cid}`;
    const name = `${label} (#${cid})`;

    await graph.executeWrite(
      `
      MERGE (c:Community {id: $id})
      SET c.project = $project,
          c.name = $name,
          c.heuristic_label = $label,
          c.symbol_count = $symbolCount,
          c.cohesion = $cohesion
      `,
      {
        id,
        project: projectName,
        name,
        label,
        symbolCount: members.length,
        cohesion,
      },
    );

    await graph.executeWrite(
      `
      UNWIND $members AS qn
      MATCH (n {qualified_name: qn, project: $project})
      MATCH (c:Community {id: $id})
      MERGE (n)-[:MEMBER_OF]->(c)
      `,
      { id, project: projectName, members },
    );

    persistedCommunities++;
    persistedMembers += members.length;
  }

  logger.info(
    `[community-detector] Created ${persistedCommunities} communities (${persistedMembers} members) via ${strategy}`,
  );

  return { communityCount: persistedCommunities, memberCount: persistedMembers, strategy };
}

// Re-export for convenience
import { CYPHER_DELETE_COMMUNITIES } from './cypher-queries.js';
export { CYPHER_DELETE_COMMUNITIES };
