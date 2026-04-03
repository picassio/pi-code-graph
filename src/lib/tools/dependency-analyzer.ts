/**
 * Dependency Analyzer Tool - Analyze callers/callees relationships
 * Provides tools for analyzing code dependencies through the knowledge graph
 */

import { MemgraphService } from '../graph-service.js';
import { ResultRow } from '../types.js';
import { CYPHER_DEFAULT_LIMIT, RelationshipType, NodeLabel } from '../constants.js';

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

const CYPHER_FIND_CALLERS = `
MATCH (caller)-[:CALLS]->(target)
WHERE target.qualified_name = $qualified_name
  OR target.name = $name
OPTIONAL MATCH (m:Module)-[:DEFINES|DEFINES_METHOD*]->(caller)
RETURN DISTINCT
  caller.qualified_name AS caller_qn,
  caller.name AS caller_name,
  labels(caller) AS caller_type,
  m.path AS file_path,
  caller.start_line AS start_line,
  caller.end_line AS end_line
ORDER BY caller_qn
LIMIT $limit
`;

const CYPHER_FIND_CALLEES = `
MATCH (source)-[:CALLS]->(callee)
WHERE source.qualified_name = $qualified_name
  OR source.name = $name
OPTIONAL MATCH (m:Module)-[:DEFINES|DEFINES_METHOD*]->(callee)
RETURN DISTINCT
  callee.qualified_name AS callee_qn,
  callee.name AS callee_name,
  labels(callee) AS callee_type,
  m.path AS file_path,
  callee.start_line AS start_line,
  callee.end_line AS end_line
ORDER BY callee_qn
LIMIT $limit
`;

const CYPHER_FIND_NODE_BY_NAME = `
MATCH (n)
WHERE n.qualified_name = $qualified_name
  OR (n.name = $name AND (n:Function OR n:Method OR n:Class))
OPTIONAL MATCH (m:Module)-[:DEFINES|DEFINES_METHOD*]->(n)
RETURN
  n.qualified_name AS qualified_name,
  n.name AS name,
  labels(n) AS type,
  m.path AS file_path,
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
    console.debug('[dependency-analyzer] Initialized');
  }

  /**
   * Find all functions/methods that call the target
   */
  async findCallers(
    qualifiedNameOrName: string,
    limit?: number
  ): Promise<DependencyNode[]> {
    console.info(`[dependency-analyzer] Finding callers of: ${qualifiedNameOrName}`);

    const results = await this.graphService.fetchAll(CYPHER_FIND_CALLERS, {
      qualified_name: qualifiedNameOrName,
      name: qualifiedNameOrName,
      limit: limit ?? this.limit,
    });

    return this.mapToNodes(results, 'caller');
  }

  /**
   * Find all functions/methods called by the target
   */
  async findCallees(
    qualifiedNameOrName: string,
    limit?: number
  ): Promise<DependencyNode[]> {
    console.info(`[dependency-analyzer] Finding callees of: ${qualifiedNameOrName}`);

    const results = await this.graphService.fetchAll(CYPHER_FIND_CALLEES, {
      qualified_name: qualifiedNameOrName,
      name: qualifiedNameOrName,
      limit: limit ?? this.limit,
    });

    return this.mapToNodes(results, 'callee');
  }

  /**
   * Get full dependency information for a node
   */
  async analyzeDependencies(qualifiedNameOrName: string): Promise<DependencyResult | null> {
    console.info(`[dependency-analyzer] Analyzing dependencies for: ${qualifiedNameOrName}`);

    // Find the target node
    const targetResults = await this.graphService.fetchAll(CYPHER_FIND_NODE_BY_NAME, {
      qualified_name: qualifiedNameOrName,
      name: qualifiedNameOrName,
    });

    if (!targetResults || targetResults.length === 0) {
      console.warn(`[dependency-analyzer] Node not found: ${qualifiedNameOrName}`);
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

    // Find callers and callees
    const [callers, callees] = await Promise.all([
      this.findCallers(target.qualified_name),
      this.findCallees(target.qualified_name),
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
    console.info(`[dependency-analyzer] Finding call chains from: ${qualifiedNameOrName}`);

    const depth = maxDepth ?? this.maxDepth;
    const query = CYPHER_CALL_CHAIN_DEPTH.replace('$maxDepth', String(depth));

    const results = await this.graphService.fetchAll(query, {
      qualified_name: qualifiedNameOrName,
      limit: limit ?? this.limit,
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
    console.info(`[dependency-analyzer] Finding reverse call chains to: ${qualifiedNameOrName}`);

    const depth = maxDepth ?? this.maxDepth;
    const query = CYPHER_REVERSE_CALL_CHAIN.replace('$maxDepth', String(depth));

    const results = await this.graphService.fetchAll(query, {
      qualified_name: qualifiedNameOrName,
      limit: limit ?? this.limit,
    });

    return this.mapToCallChains(results);
  }

  /**
   * Get dependency statistics (most called, most calling)
   */
  async getDependencyStats(limit?: number): Promise<ResultRow[]> {
    console.info('[dependency-analyzer] Getting dependency statistics');

    return this.graphService.fetchAll(CYPHER_DEPENDENCY_STATS, {
      limit: limit ?? this.limit,
    });
  }

  /**
   * Find highly connected nodes (potential core functions)
   */
  async findHighlyConnected(limit?: number): Promise<ResultRow[]> {
    console.info('[dependency-analyzer] Finding highly connected nodes');

    return this.graphService.fetchAll(CYPHER_HIGHLY_CONNECTED, {
      limit: limit ?? this.limit,
    });
  }

  /**
   * Find circular dependencies (if any)
   */
  async findCircularDependencies(limit?: number): Promise<CallChain[]> {
    console.info('[dependency-analyzer] Finding circular dependencies');

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

    const results = await this.graphService.fetchAll(query, {
      limit: limit ?? this.limit,
    });

    return this.mapToCallChains(results);
  }

  /**
   * Find orphan functions (no callers or callees)
   */
  async findOrphanFunctions(limit?: number): Promise<DependencyNode[]> {
    console.info('[dependency-analyzer] Finding orphan functions');

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

    const results = await this.graphService.fetchAll(query, {
      limit: limit ?? this.limit,
    });

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
  console.info(`[dependency-analyzer] Tool called: ${input.analysis_type} for ${input.qualified_name}`);

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
