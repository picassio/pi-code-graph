/**
 * Code Retrieval Tool - Get code by qualified name
 * Ported from codebase_rag/tools/code_retrieval.py
 */

import { readFile } from 'fs/promises';
import { join, resolve } from 'path';
import { MemgraphService } from '../graph-service.js';
import { CYPHER_FIND_BY_QUALIFIED_NAME } from '../cypher-queries.js';
import { ENCODING_UTF8 } from '../constants.js';

// =============================================================================
// Types
// =============================================================================

export interface CodeSnippet {
  qualified_name: string;
  source_code: string;
  file_path: string;
  line_start: number;
  line_end: number;
  docstring?: string | null;
  found: boolean;
  error_message?: string | null;
}

export interface CodeRetrieverConfig {
  projectRoot: string;
  graphService: MemgraphService;
}

// =============================================================================
// Error Messages
// =============================================================================

const ERR_ENTITY_NOT_FOUND = 'Code entity not found in the knowledge graph.';
const ERR_MISSING_LOCATION = 'Code entity exists but location data is incomplete.';

// =============================================================================
// CodeRetriever Class
// =============================================================================

/**
 * Retrieves source code snippets by qualified name from the knowledge graph
 */
export class CodeRetriever {
  private projectRoot: string;
  private graphService: MemgraphService;

  constructor(config: CodeRetrieverConfig) {
    this.projectRoot = resolve(config.projectRoot);
    this.graphService = config.graphService;
    console.debug(`[code-retrieval] Initialized with root: ${this.projectRoot}`);
  }

  /**
   * Find and return source code for a given qualified name
   */
  async findCodeSnippet(qualifiedName: string): Promise<CodeSnippet> {
    console.debug(`[code-retrieval] Searching for: ${qualifiedName}`);

    try {
      const results = await this.graphService.fetchAll(
        CYPHER_FIND_BY_QUALIFIED_NAME,
        { qn: qualifiedName }
      );

      if (!results || results.length === 0) {
        return {
          qualified_name: qualifiedName,
          source_code: '',
          file_path: '',
          line_start: 0,
          line_end: 0,
          found: false,
          error_message: ERR_ENTITY_NOT_FOUND,
        };
      }

      const res = results[0];
      const filePath = res.path as string | undefined;
      const startLine = res.start as number | undefined;
      const endLine = res.end as number | undefined;

      if (!filePath || startLine === undefined || endLine === undefined) {
        return {
          qualified_name: qualifiedName,
          source_code: '',
          file_path: filePath || '',
          line_start: 0,
          line_end: 0,
          found: false,
          error_message: ERR_MISSING_LOCATION,
        };
      }

      // Read the source file
      const fullPath = join(this.projectRoot, filePath);
      let fileContent: string;
      
      try {
        fileContent = await readFile(fullPath, { encoding: ENCODING_UTF8 as BufferEncoding });
      } catch (readError) {
        return {
          qualified_name: qualifiedName,
          source_code: '',
          file_path: filePath,
          line_start: startLine,
          line_end: endLine,
          found: false,
          error_message: `Failed to read file: ${(readError as Error).message}`,
        };
      }

      // Extract the code snippet by line numbers
      const allLines = fileContent.split('\n');
      const snippetLines = allLines.slice(startLine - 1, endLine);
      const sourceCode = snippetLines.join('\n');

      const docstring = res.docstring as string | null | undefined;

      return {
        qualified_name: qualifiedName,
        source_code: sourceCode,
        file_path: filePath,
        line_start: startLine,
        line_end: endLine,
        docstring: docstring || null,
        found: true,
      };
    } catch (error) {
      console.error(`[code-retrieval] Error retrieving ${qualifiedName}:`, error);
      return {
        qualified_name: qualifiedName,
        source_code: '',
        file_path: '',
        line_start: 0,
        line_end: 0,
        found: false,
        error_message: (error as Error).message,
      };
    }
  }

  /**
   * Find multiple code snippets by qualified names
   */
  async findCodeSnippets(qualifiedNames: string[]): Promise<CodeSnippet[]> {
    const results: CodeSnippet[] = [];
    
    for (const qn of qualifiedNames) {
      const snippet = await this.findCodeSnippet(qn);
      results.push(snippet);
    }
    
    return results;
  }

  /**
   * Get code snippet by node ID (from semantic search results)
   */
  async findCodeSnippetByNodeId(nodeId: number): Promise<CodeSnippet | null> {
    try {
      const query = `
        MATCH (m:Module)-[:DEFINES]->(n)
        WHERE id(n) = $node_id
        RETURN n.qualified_name AS qualified_name, n.start_line AS start_line,
               n.end_line AS end_line, m.path AS path, n.docstring AS docstring
      `;
      
      const results = await this.graphService.fetchAll(query, { node_id: nodeId });
      
      if (!results || results.length === 0) {
        return null;
      }

      const res = results[0];
      const qualifiedName = res.qualified_name as string;
      
      if (!qualifiedName) {
        return null;
      }

      return this.findCodeSnippet(qualifiedName);
    } catch (error) {
      console.error(`[code-retrieval] Error finding by node ID ${nodeId}:`, error);
      return null;
    }
  }
}

// =============================================================================
// Tool Interface for pi-coding-agent
// =============================================================================

export interface CodeRetrievalToolInput {
  qualified_name: string;
}

export interface CodeRetrievalToolResult {
  success: boolean;
  snippet?: CodeSnippet;
  error?: string;
}

/**
 * Tool function for pi-coding-agent integration
 */
export async function getCodeSnippet(
  input: CodeRetrievalToolInput,
  retriever: CodeRetriever
): Promise<CodeRetrievalToolResult> {
  console.info(`[code-retrieval] Tool called for: ${input.qualified_name}`);
  
  try {
    const snippet = await retriever.findCodeSnippet(input.qualified_name);
    
    if (!snippet.found) {
      return {
        success: false,
        snippet,
        error: snippet.error_message || 'Code not found',
      };
    }

    return {
      success: true,
      snippet,
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

export const CODE_RETRIEVAL_TOOL_NAME = 'get_code_snippet';

export const CODE_RETRIEVAL_TOOL_DESCRIPTION = 
  'Retrieves the source code for a specific function, class, or method ' +
  'using its full qualified name.';

export const CODE_RETRIEVAL_TOOL_SCHEMA = {
  name: CODE_RETRIEVAL_TOOL_NAME,
  description: CODE_RETRIEVAL_TOOL_DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      qualified_name: {
        type: 'string',
        description: "Fully qualified name (e.g., 'app.services.UserService.create_user')",
      },
    },
    required: ['qualified_name'],
  },
};

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a CodeRetriever instance
 */
export function createCodeRetriever(
  projectRoot: string,
  graphService: MemgraphService
): CodeRetriever {
  return new CodeRetriever({ projectRoot, graphService });
}

export default CodeRetriever;
