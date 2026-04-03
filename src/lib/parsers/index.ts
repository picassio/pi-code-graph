/**
 * Parser module - exports all parser components for code analysis
 * 
 * This module provides:
 * - ProcessorFactory: Creates and manages language-specific processors
 * - ImportProcessor: Parses import statements
 * - DefinitionProcessor: Extracts function/class definitions
 * - CallProcessor: Extracts function calls
 * - StructureProcessor: Identifies code structure (packages, folders)
 */

// =============================================================================
// Core Exports
// =============================================================================

export {
  // Factory
  ProcessorFactory,
  createProcessorFactory,
  FunctionRegistryTrieImpl,
  ASTCacheImpl,
} from './factory.js';

export {
  // Processors
  ImportProcessor,
} from './import-processor.js';

export {
  DefinitionProcessor,
  createDefinitionProcessor,
} from './definition-processor.js';

export {
  CallProcessor,
  CallResolver,
  createCallProcessor,
} from './call-processor.js';

export {
  StructureProcessor,
  createStructureProcessor,
  shouldSkipPath,
} from './structure-processor.js';

export {
  buildWorkspaceMap,
  type WorkspaceMap,
  type WorkspacePackage,
} from './workspace-resolver.js';

// =============================================================================
// Type Exports
// =============================================================================

export type {
  // Ingestor protocol
  IngestorProtocol,
  
  // Processor protocols
  BaseProcessor,
  ImportProcessorProtocol,
  DefinitionProcessorProtocol,
  CallProcessorProtocol,
  StructureProcessorProtocol,
  ProcessorFactoryProtocol,
  
  // Supporting types
  ImportMapping,
  ClassInheritance,
  QueryCaptures,
  ASTCacheProtocol,
  TypeInferenceProtocol,
  LanguageHandler,
  
  // Info types
  FunctionInfo,
  ClassInfo,
  MethodInfo,
  DependencyInfo,
  CallInfo,
  StructuralElements,
} from './base.js';

// =============================================================================
// Helper Exports
// =============================================================================

export {
  safeDecodeText,
  safeDecodeWithFallback,
  sortedCaptures,
  isMethodNode,
  getFunctionCaptures,
  getNodeName,
} from './base.js';

// =============================================================================
// Language Handlers
// =============================================================================

export {
  // Handler registry
  getHandler,
  hasHandler,
  getSupportedLanguages,
  clearHandlerCache,
  
  // Base classes
  BaseLanguageHandler,
  
  // Language-specific handlers
  PythonHandler,
  TypeScriptHandler,
  RustHandler,
  JavaHandler,
  CppHandler,
  GoHandler,
} from './languages/index.js';

// Re-export LanguageHandler type from languages
export type { LanguageHandler as LanguageHandlerProtocol } from './languages/index.js';
