/**
 * API-based embeddings service for code-graph-rag
 * Uses OpenAI/OpenRouter APIs for embedding generation
 * Uses zvec for vector storage and similarity search
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { EMBEDDING_CACHE_FILENAME } from './constants.js';
import { VectorStore, createVectorStore, type VectorDocument, type VectorSearchResult, type VectorStoreConfig } from './vector-store.js';
export const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';
export const DEFAULT_RETRY_COUNT = 3;
export const DEFAULT_RETRY_DELAY_MS = 1000;
export const DEFAULT_EMBEDDING_DIMENSIONS = 1536; // text-embedding-3-small default
export const DEFAULT_BATCH_SIZE = 100; // OpenAI allows up to 2048 inputs per batch
export const OPENAI_API_URL = 'https://api.openai.com/v1/embeddings';
export const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/embeddings';

// =============================================================================
// Types
// =============================================================================

export interface EmbeddingConfig {
  provider: 'openai' | 'openrouter';
  apiKey: string;
  model?: string;
  dimensions?: number;
  baseUrl?: string;
  retryCount?: number;
  retryDelayMs?: number;
}

export interface EmbeddingCacheEntry {
  embedding: number[];
  model?: string;
  timestamp?: number;
}

export interface EmbeddingResult {
  embedding: number[];
  index: number;
}

export interface EmbeddingApiResponse {
  object: string;
  data: Array<{
    object: string;
    embedding: number[];
    index: number;
  }>;
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

export interface SimilarityResult {
  index: number;
  score: number;
  content?: string;
}

// =============================================================================
// Embedding Cache
// =============================================================================

/**
 * Cache for storing embeddings by content hash.
 * Compatible with Python's .cgr-embedding-cache.json format.
 */
export class EmbeddingCache {
  private cache: Map<string, number[]> = new Map();
  private cachePath: string | null;
  private dirty = false;

  constructor(cachePath: string | null = null) {
    this.cachePath = cachePath;
  }

  /**
   * Generate SHA256 hash of content for cache key
   */
  private static contentHash(content: string): string {
    return createHash('sha256').update(content, 'utf-8').digest('hex');
  }

  /**
   * Get cached embedding for content
   */
  get(content: string): number[] | null {
    const hash = EmbeddingCache.contentHash(content);
    return this.cache.get(hash) ?? null;
  }

  /**
   * Store embedding for content
   */
  put(content: string, embedding: number[]): void {
    const hash = EmbeddingCache.contentHash(content);
    this.cache.set(hash, embedding);
    this.dirty = true;
  }

  /**
   * Get multiple cached embeddings, returning map of index -> embedding
   */
  getMany(snippets: string[]): Map<number, number[]> {
    const results = new Map<number, number[]>();
    for (let i = 0; i < snippets.length; i++) {
      const cached = this.get(snippets[i]);
      if (cached !== null) {
        results.set(i, cached);
      }
    }
    return results;
  }

  /**
   * Store multiple embeddings
   */
  putMany(snippets: string[], embeddings: number[][]): void {
    if (snippets.length !== embeddings.length) {
      throw new Error('Snippets and embeddings arrays must have same length');
    }
    for (let i = 0; i < snippets.length; i++) {
      this.put(snippets[i], embeddings[i]);
    }
  }

  /**
   * Save cache to disk (JSON format compatible with Python)
   */
  async save(): Promise<void> {
    if (!this.cachePath || !this.dirty) {
      return;
    }

    try {
      // Convert Map to plain object for JSON serialization
      const cacheObject: Record<string, number[]> = {};
      this.cache.forEach((embedding, hash) => {
        cacheObject[hash] = embedding;
      });

      // Ensure parent directory exists
      const dir = path.dirname(this.cachePath);
      await fs.promises.mkdir(dir, { recursive: true });

      await fs.promises.writeFile(
        this.cachePath,
        JSON.stringify(cacheObject, null, 2),
        'utf-8'
      );
      this.dirty = false;
    } catch (error) {
      console.warn(`Failed to save embedding cache to ${this.cachePath}:`, error);
    }
  }

  /**
   * Load cache from disk
   */
  async load(): Promise<void> {
    if (!this.cachePath) {
      return;
    }

    try {
      const data = await fs.promises.readFile(this.cachePath, 'utf-8');
      const cacheObject = JSON.parse(data) as Record<string, number[]>;

      this.cache.clear();
      for (const [hash, embedding] of Object.entries(cacheObject)) {
        this.cache.set(hash, embedding);
      }

      console.debug(`Loaded ${this.cache.size} embeddings from cache: ${this.cachePath}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`Failed to load embedding cache from ${this.cachePath}:`, error);
      }
      this.cache.clear();
    }
  }

  /**
   * Clear all cached embeddings
   */
  clear(): void {
    this.cache.clear();
    this.dirty = true;
  }

  /**
   * Get number of cached embeddings
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Check if content is cached
   */
  has(content: string): boolean {
    return this.cache.has(EmbeddingCache.contentHash(content));
  }
}

// =============================================================================
// Embedding Service
// =============================================================================

/**
 * API-based embedding service supporting OpenAI and OpenRouter
 */
export class EmbeddingService {
  private config: Required<EmbeddingConfig>;
  private cache: EmbeddingCache;
  private apiUrl: string;

  constructor(config: EmbeddingConfig, cachePath?: string) {
    // Set defaults
    this.config = {
      provider: config.provider,
      apiKey: config.apiKey,
      model: config.model ?? DEFAULT_EMBEDDING_MODEL,
      dimensions: config.dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS,
      baseUrl: config.baseUrl ?? this.getDefaultBaseUrl(config.provider),
      retryCount: config.retryCount ?? DEFAULT_RETRY_COUNT,
      retryDelayMs: config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
    };

    this.apiUrl = `${this.config.baseUrl}/embeddings`;
    this.cache = new EmbeddingCache(cachePath ?? null);
  }

  private getDefaultBaseUrl(provider: 'openai' | 'openrouter'): string {
    switch (provider) {
      case 'openai':
        return 'https://api.openai.com/v1';
      case 'openrouter':
        return 'https://openrouter.ai/api/v1';
      default:
        return 'https://api.openai.com/v1';
    }
  }

  /**
   * Initialize the service (load cache)
   */
  async initialize(): Promise<void> {
    await this.cache.load();
  }

  /**
   * Get the underlying cache instance
   */
  getCache(): EmbeddingCache {
    return this.cache;
  }

  /**
   * Sleep helper for retry delays
   */
  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Check if error is retryable (rate limits, temporary failures)
   */
  private isRetryableError(status: number): boolean {
    return status === 429 || status >= 500;
  }

  /**
   * Make API request for embeddings with retry logic
   */
  private async fetchEmbeddings(inputs: string[]): Promise<EmbeddingApiResponse> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.config.apiKey}`,
    };

    // OpenRouter requires additional headers
    if (this.config.provider === 'openrouter') {
      headers['HTTP-Referer'] = 'https://github.com/anthropics/pi-code-graph';
      headers['X-Title'] = 'pi-code-graph';
    }

    const body: Record<string, unknown> = {
      model: this.config.model,
      input: inputs,
    };

    // Only include dimensions for models that support it
    if (this.config.model.startsWith('text-embedding-3')) {
      body.dimensions = this.config.dimensions;
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.config.retryCount; attempt++) {
      try {
        const response = await fetch(this.apiUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const errorText = await response.text();
          
          // Check if retryable
          if (this.isRetryableError(response.status) && attempt < this.config.retryCount - 1) {
            const delay = this.config.retryDelayMs * Math.pow(2, attempt);
            console.warn(`Embedding API error (${response.status}), retrying in ${delay}ms...`);
            await this.sleep(delay);
            continue;
          }
          
          throw new Error(`Embedding API error (${response.status}): ${errorText}`);
        }

        return response.json() as Promise<EmbeddingApiResponse>;
      } catch (error) {
        lastError = error as Error;
        
        // Retry on network errors
        if (attempt < this.config.retryCount - 1) {
          const delay = this.config.retryDelayMs * Math.pow(2, attempt);
          console.warn(`Embedding request failed, retrying in ${delay}ms:`, (error as Error).message);
          await this.sleep(delay);
        }
      }
    }

    throw lastError ?? new Error('Failed to fetch embeddings after retries');
  }

  /**
   * Embed a single code snippet
   */
  async embedCode(code: string): Promise<number[]> {
    // Check cache first
    const cached = this.cache.get(code);
    if (cached !== null) {
      return cached;
    }

    // Fetch from API
    const response = await this.fetchEmbeddings([code]);

    if (!response.data || response.data.length === 0) {
      throw new Error('No embeddings returned from API');
    }

    const embedding = response.data[0].embedding;
    this.cache.put(code, embedding);

    return embedding;
  }

  /**
   * Embed multiple code snippets in batches
   */
  async embedCodeBatch(
    snippets: string[],
    batchSize: number = DEFAULT_BATCH_SIZE
  ): Promise<number[][]> {
    if (snippets.length === 0) {
      return [];
    }

    // Check cache for all snippets
    const cachedResults = this.cache.getMany(snippets);

    // If all are cached, return immediately
    if (cachedResults.size === snippets.length) {
      console.debug(`All ${snippets.length} embeddings from cache`);
      return snippets.map((_, i) => cachedResults.get(i)!);
    }

    // Find uncached snippets
    const uncachedIndices: number[] = [];
    const uncachedSnippets: string[] = [];

    for (let i = 0; i < snippets.length; i++) {
      if (!cachedResults.has(i)) {
        uncachedIndices.push(i);
        uncachedSnippets.push(snippets[i]);
      }
    }

    console.debug(`Fetching ${uncachedSnippets.length} embeddings (${cachedResults.size} cached)`);

    // Fetch uncached embeddings in batches
    const allNewEmbeddings: number[][] = [];

    for (let start = 0; start < uncachedSnippets.length; start += batchSize) {
      const batch = uncachedSnippets.slice(start, start + batchSize);
      const response = await this.fetchEmbeddings(batch);

      // Sort by index to ensure correct order
      const sortedData = [...response.data].sort((a, b) => a.index - b.index);

      for (const item of sortedData) {
        allNewEmbeddings.push(item.embedding);
      }

      // Progress logging for large batches
      if (uncachedSnippets.length > batchSize) {
        const progress = Math.min(start + batchSize, uncachedSnippets.length);
        console.debug(`Embedded ${progress}/${uncachedSnippets.length} snippets`);
      }
    }

    // Cache new embeddings
    this.cache.putMany(uncachedSnippets, allNewEmbeddings);

    // Combine cached and new results in original order
    const results: number[][] = new Array(snippets.length);

    cachedResults.forEach((embedding, i) => {
      results[i] = embedding;
    });

    for (let idx = 0; idx < uncachedIndices.length; idx++) {
      results[uncachedIndices[idx]] = allNewEmbeddings[idx];
    }

    return results;
  }

  /**
   * Save the cache to disk
   */
  async saveCache(): Promise<void> {
    await this.cache.save();
  }

  /**
   * Clear the cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get model info
   */
  getModelInfo(): { provider: string; model: string; dimensions: number } {
    return {
      provider: this.config.provider,
      model: this.config.model,
      dimensions: this.config.dimensions,
    };
  }
}

// =============================================================================
// Similarity Functions
// =============================================================================

/**
 * Calculate cosine similarity between two vectors
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);

  if (magnitude === 0) {
    return 0;
  }

  return dotProduct / magnitude;
}

/**
 * Calculate Euclidean distance between two vectors
 */
export function euclideanDistance(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }

  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }

  return Math.sqrt(sum);
}

/**
 * Find most similar embeddings to a query vector
 */
export function findSimilar(
  queryEmbedding: number[],
  embeddings: number[][],
  topK: number = 5,
  minScore: number = 0
): SimilarityResult[] {
  const similarities: SimilarityResult[] = [];

  for (let i = 0; i < embeddings.length; i++) {
    const score = cosineSimilarity(queryEmbedding, embeddings[i]);
    if (score >= minScore) {
      similarities.push({ index: i, score });
    }
  }

  // Sort by score descending
  similarities.sort((a, b) => b.score - a.score);

  // Return top K results
  return similarities.slice(0, topK);
}

/**
 * Semantic search: find most similar code snippets to a query
 */
export async function semanticSearch(
  service: EmbeddingService,
  query: string,
  candidates: string[],
  topK: number = 5,
  minScore: number = 0
): Promise<Array<SimilarityResult & { content: string }>> {
  if (candidates.length === 0) {
    return [];
  }

  // Get query embedding
  const queryEmbedding = await service.embedCode(query);

  // Get embeddings for all candidates
  const candidateEmbeddings = await service.embedCodeBatch(candidates);

  // Find most similar
  const results = findSimilar(queryEmbedding, candidateEmbeddings, topK, minScore);

  // Add content to results
  return results.map((r) => ({
    ...r,
    content: candidates[r.index],
  }));
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Normalize an embedding vector to unit length
 */
export function normalizeEmbedding(embedding: number[]): number[] {
  let norm = 0;
  for (const val of embedding) {
    norm += val * val;
  }
  norm = Math.sqrt(norm);

  if (norm === 0) {
    return embedding;
  }

  return embedding.map((v) => v / norm);
}

/**
 * Average multiple embeddings into one
 */
export function averageEmbeddings(embeddings: number[][]): number[] {
  if (embeddings.length === 0) {
    throw new Error('Cannot average empty embeddings array');
  }

  const dim = embeddings[0].length;
  const result = new Array(dim).fill(0);

  for (const embedding of embeddings) {
    if (embedding.length !== dim) {
      throw new Error('All embeddings must have same dimension');
    }
    for (let i = 0; i < dim; i++) {
      result[i] += embedding[i];
    }
  }

  const n = embeddings.length;
  for (let i = 0; i < dim; i++) {
    result[i] /= n;
  }

  return result;
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create an EmbeddingService from environment variables
 */
export function createEmbeddingServiceFromEnv(
  cachePath?: string
): EmbeddingService | null {
  // Try OpenAI first
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    return new EmbeddingService(
      {
        provider: 'openai',
        apiKey: openaiKey,
        model: process.env.EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL,
      },
      cachePath
    );
  }

  // Try OpenRouter
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  if (openrouterKey) {
    return new EmbeddingService(
      {
        provider: 'openrouter',
        apiKey: openrouterKey,
        model: process.env.EMBEDDING_MODEL || 'openai/text-embedding-3-small',
      },
      cachePath
    );
  }

  return null;
}

/**
 * Get the default cache path for a project
 */
export function getDefaultCachePath(projectPath: string): string {
  return path.join(projectPath, '.cgr', EMBEDDING_CACHE_FILENAME);
}

// =============================================================================
// Singleton Instance Management
// =============================================================================

let globalEmbeddingService: EmbeddingService | null = null;
let globalCachePath: string | null = null;

/**
 * Get or create the global embedding service instance
 */
export async function getEmbeddingService(
  projectPath?: string
): Promise<EmbeddingService | null> {
  const cachePath = projectPath ? getDefaultCachePath(projectPath) : null;

  // Return existing instance if same cache path
  if (globalEmbeddingService && cachePath === globalCachePath) {
    return globalEmbeddingService;
  }

  // Create new instance
  const service = createEmbeddingServiceFromEnv(cachePath ?? undefined);
  if (service) {
    await service.initialize();
    globalEmbeddingService = service;
    globalCachePath = cachePath;
  }

  return service;
}

/**
 * Clear the global embedding service instance
 */
export function clearEmbeddingService(): void {
  globalEmbeddingService = null;
  globalCachePath = null;
}

// =============================================================================
// Combined Embedding + Vector Store Service
// =============================================================================

/**
 * Combined service that handles both embedding generation and vector storage
 */
export class SemanticSearchService {
  private embeddingService: EmbeddingService;
  private vectorStore: VectorStore;
  private isInitialized = false;

  constructor(
    embeddingConfig: EmbeddingConfig,
    vectorStoreConfig?: VectorStoreConfig
  ) {
    this.embeddingService = new EmbeddingService(embeddingConfig);
    this.vectorStore = createVectorStore(vectorStoreConfig);
  }

  /**
   * Initialize both services
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    
    await Promise.all([
      this.embeddingService.initialize(),
      this.vectorStore.initialize(),
    ]);
    
    this.isInitialized = true;
  }

  /**
   * Index a code element (generate embedding and store in vector DB)
   */
  async indexCode(doc: {
    id: string;
    code: string;
    qualifiedName: string;
    filePath: string;
    project: string;
    nodeType?: string;
  }): Promise<void> {
    await this.ensureInitialized();

    // Generate embedding
    const embedding = await this.embeddingService.embedCode(doc.code);

    // Store in vector DB
    await this.vectorStore.upsert({
      id: doc.id,
      embedding,
      qualifiedName: doc.qualifiedName,
      filePath: doc.filePath,
      project: doc.project,
      nodeType: doc.nodeType,
      sourceCode: doc.code,
    });
  }

  /**
   * Index multiple code elements
   */
  async indexCodeBatch(docs: Array<{
    id: string;
    code: string;
    qualifiedName: string;
    filePath: string;
    project: string;
    nodeType?: string;
  }>): Promise<void> {
    await this.ensureInitialized();

    // Generate embeddings in batch
    const codes = docs.map(d => d.code);
    const embeddings = await this.embeddingService.embedCodeBatch(codes);

    // Store in vector DB
    const vectorDocs: VectorDocument[] = docs.map((doc, i) => ({
      id: doc.id,
      embedding: embeddings[i],
      qualifiedName: doc.qualifiedName,
      filePath: doc.filePath,
      project: doc.project,
      nodeType: doc.nodeType,
      sourceCode: doc.code,
    }));

    await this.vectorStore.upsertBatch(vectorDocs);
  }

  /**
   * Search for similar code
   */
  async search(
    query: string,
    options?: {
      topK?: number;
      project?: string;
      nodeType?: string;
    }
  ): Promise<VectorSearchResult[]> {
    await this.ensureInitialized();

    // Generate query embedding
    const queryEmbedding = await this.embeddingService.embedCode(query);

    // Search in vector DB
    return this.vectorStore.search(queryEmbedding, options);
  }

  /**
   * Delete indexed code
   */
  async delete(ids: string | string[]): Promise<void> {
    await this.ensureInitialized();
    await this.vectorStore.delete(ids);
  }

  /**
   * Delete all indexed code for a project
   */
  async deleteProject(project: string): Promise<void> {
    await this.ensureInitialized();
    await this.vectorStore.deleteByProject(project);
  }

  /**
   * Get statistics
   */
  async stats(): Promise<{ docCount: number; cacheSize: number }> {
    await this.ensureInitialized();
    const vectorStats = await this.vectorStore.stats();
    return {
      docCount: vectorStats.docCount,
      cacheSize: this.embeddingService.getCache().size,
    };
  }

  /**
   * Optimize vector store
   */
  async optimize(): Promise<void> {
    await this.ensureInitialized();
    await this.vectorStore.optimize();
  }

  /**
   * Close all resources
   */
  async close(): Promise<void> {
    await this.embeddingService.getCache().save();
    await this.vectorStore.close();
    this.isInitialized = false;
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }
  }
}

/**
 * Create a SemanticSearchService from environment variables
 */
export function createSemanticSearchServiceFromEnv(
  vectorStoreConfig?: VectorStoreConfig
): SemanticSearchService | null {
  const openaiKey = process.env.OPENAI_API_KEY;
  const openrouterKey = process.env.OPENROUTER_API_KEY;

  if (openaiKey) {
    return new SemanticSearchService(
      {
        provider: 'openai',
        apiKey: openaiKey,
        model: process.env.EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL,
      },
      vectorStoreConfig
    );
  }

  if (openrouterKey) {
    return new SemanticSearchService(
      {
        provider: 'openrouter',
        apiKey: openrouterKey,
        model: process.env.EMBEDDING_MODEL || 'openai/text-embedding-3-small',
      },
      vectorStoreConfig
    );
  }

  return null;
}

// Re-export vector store types
export { VectorStore, createVectorStore, type VectorDocument, type VectorSearchResult, type VectorStoreConfig };

export default EmbeddingService;
