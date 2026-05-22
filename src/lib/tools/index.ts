/**
 * RAG Tools Registry - Central export for all code-graph-rag tools
 * Provides unified access to code retrieval, querying, semantic search, and dependency analysis
 */

// =============================================================================
// Re-export all tools
// =============================================================================

export * from './code-retrieval.js';
export * from './codebase-query.js';
export * from './semantic-search.js';
export * from './dependency-analyzer.js';

// =============================================================================
// Import individual tools for registry
// =============================================================================

import {
  CodeRetriever,
  createCodeRetriever,
  CODE_RETRIEVAL_TOOL_NAME,
  CODE_RETRIEVAL_TOOL_DESCRIPTION,
  CODE_RETRIEVAL_TOOL_SCHEMA,
} from './code-retrieval.js';

import {
  CodebaseQueryTool,
  createCodebaseQueryTool,
  createCodebaseQueryToolWithDefaults,
  CODEBASE_QUERY_TOOL_NAME,
  CODEBASE_QUERY_TOOL_DESCRIPTION,
  CODEBASE_QUERY_TOOL_SCHEMA,
} from './codebase-query.js';

import {
  SemanticSearchTool,
  createSemanticSearchTool,
  createSemanticSearchToolWithDefaults,
  SEMANTIC_SEARCH_TOOL_NAME,
  SEMANTIC_SEARCH_TOOL_DESCRIPTION,
  SEMANTIC_SEARCH_TOOL_SCHEMA,
  GET_FUNCTION_SOURCE_TOOL_NAME,
  GET_FUNCTION_SOURCE_TOOL_DESCRIPTION,
  GET_FUNCTION_SOURCE_TOOL_SCHEMA,
} from './semantic-search.js';

import {
  DependencyAnalyzer,
  createDependencyAnalyzer,
  DEPENDENCY_ANALYZER_TOOL_NAME,
  DEPENDENCY_ANALYZER_TOOL_DESCRIPTION,
  DEPENDENCY_ANALYZER_TOOL_SCHEMA,
} from './dependency-analyzer.js';

import { MemgraphService } from '../graph-service.js';
import { CypherGenerator } from '../llm-service.js';
import { SemanticSearchService } from '../embeddings.js';

// =============================================================================
// Tool Enum
// =============================================================================

export enum ToolName {
  GET_CODE_SNIPPET = 'get_code_snippet',
  QUERY_GRAPH = 'query_graph',
  SEMANTIC_SEARCH = 'semantic_search',
  GET_FUNCTION_SOURCE = 'get_function_source',
  ANALYZE_DEPENDENCIES = 'analyze_dependencies',
}

// =============================================================================
// Tool Schema Registry
// =============================================================================

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, {
      type: string;
      description?: string;
      enum?: string[];
      default?: unknown;
    }>;
    required: string[];
  };
}

/**
 * Registry of all available tool schemas
 */
export const TOOL_SCHEMAS: Record<ToolName, ToolSchema> = {
  [ToolName.GET_CODE_SNIPPET]: CODE_RETRIEVAL_TOOL_SCHEMA,
  [ToolName.QUERY_GRAPH]: CODEBASE_QUERY_TOOL_SCHEMA,
  [ToolName.SEMANTIC_SEARCH]: SEMANTIC_SEARCH_TOOL_SCHEMA,
  [ToolName.GET_FUNCTION_SOURCE]: GET_FUNCTION_SOURCE_TOOL_SCHEMA,
  [ToolName.ANALYZE_DEPENDENCIES]: DEPENDENCY_ANALYZER_TOOL_SCHEMA,
};

/**
 * Get all tool schemas as an array (for MCP or pi extension registration)
 */
export function getAllToolSchemas(): ToolSchema[] {
  return Object.values(TOOL_SCHEMAS);
}

/**
 * Get tool schema by name
 */
export function getToolSchema(name: ToolName | string): ToolSchema | undefined {
  return TOOL_SCHEMAS[name as ToolName];
}

// =============================================================================
// Tool Collection Type
// =============================================================================

export interface ToolCollection {
  codeRetriever: CodeRetriever;
  codebaseQuery: CodebaseQueryTool;
  semanticSearch: SemanticSearchTool | null;
  dependencyAnalyzer: DependencyAnalyzer;
}

// =============================================================================
// Unified Tool Config
// =============================================================================

export interface ToolsConfig {
  projectRoot: string;
  projectName: string;
  graphService: MemgraphService;
  cypherGenerator?: CypherGenerator;
  semanticSearchService?: SemanticSearchService;
  queryConfig?: {
    maxResultRows?: number;
    maxTokens?: number;
    verbose?: boolean;
  };
  dependencyConfig?: {
    maxDepth?: number;
    limit?: number;
  };
}

// =============================================================================
// Tool Factory
// =============================================================================

/**
 * Create all tools with a unified configuration
 */
export async function createAllTools(config: ToolsConfig): Promise<ToolCollection> {
  const {
    projectRoot,
    projectName,
    graphService,
    cypherGenerator,
    semanticSearchService,
    queryConfig,
    dependencyConfig,
  } = config;

  // Create code retriever
  const codeRetriever = createCodeRetriever(projectRoot, graphService);

  // Create codebase query tool
  const scopedQueryConfig = { ...queryConfig, projectName };
  const codebaseQuery = cypherGenerator
    ? createCodebaseQueryTool(graphService, cypherGenerator, scopedQueryConfig)
    : createCodebaseQueryToolWithDefaults(graphService, undefined, scopedQueryConfig);

  // Create semantic search tool (may be null if no SemanticSearchService)
  let semanticSearch: SemanticSearchTool | null = null;
  if (semanticSearchService) {
    semanticSearch = createSemanticSearchTool({
      projectRoot,
      projectName,
      graphService,
      semanticSearchService,
    });
  } else {
    semanticSearch = await createSemanticSearchToolWithDefaults({
      projectRoot,
      projectName,
      graphService,
    });
  }

  // Create dependency analyzer
  const dependencyAnalyzer = createDependencyAnalyzer(graphService, dependencyConfig);

  return {
    codeRetriever,
    codebaseQuery,
    semanticSearch,
    dependencyAnalyzer,
  };
}

// =============================================================================
// Tool Descriptions for LLM Context
// =============================================================================

export const TOOL_DESCRIPTIONS = {
  [ToolName.GET_CODE_SNIPPET]: CODE_RETRIEVAL_TOOL_DESCRIPTION,
  [ToolName.QUERY_GRAPH]: CODEBASE_QUERY_TOOL_DESCRIPTION,
  [ToolName.SEMANTIC_SEARCH]: SEMANTIC_SEARCH_TOOL_DESCRIPTION,
  [ToolName.GET_FUNCTION_SOURCE]: GET_FUNCTION_SOURCE_TOOL_DESCRIPTION,
  [ToolName.ANALYZE_DEPENDENCIES]: DEPENDENCY_ANALYZER_TOOL_DESCRIPTION,
};

/**
 * Generate a formatted tool list for LLM prompts
 */
export function formatToolDescriptions(): string {
  const lines: string[] = ['Available Tools:'];
  
  for (const [name, description] of Object.entries(TOOL_DESCRIPTIONS)) {
    lines.push(`- ${name}: ${description}`);
  }
  
  return lines.join('\n');
}

// =============================================================================
// MCP-Compatible Tool Handler
// =============================================================================

export interface MCPToolInput {
  name: string;
  arguments: Record<string, unknown>;
}

export interface MCPToolResult {
  content: Array<{
    type: 'text';
    text: string;
  }>;
  isError?: boolean;
}

/**
 * Create an MCP-compatible tool handler
 */
export function createMCPToolHandler(
  tools: ToolCollection
): (input: MCPToolInput) => Promise<MCPToolResult> {
  return async (input: MCPToolInput): Promise<MCPToolResult> => {
    const { name, arguments: args } = input;

    try {
      let result: unknown;

      switch (name) {
        case ToolName.GET_CODE_SNIPPET: {
          const snippet = await tools.codeRetriever.findCodeSnippet(
            args.qualified_name as string
          );
          result = snippet;
          break;
        }

        case ToolName.QUERY_GRAPH: {
          const queryResult = await tools.codebaseQuery.queryCodebaseKnowledgeGraph(
            args.natural_language_query as string
          );
          result = queryResult;
          break;
        }

        case ToolName.SEMANTIC_SEARCH: {
          if (!tools.semanticSearch) {
            return {
              content: [{ type: 'text', text: 'Semantic search is not available (no embedding service configured)' }],
              isError: true,
            };
          }
          const searchResults = await tools.semanticSearch.search(
            args.query as string,
            args.top_k as number | undefined
          );
          result = searchResults;
          break;
        }

        case ToolName.GET_FUNCTION_SOURCE: {
          if (!tools.semanticSearch) {
            return {
              content: [{ type: 'text', text: 'Get function source is not available (no embedding service configured)' }],
              isError: true,
            };
          }
          const source = await tools.semanticSearch.getSourceCode(
            args.node_id as number
          );
          result = source ? { source_code: source } : { error: 'Source not found' };
          break;
        }

        case ToolName.ANALYZE_DEPENDENCIES: {
          const depResult = await tools.dependencyAnalyzer.analyzeDependencies(
            args.qualified_name as string
          );
          result = depResult;
          break;
        }

        default:
          return {
            content: [{ type: 'text', text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `Error: ${(error as Error).message}`,
        }],
        isError: true,
      };
    }
  };
}

// =============================================================================
// Default Export
// =============================================================================

export default {
  // Tool classes
  CodeRetriever,
  CodebaseQueryTool,
  SemanticSearchTool,
  DependencyAnalyzer,
  
  // Factory functions
  createCodeRetriever,
  createCodebaseQueryTool,
  createCodebaseQueryToolWithDefaults,
  createSemanticSearchTool,
  createSemanticSearchToolWithDefaults,
  createDependencyAnalyzer,
  createAllTools,
  
  // Tool schemas
  TOOL_SCHEMAS,
  getAllToolSchemas,
  getToolSchema,
  
  // Tool descriptions
  TOOL_DESCRIPTIONS,
  formatToolDescriptions,
  
  // MCP integration
  createMCPToolHandler,
  
  // Enums
  ToolName,
};
