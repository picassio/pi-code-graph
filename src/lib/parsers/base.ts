/**
 * Base processor interfaces and types for code parsing
 * Ported from codebase_rag/parsers/
 */

import type { Node as TreeSitterNode, Query, Tree } from 'web-tree-sitter';
import type { SupportedLanguage, NodeLabel, RelationshipType } from '../constants.js';
import type {
  ASTNode,
  FunctionRegistryTrie,
  SimpleNameLookup,
  LanguageQueries,
  LanguageSpec,
  PropertyDict,
  NodeIdentifier,
} from '../types.js';

// =============================================================================
// Ingestor Protocol
// =============================================================================

/**
 * Interface for graph ingestion operations
 * Handles batch creation of nodes and relationships
 */
export interface IngestorProtocol {
  /**
   * Ensure a node exists with the given label and properties
   * @param label - Node label (e.g., 'Function', 'Class')
   * @param properties - Node properties
   */
  ensureNodeBatch(label: NodeLabel | string, properties: PropertyDict): void;

  /**
   * Ensure a relationship exists between two nodes
   * @param fromNode - Source node identifier (label, key, value)
   * @param relType - Relationship type
   * @param toNode - Target node identifier (label, key, value)
   * @param properties - Optional relationship properties
   */
  ensureRelationshipBatch(
    fromNode: NodeIdentifier,
    relType: RelationshipType | string,
    toNode: NodeIdentifier,
    properties?: PropertyDict
  ): void;

  /**
   * Flush any pending batched operations
   */
  flush(): Promise<void>;
}

// =============================================================================
// AST Cache Protocol
// =============================================================================

/**
 * Interface for caching parsed ASTs by file path
 */
export interface ASTCacheProtocol {
  set(key: string, value: [TreeSitterNode, SupportedLanguage]): void;
  get(key: string): [TreeSitterNode, SupportedLanguage] | undefined;
  delete(key: string): boolean;
  has(key: string): boolean;
  entries(): IterableIterator<[string, [TreeSitterNode, SupportedLanguage]]>;
  clear(): void;
}

// =============================================================================
// Query Captures
// =============================================================================

export interface QueryCaptures {
  [captureName: string]: TreeSitterNode[];
}

// =============================================================================
// Base Processor Interface
// =============================================================================

/**
 * Base interface for all code processors
 */
export interface BaseProcessor {
  readonly repoPath: string;
  readonly projectName: string;
  readonly ingestor: IngestorProtocol;
}

// =============================================================================
// Import Processor Interface
// =============================================================================

export interface ImportMapping {
  [moduleQn: string]: {
    [localName: string]: string; // localName -> fullyQualifiedName
  };
}

export interface ImportProcessorProtocol extends BaseProcessor {
  readonly importMapping: ImportMapping;

  /**
   * Parse imports from an AST root node
   */
  parseImports(
    rootNode: TreeSitterNode,
    moduleQn: string,
    language: SupportedLanguage,
    queries: Map<SupportedLanguage, LanguageQueries>
  ): void;

  /**
   * Resolve an imported name to its full qualified name
   */
  resolveImport(localName: string, moduleQn: string): string | null;
}

// =============================================================================
// Definition Processor Interface
// =============================================================================

export interface ClassInheritance {
  [classQn: string]: string[]; // class qualified name -> list of base class qualified names
}

export interface DefinitionProcessorProtocol extends BaseProcessor {
  readonly functionRegistry: FunctionRegistryTrie;
  readonly simpleNameLookup: SimpleNameLookup;
  readonly classInheritance: ClassInheritance;

  /**
   * Process a file and extract function/class definitions
   * @returns Tuple of [rootNode, language] or null if parsing failed
   */
  processFile(
    filePath: string,
    language: SupportedLanguage,
    queries: Map<SupportedLanguage, LanguageQueries>,
    structuralElements: Map<string, string | null>
  ): Promise<[TreeSitterNode, SupportedLanguage] | null>;

  /**
   * Process dependency file (e.g., package.json, requirements.txt)
   */
  processDependencies(filepath: string): Promise<void>;
}

// =============================================================================
// Call Processor Interface
// =============================================================================

export interface CallInfo {
  callerQn: string;
  callerType: NodeLabel;
  callName: string;
  calleeQn: string;
  calleeType: NodeLabel;
}

export interface CallProcessorProtocol extends BaseProcessor {
  /**
   * Process function calls in a file
   */
  processCallsInFile(
    filePath: string,
    rootNode: TreeSitterNode,
    language: SupportedLanguage,
    queries: Map<SupportedLanguage, LanguageQueries>
  ): void;
}

// =============================================================================
// Structure Processor Interface
// =============================================================================

export interface StructuralElements {
  [relativePath: string]: string | null; // path -> package qualified name or null for folder
}

export interface StructureProcessorProtocol extends BaseProcessor {
  readonly structuralElements: Map<string, string | null>;

  /**
   * Identify folder/package structure in the repository
   */
  identifyStructure(): Promise<void>;

  /**
   * Process a generic (non-code) file
   */
  processGenericFile(filePath: string, fileName: string): void;
}

// =============================================================================
// Type Inference Interface (placeholder for future)
// =============================================================================

export interface TypeInferenceProtocol {
  /**
   * Build a map of local variable names to their inferred types
   */
  buildLocalVariableTypeMap(
    node: TreeSitterNode,
    moduleQn: string,
    language: SupportedLanguage
  ): Map<string, string>;
}

// =============================================================================
// Language Handler Interface
// =============================================================================

export interface LanguageHandler {
  /**
   * Extract decorators/annotations from a node
   */
  extractDecorators(node: TreeSitterNode): string[];

  /**
   * Get the function/method name from a node
   */
  extractFunctionName(node: TreeSitterNode): string | null;

  /**
   * Get the class name from a node
   */
  extractClassName(node: TreeSitterNode): string | null;

  /**
   * Check if a node is a method (inside a class)
   */
  isMethodNode(node: TreeSitterNode, spec: LanguageSpec): boolean;
}

// =============================================================================
// Processor Factory Interface
// =============================================================================

export interface ProcessorFactoryProtocol {
  readonly repoPath: string;
  readonly projectName: string;
  readonly queries: Map<SupportedLanguage, LanguageQueries>;
  readonly functionRegistry: FunctionRegistryTrie;
  readonly simpleNameLookup: SimpleNameLookup;
  readonly moduleQnToFilePath: Map<string, string>;

  getImportProcessor(): ImportProcessorProtocol;
  getStructureProcessor(): StructureProcessorProtocol;
  getDefinitionProcessor(): DefinitionProcessorProtocol;
  getCallProcessor(): CallProcessorProtocol;
}

// =============================================================================
// Utility Types
// =============================================================================

/**
 * Result of extracting function information
 */
export interface FunctionInfo {
  name: string;
  qualifiedName: string;
  startLine: number;
  endLine: number;
  parameters: string[];
  decorators: string[];
  docstring: string | null;
  isExported: boolean;
  isAsync: boolean;
}

/**
 * Result of extracting class information
 */
export interface ClassInfo {
  name: string;
  qualifiedName: string;
  startLine: number;
  endLine: number;
  baseClasses: string[];
  interfaces: string[];
  decorators: string[];
  docstring: string | null;
  isExported: boolean;
}

/**
 * Result of extracting method information
 */
export interface MethodInfo extends FunctionInfo {
  className: string;
  classQualifiedName: string;
  isStatic: boolean;
  isClassMethod: boolean;
  isProperty: boolean;
}

/**
 * Dependency information from package files
 */
export interface DependencyInfo {
  name: string;
  spec: string;
  properties: PropertyDict | null;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Safely decode node text as UTF-8 string.
 * Also handles Buffer/Uint8Array inputs for direct text decoding.
 */
export function safeDecodeText(input: TreeSitterNode | Buffer | Uint8Array | null): string | null {
  if (!input) {
    return null;
  }

  // Handle Buffer or Uint8Array
  if (input instanceof Buffer || input instanceof Uint8Array) {
    try {
      const decoder = new TextDecoder('utf-8', { fatal: false });
      return decoder.decode(input);
    } catch {
      return null;
    }
  }

  // Handle TreeSitterNode
  if (!input.text) {
    return null;
  }
  return input.text;
}

/**
 * Get a node's text with fallback for non-UTF8 content.
 * Also handles Buffer/Uint8Array inputs for direct text decoding.
 */
export function safeDecodeWithFallback(input: TreeSitterNode | Buffer | Uint8Array): string {
  // Handle Buffer or Uint8Array
  if (input instanceof Buffer || input instanceof Uint8Array) {
    try {
      const decoder = new TextDecoder('utf-8', { fatal: false });
      return decoder.decode(input);
    } catch {
      // Try latin-1 fallback
      try {
        const decoder = new TextDecoder('latin1');
        return decoder.decode(input);
      } catch {
        return '';
      }
    }
  }

  // Handle TreeSitterNode
  return input.text ?? '';
}

/**
 * Sort captures from a query cursor by position
 */
export function sortedCaptures(
  captures: Array<{ node: TreeSitterNode; name: string }>
): QueryCaptures {
  const result: QueryCaptures = {};

  // Sort by start position
  const sorted = [...captures].sort((a, b) => {
    const aPos = a.node.startPosition;
    const bPos = b.node.startPosition;
    if (aPos.row !== bPos.row) {
      return aPos.row - bPos.row;
    }
    return aPos.column - bPos.column;
  });

  // Group by capture name
  for (const capture of sorted) {
    const name = capture.name;
    if (!result[name]) {
      result[name] = [];
    }
    result[name].push(capture.node);
  }

  return result;
}

/**
 * Check if a node is a method (inside a class body)
 */
export function isMethodNode(node: TreeSitterNode, spec: LanguageSpec): boolean {
  let current = node.parent;
  while (current) {
    if (spec.classNodeTypes.includes(current.type)) {
      return true;
    }
    // Stop at module level
    if (spec.moduleNodeTypes.includes(current.type)) {
      return false;
    }
    current = current.parent;
  }
  return false;
}

/**
 * Get function captures from a root node using queries
 */
export function getFunctionCaptures(
  rootNode: TreeSitterNode,
  language: SupportedLanguage,
  queries: Map<SupportedLanguage, LanguageQueries>
): [LanguageSpec, QueryCaptures] | null {
  const langQueries = queries.get(language);
  if (!langQueries || !langQueries.functions) {
    return null;
  }

  const matches = langQueries.functions.matches(rootNode);
  const captures: Array<{ node: TreeSitterNode; name: string }> = [];

  for (const match of matches) {
    for (const capture of match.captures) {
      captures.push({ node: capture.node, name: capture.name });
    }
  }

  return [langQueries.config, sortedCaptures(captures)];
}

/**
 * Get node name from 'name' field or identifier
 */
export function getNodeName(node: TreeSitterNode, field: string = 'name'): string | null {
  const nameNode = node.childForFieldName(field);
  if (!nameNode) {
    return null;
  }
  return nameNode.text ?? null;
}
