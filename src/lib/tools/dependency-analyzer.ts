import { logger } from '../logger.js';
/**
 * Dependency Analyzer Tool - Analyze callers/callees relationships
 * Provides tools for analyzing code dependencies through the knowledge graph
 */

import { MemgraphService } from '../graph-service.js';
import { ResultRow } from '../types.js';
import { CYPHER_DEFAULT_LIMIT, RelationshipType, NodeLabel } from '../constants.js';

/** Replace $limit parameter in query with actual integer value (Memgraph requires integer for LIMIT) */
function withLimit(query: string, limit: number): string {
  return query.replace('$limit', String(Math.floor(limit)));
}

// =============================================================================
// Types
// =============================================================================

export interface DependencyNode {
  qualified_name: string;
  name: string;
  type: string;
  file_path?: string;
  start_line?: number;
  end_line?: number;
  /** Confidence score for the CALLS edge that linked this node (0.0-1.0). Absent when not from a relationship. */
  confidence?: number;
}

export interface CallRelationship {
  caller: DependencyNode;
  callee: DependencyNode;
  call_count?: number;
}

export interface DependencyResult {
  target: DependencyNode;
  callers: DependencyNode[];
  callees: DependencyNode[];
}

export interface CallChain {
  path: DependencyNode[];
  depth: number;
}

export interface DependencyAnalyzerConfig {
  graphService: MemgraphService;
  maxDepth?: number;
  limit?: number;
}

// =============================================================================
// Cypher Queries for Dependency Analysis
// =============================================================================

// Direct callers (depth 1) — supports both new format (path:Class.method) and bare names
const CYPHER_FIND_CALLERS = `
MATCH (caller)-[r:CALLS]->(target)
WHERE target.qualified_name = $qualified_name
  OR target.name = $name
  OR target.local_name = $name
  OR target.qualified_name ENDS WITH (':' + $name)
  OR target.qualified_name ENDS WITH ('.' + $name)
RETURN DISTINCT
  caller.qualified_name AS caller_qn,
  caller.name AS caller_name,
  caller.local_name AS caller_local,
  caller.file_path AS file_path,
  labels(caller) AS caller_type,
  caller.start_line AS start_line,
  caller.end_line AS end_line,
  coalesce(r.confidence, 1.0) AS confidence
ORDER BY caller_qn
LIMIT $limit
`;

// Transitive callers (variable depth) — uses CALLS* path traversal
const CYPHER_FIND_CALLERS_TRANSITIVE = `
MATCH (caller)-[:CALLS*1..$maxDepth]->(target)
WHERE target.qualified_name = $qualified_name
  OR target.name = $name
  OR target.local_name = $name
  OR target.qualified_name ENDS WITH (':' + $name)
  OR target.qualified_name ENDS WITH ('.' + $name)
RETURN DISTINCT
  caller.qualified_name AS caller_qn,
  caller.name AS caller_name,
  caller.local_name AS caller_local,
  caller.file_path AS file_path,
  labels(caller) AS caller_type,
  caller.start_line AS start_line,
  caller.end_line AS end_line,
  1.0 AS confidence
ORDER BY caller_qn
LIMIT $limit
`;

const CYPHER_FIND_CALLEES = `
MATCH (source)-[r:CALLS]->(callee)
WHERE source.qualified_name = $qualified_name
  OR source.name = $name
  OR source.local_name = $name
  OR source.qualified_name ENDS WITH (':' + $name)
  OR source.qualified_name ENDS WITH ('.' + $name)
RETURN DISTINCT
  callee.qualified_name AS callee_qn,
  callee.name AS callee_name,
  callee.local_name AS callee_local,
  callee.file_path AS file_path,
  labels(callee) AS callee_type,
  callee.start_line AS start_line,
  callee.end_line AS end_line,
  coalesce(r.confidence, 1.0) AS confidence
ORDER BY callee_qn
LIMIT $limit
`;

const CYPHER_FIND_CALLEES_TRANSITIVE = `
MATCH (source)-[:CALLS*1..$maxDepth]->(callee)
WHERE source.qualified_name = $qualified_name
  OR source.name = $name
  OR source.local_name = $name
  OR source.qualified_name ENDS WITH (':' + $name)
  OR source.qualified_name ENDS WITH ('.' + $name)
RETURN DISTINCT
  callee.qualified_name AS callee_qn,
  callee.name AS callee_name,
  callee.local_name AS callee_local,
  callee.file_path AS file_path,
  labels(callee) AS callee_type,
  callee.start_line AS start_line,
  callee.end_line AS end_line,
  1.0 AS confidence
ORDER BY callee_qn
LIMIT $limit
`;

// Find a node by qualified name OR by short/local name (Bug #1 fix)
// Supports new format: 'src/lib/foo.ts:Foo.bar' OR bare 'Foo.bar' OR bare 'bar'
const CYPHER_FIND_NODE_BY_NAME = `
MATCH (n)
WHERE n.qualified_name = $qualified_name
  OR n.qualified_name ENDS WITH (':' + $name)
  OR n.qualified_name ENDS WITH ('.' + $name)
  OR n.local_name = $name
  OR (n.name = $name AND (n:Function OR n:Method OR n:Class OR n:Interface))
RETURN
  n.qualified_name AS qualified_name,
  n.name AS name,
  n.local_name AS local_name,
  n.file_path AS file_path,
  labels(n) AS type,
  n.start_line AS start_line,
  n.end_line AS end_line
LIMIT 1
`;

const CYPHER_CALL_CHAIN_DEPTH = `
MATCH path = (start)-[:CALLS*1..$maxDepth]->(end)
WHERE start.qualified_name = $qualified_name
RETURN 
  [node IN nodes(path) | node.qualified_name] AS chain_qns,
  [node IN nodes(path) | node.name] AS chain_names,
  [node IN nodes(path) | labels(node)[0]] AS chain_types,
  length(path) AS depth
ORDER BY depth DESC
LIMIT $limit
`;

const CYPHER_REVERSE_CALL_CHAIN = `
MATCH path = (caller)-[:CALLS*1..$maxDepth]->(target)
WHERE target.qualified_name = $qualified_name
RETURN 
  [node IN nodes(path) | node.qualified_name] AS chain_qns,
  [node IN nodes(path) | node.name] AS chain_names,
  [node IN nodes(path) | labels(node)[0]] AS chain_types,
  length(path) AS depth
ORDER BY depth DESC
LIMIT $limit
`;

const CYPHER_DEPENDENCY_STATS = `
MATCH (n)-[r:CALLS]->(m)
WITH n, count(r) AS outgoing
MATCH (caller)-[:CALLS]->(n)
WITH n, outgoing, count(caller) AS incoming
WHERE outgoing > 0 OR incoming > 0
RETURN
  n.qualified_name AS qualified_name,
  n.name AS name,
  labels(n) AS type,
  outgoing AS calls_made,
  incoming AS called_by
ORDER BY incoming DESC, outgoing DESC
LIMIT $limit
`;

const CYPHER_HIGHLY_CONNECTED = `
MATCH (n)
WHERE n:Function OR n:Method
OPTIONAL MATCH (n)-[:CALLS]->(outgoing)
OPTIONAL MATCH (incoming)-[:CALLS]->(n)
WITH n, count(DISTINCT outgoing) AS out_degree, count(DISTINCT incoming) AS in_degree
WHERE out_degree + in_degree > 0
RETURN
  n.qualified_name AS qualified_name,
  n.name AS name,
  labels(n) AS type,
  out_degree,
  in_degree,
  out_degree + in_degree AS total_connections
ORDER BY total_connections DESC
LIMIT $limit
`;

// =============================================================================
// DependencyAnalyzer Class
// =============================================================================

/**
 * Tool for analyzing code dependencies and call relationships
 */
export class DependencyAnalyzer {
  private graphService: MemgraphService;
  private maxDepth: number;
  private limit: number;

  constructor(config: DependencyAnalyzerConfig) {
    this.graphService = config.graphService;
    this.maxDepth = config.maxDepth ?? 5;
    this.limit = config.limit ?? CYPHER_DEFAULT_LIMIT;
    logger.debug('[dependency-analyzer] Initialized');
  }

  /**
   * Find functions/methods that call the target.
   * If depth > 1, uses transitive (variable-length) traversal.
   */
  async findCallers(
    qualifiedNameOrName: string,
    limit?: number,
    depth: number = 1
  ): Promise<DependencyNode[]> {
    logger.info(`[dependency-analyzer] Finding callers of: ${qualifiedNameOrName} (depth=${depth})`);

    let query = CYPHER_FIND_CALLERS;
    if (depth > 1) {
      // Use transitive query — substitute $maxDepth before withLimit
      query = CYPHER_FIND_CALLERS_TRANSITIVE.replace('$maxDepth', String(Math.floor(depth)));
    }
    const results = await this.graphService.fetchAll(withLimit(query, limit ?? this.limit), {
      qualified_name: qualifiedNameOrName,
      name: qualifiedNameOrName,
    });

    return this.mapToNodes(results, 'caller');
  }

  /**
   * Find functions/methods called by the target.
   * If depth > 1, uses transitive (variable-length) traversal.
   */
  async findCallees(
    qualifiedNameOrName: string,
    limit?: number,
    depth: number = 1
  ): Promise<DependencyNode[]> {
    logger.info(`[dependency-analyzer] Finding callees of: ${qualifiedNameOrName} (depth=${depth})`);

    let query = CYPHER_FIND_CALLEES;
    if (depth > 1) {
      query = CYPHER_FIND_CALLEES_TRANSITIVE.replace('$maxDepth', String(Math.floor(depth)));
    }
    const results = await this.graphService.fetchAll(withLimit(query, limit ?? this.limit), {
      qualified_name: qualifiedNameOrName,
      name: qualifiedNameOrName,
    });

    return this.mapToNodes(results, 'callee');
  }

  /**
   * Get full dependency information for a node.
   * @param qualifiedNameOrName Full qualified name OR bare class/function name (Bug #1 fix)
   * @param depth Traversal depth for callers/callees (default 1, supports transitive traces)
   */
  async analyzeDependencies(
    qualifiedNameOrName: string,
    depth: number = 1
  ): Promise<DependencyResult | null> {
    logger.info(`[dependency-analyzer] Analyzing dependencies for: ${qualifiedNameOrName} (depth=${depth})`);

    // Find the target node — supports bare names via CYPHER_FIND_NODE_BY_NAME
    const targetResults = await this.graphService.fetchAll(CYPHER_FIND_NODE_BY_NAME, {
      qualified_name: qualifiedNameOrName,
      name: qualifiedNameOrName,
    });

    if (!targetResults || targetResults.length === 0) {
      logger.warn(`[dependency-analyzer] Node not found: ${qualifiedNameOrName}`);
      return null;
    }

    const targetRow = targetResults[0];
    const target: DependencyNode = {
      qualified_name: targetRow.qualified_name as string,
      name: targetRow.name as string,
      type: this.extractType(targetRow.type),
      file_path: targetRow.file_path as string | undefined,
      start_line: targetRow.start_line as number | undefined,
      end_line: targetRow.end_line as number | undefined,
    };

    // Find callers and callees — use the resolved full QN to avoid bare-name re-search
    // Pass depth through so transitive traversal works (Bug #2 fix)
    const [callers, callees] = await Promise.all([
      this.findCallers(target.qualified_name, undefined, depth),
      this.findCallees(target.qualified_name, undefined, depth),
    ]);

    return { target, callers, callees };
  }

  /**
   * Find call chains starting from a node (forward direction)
   */
  async findCallChains(
    qualifiedNameOrName: string,
    maxDepth?: number,
    limit?: number
  ): Promise<CallChain[]> {
    logger.info(`[dependency-analyzer] Finding call chains from: ${qualifiedNameOrName}`);

    const depth = maxDepth ?? this.maxDepth;
    const query = CYPHER_CALL_CHAIN_DEPTH.replace('$maxDepth', String(depth));

    const results = await this.graphService.fetchAll(withLimit(query, limit ?? this.limit), {
      qualified_name: qualifiedNameOrName,
    });

    return this.mapToCallChains(results);
  }

  /**
   * Find reverse call chains (who calls this, and who calls them)
   */
  async findReverseCallChains(
    qualifiedNameOrName: string,
    maxDepth?: number,
    limit?: number
  ): Promise<CallChain[]> {
    logger.info(`[dependency-analyzer] Finding reverse call chains to: ${qualifiedNameOrName}`);

    const depth = maxDepth ?? this.maxDepth;
    const query = CYPHER_REVERSE_CALL_CHAIN.replace('$maxDepth', String(depth));

    const results = await this.graphService.fetchAll(withLimit(query, limit ?? this.limit), {
      qualified_name: qualifiedNameOrName,
    });

    return this.mapToCallChains(results);
  }

  /**
   * Get dependency statistics (most called, most calling)
   */
  async getDependencyStats(limit?: number): Promise<ResultRow[]> {
    logger.info('[dependency-analyzer] Getting dependency statistics');

    return this.graphService.fetchAll(withLimit(CYPHER_DEPENDENCY_STATS, limit ?? this.limit), {});
  }

  /**
   * Find highly connected nodes (potential core functions)
   */
  async findHighlyConnected(limit?: number): Promise<ResultRow[]> {
    logger.info('[dependency-analyzer] Finding highly connected nodes');

    return this.graphService.fetchAll(withLimit(CYPHER_HIGHLY_CONNECTED, limit ?? this.limit), {});
  }

  /**
   * Find circular dependencies (if any)
   */
  async findCircularDependencies(limit?: number): Promise<CallChain[]> {
    logger.info('[dependency-analyzer] Finding circular dependencies');

    const query = `
      MATCH path = (n)-[:CALLS*2..${this.maxDepth}]->(n)
      WHERE n:Function OR n:Method
      RETURN DISTINCT
        [node IN nodes(path) | node.qualified_name] AS chain_qns,
        [node IN nodes(path) | node.name] AS chain_names,
        [node IN nodes(path) | labels(node)[0]] AS chain_types,
        length(path) AS depth
      ORDER BY depth
      LIMIT $limit
    `;

    const results = await this.graphService.fetchAll(withLimit(query, limit ?? this.limit), {});

    return this.mapToCallChains(results);
  }

  /**
   * Find orphan functions (no callers or callees)
   */

  async findOrphanFunctions(limit?: number): Promise<DependencyNode[]> {
    logger.info('[dependency-analyzer] Finding orphan functions');

    const query = `
      MATCH (n)
      WHERE (n:Function OR n:Method)
        AND NOT (n)-[:CALLS]->()
        AND NOT ()-[:CALLS]->(n)
      OPTIONAL MATCH (m:Module)-[:DEFINES|DEFINES_METHOD*]->(n)
      RETURN
        n.qualified_name AS qualified_name,
        n.name AS name,
        labels(n) AS type,
        m.path AS file_path,
        n.start_line AS start_line,
        n.end_line AS end_line
      ORDER BY qualified_name
      LIMIT $limit
    `;

    const results = await this.graphService.fetchAll(withLimit(query, limit ?? this.limit), {});

    return results.map(row => ({
      qualified_name: row.qualified_name as string,
      name: row.name as string,
      type: this.extractType(row.type),
      file_path: row.file_path as string | undefined,
      start_line: row.start_line as number | undefined,
      end_line: row.end_line as number | undefined,
    }));
  }

  // ===========================================================================
  // Helper Methods
  // ===========================================================================

  private mapToNodes(results: ResultRow[], prefix: string): DependencyNode[] {
    return results.map(row => ({
      qualified_name: row[`${prefix}_qn`] as string,
      name: row[`${prefix}_name`] as string,
      type: this.extractType(row[`${prefix}_type`]),
      file_path: row.file_path as string | undefined,
      start_line: row.start_line as number | undefined,
      end_line: row.end_line as number | undefined,
      confidence: row.confidence as number | undefined,
    }));
  }

  private mapToCallChains(results: ResultRow[]): CallChain[] {
    return results.map(row => {
      const qns = row.chain_qns as string[];
      const names = row.chain_names as string[];
      const types = row.chain_types as string[];

      const path: DependencyNode[] = qns.map((qn, i) => ({
        qualified_name: qn,
        name: names[i] || '',
        type: types[i] || 'Unknown',
      }));

      return {
        path,
        depth: row.depth as number,
      };
    });
  }

  private extractType(typeValue: unknown): string {
    if (Array.isArray(typeValue) && typeValue.length > 0) {
      return typeValue[0] as string;
    }
    if (typeof typeValue === 'string') {
      return typeValue;
    }
    return 'Unknown';
  }
}

// =============================================================================
// Tool Interface for pi-coding-agent
// =============================================================================

export interface DependencyAnalyzerToolInput {
  qualified_name: string;
  analysis_type: 'callers' | 'callees' | 'full' | 'call_chains' | 'reverse_chains';
  max_depth?: number;
  limit?: number;
}

export interface DependencyAnalyzerToolResult {
  success: boolean;
  target?: string;
  callers?: DependencyNode[];
  callees?: DependencyNode[];
  call_chains?: CallChain[];
  message?: string;
  error?: string;
}

/**
 * Tool function for pi-coding-agent integration
 */
export async function analyzeDependencies(
  input: DependencyAnalyzerToolInput,
  analyzer: DependencyAnalyzer
): Promise<DependencyAnalyzerToolResult> {
  logger.info(`[dependency-analyzer] Tool called: ${input.analysis_type} for ${input.qualified_name}`);

  try {
    switch (input.analysis_type) {
      case 'callers': {
        const callers = await analyzer.findCallers(input.qualified_name, input.limit);
        return {
          success: true,
          target: input.qualified_name,
          callers,
          message: `Found ${callers.length} caller(s) of ${input.qualified_name}`,
        };
      }

      case 'callees': {
        const callees = await analyzer.findCallees(input.qualified_name, input.limit);
        return {
          success: true,
          target: input.qualified_name,
          callees,
          message: `Found ${callees.length} callee(s) of ${input.qualified_name}`,
        };
      }

      case 'full': {
        const result = await analyzer.analyzeDependencies(input.qualified_name);
        if (!result) {
          return {
            success: false,
            error: `Node not found: ${input.qualified_name}`,
          };
        }
        return {
          success: true,
          target: result.target.qualified_name,
          callers: result.callers,
          callees: result.callees,
          message: `${input.qualified_name}: ${result.callers.length} caller(s), ${result.callees.length} callee(s)`,
        };
      }

      case 'call_chains': {
        const chains = await analyzer.findCallChains(
          input.qualified_name,
          input.max_depth,
          input.limit
        );
        return {
          success: true,
          target: input.qualified_name,
          call_chains: chains,
          message: `Found ${chains.length} call chain(s) starting from ${input.qualified_name}`,
        };
      }

      case 'reverse_chains': {
        const chains = await analyzer.findReverseCallChains(
          input.qualified_name,
          input.max_depth,
          input.limit
        );
        return {
          success: true,
          target: input.qualified_name,
          call_chains: chains,
          message: `Found ${chains.length} reverse call chain(s) to ${input.qualified_name}`,
        };
      }

      default:
        return {
          success: false,
          error: `Unknown analysis type: ${input.analysis_type}`,
        };
    }
  } catch (error) {
    return {
      success: false,
      error: (error as Error).message,
    };
  }
}

// =============================================================================
// Tool Description
// =============================================================================

export const DEPENDENCY_ANALYZER_TOOL_NAME = 'analyze_dependencies';

export const DEPENDENCY_ANALYZER_TOOL_DESCRIPTION =
  'Analyzes code dependencies by examining caller/callee relationships. ' +
  "Can find what calls a function, what a function calls, or trace call chains. " +
  "Useful for understanding code impact and refactoring scope.";

export const DEPENDENCY_ANALYZER_TOOL_SCHEMA = {
  name: DEPENDENCY_ANALYZER_TOOL_NAME,
  description: DEPENDENCY_ANALYZER_TOOL_DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      qualified_name: {
        type: 'string',
        description: 'Qualified name or simple name of the function/method to analyze',
      },
      analysis_type: {
        type: 'string',
        enum: ['callers', 'callees', 'full', 'call_chains', 'reverse_chains'],
        description: 'Type of analysis: callers, callees, full (both), call_chains, or reverse_chains',
      },
      max_depth: {
        type: 'number',
        description: 'Maximum depth for call chain analysis (default: 5)',
        default: 5,
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results (default: 50)',
        default: 50,
      },
    },
    required: ['qualified_name', 'analysis_type'],
  },
};

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a DependencyAnalyzer instance
 */
export function createDependencyAnalyzer(
  graphService: MemgraphService,
  config?: Omit<DependencyAnalyzerConfig, 'graphService'>
): DependencyAnalyzer {
  return new DependencyAnalyzer({
    graphService,
    ...config,
  });
}

export default DependencyAnalyzer;
