/**
 * code-graph-rag library
 * TypeScript port of codebase_rag for pi-coding-agent
 */

// Export logger
export { logger, setLogLevel, getLogLevel, getLogFilePath, type LogLevel } from './logger.js';

// Export all types
export * from './types.js';

// Export all constants
export * from './constants.js';

// Export all cypher queries
export * from './cypher-queries.js';

// Export graph service
export * from './graph-service.js';

// Export embeddings service
export * from './embeddings.js';

// Export vector store
export * from './vector-store.js';

// Export LLM service
export * from './llm-service.js';

// Export graph updater (selective exports to avoid naming collision)
export {
  GraphUpdater,
  createGraphUpdater,
  createGraphUpdaterWithLanguages,
  FunctionRegistryTrie as FunctionRegistryTrieClass,
  BoundedASTCache,
  hashFile,
  loadHashCache,
  saveHashCache,
  type FileHashCache,
  type ProgressCallback,
  type GraphUpdaterConfig,
  type QueryProtocol,
  type FlushableIngestor,
} from './graph-updater.js';

// Export tree-sitter infrastructure
export * as treeSitter from './tree-sitter/index.js';

// Export parser infrastructure
export * as parsers from './parsers/index.js';
export {
  ProcessorFactory,
  createProcessorFactory,
  FunctionRegistryTrieImpl,
} from './parsers/index.js';

// Export Ax runtime integration
export * as axRuntime from './ax/index.js';
export * from './ax/index.js';

// Export RAG tools
export * as tools from './tools/index.js';
export { ToolName, ToolCollection, createAllTools, createMCPToolHandler } from './tools/index.js';
