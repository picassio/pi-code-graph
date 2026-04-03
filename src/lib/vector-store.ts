/**
 * Vector store using zvec (Alibaba's embedded vector database)
 * Replaces in-memory similarity search with persistent, indexed storage
 */

import * as path from 'path';
import * as fs from 'fs';
import { homedir } from 'os';
import {
  ZVecCreateAndOpen,
  ZVecOpen,
  ZVecCollectionSchema,
  ZVecDataType,
  ZVecIndexType,
  ZVecMetricType,
  ZVecCollection,
  ZVecDoc,
  ZVecDocInput,
  isZVecError,
} from '@zvec/zvec';

// =============================================================================
// Constants
// =============================================================================

export const DEFAULT_VECTOR_DIMENSION = 1536; // OpenAI text-embedding-3-small
export const DEFAULT_HNSW_M = 16;
export const DEFAULT_HNSW_EF_CONSTRUCTION = 200;
export const DEFAULT_HNSW_EF_SEARCH = 100;

// =============================================================================
// Types
// =============================================================================

export interface VectorStoreConfig {
  /** Path to store vector data (default: ~/.cgs/vectors) */
  storagePath?: string;
  /** Vector dimension (default: 1536 for OpenAI) */
  dimension?: number;
  /** Project name for filtering */
  projectName?: string;
  /** HNSW M parameter */
  hnswM?: number;
  /** HNSW efConstruction parameter */
  hnswEfConstruction?: number;
}

export interface VectorDocument {
  /** Unique ID (typically qualified_name) */
  id: string;
  /** Vector embedding */
  embedding: number[];
  /** Qualified name of the code element */
  qualifiedName: string;
  /** File path */
  filePath: string;
  /** Project name */
  project: string;
  /** Node type (function, class, method) */
  nodeType?: string;
  /** Source code snippet */
  sourceCode?: string;
}

export interface VectorSearchResult {
  /** Document ID */
  id: string;
  /** Similarity score (0-1 for cosine) */
  score: number;
  /** Qualified name */
  qualifiedName: string;
  /** File path */
  filePath: string;
  /** Project name */
  project: string;
  /** Node type */
  nodeType?: string;
  /** Source code snippet */
  sourceCode?: string;
}

// =============================================================================
// Vector Store
// =============================================================================

/**
 * Vector store backed by zvec for efficient similarity search
 */
export class VectorStore {
  private collection: ZVecCollection | null = null;
  private config: Required<VectorStoreConfig>;
  private isInitialized = false;

  constructor(config: VectorStoreConfig = {}) {
    this.config = {
      storagePath: config.storagePath || path.join(homedir(), '.cgr', 'vectors'),
      dimension: config.dimension || DEFAULT_VECTOR_DIMENSION,
      projectName: config.projectName || 'default',
      hnswM: config.hnswM || DEFAULT_HNSW_M,
      hnswEfConstruction: config.hnswEfConstruction || DEFAULT_HNSW_EF_CONSTRUCTION,
    };
  }

  /**
   * Initialize the vector store (create or open collection)
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    // Ensure storage directory exists
    const storageDir = path.dirname(this.config.storagePath);
    if (!fs.existsSync(storageDir)) {
      fs.mkdirSync(storageDir, { recursive: true });
    }

    try {
      // Try to open existing collection
      if (fs.existsSync(this.config.storagePath)) {
        this.collection = ZVecOpen(this.config.storagePath);
      } else {
        // Create new collection with schema
        const schema = new ZVecCollectionSchema({
          name: 'code_embeddings',
          vectors: {
            name: 'embedding',
            dataType: ZVecDataType.VECTOR_FP32,
            dimension: this.config.dimension,
            indexParams: {
              indexType: ZVecIndexType.HNSW,
              metricType: ZVecMetricType.COSINE,
              m: this.config.hnswM,
              efConstruction: this.config.hnswEfConstruction,
            },
          },
          fields: [
            { name: 'qualified_name', dataType: ZVecDataType.STRING },
            { name: 'file_path', dataType: ZVecDataType.STRING },
            { name: 'project', dataType: ZVecDataType.STRING },
            { name: 'node_type', dataType: ZVecDataType.STRING, nullable: true },
            { name: 'source_code', dataType: ZVecDataType.STRING, nullable: true },
          ],
        });

        this.collection = ZVecCreateAndOpen(this.config.storagePath, schema);
      }

      this.isInitialized = true;
    } catch (err) {
      if (isZVecError(err)) {
        throw new Error(`Failed to initialize vector store: ${err.code} - ${err.message}`);
      }
      throw err;
    }
  }

  /**
   * Insert or update a single document
   */
  async upsert(doc: VectorDocument): Promise<void> {
    await this.ensureInitialized();

    const zvecDoc: ZVecDocInput = {
      id: doc.id,
      vectors: {
        embedding: new Float32Array(doc.embedding),
      },
      fields: {
        qualified_name: doc.qualifiedName,
        file_path: doc.filePath,
        project: doc.project,
        node_type: doc.nodeType || '',
        source_code: doc.sourceCode || '',
      },
    };

    const status = this.collection!.upsertSync(zvecDoc);
    if (!status.ok) {
      throw new Error(`Failed to upsert document ${doc.id}: ${status.message}`);
    }
  }

  /**
   * Insert or update multiple documents
   */
  async upsertBatch(docs: VectorDocument[]): Promise<void> {
    await this.ensureInitialized();

    const zvecDocs: ZVecDocInput[] = docs.map(doc => ({
      id: doc.id,
      vectors: {
        embedding: new Float32Array(doc.embedding),
      },
      fields: {
        qualified_name: doc.qualifiedName,
        file_path: doc.filePath,
        project: doc.project,
        node_type: doc.nodeType || '',
        source_code: doc.sourceCode || '',
      },
    }));

    const statuses = this.collection!.upsertSync(zvecDocs);
    const failures = statuses.filter(s => !s.ok);
    if (failures.length > 0) {
      throw new Error(`Failed to upsert ${failures.length} documents: ${failures[0].message}`);
    }
  }

  /**
   * Search for similar vectors
   */
  async search(
    queryEmbedding: number[],
    options: {
      topK?: number;
      project?: string;
      nodeType?: string;
      efSearch?: number;
    } = {}
  ): Promise<VectorSearchResult[]> {
    await this.ensureInitialized();

    const { topK = 10, project, nodeType, efSearch = DEFAULT_HNSW_EF_SEARCH } = options;

    // Build filter expression
    const filters: string[] = [];
    if (project) {
      filters.push(`project = '${project}'`);
    }
    if (nodeType) {
      filters.push(`node_type = '${nodeType}'`);
    }

    const results = this.collection!.querySync({
      fieldName: 'embedding',
      vector: new Float32Array(queryEmbedding),
      topk: topK,
      filter: filters.length > 0 ? filters.join(' AND ') : undefined,
      params: {
        indexType: ZVecIndexType.HNSW,
        ef: efSearch,
      },
    });

    return results.map((doc: ZVecDoc) => ({
      id: doc.id,
      score: doc.score,
      qualifiedName: doc.fields.qualified_name as string,
      filePath: doc.fields.file_path as string,
      project: doc.fields.project as string,
      nodeType: doc.fields.node_type as string || undefined,
      sourceCode: doc.fields.source_code as string || undefined,
    }));
  }

  /**
   * Delete documents by IDs
   */
  async delete(ids: string | string[]): Promise<void> {
    await this.ensureInitialized();

    if (Array.isArray(ids)) {
      const statuses = this.collection!.deleteSync(ids);
      const failures = statuses.filter(s => !s.ok && s.code !== 'ZVEC_NOT_FOUND');
      if (failures.length > 0) {
        throw new Error(`Failed to delete ${failures.length} documents: ${failures[0].message}`);
      }
    } else {
      const status = this.collection!.deleteSync(ids);
      if (!status.ok && status.code !== 'ZVEC_NOT_FOUND') {
        throw new Error(`Failed to delete document: ${status.message}`);
      }
    }
  }

  /**
   * Delete all documents for a project
   */
  async deleteByProject(project: string): Promise<void> {
    await this.ensureInitialized();

    const status = this.collection!.deleteByFilterSync(`project = '${project}'`);
    if (!status.ok) {
      throw new Error(`Failed to delete documents for project ${project}: ${status.message}`);
    }
  }

  /**
   * Fetch documents by IDs
   */
  async fetch(ids: string | string[]): Promise<Map<string, VectorDocument>> {
    await this.ensureInitialized();

    const results = this.collection!.fetchSync(ids);
    const docs = new Map<string, VectorDocument>();

    for (const [id, doc] of Object.entries(results)) {
      docs.set(id, {
        id: doc.id,
        embedding: Array.from(doc.vectors.embedding as Float32Array),
        qualifiedName: doc.fields.qualified_name as string,
        filePath: doc.fields.file_path as string,
        project: doc.fields.project as string,
        nodeType: doc.fields.node_type as string || undefined,
        sourceCode: doc.fields.source_code as string || undefined,
      });
    }

    return docs;
  }

  /**
   * Get collection statistics
   */
  async stats(): Promise<{ docCount: number; indexCompleteness: Record<string, number> }> {
    await this.ensureInitialized();
    return this.collection!.stats;
  }

  /**
   * Optimize the collection (rebuild indexes)
   */
  async optimize(): Promise<void> {
    await this.ensureInitialized();
    this.collection!.optimizeSync();
  }

  /**
   * Close the collection
   */
  async close(): Promise<void> {
    if (this.collection) {
      this.collection.closeSync();
      this.collection = null;
      this.isInitialized = false;
    }
  }

  /**
   * Destroy the collection (delete all data)
   */
  async destroy(): Promise<void> {
    if (this.collection) {
      this.collection.destroySync();
      this.collection = null;
      this.isInitialized = false;
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }
  }
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a vector store instance
 */
export function createVectorStore(config?: VectorStoreConfig): VectorStore {
  return new VectorStore(config);
}
