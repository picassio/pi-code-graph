import { logger } from './logger.js';
/**
 * Graph updater with incremental indexing support
 * Ported from codebase_rag/graph_updater.py
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile, stat, readdir, access, constants, mkdir } from 'node:fs/promises';
import { join, relative, dirname, basename, extname, resolve } from 'node:path';
import { homedir } from 'node:os';

import type { SemanticSearchService } from './embeddings.js';

import type { Node as TreeSitterNode } from 'web-tree-sitter';
import { SupportedLanguage } from './constants.js';
import type { LanguageQueries, QualifiedName, SimpleNameLookup, NodeType, ResultRow } from './types.js';
import type { IngestorProtocol, ASTCacheProtocol, StructuralElements } from './parsers/base.js';
import { ProcessorFactory, FunctionRegistryTrieImpl } from './parsers/factory.js';
import { shouldSkipPath } from './parsers/structure-processor.js';
import { getLanguageSpecForExtension, loadAllQueries } from './tree-sitter/index.js';
import * as cs from './constants.js';
import {
  CYPHER_DELETE_MODULE,
  CYPHER_DELETE_FILE,
  CYPHER_DELETE_FOLDER,
  CYPHER_ALL_FILE_PATHS,
  CYPHER_ALL_MODULE_PATHS_INTERNAL,
  CYPHER_ALL_FOLDER_PATHS,
} from './cypher-queries.js';

// =============================================================================
// Types
// =============================================================================

/** File hash cache: relative path -> SHA-256 hash */
export type FileHashCache = Record<string, string>;

/** Progress callback for file indexing */
export interface ProgressCallback {
  (current: number, total: number, message: string): void;
}

/** Graph updater configuration */
export interface GraphUpdaterConfig {
  /** Force full re-index (ignore cache) */
  force?: boolean;
  /** Paths to explicitly unignore */
  unignorePaths?: Set<string>;
  /** Paths to explicitly exclude */
  excludePaths?: Set<string>;
  /** Project name (defaults to directory name) */
  projectName?: string;
  /** Progress callback */
  onProgress?: ProgressCallback;
  /** Hash cache filename */
  hashCacheFilename?: string;
  /** Maximum entries in AST cache */
  astCacheMaxEntries?: number;
  /** Maximum memory for AST cache in MB */
  astCacheMaxMemoryMB?: number;
  /** Flush interval (number of files between flushes) */
  flushInterval?: number;
  /** Enable embedding generation (defaults to true when semanticSearchService is provided) */
  enableEmbeddings?: boolean;
  /** Semantic search service for embedding generation and vector storage */
  semanticSearchService?: SemanticSearchService;
  /** Enable community detection via Memgraph Leiden (default false) */
  enableCommunities?: boolean;
  /** Enable process detection via BFS from entry points (default false) */
  enableProcesses?: boolean;
}

/** Query protocol for services that support Cypher queries */
export interface QueryProtocol extends IngestorProtocol {
  executeWrite(query: string, params: Record<string, unknown>): Promise<void>;
  fetchAll(query: string, params?: Record<string, unknown>): Promise<ResultRow[]>;
}

/** Protocol for ingestors that support flushAll (e.g., MemgraphService) */
export interface FlushableIngestor extends IngestorProtocol {
  flushAll(): Promise<void>;
}

/** Extended definition processor with optional C++ and override methods */
interface ExtendedDefinitionProcessor {
  resolveDeferredCppMethods?(): Promise<number> | number;
  processAllMethodOverrides?(): Promise<void> | void;
}

// =============================================================================
// Constants
// =============================================================================

const HASH_CACHE_DIR = join(homedir(), '.cgs', 'cache');
const DEFAULT_FLUSH_INTERVAL = 50;
const DEFAULT_AST_CACHE_MAX_ENTRIES = 500;
const DEFAULT_AST_CACHE_MAX_MEMORY_MB = 256;
const HASH_CHUNK_SIZE = 8192;
const CACHE_EVICTION_DIVISOR = 4;
const BYTES_PER_MB = 1024 * 1024;

// =============================================================================
// FunctionRegistryTrie Implementation
// =============================================================================

/**
 * Enhanced FunctionRegistryTrie with prefix/suffix search and cleanup support
 * Uses a trie structure for efficient prefix-based lookups
 */
export class FunctionRegistryTrie {
  private root: Map<string, Map<string, unknown> | string | NodeType> = new Map();
  private entriesMap: Map<QualifiedName, NodeType> = new Map();
  private simpleNameLookup: SimpleNameLookup;

  constructor(simpleNameLookup?: SimpleNameLookup) {
    this.simpleNameLookup = simpleNameLookup ?? new Map();
  }

  /**
   * Insert a qualified name with its type into the trie
   */
  insert(qualifiedName: QualifiedName, funcType: NodeType): void {
    this.entriesMap.set(qualifiedName, funcType);

    const parts = qualifiedName.split(cs.SEPARATOR_DOT);
    let current: Map<string, unknown> = this.root as Map<string, unknown>;

    for (const part of parts) {
      if (!current.has(part)) {
        current.set(part, new Map());
      }
      const child = current.get(part);
      if (child instanceof Map) {
        current = child;
      } else {
        // Create a new map if the current value is not a map
        const newMap = new Map();
        current.set(part, newMap);
        current = newMap;
      }
    }

    current.set(cs.TRIE_TYPE_KEY, funcType);
    current.set(cs.TRIE_QN_KEY, qualifiedName);

    // Update simple name lookup
    const simpleName = parts[parts.length - 1];
    let qnSet = this.simpleNameLookup.get(simpleName);
    if (!qnSet) {
      qnSet = new Set();
      this.simpleNameLookup.set(simpleName, qnSet);
    }
    qnSet.add(qualifiedName);
  }

  /**
   * Get the type for a qualified name
   */
  get(qualifiedName: QualifiedName, defaultValue?: NodeType): NodeType | undefined {
    return this.entriesMap.get(qualifiedName) ?? defaultValue;
  }

  /**
   * Check if a qualified name exists
   */
  has(qualifiedName: QualifiedName): boolean {
    return this.entriesMap.has(qualifiedName);
  }

  /**
   * Set a qualified name (alias for insert)
   */
  set(qualifiedName: QualifiedName, funcType: NodeType): void {
    this.insert(qualifiedName, funcType);
  }

  /**
   * Delete a qualified name from the trie
   */
  delete(qualifiedName: QualifiedName): void {
    if (!this.entriesMap.has(qualifiedName)) {
      return;
    }

    this.entriesMap.delete(qualifiedName);

    const parts = qualifiedName.split(cs.SEPARATOR_DOT);
    this.cleanupTriePath(parts, this.root as Map<string, unknown>);

    // Update simple name lookup
    const simpleName = parts[parts.length - 1];
    const qnSet = this.simpleNameLookup.get(simpleName);
    if (qnSet) {
      qnSet.delete(qualifiedName);
      if (qnSet.size === 0) {
        this.simpleNameLookup.delete(simpleName);
      }
    }
  }

  /**
   * Recursively clean up empty trie paths after deletion
   */
  private cleanupTriePath(parts: string[], node: Map<string, unknown>): boolean {
    if (parts.length === 0) {
      node.delete(cs.TRIE_QN_KEY);
      node.delete(cs.TRIE_TYPE_KEY);
      return node.size === 0;
    }

    const part = parts[0];
    if (!node.has(part)) {
      return false;
    }

    const child = node.get(part);
    if (!(child instanceof Map)) {
      return false;
    }

    if (this.cleanupTriePath(parts.slice(1), child)) {
      node.delete(part);
    }

    const isEndpoint = node.has(cs.TRIE_QN_KEY);
    const hasChildren = Array.from(node.keys()).some(
      (key) => !key.startsWith(cs.TRIE_INTERNAL_PREFIX)
    );
    return !hasChildren && !isEndpoint;
  }

  /**
   * Navigate to a prefix in the trie
   */
  private navigateToPrefix(prefix: string): Map<string, unknown> | null {
    const parts = prefix ? prefix.split(cs.SEPARATOR_DOT) : [];
    let current: Map<string, unknown> = this.root as Map<string, unknown>;

    for (const part of parts) {
      if (!current.has(part)) {
        return null;
      }
      const child = current.get(part);
      if (!(child instanceof Map)) {
        return null;
      }
      current = child;
    }
    return current;
  }

  /**
   * Collect all entries from a subtree
   */
  private collectFromSubtree(
    node: Map<string, unknown>,
    filterFn?: (qn: QualifiedName) => boolean
  ): Array<[QualifiedName, NodeType]> {
    const results: Array<[QualifiedName, NodeType]> = [];

    const dfs = (n: Map<string, unknown>): void => {
      if (n.has(cs.TRIE_QN_KEY)) {
        const qn = n.get(cs.TRIE_QN_KEY) as string;
        const funcType = n.get(cs.TRIE_TYPE_KEY) as NodeType;
        if (!filterFn || filterFn(qn)) {
          results.push([qn, funcType]);
        }
      }

      for (const [key, child] of n) {
        if (!key.startsWith(cs.TRIE_INTERNAL_PREFIX) && child instanceof Map) {
          dfs(child);
        }
      }
    };

    dfs(node);
    return results;
  }

  /**
   * Get all keys
   */
  keys(): IterableIterator<QualifiedName> {
    return this.entriesMap.keys();
  }

  /**
   * Get all entries as iterator
   */
  entries_iter(): IterableIterator<[QualifiedName, NodeType]> {
    return this.entriesMap.entries();
  }

  /**
   * Get all entries as iterator (standard Map interface)
   */
  [Symbol.iterator](): IterableIterator<[QualifiedName, NodeType]> {
    return this.entriesMap.entries();
  }

  /**
   * Get all entries as iterator (matches Map.entries())
   */
  entries(): IterableIterator<[QualifiedName, NodeType]> {
    return this.entriesMap.entries();
  }

  /**
   * Get all items as array
   */
  items(): Array<[QualifiedName, NodeType]> {
    return Array.from(this.entriesMap);
  }

  /**
   * Get the number of entries
   */
  get size(): number {
    return this.entriesMap.size;
  }

  /**
   * Find entries with both a prefix and suffix
   */
  findWithPrefixAndSuffix(prefix: string, suffix: string): QualifiedName[] {
    const node = this.navigateToPrefix(prefix);
    if (!node) {
      return [];
    }
    const suffixPattern = `.${suffix}`;
    const matches = this.collectFromSubtree(node, (qn) => qn.endsWith(suffixPattern));
    return matches.map(([qn]) => qn);
  }

  /**
   * Find entries ending with a suffix
   */
  findEndingWith(suffix: string): QualifiedName[] {
    // Use simple name lookup for O(1) lookup if available
    const qnSet = this.simpleNameLookup.get(suffix);
    if (qnSet) {
      return Array.from(qnSet).sort();
    }
    // Fallback to linear scan
    return Array.from(this.entriesMap.keys())
      .filter((qn) => qn.endsWith(`.${suffix}`))
      .sort();
  }

  /**
   * Find entries with a prefix
   */
  findWithPrefix(prefix: string): Array<[QualifiedName, NodeType]> {
    const node = this.navigateToPrefix(prefix);
    return node ? this.collectFromSubtree(node) : [];
  }

  /**
   * Clear all entries
   */
  clear(): void {
    this.root.clear();
    this.entriesMap.clear();
    this.simpleNameLookup.clear();
  }

  /**
   * Get the simple name lookup for compatibility with existing code
   */
  getSimpleNameLookup(): SimpleNameLookup {
    return this.simpleNameLookup;
  }
}

// =============================================================================
// BoundedASTCache Implementation
// =============================================================================

/**
 * LRU-bounded cache for parsed AST trees
 * Evicts least recently used entries when limits are exceeded
 */
export class BoundedASTCache implements ASTCacheProtocol {
  private cache: Map<string, [TreeSitterNode, SupportedLanguage]> = new Map();
  private accessOrder: string[] = [];
  private maxEntries: number;
  private maxMemoryBytes: number;

  constructor(
    maxEntries: number = DEFAULT_AST_CACHE_MAX_ENTRIES,
    maxMemoryMB: number = DEFAULT_AST_CACHE_MAX_MEMORY_MB
  ) {
    this.maxEntries = maxEntries;
    this.maxMemoryBytes = maxMemoryMB * BYTES_PER_MB;
  }

  /**
   * Set a value in the cache (moves to end of access order)
   */
  set(key: string, value: [TreeSitterNode, SupportedLanguage]): void {
    // Remove existing entry from access order
    if (this.cache.has(key)) {
      const index = this.accessOrder.indexOf(key);
      if (index !== -1) {
        this.accessOrder.splice(index, 1);
      }
    }

    this.cache.set(key, value);
    this.accessOrder.push(key);

    this.enforceLimits();
  }

  /**
   * Get a value from the cache (updates access order)
   */
  get(key: string): [TreeSitterNode, SupportedLanguage] | undefined {
    const value = this.cache.get(key);
    if (value) {
      // Move to end of access order
      const index = this.accessOrder.indexOf(key);
      if (index !== -1) {
        this.accessOrder.splice(index, 1);
        this.accessOrder.push(key);
      }
    }
    return value;
  }

  /**
   * Delete a value from the cache
   */
  delete(key: string): boolean {
    const existed = this.cache.has(key);
    if (existed) {
      this.cache.delete(key);
      const index = this.accessOrder.indexOf(key);
      if (index !== -1) {
        this.accessOrder.splice(index, 1);
      }
    }
    return existed;
  }

  /**
   * Check if a key exists in the cache
   */
  has(key: string): boolean {
    return this.cache.has(key);
  }

  /**
   * Get all entries
   */
  entries(): IterableIterator<[string, [TreeSitterNode, SupportedLanguage]]> {
    return this.cache.entries();
  }

  /**
   * Get the number of entries
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Clear all entries
   */
  clear(): void {
    this.cache.clear();
    this.accessOrder = [];
  }

  /**
   * Enforce cache size limits
   */
  private enforceLimits(): void {
    // Evict oldest entries if we exceed max entries
    while (this.cache.size > this.maxEntries && this.accessOrder.length > 0) {
      const oldestKey = this.accessOrder.shift()!;
      this.cache.delete(oldestKey);
    }

    // Check if we should evict for memory
    if (this.shouldEvictForMemory()) {
      const entriesToRemove = Math.max(1, Math.floor(this.cache.size / CACHE_EVICTION_DIVISOR));
      for (let i = 0; i < entriesToRemove && this.accessOrder.length > 0; i++) {
        const oldestKey = this.accessOrder.shift()!;
        this.cache.delete(oldestKey);
      }
    }
  }

  /**
   * Check if we should evict entries for memory pressure
   */
  private shouldEvictForMemory(): boolean {
    // Rough estimate - in Node.js we can't easily measure object sizes
    // Use entry count as a heuristic
    const memoryThresholdRatio = 0.8;
    return this.cache.size > this.maxEntries * memoryThresholdRatio;
  }
}

// =============================================================================
// File Hashing Functions
// =============================================================================

/**
 * Compute SHA-256 hash of a file
 */
export async function hashFile(filepath: string): Promise<string> {
  const hasher = createHash('sha256');
  const content = await readFile(filepath);

  // Process in chunks to avoid memory issues with large files
  for (let i = 0; i < content.length; i += HASH_CHUNK_SIZE) {
    hasher.update(content.subarray(i, i + HASH_CHUNK_SIZE));
  }

  return hasher.digest('hex');
}

/**
 * Load hash cache from disk
 */
export async function loadHashCache(cachePath: string): Promise<FileHashCache> {
  try {
    await access(cachePath, constants.F_OK);
    const content = await readFile(cachePath, 'utf-8');
    const data = JSON.parse(content);
    if (typeof data === 'object' && data !== null) {
      logger.info(`[graph-updater] Loaded hash cache: ${Object.keys(data).length} entries from ${cachePath}`);
      return data as FileHashCache;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn(`[graph-updater] Failed to load hash cache from ${cachePath}:`, error);
    }
  }
  return {};
}

/**
 * Save hash cache to disk
 */
export async function saveHashCache(cachePath: string, hashes: FileHashCache): Promise<void> {
  try {
    await mkdir(dirname(cachePath), { recursive: true });
    const content = JSON.stringify(hashes, null, 2);
    await writeFile(cachePath, content, 'utf-8');
    logger.info(`[graph-updater] Saved hash cache: ${Object.keys(hashes).length} entries to ${cachePath}`);
  } catch (error) {
    logger.warn(`[graph-updater] Failed to save hash cache to ${cachePath}:`, error);
  }
}

// =============================================================================
// GraphUpdater Class
// =============================================================================

/**
 * Main class for incremental code graph indexing
 * Handles file change detection, AST parsing, and graph updates
 */
export class GraphUpdater {
  readonly ingestor: IngestorProtocol;
  readonly repoPath: string;
  readonly projectName: string;
  readonly queries: Map<SupportedLanguage, LanguageQueries>;
  readonly functionRegistry: FunctionRegistryTrie;
  readonly simpleNameLookup: SimpleNameLookup;
  readonly astCache: BoundedASTCache;
  readonly factory: ProcessorFactory;

  private readonly unignorePaths: Set<string> | null;
  private readonly excludePaths: Set<string> | null;
  private readonly hashCacheFilename: string;
  private readonly flushInterval: number;
  private readonly enableEmbeddings: boolean;
  private readonly enableCommunities: boolean;
  private readonly enableProcesses: boolean;
  private readonly semanticSearchService?: SemanticSearchService;
  private readonly onProgress?: ProgressCallback;

  // For single-file mode
  private singleFile: string | null = null;

  // Track changed files for incremental embedding updates
  private changedFilePaths: Set<string> = new Set();
  private isForceRun = false;

  constructor(
    ingestor: IngestorProtocol,
    repoPath: string,
    queries: Map<SupportedLanguage, LanguageQueries>,
    config: GraphUpdaterConfig = {}
  ) {
    this.ingestor = ingestor;

    // Handle single file mode
    let finalRepoPath = repoPath;
    try {
      // We'll check this synchronously in the constructor for simplicity
      // The actual file check happens in run()
      this.singleFile = null;
    } catch {
      // Path doesn't exist yet, handle in run()
    }

    this.repoPath = resolve(finalRepoPath);
    this.queries = queries;
    this.projectName = (config.projectName?.trim()) || basename(this.repoPath);

    this.unignorePaths = config.unignorePaths ?? null;
    this.excludePaths = config.excludePaths ?? null;
    this.hashCacheFilename = config.hashCacheFilename ?? `${this.projectName}.json`;
    this.flushInterval = config.flushInterval ?? DEFAULT_FLUSH_INTERVAL;
    this.semanticSearchService = config.semanticSearchService;
    this.enableEmbeddings = config.enableEmbeddings ?? (config.semanticSearchService != null);
    this.enableCommunities = config.enableCommunities ?? false;
    this.enableProcesses = config.enableProcesses ?? false;
    this.onProgress = config.onProgress;

    // Initialize registries
    this.simpleNameLookup = new Map();
    this.functionRegistry = new FunctionRegistryTrie(this.simpleNameLookup);
    this.astCache = new BoundedASTCache(
      config.astCacheMaxEntries ?? DEFAULT_AST_CACHE_MAX_ENTRIES,
      config.astCacheMaxMemoryMB ?? DEFAULT_AST_CACHE_MAX_MEMORY_MB
    );

    // Create processor factory with FunctionRegistryTrieImpl adapter
    const registryAdapter = new FunctionRegistryTrieImpl();

    this.factory = new ProcessorFactory({
      ingestor: this.ingestor,
      repoPath: this.repoPath,
      projectName: this.projectName,
      queries: this.queries,
      functionRegistry: registryAdapter,
      simpleNameLookup: this.simpleNameLookup,
      astCache: this.astCache,
      unignorePaths: this.unignorePaths,
      excludePaths: this.excludePaths,
    });
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Run the indexing process
   */
  async run(force: boolean = false): Promise<void> {
    this.isForceRun = force;
    this.changedFilePaths.clear();

    // Check if repo path is a single file
    const repoStat = await stat(this.repoPath);
    if (repoStat.isFile()) {
      this.singleFile = this.repoPath;
      // Update repoPath to parent directory
      (this as { repoPath: string }).repoPath = dirname(this.repoPath);
    }

    // Ensure project node exists
    this.ingestor.ensureNodeBatch(cs.NodeLabel.PROJECT, { [cs.KEY_NAME]: this.projectName });
    logger.info(`[graph-updater] Ensuring project: ${this.projectName}`);

    // Pass 1: Identify structure (packages, folders)
    logger.info('[graph-updater] Pass 1: Identifying structure...');
    await this.factory.getStructureProcessor().identifyStructure();

    // Pass 2: Process files
    logger.info('[graph-updater] Pass 2: Processing files...');
    await this.processFiles(force);

    // Resolve any deferred operations
    const definitionProcessor = this.factory.getDefinitionProcessor() as unknown as ExtendedDefinitionProcessor;
    if (definitionProcessor.resolveDeferredCppMethods) {
      const corrected = await definitionProcessor.resolveDeferredCppMethods();
      if (corrected > 0) {
        logger.info(`[graph-updater] Resolved ${corrected} deferred C++ out-of-class methods`);
      }
    }

    logger.info(`[graph-updater] Found ${this.functionRegistry.size} functions/methods`);

    // Pass 3: Process function calls
    logger.info('[graph-updater] Pass 3: Processing function calls...');
    await this.processFunctionCalls();

    // Process method overrides
    if (definitionProcessor.processAllMethodOverrides) {
      await definitionProcessor.processAllMethodOverrides();
    }

    logger.info('[graph-updater] Analysis complete');
    await this.flushIngestor();

    // Prune orphan nodes
    await this.pruneOrphanNodes();

    // Pass 4: Generate embeddings (if enabled)
    if (this.enableEmbeddings) {
      logger.info('[graph-updater] Pass 4: Generating embeddings...');
      await this.generateSemanticEmbeddings();
    }

    // Pass 5: Community detection (if enabled)
    if (this.enableCommunities) {
      logger.info('[graph-updater] Pass 5: Detecting communities...');
      try {
        const { detectCommunities } = await import('./community-detector.js');
        const ingestor = this.ingestor as unknown as {
          executeWrite?: (q: string, p?: Record<string, unknown>) => Promise<void>;
          fetchAll?: (q: string, p?: Record<string, unknown>) => Promise<ResultRow[]>;
        };
        if (ingestor.executeWrite && ingestor.fetchAll) {
          await detectCommunities(
            {
              executeWrite: ingestor.executeWrite.bind(this.ingestor),
              fetchAll: ingestor.fetchAll.bind(this.ingestor),
            },
            this.projectName,
          );
        } else {
          logger.warn('[graph-updater] Ingestor lacks query support, skipping community detection');
        }
      } catch (err) {
        logger.warn(`[graph-updater] Community detection failed: ${(err as Error).message}`);
      }
    }

    // Pass 6: Process detection (if enabled)
    if (this.enableProcesses) {
      logger.info('[graph-updater] Pass 6: Detecting processes...');
      try {
        const { detectProcesses } = await import('./process-detector.js');
        const ingestor = this.ingestor as unknown as {
          executeWrite?: (q: string, p?: Record<string, unknown>) => Promise<void>;
          fetchAll?: (q: string, p?: Record<string, unknown>) => Promise<ResultRow[]>;
        };
        if (ingestor.executeWrite && ingestor.fetchAll) {
          await detectProcesses(
            {
              executeWrite: ingestor.executeWrite.bind(this.ingestor),
              fetchAll: ingestor.fetchAll.bind(this.ingestor),
            },
            this.projectName,
          );
        } else {
          logger.warn('[graph-updater] Ingestor lacks query support, skipping process detection');
        }
      } catch (err) {
        logger.warn(`[graph-updater] Process detection failed: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Remove a file from internal state (for incremental updates)
   */
  removeFileFromState(filePath: string): void {
    logger.debug(`[graph-updater] Removing state for: ${filePath}`);

    // Remove from AST cache
    if (this.astCache.has(filePath)) {
      this.astCache.delete(filePath);
      logger.debug('[graph-updater] Removed from AST cache');
    }

    // New format: keys start with '<file_path>:' (e.g., 'src/lib/foo.ts:Foo.bar').
    const relativePath = relative(this.repoPath, filePath).replace(/\\/g, '/');
    const filePrefix = `${relativePath}:`;

    const qnsToRemove = new Set<string>();
    for (const qn of this.functionRegistry.keys()) {
      if (qn.startsWith(filePrefix) || qn === relativePath) {
        qnsToRemove.add(qn);
        this.functionRegistry.delete(qn);
      }
    }

    if (qnsToRemove.size > 0) {
      logger.debug(`[graph-updater] Removed ${qnsToRemove.size} qualified names from registry`);
    }
  }

  /**
   * Get statistics about the current state
   */
  getStats(): {
    registeredFunctions: number;
    simpleNames: number;
    cachedASTs: number;
  } {
    return {
      registeredFunctions: this.functionRegistry.size,
      simpleNames: this.simpleNameLookup.size,
      cachedASTs: this.astCache.size,
    };
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Check if a directory should be kept (not ignored)
   */
  private shouldKeepDir(dirname: string, dirPrefix: string): boolean {
    if (!cs.IGNORE_PATTERNS.has(dirname) && (!this.excludePaths || !this.excludePaths.has(dirname))) {
      return true;
    }
    return !!(
      this.unignorePaths &&
      Array.from(this.unignorePaths).some(
        (u) => u.startsWith(`${dirPrefix}${dirname}/`) || u === `${dirPrefix}${dirname}`
      )
    );
  }

  /**
   * Check if a file is a dependency file (package.json, requirements.txt, etc.)
   */
  private isDependencyFile(fileName: string, filePath: string): boolean {
    return (
      cs.DEPENDENCY_FILES.has(fileName.toLowerCase()) ||
      extname(filePath).toLowerCase() === cs.CSPROJ_SUFFIX
    );
  }

  /**
   * Collect all eligible files for processing
   */
  private async collectEligibleFiles(): Promise<string[]> {
    if (this.singleFile) {
      if (!shouldSkipPath(this.singleFile, this.repoPath, this.excludePaths, this.unignorePaths)) {
        return [this.singleFile];
      }
      return [];
    }

    const eligible: string[] = [];

    const walkDir = async (dir: string): Promise<void> => {
      const relDir = relative(this.repoPath, dir);
      const dirPrefix = relDir === '' || relDir === '.' ? '' : `${relDir}/`;

      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        return;
      }

      // Sort entries
      entries.sort();

      // Separate directories and files
      const dirs: string[] = [];
      const files: string[] = [];

      for (const entry of entries) {
        const fullPath = join(dir, entry);
        try {
          const entryStat = await stat(fullPath);
          if (entryStat.isDirectory()) {
            if (this.shouldKeepDir(entry, dirPrefix)) {
              dirs.push(fullPath);
            }
          } else if (entryStat.isFile()) {
            if (!shouldSkipPath(fullPath, this.repoPath, this.excludePaths, this.unignorePaths)) {
              eligible.push(fullPath);
            }
          }
        } catch {
          // Skip entries we can't stat
        }
      }

      // Recursively process directories
      for (const subDir of dirs) {
        await walkDir(subDir);
      }
    };

    await walkDir(this.repoPath);
    return eligible;
  }

  /**
   * Process all files with incremental change detection
   */
  private async processFiles(force: boolean): Promise<void> {
    const cachePath = join(HASH_CACHE_DIR, this.hashCacheFilename);
    const oldHashes = force ? {} : await loadHashCache(cachePath);

    if (force) {
      logger.info('[graph-updater] Force mode: ignoring hash cache');
    }

    const eligibleFiles = await this.collectEligibleFiles();

    // Build the suffix index used by the import processor as a fallback
    // resolution layer (handles re-export chains and ambiguous imports).
    try {
      this.factory.getImportProcessor().buildAndSetSuffixIndex(eligibleFiles);
    } catch (err) {
      logger.warn('[graph-updater] Failed to build suffix index:', err);
    }

    const newHashes: FileHashCache = {};
    let skippedCount = 0;
    let changedCount = 0;
    let processedSinceFlush = 0;

    const currentFileKeys = new Set<string>();

    for (let i = 0; i < eligibleFiles.length; i++) {
      const filepath = eligibleFiles[i];
      const fileKey = relative(this.repoPath, filepath);
      currentFileKeys.add(fileKey);

      // Hash the file
      let currentHash: string;
      try {
        currentHash = await hashFile(filepath);
      } catch (error) {
        logger.warn(`[graph-updater] Failed to hash ${fileKey}:`, error);
        continue;
      }
      newHashes[fileKey] = currentHash;

      // Check if file has changed
      if (!force && fileKey in oldHashes && oldHashes[fileKey] === currentHash) {
        logger.debug(`[graph-updater] Unchanged: ${fileKey}`);
        skippedCount++;
        this.onProgress?.(i + 1, eligibleFiles.length, `Skipped (unchanged): ${fileKey}`);
        continue;
      }

      // File is new or changed
      if (fileKey in oldHashes) {
        logger.debug(`[graph-updater] Changed: ${fileKey}`);
        this.removeFileFromState(filepath);
      } else {
        logger.debug(`[graph-updater] New: ${fileKey}`);
      }

      this.changedFilePaths.add(fileKey);
      changedCount++;
      await this.processSingleFile(filepath);

      processedSinceFlush++;
      if (processedSinceFlush >= this.flushInterval) {
        logger.info(`[graph-updater] Periodic flush after ${processedSinceFlush} files`);
        await this.flushIngestor();
        processedSinceFlush = 0;
      }

      this.onProgress?.(i + 1, eligibleFiles.length, `Processed: ${fileKey}`);
    }

    // Handle deleted files
    const deletedKeys = Object.keys(oldHashes).filter((k) => !currentFileKeys.has(k));
    if (deletedKeys.length > 0) {
      logger.info(`[graph-updater] ${deletedKeys.length} files deleted`);
      for (const deletedKey of deletedKeys) {
        const deletedPath = join(this.repoPath, deletedKey);
        this.removeFileFromState(deletedPath);
        this.changedFilePaths.add(deletedKey);

        if (this.isQueryProtocol(this.ingestor)) {
          await this.ingestor.executeWrite(CYPHER_DELETE_MODULE, { [cs.KEY_PATH]: deletedKey });
          await this.ingestor.executeWrite(CYPHER_DELETE_FILE, { [cs.KEY_PATH]: deletedKey });
        }
      }
    }

    if (skippedCount > 0) {
      logger.info(`[graph-updater] Skipped ${skippedCount} unchanged files`);
    }
    if (changedCount > 0) {
      logger.info(`[graph-updater] Processed ${changedCount} changed files`);
    }

    // Save updated hash cache
    await saveHashCache(cachePath, newHashes);
  }

  /**
   * Process a single file
   */
  private async processSingleFile(filepath: string): Promise<void> {
    const fileName = basename(filepath);
    const ext = extname(filepath);

    // Try to get language spec for this file extension
    const langSpec = getLanguageSpecForExtension(ext);

    if (langSpec && this.queries.has(langSpec.language)) {
      // Process as code file
      const result = await this.factory
        .getDefinitionProcessor()
        .processFile(
          filepath,
          langSpec.language,
          this.queries,
          this.factory.getStructureProcessor().structuralElements
        );

      if (result) {
        const [rootNode, language] = result;
        this.astCache.set(filepath, [rootNode, language]);

        // Sync with our function registry
        const factoryRegistry = this.factory.functionRegistry;
        if (factoryRegistry instanceof FunctionRegistryTrieImpl) {
          for (const [qn, nodeType] of factoryRegistry.entries()) {
            this.functionRegistry.set(qn, nodeType);
          }
        }
      }
    } else if (this.isDependencyFile(fileName, filepath)) {
      // Process as dependency file
      await this.factory.getDefinitionProcessor().processDependencies(filepath);
    }

    // Process as generic file
    this.factory.getStructureProcessor().processGenericFile(filepath, fileName);
  }

  /**
   * Process function calls for all cached ASTs
   */
  private async processFunctionCalls(): Promise<void> {
    const callProcessor = this.factory.getCallProcessor();
    const entries = Array.from(this.astCache.entries());

    for (const [filePath, [rootNode, language]] of entries) {
      callProcessor.processCallsInFile(filePath, rootNode, language, this.queries);
    }
  }

  /**
   * Prune orphan nodes from the graph
   */
  private async pruneOrphanNodes(): Promise<void> {
    if (!this.isQueryProtocol(this.ingestor)) {
      return;
    }

    logger.info('[graph-updater] Pruning orphan nodes...');
    let totalPruned = 0;

    const projectPrefix = `${this.projectName}.`;
    const repoAbs = resolve(this.repoPath);

    const pruneSpecs: Array<{
      queryAll: string;
      deleteQuery: string;
      label: string;
    }> = [
      { queryAll: CYPHER_ALL_FILE_PATHS, deleteQuery: CYPHER_DELETE_FILE, label: 'File' },
      { queryAll: CYPHER_ALL_MODULE_PATHS_INTERNAL, deleteQuery: CYPHER_DELETE_MODULE, label: 'Module' },
      { queryAll: CYPHER_ALL_FOLDER_PATHS, deleteQuery: CYPHER_DELETE_FOLDER, label: 'Folder' },
    ];

    for (const { queryAll, deleteQuery, label } of pruneSpecs) {
      const rows = await this.ingestor.fetchAll(queryAll);
      const orphans: string[] = [];

      for (const row of rows) {
        const path = row.path;
        if (typeof path !== 'string' || !path) {
          continue;
        }

        const absPath = row.absolute_path;
        const qn = row.qualified_name as string | undefined;

        // Skip nodes from other projects
        if (typeof absPath === 'string' && !absPath.startsWith(repoAbs)) {
          continue;
        }
        if (typeof qn === 'string' && qn && !qn.startsWith(projectPrefix)) {
          continue;
        }

        // Check if file/folder exists
        const fullPath = join(this.repoPath, path);
        try {
          await access(fullPath, constants.F_OK);
        } catch {
          orphans.push(path);
        }
      }

      if (orphans.length > 0) {
        logger.info(`[graph-updater] Found ${orphans.length} orphan ${label} nodes`);
        for (const orphanPath of orphans) {
          logger.debug(`[graph-updater] Deleting orphan ${label}: ${orphanPath}`);
          await this.ingestor.executeWrite(deleteQuery, { [cs.KEY_PATH]: orphanPath });
        }
        totalPruned += orphans.length;
      }
    }

    if (totalPruned > 0) {
      logger.info(`[graph-updater] Pruned ${totalPruned} total orphan nodes`);
    } else {
      logger.info('[graph-updater] No orphan nodes found');
    }
  }

  /**
   * Generate semantic embeddings for functions and store in zvec via SemanticSearchService
   */
  private async generateSemanticEmbeddings(): Promise<void> {
    if (!this.semanticSearchService) {
      logger.warn('[graph-updater] No SemanticSearchService provided, skipping embedding generation');
      return;
    }

    if (!this.isQueryProtocol(this.ingestor)) {
      logger.warn('[graph-updater] Ingestor does not support queries, skipping embedding generation');
      return;
    }

    // Query all functions/methods from the graph
    const results = await this.ingestor.fetchAll(cs.CYPHER_QUERY_EMBEDDINGS, {
      project_name: this.projectName,
    });

    if (!results || results.length === 0) {
      logger.info('[graph-updater] No functions/methods found for embedding generation');
      return;
    }

    // On incremental update, only re-embed functions from changed files
    const filteredResults = this.isForceRun
      ? results
      : results.filter(row => {
          const filePath = row.path as string | null;
          return filePath && this.changedFilePaths.has(filePath);
        });

    if (filteredResults.length === 0) {
      logger.info('[graph-updater] No changed functions to embed');
      return;
    }

    logger.info(`[graph-updater] Generating embeddings for ${filteredResults.length}/${results.length} functions/methods${this.isForceRun ? ' (full)' : ' (changed only)'}...`);

    // Build embedding documents from source code
    const BATCH_SIZE = 50;
    const docs: Array<{
      id: string;
      code: string;
      qualifiedName: string;
      filePath: string;
      project: string;
      nodeType?: string;
    }> = [];

    for (const row of filteredResults) {
      const qualifiedName = row.qualified_name as string;
      const filePath = row.path as string | null;
      const startLine = row.start_line as number | null;
      const endLine = row.end_line as number | null;

      if (!filePath || startLine === null || endLine === null) {
        continue;
      }

      try {
        const fullPath = join(this.repoPath, filePath);
        const content = await readFile(fullPath, 'utf-8');
        const lines = content.split('\n');
        const codeSnippet = lines.slice(startLine - 1, endLine).join('\n');

        // Embedding text: qualifiedName + code snippet (truncated)
        const embeddingText = `${qualifiedName}\n${codeSnippet.slice(0, 500)}`;

        // zvec doc IDs max 64 chars — hash if too long
        const docId = qualifiedName.length <= 64
          ? qualifiedName
          : createHash('sha256').update(qualifiedName).digest('hex').slice(0, 16) + '_' + qualifiedName.slice(-47);

        docs.push({
          id: docId,
          code: embeddingText,
          qualifiedName,
          filePath,
          project: this.projectName,
          nodeType: 'Function',
        });
      } catch {
        logger.debug(`[graph-updater] Skipping unreadable file: ${filePath}`);
      }
    }

    if (docs.length === 0) {
      logger.info('[graph-updater] No readable functions found for embedding generation');
      return;
    }

    // Process in batches of 50
    let processed = 0;
    for (let start = 0; start < docs.length; start += BATCH_SIZE) {
      const batch = docs.slice(start, start + BATCH_SIZE);
      await this.semanticSearchService.indexCodeBatch(batch);
      processed += batch.length;

      this.onProgress?.(processed, docs.length, `Embeddings: ${processed}/${docs.length}`);
      logger.info(`[graph-updater] Embedded ${processed}/${docs.length} functions`);
    }

    // Optimize the vector store after bulk indexing
    await this.semanticSearchService.optimize();
    logger.info(`[graph-updater] Embedding generation complete: ${docs.length} functions indexed`);
  }

  /**
   * Type guard to check if ingestor supports query operations
   */
  private isQueryProtocol(ingestor: IngestorProtocol): ingestor is QueryProtocol {
    return (
      typeof (ingestor as QueryProtocol).executeWrite === 'function' &&
      typeof (ingestor as QueryProtocol).fetchAll === 'function'
    );
  }

  /**
   * Type guard to check if ingestor supports flushAll
   */
  private isFlushableIngestor(ingestor: IngestorProtocol): ingestor is FlushableIngestor {
    return typeof (ingestor as FlushableIngestor).flushAll === 'function';
  }

  /**
   * Flush the ingestor using the appropriate method
   */
  private async flushIngestor(): Promise<void> {
    if (this.isFlushableIngestor(this.ingestor)) {
      await this.ingestor.flushAll();
    } else {
      await this.ingestor.flush();
    }
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a GraphUpdater instance
 */
export async function createGraphUpdater(
  ingestor: IngestorProtocol,
  repoPath: string,
  config: GraphUpdaterConfig = {}
): Promise<GraphUpdater> {
  // Load all language queries
  const queries = await loadAllQueries();

  return new GraphUpdater(ingestor, repoPath, queries, config);
}

/**
 * Create a GraphUpdater with a specific set of languages
 */
export async function createGraphUpdaterWithLanguages(
  ingestor: IngestorProtocol,
  repoPath: string,
  languages: SupportedLanguage[],
  config: GraphUpdaterConfig = {}
): Promise<GraphUpdater> {
  const { getQueries } = await import('./tree-sitter/index.js');

  const queries = new Map<SupportedLanguage, LanguageQueries>();
  for (const lang of languages) {
    try {
      const langQueries = await getQueries(lang);
      queries.set(lang, langQueries);
    } catch (error) {
      logger.warn(`[graph-updater] Failed to load queries for ${lang}:`, error);
    }
  }

  return new GraphUpdater(ingestor, repoPath, queries, config);
}
