import { logger } from '../logger.js';
/**
 * Semantic Search Tool - Embedding-based code search
 * Ported from codebase_rag/tools/semantic_search.py
 */

import { readFile } from 'fs/promises';
import { join, resolve } from 'path';
import { MemgraphService } from '../graph-service.js';
import {
  EmbeddingService,
  cosineSimilarity,
  getEmbeddingService,
} from '../embeddings.js';
import { buildNodesByIdsQuery, CYPHER_GET_FUNCTION_SOURCE_LOCATION } from '../cypher-queries.js';
import { SemanticSearchResult, EmbeddingQueryResult } from '../types.js';
import {
  ENCODING_UTF8,
  SEMANTIC_TYPE_UNKNOWN,
  CYPHER_QUERY_EMBEDDINGS,
} from '../constants.js';

// =============================================================================
// Types
// =============================================================================

export interface SemanticSearchConfig {
  projectRoot: string;
  projectName: string;
  graphService: MemgraphService;
  embeddingService: EmbeddingService;
}

export interface SemanticSearchToolConfig {
  projectRoot: string;
  projectName: string;
  graphService: MemgraphService;
  embeddingService?: EmbeddingService;
}

export interface SearchResultWithSource extends SemanticSearchResult {
  source_code?: string;
  file_path?: string;
  start_line?: number;
  end_line?: number;
}

export interface EmbeddingIndex {
  nodeIds: number[];
  embeddings: number[][];
  qualifiedNames: string[];
  nodeIdToIndex: Map<number, number>;
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
  private embeddingService: EmbeddingService;
  private embeddingIndex: EmbeddingIndex | null = null;
  private indexingInProgress = false;

  constructor(config: SemanticSearchConfig) {
    this.projectRoot = resolve(config.projectRoot);
    this.projectName = config.projectName;
    this.graphService = config.graphService;
    this.embeddingService = config.embeddingService;
    logger.debug(`[semantic-search] Initialized for project: ${this.projectName}`);
  }

  /**
   * Build or refresh the embedding index from the graph
   */
  async buildIndex(): Promise<void> {
    if (this.indexingInProgress) {
      logger.warn('[semantic-search] Indexing already in progress');
      return;
    }

    this.indexingInProgress = true;
    logger.info('[semantic-search] Building embedding index...');

    try {
      // Query all functions/methods from the graph
      const results = await this.graphService.fetchAll(CYPHER_QUERY_EMBEDDINGS, {
        project_name: this.projectName,
      });

      if (!results || results.length === 0) {
        logger.warn('[semantic-search] No functions/methods found for indexing');
        this.embeddingIndex = {
          nodeIds: [],
          embeddings: [],
          qualifiedNames: [],
          nodeIdToIndex: new Map(),
        };
        return;
      }

      // Extract code snippets for embedding
      const nodeIds: number[] = [];
      const qualifiedNames: string[] = [];
      const codeSnippets: string[] = [];
      const nodeIdToIndex = new Map<number, number>();

      for (const row of results as unknown as EmbeddingQueryResult[]) {
        const nodeId = row.node_id;
        const qualifiedName = row.qualified_name;
        const path = row.path;
        const startLine = row.start_line;
        const endLine = row.end_line;

        if (path && startLine !== null && endLine !== null) {
          try {
            const fullPath = join(this.projectRoot, path);
            const content = await readFile(fullPath, { encoding: ENCODING_UTF8 as BufferEncoding });
            const lines = content.split('\n');
            const codeSnippet = lines.slice(startLine - 1, endLine).join('\n');

            // Use qualified name + code signature for embedding
            const embeddingText = `${qualifiedName}\n${codeSnippet.slice(0, 500)}`;
            
            nodeIdToIndex.set(nodeId, nodeIds.length);
            nodeIds.push(nodeId);
            qualifiedNames.push(qualifiedName);
            codeSnippets.push(embeddingText);
          } catch {
            // Skip files that can't be read
            logger.debug(`[semantic-search] Skipping unreadable file: ${path}`);
          }
        }
      }

      logger.info(`[semantic-search] Generating embeddings for ${codeSnippets.length} code snippets...`);

      // Generate embeddings in batches
      const embeddings = await this.embeddingService.embedCodeBatch(codeSnippets);

      // Save cache
      await this.embeddingService.saveCache();

      this.embeddingIndex = {
        nodeIds,
        embeddings,
        qualifiedNames,
        nodeIdToIndex,
      };

      logger.info(`[semantic-search] Index built with ${nodeIds.length} entries`);
    } finally {
      this.indexingInProgress = false;
    }
  }

  /**
   * Check if the index is ready
   */
  isIndexReady(): boolean {
    return this.embeddingIndex !== null && this.embeddingIndex.nodeIds.length > 0;
  }

  /**
   * Search for code using natural language query
   */
  async search(query: string, topK: number = 5): Promise<SemanticSearchResult[]> {
    logger.info(`[semantic-search] Searching for: "${query}" (top ${topK})`);

    if (!this.embeddingIndex || this.embeddingIndex.nodeIds.length === 0) {
      logger.warn('[semantic-search] Index not built or empty');
      return [];
    }

    try {
      // Generate query embedding
      const queryEmbedding = await this.embeddingService.embedCode(query);

      // Calculate similarities
      const similarities: Array<{ index: number; score: number }> = [];

      for (let i = 0; i < this.embeddingIndex.embeddings.length; i++) {
        const score = cosineSimilarity(queryEmbedding, this.embeddingIndex.embeddings[i]);
        similarities.push({ index: i, score });
      }

      // Sort by score descending
      similarities.sort((a, b) => b.score - a.score);

      // Take top K
      const topResults = similarities.slice(0, topK);

      // Fetch node metadata from graph
      const nodeIds = topResults.map(r => this.embeddingIndex!.nodeIds[r.index]);
      const nodeMetadata = await this.fetchNodeMetadata(nodeIds);

      // Format results
      const results: SemanticSearchResult[] = [];

      for (const { index, score } of topResults) {
        const nodeId = this.embeddingIndex.nodeIds[index];
        const qualifiedName = this.embeddingIndex.qualifiedNames[index];
        const metadata = nodeMetadata.get(nodeId);

        results.push({
          node_id: nodeId,
          qualified_name: qualifiedName,
          name: metadata?.name || qualifiedName.split('.').pop() || '',
          type: metadata?.type || SEMANTIC_TYPE_UNKNOWN,
          score: Math.round(score * 1000) / 1000,
        });
      }

      logger.info(`[semantic-search] Found ${results.length} results for: "${query}"`);
      return results;
    } catch (error) {
      logger.error('[semantic-search] Search error:', error);
      return [];
    }
  }

  /**
   * Fetch node metadata from the graph
   */
  private async fetchNodeMetadata(
    nodeIds: number[]
  ): Promise<Map<number, { name: string; type: string }>> {
    const metadata = new Map<number, { name: string; type: string }>();

    if (nodeIds.length === 0) return metadata;

    try {
      const query = buildNodesByIdsQuery(nodeIds);
      const params: Record<string, number> = {};
      nodeIds.forEach((id, i) => {
        params[String(i)] = id;
      });

      const results = await this.graphService.fetchAll(query, params);

      for (const row of results) {
        const nodeId = row.node_id as number;
        const name = row.name as string;
        const typeArr = row.type as string[];
        const type = Array.isArray(typeArr) && typeArr.length > 0 
          ? typeArr[0] 
          : SEMANTIC_TYPE_UNKNOWN;

        metadata.set(nodeId, { name, type });
      }
    } catch (error) {
      logger.error('[semantic-search] Error fetching node metadata:', error);
    }

    return metadata;
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
   * Search with source code included
   */
  async searchWithSource(
    query: string,
    topK: number = 5
  ): Promise<SearchResultWithSource[]> {
    const results = await this.search(query, topK);
    const resultsWithSource: SearchResultWithSource[] = [];

    for (const result of results) {
      const source = await this.getSourceCode(result.node_id);
      
      // Fetch additional location info
      const locationResults = await this.graphService.fetchAll(
        CYPHER_GET_FUNCTION_SOURCE_LOCATION,
        { node_id: result.node_id }
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
    // Ensure index is ready
    if (!tool.isIndexReady()) {
      await tool.buildIndex();
    }

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
 * Create a SemanticSearchTool with auto-detected embedding service
 */
export async function createSemanticSearchToolWithDefaults(
  config: SemanticSearchToolConfig
): Promise<SemanticSearchTool | null> {
  const embeddingService = config.embeddingService || await getEmbeddingService(config.projectRoot);

  if (!embeddingService) {
    logger.warn('[semantic-search] No embedding service available. Set OPENAI_API_KEY or OPENROUTER_API_KEY.');
    return null;
  }

  return new SemanticSearchTool({
    projectRoot: config.projectRoot,
    projectName: config.projectName,
    graphService: config.graphService,
    embeddingService,
  });
}

export default SemanticSearchTool;
