/**
 * Codebase Query Tool - Natural language queries to the knowledge graph
 * Ported from codebase_rag/tools/codebase_query.py
 */

import { MemgraphService } from '../graph-service.js';
import {
  CypherGenerator,
  LLMGenerationError,
  CypherGeneratorConfig,
} from '../llm-service.js';
import { ResultRow } from '../types.js';
import { CYPHER_DEFAULT_LIMIT } from '../constants.js';

// =============================================================================
// Types
// =============================================================================

export interface QueryGraphData {
  query_used: string;
  results: ResultRow[];
  summary: string;
  error?: string;
}

export interface QueryConfig {
  maxResultRows?: number;
  maxTokens?: number;
  verbose?: boolean;
}

export interface CodebaseQueryToolConfig {
  graphService: MemgraphService;
  cypherGenerator: CypherGenerator;
  config?: QueryConfig;
}

// =============================================================================
// Constants
// =============================================================================

const QUERY_NOT_AVAILABLE = 'Query generation failed';
const DEFAULT_MAX_RESULT_ROWS = CYPHER_DEFAULT_LIMIT;
const DEFAULT_MAX_TOKENS = 8000;

// =============================================================================
// Result Truncation Utilities
// =============================================================================

/**
 * Simple token estimation (words + punctuation)
 */
function estimateTokens(text: string): number {
  // Rough estimate: ~4 characters per token on average
  return Math.ceil(text.length / 4);
}

/**
 * Truncate results to fit within token limits
 */
function truncateResultsByTokens(
  results: ResultRow[],
  maxTokens: number,
  originalTotal: number
): {
  results: ResultRow[];
  tokensUsed: number;
  wasTruncated: boolean;
} {
  let tokensUsed = 0;
  const truncatedResults: ResultRow[] = [];

  for (const row of results) {
    const rowStr = JSON.stringify(row);
    const rowTokens = estimateTokens(rowStr);

    if (tokensUsed + rowTokens > maxTokens) {
      break;
    }

    truncatedResults.push(row);
    tokensUsed += rowTokens;
  }

  return {
    results: truncatedResults,
    tokensUsed,
    wasTruncated: truncatedResults.length < results.length || truncatedResults.length < originalTotal,
  };
}

// =============================================================================
// Summary Generation
// =============================================================================

function formatSummarySuccess(count: number): string {
  return `Query returned ${count} result(s).`;
}

function formatSummaryTruncated(
  kept: number,
  total: number,
  tokens: number,
  maxTokens: number
): string {
  return `Results truncated: showing ${kept} of ${total} results (${tokens}/${maxTokens} tokens).`;
}

function formatSummaryTranslationFailed(error: string): string {
  return `Failed to translate natural language to Cypher: ${error}`;
}

function formatSummaryDbError(error: string): string {
  return `Database query error: ${error}`;
}

// =============================================================================
// CodebaseQueryTool Class
// =============================================================================

/**
 * Tool for querying the codebase knowledge graph using natural language
 */
export class CodebaseQueryTool {
  private graphService: MemgraphService;
  private cypherGenerator: CypherGenerator;
  private maxResultRows: number;
  private maxTokens: number;
  private verbose: boolean;

  constructor(config: CodebaseQueryToolConfig) {
    this.graphService = config.graphService;
    this.cypherGenerator = config.cypherGenerator;
    this.maxResultRows = config.config?.maxResultRows ?? DEFAULT_MAX_RESULT_ROWS;
    this.maxTokens = config.config?.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.verbose = config.config?.verbose ?? false;
  }

  /**
   * Query the codebase knowledge graph using natural language
   */
  async queryCodebaseKnowledgeGraph(
    naturalLanguageQuery: string
  ): Promise<QueryGraphData> {
    if (this.verbose) {
      console.info(`[codebase-query] Received query: ${naturalLanguageQuery}`);
    }

    let cypherQuery = QUERY_NOT_AVAILABLE;

    try {
      // Generate Cypher from natural language
      cypherQuery = await this.cypherGenerator.generate(naturalLanguageQuery);

      if (this.verbose) {
        console.info(`[codebase-query] Generated Cypher: ${cypherQuery}`);
      }

      // Execute the query
      const results = await this.graphService.fetchAll(cypherQuery);

      const totalCount = results.length;

      // Apply row cap
      let cappedResults = results;
      if (totalCount > this.maxResultRows) {
        cappedResults = results.slice(0, this.maxResultRows);
      }

      // Apply token truncation
      const { results: truncatedResults, tokensUsed, wasTruncated } = truncateResultsByTokens(
        cappedResults,
        this.maxTokens,
        totalCount
      );

      // Generate summary
      let summary: string;
      if (wasTruncated || totalCount > truncatedResults.length) {
        summary = formatSummaryTruncated(
          truncatedResults.length,
          totalCount,
          tokensUsed,
          this.maxTokens
        );
      } else {
        summary = formatSummarySuccess(truncatedResults.length);
      }

      // Log results table if verbose
      if (this.verbose && truncatedResults.length > 0) {
        console.info('[codebase-query] Results:');
        console.table(truncatedResults.slice(0, 10));
        if (truncatedResults.length > 10) {
          console.info(`  ... and ${truncatedResults.length - 10} more rows`);
        }
      }

      return {
        query_used: cypherQuery,
        results: truncatedResults,
        summary,
      };
    } catch (error) {
      if (error instanceof LLMGenerationError) {
        console.error(`[codebase-query] LLM generation error:`, error.message);
        return {
          query_used: QUERY_NOT_AVAILABLE,
          results: [],
          summary: formatSummaryTranslationFailed(error.message),
          error: error.message,
        };
      }

      console.error(`[codebase-query] Query error:`, error);
      return {
        query_used: cypherQuery,
        results: [],
        summary: formatSummaryDbError((error as Error).message),
        error: (error as Error).message,
      };
    }
  }

  /**
   * Execute a raw Cypher query (bypassing LLM generation)
   */
  async executeRawQuery(cypherQuery: string): Promise<QueryGraphData> {
    if (this.verbose) {
      console.info(`[codebase-query] Executing raw Cypher: ${cypherQuery}`);
    }

    try {
      const results = await this.graphService.fetchAll(cypherQuery);
      const totalCount = results.length;

      let cappedResults = results;
      if (totalCount > this.maxResultRows) {
        cappedResults = results.slice(0, this.maxResultRows);
      }

      const { results: truncatedResults, tokensUsed, wasTruncated } = truncateResultsByTokens(
        cappedResults,
        this.maxTokens,
        totalCount
      );

      let summary: string;
      if (wasTruncated || totalCount > truncatedResults.length) {
        summary = formatSummaryTruncated(
          truncatedResults.length,
          totalCount,
          tokensUsed,
          this.maxTokens
        );
      } else {
        summary = formatSummarySuccess(truncatedResults.length);
      }

      return {
        query_used: cypherQuery,
        results: truncatedResults,
        summary,
      };
    } catch (error) {
      return {
        query_used: cypherQuery,
        results: [],
        summary: formatSummaryDbError((error as Error).message),
        error: (error as Error).message,
      };
    }
  }
}

// =============================================================================
// Tool Interface for pi-coding-agent
// =============================================================================

export interface CodebaseQueryToolInput {
  natural_language_query: string;
}

export interface CodebaseQueryToolResult {
  success: boolean;
  data?: QueryGraphData;
  error?: string;
}

/**
 * Tool function for pi-coding-agent integration
 */
export async function queryCodebaseGraph(
  input: CodebaseQueryToolInput,
  tool: CodebaseQueryTool
): Promise<CodebaseQueryToolResult> {
  console.info(`[codebase-query] Tool called with: ${input.natural_language_query}`);

  try {
    const data = await tool.queryCodebaseKnowledgeGraph(input.natural_language_query);

    if (data.error) {
      return {
        success: false,
        data,
        error: data.error,
      };
    }

    return {
      success: true,
      data,
    };
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

export const CODEBASE_QUERY_TOOL_NAME = 'query_graph';

export const CODEBASE_QUERY_TOOL_DESCRIPTION =
  'Query the codebase knowledge graph using natural language questions. ' +
  "Ask in plain English about classes, functions, methods, dependencies, or code structure. " +
  "Examples: 'Find all functions that call each other', " +
  "'What classes are in the user module', " +
  "'Show me functions with the longest call chains'.";

export const CODEBASE_QUERY_TOOL_SCHEMA = {
  name: CODEBASE_QUERY_TOOL_NAME,
  description: CODEBASE_QUERY_TOOL_DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      natural_language_query: {
        type: 'string',
        description: 'Your question in plain English about the codebase',
      },
    },
    required: ['natural_language_query'],
  },
};

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a CodebaseQueryTool instance
 */
export function createCodebaseQueryTool(
  graphService: MemgraphService,
  cypherGenerator: CypherGenerator,
  config?: QueryConfig
): CodebaseQueryTool {
  return new CodebaseQueryTool({
    graphService,
    cypherGenerator,
    config,
  });
}

/**
 * Create a CodebaseQueryTool with auto-configured CypherGenerator
 */
export function createCodebaseQueryToolWithDefaults(
  graphService: MemgraphService,
  cypherConfig?: CypherGeneratorConfig,
  queryConfig?: QueryConfig
): CodebaseQueryTool {
  const cypherGenerator = new CypherGenerator(cypherConfig);
  return createCodebaseQueryTool(graphService, cypherGenerator, queryConfig);
}

export default CodebaseQueryTool;
