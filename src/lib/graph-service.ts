import { logger } from './logger.js';

/**
 * Memgraph graph service using neo4j-driver (Bolt protocol)
 * Ported from codebase_rag/services/graph_service.py
 */

import neo4j, {
  Driver,
  Session,
  ManagedTransaction,
  QueryResult,
  Record as Neo4jRecord,
  Integer,
  isInt,
} from 'neo4j-driver';

import {
  PropertyValue,
  PropertyDict,
  ResultRow,
  ResultValue,
  NodeBatchRow,
  RelBatchRow,
  GraphData,
  GraphMetadata,
  BatchParams,
} from './types.js';

import {
  NodeLabel,
  NODE_UNIQUE_CONSTRAINTS,
  KEY_PROPS,
  KEY_FROM_VAL,
  KEY_TO_VAL,
  KEY_CREATED,
  KEY_NAME,
  KEY_PROJECT_NAME,
  REL_TYPE_CALLS,
  ERR_SUBSTR_ALREADY_EXISTS,
  ERR_SUBSTR_CONSTRAINT,
} from './constants.js';

import {
  CYPHER_DELETE_ALL,
  CYPHER_DELETE_PROJECT,
  CYPHER_LIST_PROJECTS,
  CYPHER_EXPORT_NODES,
  CYPHER_EXPORT_RELATIONSHIPS,
  buildConstraintQuery,
  buildIndexQuery,
  buildMergeNodeQuery,
  buildMergeRelationshipQuery,
  buildCreateNodeQuery,
  buildCreateRelationshipQuery,
  wrapWithUnwind,
} from './cypher-queries.js';

// Re-export for backwards compatibility
export const REL_TYPE_CALLS_CONST = 'CALLS';

// =============================================================================
// Configuration Types
// =============================================================================

export interface MemgraphConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
  database?: string;
  encrypted?: boolean;
  maxConnectionPoolSize?: number;
  connectionTimeout?: number;
}

export interface MemgraphServiceOptions {
  batchSize?: number;
  useMerge?: boolean;
  flushPoolSize?: number;
  logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'silent';
}

// =============================================================================
// Logger (simple console logger with levels)
// =============================================================================

type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

class Logger {
  private level: LogLevel;
  private levels: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
    silent: 4,
  };

  constructor(level: LogLevel = 'info') {
    this.level = level;
  }

  private shouldLog(msgLevel: LogLevel): boolean {
    return this.levels[msgLevel] >= this.levels[this.level];
  }

  debug(msg: string, ...args: unknown[]): void {
    if (this.shouldLog('debug')) logger.debug(`[graph] ${msg}`, ...args);
  }

  info(msg: string, ...args: unknown[]): void {
    if (this.shouldLog('info')) logger.info(`[graph] ${msg}`, ...args);
  }

  warn(msg: string, ...args: unknown[]): void {
    if (this.shouldLog('warn')) logger.warn(`[graph] ${msg}`, ...args);
  }

  error(msg: string, ...args: unknown[]): void {
    if (this.shouldLog('error')) logger.error(`[graph] ${msg}`, ...args);
  }
}

// =============================================================================
// Type Helpers
// =============================================================================

/**
 * Convert Neo4j Integer to number for JS compatibility
 */
function convertValue(val: unknown): ResultValue {
  if (isInt(val)) {
    return (val as Integer).toNumber();
  }
  if (Array.isArray(val)) {
    return val.map(v => convertValue(v)) as ResultValue;
  }
  if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
    const obj: Record<string, ResultValue> = {};
    for (const [k, v] of Object.entries(val)) {
      obj[k] = convertValue(v) as any;
    }
    return obj as Record<string, any>;
  }
  return val as ResultValue;
}

/**
 * Convert Neo4j record to plain object
 */
function recordToRow(record: Neo4jRecord): ResultRow {
  const row: ResultRow = {};
  for (const key of record.keys) {
    row[key as string] = convertValue(record.get(key));
  }
  return row;
}

/**
 * Convert QueryResult to array of ResultRow
 */
function resultToRows(result: QueryResult): ResultRow[] {
  return result.records.map(recordToRow);
}

// =============================================================================
// Relationship Pattern Key
// =============================================================================

type RelPattern = [string, string, string, string, string]; // [fromLabel, fromKey, relType, toLabel, toKey]

function patternToKey(pattern: RelPattern): string {
  return pattern.join(':');
}

// =============================================================================
// MemgraphService Class
// =============================================================================

/**
 * Service for interacting with Memgraph database via Bolt protocol.
 * Provides connection pooling, batch operations, and CRUD methods.
 */
export class MemgraphService {
  private config: MemgraphConfig;
  private options: MemgraphServiceOptions;
  private driver: Driver | null = null;
  private logger: Logger;

  // Batch buffers
  private nodeBuffer: Array<{ label: string; properties: PropertyDict }> = [];
  private relGroups: Map<string, RelBatchRow[]> = new Map();
  private relCount = 0;
  private flushPromise: Promise<void> | null = null;

  // Pattern metadata for relationship flushing
  private patternMeta: Map<string, RelPattern> = new Map();

  constructor(config: MemgraphConfig, options: MemgraphServiceOptions = {}) {
    this.config = {
      maxConnectionPoolSize: 50,
      connectionTimeout: 30000,
      encrypted: false,
      ...config,
    };
    this.options = {
      batchSize: 1000,
      useMerge: true,
      flushPoolSize: 4,
      logLevel: 'info',
      ...options,
    };
    this.logger = new Logger(this.options.logLevel);
  }

  // ===========================================================================
  // Connection Management
  // ===========================================================================

  /**
   * Connect to Memgraph database
   */
  async connect(): Promise<void> {
    const uri = `bolt://${this.config.host}:${this.config.port}`;
    this.logger.info(`Connecting to Memgraph at ${uri}`);

    const authToken = this.config.username && this.config.password
      ? neo4j.auth.basic(this.config.username, this.config.password)
      : undefined;

    this.driver = neo4j.driver(uri, authToken, {
      maxConnectionPoolSize: this.config.maxConnectionPoolSize,
      connectionTimeout: this.config.connectionTimeout,
      encrypted: this.config.encrypted ? 'ENCRYPTION_ON' : 'ENCRYPTION_OFF',
      trust: 'TRUST_ALL_CERTIFICATES',
    });

    // Verify connection
    try {
      await this.driver.verifyConnectivity();
      this.logger.info('Connected to Memgraph');
    } catch (err) {
      this.logger.error('Failed to connect to Memgraph', err);
      throw err;
    }
  }

  /**
   * Close the database connection
   */
  async close(): Promise<void> {
    if (this.driver) {
      // Flush any remaining data
      await this.flushAll();
      await this.driver.close();
      this.driver = null;
      this.logger.info('Disconnected from Memgraph');
    }
  }

  /**
   * Check if connected to database
   */
  isConnected(): boolean {
    return this.driver !== null;
  }

  /**
   * Get a session for database operations
   */
  private getSession(mode: 'READ' | 'WRITE' = 'WRITE'): Session {
    if (!this.driver) {
      throw new Error('Not connected to Memgraph');
    }
    return this.driver.session({
      database: this.config.database,
      defaultAccessMode: mode === 'READ' ? neo4j.session.READ : neo4j.session.WRITE,
    });
  }

  // ===========================================================================
  // Query Execution
  // ===========================================================================

  /**
   * Execute a read query and return results
   */
  async query<T extends ResultRow = ResultRow>(
    cypher: string,
    params: Record<string, PropertyValue> = {}
  ): Promise<T[]> {
    this.logger.debug('Query:', cypher, params);
    const session = this.getSession('READ');
    try {
      const result = await session.run(cypher, params);
      return resultToRows(result) as T[];
    } finally {
      await session.close();
    }
  }

  /**
   * Execute a write query (alias for executeWrite for compatibility)
   */
  async execute(
    cypher: string,
    params: Record<string, PropertyValue> = {}
  ): Promise<ResultRow[]> {
    return this.executeWrite(cypher, params);
  }

  /**
   * Execute a write query
   */
  async executeWrite(
    cypher: string,
    params: Record<string, PropertyValue> = {}
  ): Promise<ResultRow[]> {
    this.logger.debug('Execute:', cypher, params);
    const session = this.getSession('WRITE');
    try {
      const result = await session.run(cypher, params);
      return resultToRows(result);
    } catch (err) {
      const errStr = String(err).toLowerCase();
      // Ignore "already exists" errors for constraints/indexes
      if (!errStr.includes(ERR_SUBSTR_ALREADY_EXISTS) &&
          !errStr.includes(ERR_SUBSTR_CONSTRAINT)) {
        this.logger.error('Query error:', err);
        this.logger.error('Query:', cypher);
        this.logger.error('Params:', params);
      }
      throw err;
    } finally {
      await session.close();
    }
  }

  /**
   * Execute a query within a transaction
   */
  async executeInTransaction<T>(
    fn: (tx: ManagedTransaction) => Promise<T>
  ): Promise<T> {
    const session = this.getSession('WRITE');
    try {
      return await session.executeWrite(fn);
    } finally {
      await session.close();
    }
  }

  /**
   * Execute a batch query with UNWIND
   */
  private async executeBatch(
    query: string,
    paramsList: BatchParams[]
  ): Promise<void> {
    if (paramsList.length === 0) return;

    const maxRetries = 10;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const session = this.getSession('WRITE');
      try {
        await session.run(wrapWithUnwind(query), { batch: paramsList });
        return;
      } catch (err) {
        const errStr = String(err).toLowerCase();
        if (errStr.includes('conflicting transaction') && attempt < maxRetries - 1) {
          // Exponential backoff with jitter: 50ms, 100ms, 200ms, 400ms, ..., up to ~10s
          const baseMs = Math.min(50 * Math.pow(2, attempt), 5000);
          const jitter = Math.random() * baseMs * 0.5;
          const delayMs = baseMs + jitter;
          this.logger.warn(`Transaction conflict, retrying (${attempt + 1}/${maxRetries}) after ${Math.round(delayMs)}ms...`);
          await session.close();
          await new Promise(r => setTimeout(r, delayMs));
          continue;
        }
        if (!errStr.includes(ERR_SUBSTR_ALREADY_EXISTS)) {
          this.logger.error('Batch error:', err);
          this.logger.error('Query:', query);
          if (paramsList.length > 10) {
            this.logger.error(`Batch params (${paramsList.length} items, first 10):`, paramsList.slice(0, 10));
          } else {
            this.logger.error('Batch params:', paramsList);
          }
        }
        throw err;
      } finally {
        await session.close();
      }
    }
  }

  /**
   * Execute a batch query with UNWIND and return results
   */
  private async executeBatchWithReturn(
    query: string,
    paramsList: BatchParams[]
  ): Promise<ResultRow[]> {
    if (paramsList.length === 0) return [];

    const maxRetries = 10;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const session = this.getSession('WRITE');
      try {
        const result = await session.run(wrapWithUnwind(query), { batch: paramsList });
        return resultToRows(result);
      } catch (err) {
        const errStr = String(err).toLowerCase();
        if (errStr.includes('conflicting transaction') && attempt < maxRetries - 1) {
          const baseMs = Math.min(50 * Math.pow(2, attempt), 5000);
          const jitter = Math.random() * baseMs * 0.5;
          const delayMs = baseMs + jitter;
          this.logger.warn(`Transaction conflict, retrying (${attempt + 1}/${maxRetries}) after ${Math.round(delayMs)}ms...`);
          await session.close();
          await new Promise(r => setTimeout(r, delayMs));
          continue;
        }
        this.logger.error('Batch error:', err);
        this.logger.error('Query:', query);
        throw err;
      } finally {
        await session.close();
      }
    }
    // Should not reach here, but satisfy TypeScript
    return [];
  }

  // ===========================================================================
  // Database Management
  // ===========================================================================

  /**
   * Delete all data from the database
   */
  async cleanDatabase(): Promise<void> {
    this.logger.info('Cleaning database...');
    await this.executeWrite(CYPHER_DELETE_ALL);
    this.logger.info('Database cleaned');
  }

  /**
   * List all projects in the database
   */
  async listProjects(): Promise<string[]> {
    const results = await this.query(CYPHER_LIST_PROJECTS);
    return results.map(r => String(r[KEY_NAME]));
  }

  /**
   * Delete a specific project and all its data
   */
  async deleteProject(projectName: string): Promise<void> {
    this.logger.info(`Deleting project: ${projectName}`);
    await this.executeWrite(CYPHER_DELETE_PROJECT, { [KEY_PROJECT_NAME]: projectName });
    this.logger.info(`Project deleted: ${projectName}`);
  }

  /**
   * Ensure uniqueness constraints exist for all node labels
   */
  async ensureConstraints(): Promise<void> {
    this.logger.info('Ensuring constraints...');
    for (const [label, prop] of Object.entries(NODE_UNIQUE_CONSTRAINTS)) {
      try {
        await this.executeWrite(buildConstraintQuery(label, prop));
      } catch {
        // Constraint may already exist
      }
    }
    this.logger.info('Constraints ensured');
    await this.ensureIndexes();
  }

  /**
   * Ensure indexes exist for all node labels
   */
  private async ensureIndexes(): Promise<void> {
    this.logger.info('Ensuring indexes...');
    for (const [label, prop] of Object.entries(NODE_UNIQUE_CONSTRAINTS)) {
      try {
        await this.executeWrite(buildIndexQuery(label, prop));
      } catch {
        // Index may already exist
      }
    }
    this.logger.info('Indexes ensured');
  }

  // ===========================================================================
  // CRUD Operations
  // ===========================================================================

  /**
   * Create a node with the given label and properties
   */
  async createNode(
    label: string,
    properties: PropertyDict
  ): Promise<ResultRow[]> {
    const idKey = NODE_UNIQUE_CONSTRAINTS[label];
    if (!idKey) {
      throw new Error(`No unique constraint defined for label: ${label}`);
    }

    const id = properties[idKey];
    if (id === undefined || id === null) {
      throw new Error(`Missing required property '${idKey}' for label '${label}'`);
    }

    const props: PropertyDict = {};
    for (const [k, v] of Object.entries(properties)) {
      if (k !== idKey) props[k] = v;
    }

    const query = this.options.useMerge
      ? buildMergeNodeQuery(label, idKey)
      : buildCreateNodeQuery(label, idKey);

    return this.executeBatchWithReturn(query, [{ id, props }]);
  }

  /**
   * Create multiple nodes in a batch
   */
  async createNodes(
    label: string,
    propertiesList: PropertyDict[]
  ): Promise<void> {
    if (propertiesList.length === 0) return;

    const idKey = NODE_UNIQUE_CONSTRAINTS[label];
    if (!idKey) {
      this.logger.warn(`No unique constraint for label: ${label}`);
      return;
    }

    const batchRows: NodeBatchRow[] = [];
    let skipped = 0;

    for (const properties of propertiesList) {
      const id = properties[idKey];
      if (id === undefined || id === null) {
        this.logger.warn(`Missing '${idKey}' for ${label}, props: ${Object.keys(properties)}`);
        skipped++;
        continue;
      }

      const props: PropertyDict = {};
      for (const [k, v] of Object.entries(properties)) {
        if (k !== idKey) props[k] = v;
      }
      batchRows.push({ id, props });
    }

    if (batchRows.length === 0) return;

    const query = this.options.useMerge
      ? buildMergeNodeQuery(label, idKey)
      : buildCreateNodeQuery(label, idKey);

    await this.executeBatch(query, batchRows);

    if (skipped > 0) {
      this.logger.info(`Skipped ${skipped} nodes for ${label}`);
    }
  }

  /**
   * Create a relationship between two nodes
   */
  async createRelationship(
    fromSpec: [string, string, PropertyValue],
    relType: string,
    toSpec: [string, string, PropertyValue],
    properties: PropertyDict = {}
  ): Promise<ResultRow[]> {
    const [fromLabel, fromKey, fromVal] = fromSpec;
    const [toLabel, toKey, toVal] = toSpec;

    const hasProps = Object.keys(properties).length > 0;
    const query = this.options.useMerge
      ? buildMergeRelationshipQuery(fromLabel, fromKey, relType, toLabel, toKey, hasProps)
      : buildCreateRelationshipQuery(fromLabel, fromKey, relType, toLabel, toKey, hasProps);

    const row: RelBatchRow = {
      from_val: fromVal,
      to_val: toVal,
      props: properties,
    };

    return this.executeBatchWithReturn(query, [row]);
  }

  /**
   * Create multiple relationships in a batch
   */
  async createRelationships(
    fromLabel: string,
    fromKey: string,
    relType: string,
    toLabel: string,
    toKey: string,
    relationships: Array<{ fromVal: PropertyValue; toVal: PropertyValue; props?: PropertyDict }>
  ): Promise<void> {
    if (relationships.length === 0) return;

    const hasProps = relationships.some(r => r.props && Object.keys(r.props).length > 0);
    const query = this.options.useMerge
      ? buildMergeRelationshipQuery(fromLabel, fromKey, relType, toLabel, toKey, hasProps)
      : buildCreateRelationshipQuery(fromLabel, fromKey, relType, toLabel, toKey, hasProps);

    const rows: RelBatchRow[] = relationships.map(r => ({
      from_val: r.fromVal,
      to_val: r.toVal,
      props: r.props || {},
    }));

    await this.executeBatchWithReturn(query, rows);
  }

  /**
   * Delete a node by label and key value
   */
  async deleteNode(label: string, keyValue: PropertyValue): Promise<void> {
    const idKey = NODE_UNIQUE_CONSTRAINTS[label];
    if (!idKey) {
      throw new Error(`No unique constraint defined for label: ${label}`);
    }
    const query = `MATCH (n:${label} {${idKey}: $keyValue}) DETACH DELETE n`;
    await this.executeWrite(query, { keyValue } as Record<string, PropertyValue>);
  }

  /**
   * Delete nodes matching a query
   */
  async deleteNodes(cypher: string, params: Record<string, PropertyValue> = {}): Promise<void> {
    await this.executeWrite(cypher, params);
  }

  /**
   * Update a node's properties
   */
  async updateNode(
    label: string,
    keyValue: PropertyValue,
    properties: PropertyDict
  ): Promise<ResultRow[]> {
    const idKey = NODE_UNIQUE_CONSTRAINTS[label];
    if (!idKey) {
      throw new Error(`No unique constraint defined for label: ${label}`);
    }

    const setParts = Object.keys(properties)
      .filter(k => k !== idKey)
      .map(k => `n.${k} = $${k}`);

    if (setParts.length === 0) return [];

    const query = `MATCH (n:${label} {${idKey}: $keyValue}) SET ${setParts.join(', ')} RETURN n`;
    return this.executeWrite(query, { keyValue, ...properties } as Record<string, PropertyValue>);
  }

  /**
   * Find nodes by label and optional filters
   */
  async findNodes(
    label: string,
    filters: PropertyDict = {},
    limit?: number
  ): Promise<ResultRow[]> {
    let query = `MATCH (n:${label})`;

    if (Object.keys(filters).length > 0) {
      const whereParts = Object.entries(filters).map(([k, _]) => `n.${k} = $${k}`);
      query += ` WHERE ${whereParts.join(' AND ')}`;
    }

    query += ' RETURN n';
    if (limit !== undefined) query += ` LIMIT ${limit}`;

    return this.query(query, filters);
  }

  /**
   * Find a single node by label and key value
   */
  async findNode(label: string, keyValue: PropertyValue): Promise<ResultRow | null> {
    const idKey = NODE_UNIQUE_CONSTRAINTS[label];
    if (!idKey) {
      throw new Error(`No unique constraint defined for label: ${label}`);
    }
    const results = await this.query(
      `MATCH (n:${label} {${idKey}: $keyValue}) RETURN n LIMIT 1`,
      { keyValue } as Record<string, PropertyValue>
    );
    return results.length > 0 ? results[0] : null;
  }

  // ===========================================================================
  // Buffered Batch Operations
  // ===========================================================================

  /**
   * Add a node to the batch buffer (will be flushed when buffer is full)
   */
  ensureNodeBatch(label: string, properties: PropertyDict): void {
    this.nodeBuffer.push({ label, properties });
    if (this.nodeBuffer.length >= (this.options.batchSize || 1000)) {
      this.logger.debug(`Node buffer full, flushing ${this.options.batchSize} nodes`);
      void this.enqueueFlush();
    }
  }

  /**
   * Add a relationship to the batch buffer
   */
  ensureRelationshipBatch(
    fromSpec: [string, string, PropertyValue],
    relType: string,
    toSpec: [string, string, PropertyValue],
    properties: PropertyDict = {}
  ): void {
    const [fromLabel, fromKey, fromVal] = fromSpec;
    const [toLabel, toKey, toVal] = toSpec;

    const pattern: RelPattern = [fromLabel, fromKey, relType, toLabel, toKey];
    const patternKey = patternToKey(pattern);

    if (!this.relGroups.has(patternKey)) {
      this.relGroups.set(patternKey, []);
      this.patternMeta.set(patternKey, pattern);
    }

    this.relGroups.get(patternKey)!.push({
      from_val: fromVal,
      to_val: toVal,
      props: properties,
    });

    this.relCount++;

    if (this.relCount >= (this.options.batchSize || 1000)) {
      this.logger.debug(`Relationship buffer full, flushing ${this.options.batchSize} relationships`);
      void this.enqueueFlush();
    }
  }

  /**
   * Flush all buffered nodes to the database
   */
  async flushNodes(): Promise<void> {
    if (this.nodeBuffer.length === 0) return;

    const bufferSize = this.nodeBuffer.length;
    const nodesByLabel = new Map<string, PropertyDict[]>();

    for (const { label, properties } of this.nodeBuffer) {
      if (!nodesByLabel.has(label)) {
        nodesByLabel.set(label, []);
      }
      nodesByLabel.get(label)!.push(properties);
    }

    let flushedTotal = 0;
    let skippedTotal = 0;
    let firstError: Error | null = null;

    // Process each label group sequentially to avoid transaction conflicts
    for (const [label, propsList] of nodesByLabel.entries()) {
      try {
        const idKey = NODE_UNIQUE_CONSTRAINTS[label];
        if (!idKey) {
          this.logger.warn(`No unique constraint for label: ${label}`);
          skippedTotal += propsList.length;
          continue;
        }

        const batchRows: NodeBatchRow[] = [];
        let skipped = 0;

        for (const props of propsList) {
          const id = props[idKey];
          if (id === undefined || id === null) {
            this.logger.warn(`Missing '${idKey}' for ${label}`);
            skipped++;
            continue;
          }

          const rowProps: PropertyDict = {};
          for (const [k, v] of Object.entries(props)) {
            if (k !== idKey) rowProps[k] = v;
          }
          batchRows.push({ id, props: rowProps });
        }

        if (batchRows.length > 0) {
          const query = this.options.useMerge
            ? buildMergeNodeQuery(label, idKey)
            : buildCreateNodeQuery(label, idKey);
          await this.executeBatch(query, batchRows);
        }

        flushedTotal += batchRows.length;
        skippedTotal += skipped;
      } catch (err) {
        this.logger.error(`Error flushing nodes for label ${label}:`, err);
        if (firstError === null) firstError = err as Error;
        skippedTotal += propsList.length;
      }
    }

    this.logger.info(`Nodes flushed: ${flushedTotal}/${bufferSize}`);
    if (skippedTotal > 0) {
      this.logger.info(`Nodes skipped: ${skippedTotal}`);
    }

    this.nodeBuffer = [];

    if (firstError !== null) {
      throw firstError;
    }
  }

  /**
   * Flush all buffered relationships to the database
   */
  async flushRelationships(): Promise<void> {
    if (this.relCount === 0) return;

    let totalAttempted = 0;
    let totalSuccessful = 0;
    let firstError: Error | null = null;

    // Process each pattern group sequentially to avoid transaction conflicts
    for (const [patternKey, paramsList] of this.relGroups.entries()) {
      try {
        const pattern = this.patternMeta.get(patternKey);
        if (!pattern) {
          totalAttempted += paramsList.length;
          continue;
        }

        const [fromLabel, fromKey, relType, toLabel, toKey] = pattern;
        const hasProps = paramsList.some(p => Object.keys(p.props).length > 0);

        const query = this.options.useMerge
          ? buildMergeRelationshipQuery(fromLabel, fromKey, relType, toLabel, toKey, hasProps)
          : buildCreateRelationshipQuery(fromLabel, fromKey, relType, toLabel, toKey, hasProps);

        const results = await this.executeBatchWithReturn(query, paramsList);

        let batchSuccessful = 0;
        for (const r of results) {
          const created = r[KEY_CREATED];
          if (typeof created === 'number') {
            batchSuccessful += created;
          }
        }

        // Log warnings for CALLS relationships that failed
        if (relType === REL_TYPE_CALLS_CONST) {
          const failed = paramsList.length - batchSuccessful;
          if (failed > 0) {
            this.logger.warn(`CALLS relationships failed: ${failed}`);
            for (let i = 0; i < Math.min(3, paramsList.length); i++) {
              const sample = paramsList[i];
              this.logger.warn(
                `  Sample ${i + 1}: ${fromLabel}(${sample[KEY_FROM_VAL]}) -> ${toLabel}(${sample[KEY_TO_VAL]})`
              );
            }
          }
        }

        totalAttempted += paramsList.length;
        totalSuccessful += batchSuccessful;
      } catch (err) {
        this.logger.error(`Error flushing relationships for pattern ${patternKey}:`, err);
        if (firstError === null) firstError = err as Error;
        totalAttempted += paramsList.length;
      }
    }

    this.logger.info(
      `Relationships flushed: ${this.relCount} total, ${totalSuccessful} successful, ${totalAttempted - totalSuccessful} failed`
    );

    this.relCount = 0;
    this.relGroups.clear();
    this.patternMeta.clear();

    if (firstError !== null) {
      throw firstError;
    }
  }

  /**
   * Enqueue a flush operation, ensuring only one runs at a time
   * Prevents concurrent transaction conflicts from fire-and-forget flushes
   */
  private async enqueueFlush(): Promise<void> {
    if (this.flushPromise) {
      // Wait for the current flush to finish, then flush again
      await this.flushPromise;
    }
    this.flushPromise = this.flushAll().finally(() => {
      this.flushPromise = null;
    });
    await this.flushPromise;
  }

  /**
   * Flush all buffered data to the database
   */
  async flushAll(): Promise<void> {
    this.logger.info('Flushing all buffered data...');
    await this.flushNodes();
    await this.flushRelationships();
    this.logger.info('Flush complete');
  }

  /**
   * Flush pending operations (alias for flushAll to implement IngestorProtocol)
   */
  async flush(): Promise<void> {
    return this.flushAll();
  }

  // ===========================================================================
  // Fetch Operations
  // ===========================================================================

  /**
   * Fetch all results from a query (alias for query())
   */
  async fetchAll(
    cypher: string,
    params: Record<string, PropertyValue> = {}
  ): Promise<ResultRow[]> {
    this.logger.debug('Fetch:', cypher, params);
    return this.query(cypher, params);
  }

  // ===========================================================================
  // Export Operations
  // ===========================================================================

  /**
   * Export the entire graph to a JSON-serializable object
   */
  async exportGraphToDict(): Promise<GraphData> {
    this.logger.info('Exporting graph...');

    const nodesData = await this.fetchAll(CYPHER_EXPORT_NODES);
    const relationshipsData = await this.fetchAll(CYPHER_EXPORT_RELATIONSHIPS);

    const metadata: GraphMetadata = {
      total_nodes: nodesData.length,
      total_relationships: relationshipsData.length,
      exported_at: new Date().toISOString(),
    };

    this.logger.info(`Exported ${nodesData.length} nodes, ${relationshipsData.length} relationships`);

    return {
      nodes: nodesData,
      relationships: relationshipsData,
      metadata,
    };
  }

  // ===========================================================================
  // Statistics
  // ===========================================================================

  /**
   * Get node count by label
   */
  async getNodeCounts(): Promise<Record<string, number>> {
    const results = await this.query(`
      MATCH (n)
      RETURN labels(n) AS labels, count(*) AS count
      ORDER BY count DESC
    `);

    const counts: Record<string, number> = {};
    for (const row of results) {
      const labels = row.labels;
      if (Array.isArray(labels) && labels.length > 0) {
        const label = String(labels[0]);
        counts[label] = (row.count as number) || 0;
      }
    }
    return counts;
  }

  /**
   * Get relationship count by type
   */
  async getRelationshipCounts(): Promise<Record<string, number>> {
    const results = await this.query(`
      MATCH ()-[r]->()
      RETURN type(r) AS type, count(*) AS count
      ORDER BY count DESC
    `);

    const counts: Record<string, number> = {};
    for (const row of results) {
      const type = String(row.type);
      counts[type] = (row.count as number) || 0;
    }
    return counts;
  }

  /**
   * Get total node and relationship counts
   */
  async getStats(): Promise<{ nodes: number; relationships: number }> {
    const nodeResult = await this.query('MATCH (n) RETURN count(n) AS count');
    const relResult = await this.query('MATCH ()-[r]->() RETURN count(r) AS count');

    return {
      nodes: (nodeResult[0]?.count as number) || 0,
      relationships: (relResult[0]?.count as number) || 0,
    };
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a MemgraphService instance from config
 */
export function createMemgraphService(
  config: MemgraphConfig,
  options?: MemgraphServiceOptions
): MemgraphService {
  return new MemgraphService(config, options);
}

/**
 * Create a MemgraphService instance from environment or defaults
 */
export function createMemgraphServiceFromEnv(
  options?: MemgraphServiceOptions
): MemgraphService {
  const host = process.env.MEMGRAPH_HOST || process.env.MG_HOST || 'localhost';
  const port = parseInt(process.env.MEMGRAPH_PORT || process.env.MG_PORT || '7687', 10);
  const username = process.env.MEMGRAPH_USER || process.env.MG_USER;
  const password = process.env.MEMGRAPH_PASSWORD || process.env.MG_PASSWORD;

  return new MemgraphService({ host, port, username, password }, options);
}

// =============================================================================
// Re-exports for convenience
// =============================================================================

export { neo4j };
export type { Driver, Session, ManagedTransaction, QueryResult };
