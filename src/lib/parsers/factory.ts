/**
 * ProcessorFactory - Creates and manages language-specific processors
 * Ported from codebase_rag/parsers/factory.py
 */

import { SupportedLanguage } from '../constants.js';
import type { LanguageQueries, FunctionRegistryTrie, SimpleNameLookup, ASTCache } from '../types.js';
import type {
  IngestorProtocol,
  ProcessorFactoryProtocol,
  ImportProcessorProtocol,
  StructureProcessorProtocol,
  DefinitionProcessorProtocol,
  CallProcessorProtocol,
  ASTCacheProtocol,
} from './base.js';
import { ImportProcessor } from './import-processor.js';
import { StructureProcessor } from './structure-processor.js';
import { DefinitionProcessor } from './definition-processor.js';
import { CallProcessor } from './call-processor.js';
import { buildWorkspaceMap, type WorkspaceMap } from './workspace-resolver.js';
import { loadTsconfigAliases, type TsconfigAliasMap } from './tsconfig-resolver.js';

// =============================================================================
// Function Registry Trie Implementation
// =============================================================================

/**
 * A trie-based function registry for efficient prefix/suffix searches
 */
export class FunctionRegistryTrieImpl implements FunctionRegistryTrie {
  private registry = new Map<string, import('../types.js').NodeType>();
  private prefixTrie: Map<string, Set<string>> = new Map();
  private suffixTrie: Map<string, Set<string>> = new Map();

  has(qualifiedName: string): boolean {
    return this.registry.has(qualifiedName);
  }

  get(qualifiedName: string): import('../types.js').NodeType | undefined {
    return this.registry.get(qualifiedName);
  }

  set(qualifiedName: string, funcType: import('../types.js').NodeType): void {
    this.registry.set(qualifiedName, funcType);

    // Build prefix trie entries
    const parts = qualifiedName.split('.');
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('.');
      let set = this.prefixTrie.get(prefix);
      if (!set) {
        set = new Set();
        this.prefixTrie.set(prefix, set);
      }
      set.add(qualifiedName);
    }

    // Build suffix trie entries (for finding methods by name)
    for (let i = 0; i < parts.length; i++) {
      const suffix = parts.slice(i).join('.');
      let set = this.suffixTrie.get(suffix);
      if (!set) {
        set = new Set();
        this.suffixTrie.set(suffix, set);
      }
      set.add(qualifiedName);
    }
  }

  keys(): IterableIterator<string> {
    return this.registry.keys();
  }

  entries(): IterableIterator<[string, import('../types.js').NodeType]> {
    return this.registry.entries();
  }

  findWithPrefix(prefix: string): Array<[string, import('../types.js').NodeType]> {
    const matches = this.prefixTrie.get(prefix);
    if (!matches) return [];

    return Array.from(matches).map((qn) => [qn, this.registry.get(qn)!]);
  }

  findEndingWith(suffix: string): string[] {
    const matches = this.suffixTrie.get(suffix);
    return matches ? Array.from(matches) : [];
  }

  clear(): void {
    this.registry.clear();
    this.prefixTrie.clear();
    this.suffixTrie.clear();
  }

  get size(): number {
    return this.registry.size;
  }
}

// =============================================================================
// AST Cache Implementation
// =============================================================================

/**
 * Cache for parsed AST trees
 */
export class ASTCacheImpl implements ASTCacheProtocol {
  private cache = new Map<string, [import('web-tree-sitter').Node, SupportedLanguage]>();

  set(key: string, value: [import('web-tree-sitter').Node, SupportedLanguage]): void {
    this.cache.set(key, value);
  }

  get(key: string): [import('web-tree-sitter').Node, SupportedLanguage] | undefined {
    return this.cache.get(key);
  }

  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  entries(): IterableIterator<[string, [import('web-tree-sitter').Node, SupportedLanguage]]> {
    return this.cache.entries();
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

// =============================================================================
// Processor Factory Implementation
// =============================================================================

export class ProcessorFactory implements ProcessorFactoryProtocol {
  readonly ingestor: IngestorProtocol;
  readonly repoPath: string;
  readonly projectName: string;
  readonly queries: Map<SupportedLanguage, LanguageQueries>;
  readonly functionRegistry: FunctionRegistryTrie;
  readonly simpleNameLookup: SimpleNameLookup;
  readonly astCache: ASTCacheProtocol;
  readonly moduleQnToFilePath: Map<string, string> = new Map();

  private readonly unignorePaths: Set<string> | null;
  private readonly excludePaths: Set<string> | null;
  private readonly workspaceMap: WorkspaceMap;
  private readonly tsconfigAliases: TsconfigAliasMap;

  // Cached processor instances
  private _importProcessor: ImportProcessor | null = null;
  private _structureProcessor: StructureProcessor | null = null;
  private _definitionProcessor: DefinitionProcessor | null = null;
  private _callProcessor: CallProcessor | null = null;

  constructor(options: {
    ingestor: IngestorProtocol;
    repoPath: string;
    projectName: string;
    queries: Map<SupportedLanguage, LanguageQueries>;
    functionRegistry?: FunctionRegistryTrie;
    simpleNameLookup?: SimpleNameLookup;
    astCache?: ASTCacheProtocol;
    unignorePaths?: Set<string> | null;
    excludePaths?: Set<string> | null;
  }) {
    this.ingestor = options.ingestor;
    this.repoPath = options.repoPath;
    this.projectName = options.projectName;
    this.queries = options.queries;
    this.functionRegistry = options.functionRegistry ?? new FunctionRegistryTrieImpl();
    this.simpleNameLookup = options.simpleNameLookup ?? new Map();
    this.astCache = options.astCache ?? new ASTCacheImpl();
    this.unignorePaths = options.unignorePaths ?? null;
    this.excludePaths = options.excludePaths ?? null;
    this.workspaceMap = buildWorkspaceMap(this.repoPath, this.projectName);
    this.tsconfigAliases = loadTsconfigAliases(this.repoPath);
  }

  // ===========================================================================
  // Processor Getters (Lazy Initialization)
  // ===========================================================================

  getImportProcessor(): ImportProcessor {
    if (!this._importProcessor) {
      this._importProcessor = new ImportProcessor(
        this.repoPath,
        this.projectName,
        this.ingestor,
        this.functionRegistry,
        this.workspaceMap,
        this.tsconfigAliases
      );
    }
    return this._importProcessor;
  }

  getStructureProcessor(): StructureProcessor {
    if (!this._structureProcessor) {
      this._structureProcessor = new StructureProcessor(
        this.ingestor,
        this.repoPath,
        this.projectName,
        this.queries,
        this.unignorePaths,
        this.excludePaths
      );
    }
    return this._structureProcessor;
  }

  getDefinitionProcessor(): DefinitionProcessor {
    if (!this._definitionProcessor) {
      this._definitionProcessor = new DefinitionProcessor(
        this.ingestor,
        this.repoPath,
        this.projectName,
        this.functionRegistry,
        this.simpleNameLookup,
        this.getImportProcessor(),
        this.moduleQnToFilePath
      );
    }
    return this._definitionProcessor;
  }

  getCallProcessor(): CallProcessor {
    if (!this._callProcessor) {
      this._callProcessor = new CallProcessor(
        this.ingestor,
        this.repoPath,
        this.projectName,
        this.functionRegistry,
        this.getImportProcessor(),
        null, // Type inference - not implemented yet
        this.getDefinitionProcessor().classInheritance
      );
    }
    return this._callProcessor;
  }

  // ===========================================================================
  // Utility Methods
  // ===========================================================================

  /**
   * Reset all processors (useful when re-indexing)
   */
  reset(): void {
    this._importProcessor = null;
    this._structureProcessor = null;
    this._definitionProcessor = null;
    this._callProcessor = null;
    this.moduleQnToFilePath.clear();

    if (this.functionRegistry instanceof FunctionRegistryTrieImpl) {
      this.functionRegistry.clear();
    }
    this.simpleNameLookup.clear();

    if (this.astCache instanceof ASTCacheImpl) {
      this.astCache.clear();
    }
  }

  /**
   * Get statistics about the processed codebase
   */
  getStats(): {
    registeredFunctions: number;
    simpleNames: number;
    cachedASTs: number;
    moduleCount: number;
  } {
    return {
      registeredFunctions: this.functionRegistry instanceof FunctionRegistryTrieImpl
        ? this.functionRegistry.size
        : 0,
      simpleNames: this.simpleNameLookup.size,
      cachedASTs: this.astCache instanceof ASTCacheImpl ? this.astCache.size : 0,
      moduleCount: this.moduleQnToFilePath.size,
    };
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a new ProcessorFactory instance
 */
export function createProcessorFactory(options: {
  ingestor: IngestorProtocol;
  repoPath: string;
  projectName: string;
  queries: Map<SupportedLanguage, LanguageQueries>;
  functionRegistry?: FunctionRegistryTrie;
  simpleNameLookup?: SimpleNameLookup;
  astCache?: ASTCacheProtocol;
  unignorePaths?: Set<string> | null;
  excludePaths?: Set<string> | null;
}): ProcessorFactory {
  return new ProcessorFactory(options);
}
