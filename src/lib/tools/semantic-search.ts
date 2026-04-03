import { logger } from '../logger.js';
/**
 * Semantic Search Tool - Embedding-based code search
 * Ported from codebase_rag/tools/semantic_search.py
 */

import { readFile } from 'fs/promises';
import { join, resolve } from 'path';
import { MemgraphService } from '../graph-service.js';
import {
  SemanticSearchService,
} from '../embeddings.js';
import { CYPHER_GET_FUNCTION_SOURCE_LOCATION } from '../cypher-queries.js';
import { SemanticSearchResult } from '../types.js';
import {
  ENCODING_UTF8,
  SEMANTIC_TYPE_UNKNOWN,
} from '../constants.js';

// =============================================================================
// Types
// =============================================================================

export interface SemanticSearchConfig {
  projectRoot: string;
  projectName: string;
  graphService: MemgraphService;
  semanticSearchService: SemanticSearchService;
}

export interface SemanticSearchToolConfig {
  projectRoot: string;
  projectName: string;
  graphService: MemgraphService;
  semanticSearchService?: SemanticSearchService;
}

export interface SearchResultWithSource extends SemanticSearchResult {
  source_code?: string;
  file_path?: string;
  start_line?: number;
  end_line?: number;
}

// =============================================================================
// SemanticSearchTool Class
// =============================================================================

/**
 * Tool for semantic (embedding-based) code search
 */
export class SemanticSearchTool {
  private projectRoot: string;
  private projectName: string;
  private graphService: MemgraphService;
  private semanticSearchService: SemanticSearchService;

  constructor(config: SemanticSearchConfig) {
    this.projectRoot = resolve(config.projectRoot);
    this.projectName = config.projectName;
    this.graphService = config.graphService;
    this.semanticSearchService = config.semanticSearchService;
    logger.debug(`[semantic-search] Initialized for project: ${this.projectName}`);
  }

  /**
   * Check if the search service is ready
   */
  isIndexReady(): boolean {
    return true; // zvec-backed store is always ready after initialization
  }

  /**
   * Search for code using natural language query
   */
  async search(query: string, topK: number = 5): Promise<SemanticSearchResult[]> {
    logger.info(`[semantic-search] Searching for: "${query}" (top ${topK})`);

    try {
      // Use SemanticSearchService to embed query and search zvec
      const vectorResults = await this.semanticSearchService.search(query, {
        topK,
        project: this.projectName,
      });

      // Map vector results to SemanticSearchResult format
      const results: SemanticSearchResult[] = vectorResults.map(r => {
        const parts = r.qualifiedName.split('.');
        return {
          node_id: 0, // zvec results don't carry graph node IDs
          qualified_name: r.qualifiedName,
          name: parts[parts.length - 1] || '',
          type: r.nodeType || SEMANTIC_TYPE_UNKNOWN,
          score: Math.round(r.score * 1000) / 1000,
        };
      });

      logger.info(`[semantic-search] Found ${results.length} results for: "${query}"`);
      return results;
    } catch (error) {
      logger.error('[semantic-search] Search error:', error);
      return [];
    }
  }

  /**
   * Get source code for a specific node ID
   */
  async getSourceCode(nodeId: number): Promise<string | null> {
    try {
      const results = await this.graphService.fetchAll(
        CYPHER_GET_FUNCTION_SOURCE_LOCATION,
        { node_id: nodeId }
      );

      if (!results || results.length === 0) {
        logger.warn(`[semantic-search] Node ${nodeId} not found`);
        return null;
      }

      const row = results[0];
      const filePath = row.path as string | null;
      const startLine = row.start_line as number | null;
      const endLine = row.end_line as number | null;

      if (!filePath || startLine === null || endLine === null) {
        logger.warn(`[semantic-search] Incomplete location for node ${nodeId}`);
        return null;
      }

      const fullPath = join(this.projectRoot, filePath);
      const content = await readFile(fullPath, { encoding: ENCODING_UTF8 as BufferEncoding });
      const lines = content.split('\n');
      
      return lines.slice(startLine - 1, endLine).join('\n');
    } catch (error) {
      logger.error(`[semantic-search] Error getting source for node ${nodeId}:`, error);
      return null;
    }
  }

  /**
   * Get source code for a search result by qualified name
   */
  async getSourceForResult(qualifiedName: string): Promise<string | null> {
    try {
      const results = await this.graphService.fetchAll(
        CYPHER_GET_FUNCTION_SOURCE_LOCATION,
        { qualified_name: qualifiedName }
      );

      if (!results || results.length === 0) {
        return null;
      }

      const row = results[0];
      const filePath = row.path as string | null;
      const startLine = row.start_line as number | null;
      const endLine = row.end_line as number | null;

      if (!filePath || startLine === null || endLine === null) {
        return null;
      }

      const fullPath = join(this.projectRoot, filePath);
      const content = await readFile(fullPath, { encoding: ENCODING_UTF8 as BufferEncoding });
      const lines = content.split('\n');
      return lines.slice(startLine - 1, endLine).join('\n');
    } catch (error) {
      logger.error(`[semantic-search] Error getting source for ${qualifiedName}:`, error);
      return null;
    }
  }

  /**
   * Search with source code included
   */
  async searchWithSource(
    query: string,
    topK: number = 5
  ): Promise<SearchResultWithSource[]> {
    const results = await this.search(query, topK);
    const resultsWithSource: SearchResultWithSource[] = [];

    for (const result of results) {
      const source = await this.getSourceForResult(result.qualified_name);

      // Fetch location info
      const locationResults = await this.graphService.fetchAll(
        CYPHER_GET_FUNCTION_SOURCE_LOCATION,
        { qualified_name: result.qualified_name }
      );

      const location = locationResults?.[0];

      resultsWithSource.push({
        ...result,
        source_code: source || undefined,
        file_path: location?.path as string | undefined,
        start_line: location?.start_line as number | undefined,
        end_line: location?.end_line as number | undefined,
      });
    }

    return resultsWithSource;
  }
}

// =============================================================================
// Tool Interface for pi-coding-agent
// =============================================================================

export interface SemanticSearchToolInput {
  query: string;
  top_k?: number;
}

export interface SemanticSearchToolResult {
  success: boolean;
  results?: SemanticSearchResult[];
  message?: string;
  error?: string;
}

/**
 * Tool function for pi-coding-agent integration
 */
export async function semanticSearchFunctions(
  input: SemanticSearchToolInput,
  tool: SemanticSearchTool
): Promise<SemanticSearchToolResult> {
  logger.info(`[semantic-search] Tool called with query: "${input.query}"`);

  try {
    const results = await tool.search(input.query, input.top_k ?? 5);

    if (results.length === 0) {
      return {
        success: true,
        results: [],
        message: `No functions found matching: "${input.query}"`,
      };
    }

    return {
      success: true,
      results,
      message: `Found ${results.length} function(s) matching: "${input.query}"`,
    };
  } catch (error) {
    return {
      success: false,
      error: (error as Error).message,
    };
  }
}

/**
 * Tool function to get source code by node ID
 */
export async function getFunctionSource(
  nodeId: number,
  tool: SemanticSearchTool
): Promise<{ success: boolean; source_code?: string; error?: string }> {
  logger.info(`[semantic-search] Getting source for node: ${nodeId}`);

  try {
    const source = await tool.getSourceCode(nodeId);

    if (source === null) {
      return {
        success: false,
        error: `Source code not found for node ID: ${nodeId}`,
      };
    }

    return {
      success: true,
      source_code: source,
    };
  } catch (error) {
    return {
      success: false,
      error: (error as Error).message,
    };
  }
}

// =============================================================================
// Tool Descriptions
// =============================================================================

export const SEMANTIC_SEARCH_TOOL_NAME = 'semantic_search';

export const SEMANTIC_SEARCH_TOOL_DESCRIPTION =
  'Performs a semantic search for functions based on a natural language query ' +
  'describing their purpose, returning a list of potential matches with similarity scores.';

export const SEMANTIC_SEARCH_TOOL_SCHEMA = {
  name: SEMANTIC_SEARCH_TOOL_NAME,
  description: SEMANTIC_SEARCH_TOOL_DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Natural language description of the function you are looking for',
      },
      top_k: {
        type: 'number',
        description: 'Maximum number of results to return (default: 5)',
        default: 5,
      },
    },
    required: ['query'],
  },
};

export const GET_FUNCTION_SOURCE_TOOL_NAME = 'get_function_source';

export const GET_FUNCTION_SOURCE_TOOL_DESCRIPTION =
  'Retrieves the source code for a specific function or method using its internal node ID, ' +
  'typically obtained from a semantic search result.';

export const GET_FUNCTION_SOURCE_TOOL_SCHEMA = {
  name: GET_FUNCTION_SOURCE_TOOL_NAME,
  description: GET_FUNCTION_SOURCE_TOOL_DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      node_id: {
        type: 'number',
        description: 'Internal node ID from semantic search result',
      },
    },
    required: ['node_id'],
  },
};

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create a SemanticSearchTool instance
 */
export function createSemanticSearchTool(
  config: SemanticSearchConfig
): SemanticSearchTool {
  return new SemanticSearchTool(config);
}

/**
 * Create a SemanticSearchTool with optional SemanticSearchService
 */
export async function createSemanticSearchToolWithDefaults(
  config: SemanticSearchToolConfig
): Promise<SemanticSearchTool | null> {
  if (!config.semanticSearchService) {
    logger.warn('[semantic-search] No SemanticSearchService available.');
    return null;
  }

  return new SemanticSearchTool({
    projectRoot: config.projectRoot,
    projectName: config.projectName,
    graphService: config.graphService,
    semanticSearchService: config.semanticSearchService,
  });
}

export default SemanticSearchTool;
