/**
 * Type definitions for code-graph-rag library
 * Ported from codebase_rag/types_defs.py
 */

import type { NodeLabel, RelationshipType, SupportedLanguage } from './constants.js';
import type { Node as TreeSitterNode, Language, Parser, Query } from 'web-tree-sitter';

// =============================================================================
// Basic Type Aliases
// =============================================================================

export type PropertyValue = string | number | boolean | string[] | null;
export type PropertyDict = Record<string, PropertyValue>;

export type ResultScalar = string | number | boolean | null;
export type ResultValue = ResultScalar | ResultScalar[] | Record<string, ResultScalar>;
export type ResultRow = Record<string, ResultValue>;

export type SimpleName = string;
export type QualifiedName = string;
export type SimpleNameLookup = Map<SimpleName, Set<QualifiedName>>;

export type NodeIdentifier = [NodeLabel | string, string, string | null];

export type ASTNode = TreeSitterNode;

// =============================================================================
// Enums
// =============================================================================

/**
 * Types of code constructs that can be tracked in the graph
 */
export enum NodeType {
  FUNCTION = 'Function',
  METHOD = 'Method',
  CLASS = 'Class',
  MODULE = 'Module',
  INTERFACE = 'Interface',
  PACKAGE = 'Package',
  ENUM = 'Enum',
  TYPE = 'Type',
  UNION = 'Union',
}

// =============================================================================
// Trie Types
// =============================================================================

export type TrieNode = {
  [key: string]: TrieNode | QualifiedName | NodeType;
};

export type FunctionRegistry = Map<QualifiedName, NodeType>;

/**
 * Protocol for FunctionRegistry with trie-based prefix/suffix search
 */
export interface FunctionRegistryTrie {
  has(qualifiedName: QualifiedName): boolean;
  get(qualifiedName: QualifiedName): NodeType | undefined;
  set(qualifiedName: QualifiedName, funcType: NodeType): void;
  keys(): IterableIterator<QualifiedName>;
  entries(): IterableIterator<[QualifiedName, NodeType]>;
  findWithPrefix(prefix: string): Array<[QualifiedName, NodeType]>;
  findEndingWith(suffix: string): QualifiedName[];
}

// =============================================================================
// AST Cache Protocol
// =============================================================================

export interface ASTCache {
  set(key: string, value: [TreeSitterNode, SupportedLanguage]): void;
  get(key: string): [TreeSitterNode, SupportedLanguage] | undefined;
  delete(key: string): boolean;
  has(key: string): boolean;
  entries(): IterableIterator<[string, [TreeSitterNode, SupportedLanguage]]>;
}

// =============================================================================
// TypedDict Equivalents (Interfaces)
// =============================================================================

export interface FunctionMatch {
  node: TreeSitterNode;
  simpleName: string;
  qualifiedName: string;
  parentClass: string | null;
  lineNumber: number;
}

export interface NodeBatchRow {
  id: PropertyValue;
  props: PropertyDict;
}

export interface RelBatchRow {
  from_val: PropertyValue;
  to_val: PropertyValue;
  props: PropertyDict;
}

export type BatchParams = NodeBatchRow | RelBatchRow | PropertyDict;

export interface BatchWrapper {
  batch: BatchParams[];
}

// =============================================================================
// Graph Data Types
// =============================================================================

export interface GraphMetadata {
  total_nodes: number;
  total_relationships: number;
  exported_at: string;
}

export interface NodeData {
  node_id: number;
  labels: string[];
  properties: PropertyDict;
}

export interface RelationshipData {
  from_id: number;
  to_id: number;
  type: string;
  properties: PropertyDict;
}

export interface GraphData {
  nodes: NodeData[] | ResultRow[];
  relationships: RelationshipData[] | ResultRow[];
  metadata: GraphMetadata;
}

export interface GraphSummary {
  total_nodes: number;
  total_relationships: number;
  node_labels: Record<string, number>;
  relationship_types: Record<string, number>;
  metadata: GraphMetadata;
}

// =============================================================================
// Embedding & Search Types
// =============================================================================

export interface EmbeddingQueryResult {
  node_id: number;
  qualified_name: string;
  start_line: number | null;
  end_line: number | null;
  path: string | null;
}

export interface SemanticSearchResult {
  node_id: number;
  qualified_name: string;
  name: string;
  type: string;
  score: number;
}

// =============================================================================
// Java Parser Types
// =============================================================================

export interface JavaClassInfo {
  name: string | null;
  type: string;
  superclass: string | null;
  interfaces: string[];
  modifiers: string[];
  typeParameters: string[];
}

export interface JavaMethodInfo {
  name: string | null;
  type: string;
  returnType: string | null;
  parameters: string[];
  modifiers: string[];
  typeParameters: string[];
  annotations: string[];
}

export interface JavaFieldInfo {
  name: string | null;
  type: string | null;
  modifiers: string[];
  annotations: string[];
}

export interface JavaAnnotationInfo {
  name: string | null;
  arguments: string[];
}

export interface JavaMethodCallInfo {
  name: string | null;
  object: string | null;
  arguments: number;
}

// =============================================================================
// Result Types for Named Tuples
// =============================================================================

export interface CancelledResult {
  cancelled: boolean;
}

export interface CgrignorePatterns {
  exclude: Set<string>;
  unignore: Set<string>;
}

// =============================================================================
// Model & Provider Types
// =============================================================================

export interface ModelConfigKwargs {
  api_key?: string | null;
  endpoint?: string | null;
  project_id?: string | null;
  region?: string | null;
  provider_type?: string | null;
  thinking_budget?: number | null;
  service_account_file?: string | null;
}

// =============================================================================
// Language & Parser Types
// =============================================================================

export interface LanguageImport {
  langKey: SupportedLanguage;
  modulePath: string;
  attrName: string;
  submoduleName: SupportedLanguage;
}

export interface LanguageQueries {
  functions: Query | null;
  classes: Query | null;
  calls: Query | null;
  imports: Query | null;
  locals: Query | null;
  config: LanguageSpec;
  language: Language;
  parser: Parser;
}

export interface LanguageSpec {
  language: SupportedLanguage;
  extensions: readonly string[];
  functionNodeTypes: readonly string[];
  classNodeTypes: readonly string[];
  callNodeTypes: readonly string[];
  importNodeTypes: readonly string[];
  moduleNodeTypes: readonly string[];
  indexFiles: readonly string[];
  packageIndicators: readonly string[];
  functionsQuery?: string;
  classesQuery?: string;
  callsQuery?: string;
  importsQuery?: string;
  localsQuery?: string;
}

export interface LanguageMetadata {
  status: LanguageStatus;
  additionalFeatures: string;
  displayName: string;
}

export enum LanguageStatus {
  FULL = 'Fully Supported',
  DEV = 'In Development',
}

// =============================================================================
// Tool Types
// =============================================================================

export interface ToolNames {
  queryGraph: string;
  readFile: string;
  analyzeDocument: string;
  semanticSearch: string;
  createFile: string;
  editFile: string;
  shellCommand: string;
}

export interface ConfirmationToolNames {
  replaceCode: string;
  createFile: string;
  shellCommand: string;
}

export interface ReplaceCodeArgs {
  file_path?: string;
  target_code?: string;
  replacement_code?: string;
}

export interface CreateFileArgs {
  file_path?: string;
  content?: string;
}

export interface ShellCommandArgs {
  command?: string;
}

export interface RawToolArgs {
  filePath: string;
  targetCode: string;
  replacementCode: string;
  content: string;
  command: string;
}

export type ToolArgs = ReplaceCodeArgs | CreateFileArgs | ShellCommandArgs;

export interface FunctionNodeProps {
  qualified_name?: string;
  name?: string | null;
  start_line?: number;
  end_line?: number;
  docstring?: string | null;
}

// =============================================================================
// MCP Types
// =============================================================================

export type MCPToolArguments = Record<string, string | number | null>;

export interface MCPInputSchemaProperty {
  type?: string;
  description?: string;
  default?: string | number;
}

export type MCPInputSchemaProperties = Record<string, MCPInputSchemaProperty>;

export interface MCPInputSchema {
  type: string;
  properties: MCPInputSchemaProperties;
  required: string[];
}

export interface MCPToolSchema {
  name: string;
  description: string;
  inputSchema: MCPInputSchema;
}

// =============================================================================
// Query Result Types
// =============================================================================

export interface QueryResultDict {
  query_used?: string;
  results?: ResultRow[];
  summary?: string;
  error?: string;
}

export interface CodeSnippetResultDict {
  qualified_name?: string;
  source_code?: string;
  file_path?: string;
  line_start?: number;
  line_end?: number;
  docstring?: string | null;
  found?: boolean;
  error_message?: string | null;
  error?: string;
}

export interface ListProjectsSuccessResult {
  projects: string[];
  count: number;
}

export interface ListProjectsErrorResult {
  projects: string[];
  count: number;
  error: string;
}

export type ListProjectsResult = ListProjectsSuccessResult | ListProjectsErrorResult;

export interface DeleteProjectSuccessResult {
  success: boolean;
  project: string;
  message: string;
}

export interface DeleteProjectErrorResult {
  success: boolean;
  error: string;
}

export type DeleteProjectResult = DeleteProjectSuccessResult | DeleteProjectErrorResult;

export type MCPResultType =
  | string
  | QueryResultDict
  | CodeSnippetResultDict
  | ListProjectsResult
  | DeleteProjectResult;

export type MCPHandlerType = (...args: unknown[]) => Promise<MCPResultType>;

// =============================================================================
// Schema Types
// =============================================================================

export interface NodeSchema {
  label: NodeLabel;
  properties: string;
}

export interface RelationshipSchema {
  sources: readonly NodeLabel[];
  relType: RelationshipType;
  targets: readonly NodeLabel[];
}

// =============================================================================
// Event Types
// =============================================================================

export enum EventType {
  MODIFIED = 'modified',
  CREATED = 'created',
  DELETED = 'deleted',
}

// =============================================================================
// C++ Node Types
// =============================================================================

export enum CppNodeType {
  TRANSLATION_UNIT = 'translation_unit',
  NAMESPACE_DEFINITION = 'namespace_definition',
  NAMESPACE_IDENTIFIER = 'namespace_identifier',
  IDENTIFIER = 'identifier',
  EXPORT = 'export',
  EXPORT_KEYWORD = 'export_keyword',
  PRIMITIVE_TYPE = 'primitive_type',
  DECLARATION = 'declaration',
  FUNCTION_DEFINITION = 'function_definition',
  TEMPLATE_DECLARATION = 'template_declaration',
  CLASS_SPECIFIER = 'class_specifier',
  FUNCTION_DECLARATOR = 'function_declarator',
  POINTER_DECLARATOR = 'pointer_declarator',
  REFERENCE_DECLARATOR = 'reference_declarator',
  FIELD_DECLARATION = 'field_declaration',
  FIELD_IDENTIFIER = 'field_identifier',
  QUALIFIED_IDENTIFIER = 'qualified_identifier',
  OPERATOR_NAME = 'operator_name',
  DESTRUCTOR_NAME = 'destructor_name',
  CONSTRUCTOR_OR_DESTRUCTOR_DEFINITION = 'constructor_or_destructor_definition',
  CONSTRUCTOR_OR_DESTRUCTOR_DECLARATION = 'constructor_or_destructor_declaration',
  INLINE_METHOD_DEFINITION = 'inline_method_definition',
  OPERATOR_CAST_DEFINITION = 'operator_cast_definition',
}

// =============================================================================
// UniXcoder Types
// =============================================================================

export enum UniXcoderMode {
  ENCODER_ONLY = '<encoder-only>',
  DECODER_ONLY = '<decoder-only>',
  ENCODER_DECODER = '<encoder-decoder>',
}
