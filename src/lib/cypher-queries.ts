/**
 * Cypher query templates for code-graph-rag library
 * Ported from codebase_rag/cypher_queries.py
 */

import { CYPHER_DEFAULT_LIMIT } from './constants.js';

// =============================================================================
// Basic CRUD Queries
// =============================================================================

export const CYPHER_DELETE_ALL = 'MATCH (n) DETACH DELETE n;';

export const CYPHER_LIST_PROJECTS = 'MATCH (p:Project) RETURN p.name AS name ORDER BY p.name';

export const CYPHER_DELETE_PROJECT = `
MATCH (p:Project {name: $project_name})
OPTIONAL MATCH (p)-[:CONTAINS_PACKAGE|CONTAINS_FOLDER|CONTAINS_FILE|CONTAINS_MODULE*]->(container)
OPTIONAL MATCH (container)-[:DEFINES|DEFINES_METHOD*]->(defined)
DETACH DELETE p, container, defined
`;

// =============================================================================
// Delete Queries (Used by graph updater)
// =============================================================================

// Module nodes still carry `path` (relative path) for back-compat with file deletion.
export const CYPHER_DELETE_MODULE = 'MATCH (m:Module {path: $path})-[*0..]->(c) DETACH DELETE m, c';
export const CYPHER_DELETE_FILE = 'MATCH (f:File {path: $path}) DETACH DELETE f';
export const CYPHER_DELETE_FOLDER = 'MATCH (f:Folder {path: $path}) DETACH DELETE f';
export const CYPHER_DELETE_CALLS = 'MATCH ()-[r:CALLS]->() DELETE r';

// Delete all communities for a given project (and their MEMBER_OF edges).
export const CYPHER_DELETE_COMMUNITIES =
  'MATCH (c:Community {project: $project}) DETACH DELETE c';

export const CYPHER_LIST_COMMUNITIES = `
MATCH (c:Community {project: $project})
WHERE $namePattern IS NULL OR c.name CONTAINS $namePattern OR c.heuristic_label CONTAINS $namePattern
RETURN c.id AS id, c.name AS name, c.heuristic_label AS heuristic_label,
       c.symbol_count AS symbol_count, c.cohesion AS cohesion
ORDER BY c.symbol_count DESC
LIMIT $limit
`;

// Delete all processes for a given project (and their HAS_STEP edges).
export const CYPHER_DELETE_PROCESSES =
  'MATCH (p:Process {project: $project}) DETACH DELETE p';

export const CYPHER_LIST_PROCESSES = `
MATCH (p:Process {project: $project})
WHERE $namePattern IS NULL OR p.entry_point_qn CONTAINS $namePattern OR p.name CONTAINS $namePattern
RETURN p.id AS id, p.name AS name, p.entry_point_qn AS entry_point_qn,
       p.terminal_qn AS terminal_qn, p.step_count AS step_count, p.trace AS trace
ORDER BY p.step_count DESC
LIMIT $limit
`;

// =============================================================================
// Path Queries (For orphan pruning)
// =============================================================================

export const CYPHER_ALL_FILE_PATHS =
  'MATCH (f:File) RETURN f.path AS path, f.absolute_path AS absolute_path';

export const CYPHER_ALL_MODULE_PATHS_INTERNAL =
  'MATCH (m:Module) WHERE m.is_external IS NULL OR m.is_external = false ' +
  'RETURN m.path AS path, m.qualified_name AS qualified_name';

export const CYPHER_ALL_FOLDER_PATHS =
  'MATCH (f:Folder) RETURN f.path AS path, f.absolute_path AS absolute_path';

// =============================================================================
// Example Queries (Used for LLM context)
// =============================================================================

export const CYPHER_EXAMPLE_DECORATED_FUNCTIONS = `MATCH (n:Function|Method)
WHERE ANY(d IN n.decorators WHERE toLower(d) IN ['flow', 'task'])
RETURN n.name AS name, n.qualified_name AS qualified_name, labels(n) AS type
LIMIT ${CYPHER_DEFAULT_LIMIT}`;

export const CYPHER_EXAMPLE_CONTENT_BY_PATH = `MATCH (n)
WHERE n.path IS NOT NULL AND n.path STARTS WITH 'workflows'
RETURN n.name AS name, n.path AS path, labels(n) AS type
LIMIT ${CYPHER_DEFAULT_LIMIT}`;

export const CYPHER_EXAMPLE_KEYWORD_SEARCH = `MATCH (n)
WHERE toLower(n.name) CONTAINS 'database' OR (n.qualified_name IS NOT NULL AND toLower(n.qualified_name) CONTAINS 'database')
RETURN n.name AS name, n.qualified_name AS qualified_name, labels(n) AS type
LIMIT ${CYPHER_DEFAULT_LIMIT}`;

export const CYPHER_EXAMPLE_FIND_FILE = `MATCH (f:File) WHERE toLower(f.name) = 'readme.md' AND f.path = 'README.md'
RETURN f.path as path, f.name as name, labels(f) as type`;

export const CYPHER_EXAMPLE_README = `MATCH (f:File)
WHERE toLower(f.name) CONTAINS 'readme'
RETURN f.path AS path, f.name AS name, labels(f) AS type
LIMIT ${CYPHER_DEFAULT_LIMIT}`;

export const CYPHER_EXAMPLE_PYTHON_FILES = `MATCH (f:File)
WHERE f.extension = '.py'
RETURN f.path AS path, f.name AS name, labels(f) AS type
LIMIT ${CYPHER_DEFAULT_LIMIT}`;

export const CYPHER_EXAMPLE_TASKS = `MATCH (n:Function|Method)
WHERE 'task' IN n.decorators
RETURN n.qualified_name AS qualified_name, n.name AS name, labels(n) AS type
LIMIT ${CYPHER_DEFAULT_LIMIT}`;

export const CYPHER_EXAMPLE_FILES_IN_FOLDER = `MATCH (f:File)
WHERE f.path STARTS WITH 'services'
RETURN f.path AS path, f.name AS name, labels(f) AS type
LIMIT ${CYPHER_DEFAULT_LIMIT}`;

export const CYPHER_EXAMPLE_LIMIT_ONE =
  'MATCH (f:File) RETURN f.path as path, f.name as name, labels(f) as type LIMIT 1';

export const CYPHER_EXAMPLE_CLASS_METHODS = `MATCH (c:Class)-[:DEFINES_METHOD]->(m:Method)
WHERE c.name = 'UserService'
RETURN c.name AS className, m.name AS methodName, m.qualified_name AS qualified_name, labels(m) AS type
LIMIT ${CYPHER_DEFAULT_LIMIT}`;

// -----------------------------------------------------------------------------
// New-format examples using project / file_path / local_name (PREFERRED)
// -----------------------------------------------------------------------------

export const CYPHER_EXAMPLE_NODES_IN_FILE = `MATCH (n)
WHERE n.project = $project AND n.file_path = 'src/lib/vector-store.ts'
RETURN n.local_name AS local_name, n.file_path AS file_path, labels(n) AS type
LIMIT ${CYPHER_DEFAULT_LIMIT}`;

export const CYPHER_EXAMPLE_NODES_UNDER_DIR = `MATCH (n:Function|Method|Class)
WHERE n.project = $project AND n.file_path STARTS WITH 'src/lib/'
RETURN n.local_name AS local_name, n.file_path AS file_path, labels(n) AS type
LIMIT ${CYPHER_DEFAULT_LIMIT}`;

export const CYPHER_EXAMPLE_CLASS_BY_LOCAL_NAME = `MATCH (c:Class)
WHERE c.project = $project AND c.local_name ENDS WITH 'VectorStore'
RETURN c.local_name AS local_name, c.file_path AS file_path, labels(c) AS type
LIMIT ${CYPHER_DEFAULT_LIMIT}`;

export const CYPHER_EXAMPLE_METHODS_OF_CLASS_NEW = `MATCH (c:Class)-[:DEFINES_METHOD]->(m:Method)
WHERE c.project = $project AND c.file_path = 'src/lib/vector-store.ts' AND c.local_name = 'VectorStore'
RETURN c.local_name AS className, m.local_name AS methodName, m.file_path AS file_path, labels(m) AS type
LIMIT ${CYPHER_DEFAULT_LIMIT}`;

// =============================================================================
// Export Queries
// =============================================================================

export const CYPHER_EXPORT_NODES = `
MATCH (n)
RETURN id(n) as node_id, labels(n) as labels, properties(n) as properties
`;

export const CYPHER_EXPORT_RELATIONSHIPS = `
MATCH (a)-[r]->(b)
RETURN id(a) as from_id, id(b) as to_id, type(r) as type, properties(r) as properties
`;

// =============================================================================
// Source Location Queries
// =============================================================================

export const CYPHER_GET_FUNCTION_SOURCE_LOCATION = `
MATCH (m:Module)-[:DEFINES]->(n)
WHERE id(n) = $node_id
RETURN n.qualified_name AS qualified_name, n.start_line AS start_line,
       n.end_line AS end_line, m.path AS path
`;

export const CYPHER_FIND_BY_QUALIFIED_NAME = `
MATCH (n) WHERE n.qualified_name = $qn
OPTIONAL MATCH (m:Module)-[*]-(n)
RETURN n.name AS name, n.start_line AS start, n.end_line AS end, m.path AS path, n.docstring AS docstring
LIMIT 1
`;

// =============================================================================
// Statistics Queries
// =============================================================================

export const CYPHER_STATS_NODE_COUNTS = `
MATCH (n)
RETURN labels(n) AS labels, count(*) AS count
ORDER BY count DESC
`;

export const CYPHER_STATS_RELATIONSHIP_COUNTS = `
MATCH ()-[r]->()
RETURN type(r) AS type, count(*) AS count
ORDER BY count DESC
`;

// =============================================================================
// Return Clauses
// =============================================================================

export const CYPHER_RETURN_COUNT = 'RETURN count(r) as created';
export const CYPHER_SET_PROPS_RETURN_COUNT = 'SET r += row.props\nRETURN count(r) as created';

// =============================================================================
// Query Builder Functions
// =============================================================================

/**
 * Wraps a query with UNWIND for batch processing
 */
export function wrapWithUnwind(query: string): string {
  return `UNWIND $batch AS row\n${query}`;
}

/**
 * Builds a query to fetch nodes by their IDs
 */
export function buildNodesByIdsQuery(nodeIds: number[]): string {
  const placeholders = nodeIds.map((_, i) => `$${i}`).join(', ');
  return `
MATCH (n)
WHERE id(n) IN [${placeholders}]
RETURN id(n) AS node_id, n.qualified_name AS qualified_name,
       labels(n) AS type, n.name AS name
ORDER BY n.qualified_name
`;
}

/**
 * Builds a CREATE CONSTRAINT query for unique property
 */
export function buildConstraintQuery(label: string, prop: string): string {
  return `CREATE CONSTRAINT ON (n:${label}) ASSERT n.${prop} IS UNIQUE;`;
}

/**
 * Builds a CREATE INDEX query
 */
export function buildIndexQuery(label: string, prop: string): string {
  return `CREATE INDEX ON :${label}(${prop});`;
}

/**
 * Builds a MERGE query for creating/updating nodes
 */
export function buildMergeNodeQuery(label: string, idKey: string): string {
  return `MERGE (n:${label} {${idKey}: row.id})\nSET n += row.props`;
}

/**
 * Builds a MERGE query for creating/updating relationships
 */
export function buildMergeRelationshipQuery(
  fromLabel: string,
  fromKey: string,
  relType: string,
  toLabel: string,
  toKey: string,
  hasProps: boolean = false
): string {
  let query =
    `MATCH (a:${fromLabel} {${fromKey}: row.from_val}), ` +
    `(b:${toLabel} {${toKey}: row.to_val})\n` +
    `MERGE (a)-[r:${relType}]->(b)\n`;
  query += hasProps ? CYPHER_SET_PROPS_RETURN_COUNT : CYPHER_RETURN_COUNT;
  return query;
}

/**
 * Builds a CREATE query for nodes (no MERGE, direct create)
 */
export function buildCreateNodeQuery(label: string, idKey: string): string {
  return `CREATE (n:${label} {${idKey}: row.id})\nSET n += row.props`;
}

/**
 * Builds a CREATE query for relationships (no MERGE, direct create)
 */
export function buildCreateRelationshipQuery(
  fromLabel: string,
  fromKey: string,
  relType: string,
  toLabel: string,
  toKey: string,
  hasProps: boolean = false
): string {
  let query =
    `MATCH (a:${fromLabel} {${fromKey}: row.from_val}), ` +
    `(b:${toLabel} {${toKey}: row.to_val})\n` +
    `CREATE (a)-[r:${relType}]->(b)\n`;
  query += hasProps ? CYPHER_SET_PROPS_RETURN_COUNT : CYPHER_RETURN_COUNT;
  return query;
}

// =============================================================================
// Query Collections (for LLM examples)
// =============================================================================

/**
 * Collection of example queries for LLM context
 */
export const EXAMPLE_QUERIES = {
  decoratedFunctions: CYPHER_EXAMPLE_DECORATED_FUNCTIONS,
  contentByPath: CYPHER_EXAMPLE_CONTENT_BY_PATH,
  keywordSearch: CYPHER_EXAMPLE_KEYWORD_SEARCH,
  findFile: CYPHER_EXAMPLE_FIND_FILE,
  readme: CYPHER_EXAMPLE_README,
  pythonFiles: CYPHER_EXAMPLE_PYTHON_FILES,
  tasks: CYPHER_EXAMPLE_TASKS,
  filesInFolder: CYPHER_EXAMPLE_FILES_IN_FOLDER,
  limitOne: CYPHER_EXAMPLE_LIMIT_ONE,
  classMethods: CYPHER_EXAMPLE_CLASS_METHODS,
  nodesInFile: CYPHER_EXAMPLE_NODES_IN_FILE,
  nodesUnderDir: CYPHER_EXAMPLE_NODES_UNDER_DIR,
  classByLocalName: CYPHER_EXAMPLE_CLASS_BY_LOCAL_NAME,
  methodsOfClassNew: CYPHER_EXAMPLE_METHODS_OF_CLASS_NEW,
} as const;

/**
 * Generate a parameterized delete query for a path
 */
export function buildDeleteByPathQuery(
  label: 'Module' | 'File' | 'Folder'
): string {
  switch (label) {
    case 'Module':
      return CYPHER_DELETE_MODULE;
    case 'File':
      return CYPHER_DELETE_FILE;
    case 'Folder':
      return CYPHER_DELETE_FOLDER;
  }
}
