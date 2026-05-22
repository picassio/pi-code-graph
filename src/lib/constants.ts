/**
 * Constants for code-graph-rag library
 * Ported from codebase_rag/constants.py
 */

// =============================================================================
// Core Enums
// =============================================================================

export enum ModelRole {
  ORCHESTRATOR = 'orchestrator',
  CYPHER = 'cypher',
}

export enum Provider {
  OLLAMA = 'ollama',
  ANTHROPIC = 'anthropic',
  OPENAI = 'openai',
  GOOGLE = 'google',
  AZURE = 'azure',
  LITELLM_PROXY = 'litellm_proxy',
}

export enum GoogleProviderType {
  GLA = 'gla',
  VERTEX = 'vertex',
}

export enum NodeLabel {
  PROJECT = 'Project',
  PACKAGE = 'Package',
  FOLDER = 'Folder',
  FILE = 'File',
  MODULE = 'Module',
  CLASS = 'Class',
  FUNCTION = 'Function',
  METHOD = 'Method',
  INTERFACE = 'Interface',
  ENUM = 'Enum',
  TYPE = 'Type',
  UNION = 'Union',
  MODULE_INTERFACE = 'ModuleInterface',
  MODULE_IMPLEMENTATION = 'ModuleImplementation',
  EXTERNAL_PACKAGE = 'ExternalPackage',
  COMMENT = 'Comment',
  LITERAL = 'Literal',
  BUILTIN = 'Builtin',
}

export enum RelationshipType {
  CONTAINS_PACKAGE = 'CONTAINS_PACKAGE',
  CONTAINS_FOLDER = 'CONTAINS_FOLDER',
  CONTAINS_FILE = 'CONTAINS_FILE',
  CONTAINS_MODULE = 'CONTAINS_MODULE',
  DEFINES = 'DEFINES',
  DEFINES_METHOD = 'DEFINES_METHOD',
  IMPORTS = 'IMPORTS',
  EXPORTS = 'EXPORTS',
  EXPORTS_MODULE = 'EXPORTS_MODULE',
  IMPLEMENTS_MODULE = 'IMPLEMENTS_MODULE',
  INHERITS = 'INHERITS',
  IMPLEMENTS = 'IMPLEMENTS',
  OVERRIDES = 'OVERRIDES',
  CALLS = 'CALLS',
  DEPENDS_ON_EXTERNAL = 'DEPENDS_ON_EXTERNAL',
}

export enum UniqueKeyType {
  NAME = 'name',
  PATH = 'path',
  QUALIFIED_NAME = 'qualified_name',
}

export enum SupportedLanguage {
  PYTHON = 'python',
  JS = 'javascript',
  TS = 'typescript',
  RUST = 'rust',
  GO = 'go',
  SCALA = 'scala',
  JAVA = 'java',
  C = 'c',
  CPP = 'cpp',
  CSHARP = 'c-sharp',
  PHP = 'php',
  LUA = 'lua',
}

export enum TreeSitterModule {
  PYTHON = 'tree_sitter_python',
  JS = 'tree_sitter_javascript',
  TS = 'tree_sitter_typescript',
  RUST = 'tree_sitter_rust',
  GO = 'tree_sitter_go',
  SCALA = 'tree_sitter_scala',
  JAVA = 'tree_sitter_java',
  C = 'tree_sitter_c',
  CPP = 'tree_sitter_cpp',
  LUA = 'tree_sitter_lua',
  PHP = 'tree_sitter_php',
}

// =============================================================================
// Node Label to Unique Key Mapping
// =============================================================================

export const NODE_LABEL_UNIQUE_KEYS: Record<NodeLabel, UniqueKeyType> = {
  [NodeLabel.PROJECT]: UniqueKeyType.NAME,
  [NodeLabel.PACKAGE]: UniqueKeyType.QUALIFIED_NAME,
  [NodeLabel.FOLDER]: UniqueKeyType.PATH,
  [NodeLabel.FILE]: UniqueKeyType.PATH,
  [NodeLabel.MODULE]: UniqueKeyType.QUALIFIED_NAME,
  [NodeLabel.CLASS]: UniqueKeyType.QUALIFIED_NAME,
  [NodeLabel.FUNCTION]: UniqueKeyType.QUALIFIED_NAME,
  [NodeLabel.METHOD]: UniqueKeyType.QUALIFIED_NAME,
  [NodeLabel.INTERFACE]: UniqueKeyType.QUALIFIED_NAME,
  [NodeLabel.ENUM]: UniqueKeyType.QUALIFIED_NAME,
  [NodeLabel.TYPE]: UniqueKeyType.QUALIFIED_NAME,
  [NodeLabel.UNION]: UniqueKeyType.QUALIFIED_NAME,
  [NodeLabel.MODULE_INTERFACE]: UniqueKeyType.QUALIFIED_NAME,
  [NodeLabel.MODULE_IMPLEMENTATION]: UniqueKeyType.QUALIFIED_NAME,
  [NodeLabel.EXTERNAL_PACKAGE]: UniqueKeyType.NAME,
  [NodeLabel.COMMENT]: UniqueKeyType.QUALIFIED_NAME,
  [NodeLabel.LITERAL]: UniqueKeyType.QUALIFIED_NAME,
  [NodeLabel.BUILTIN]: UniqueKeyType.QUALIFIED_NAME,
};

export const NODE_UNIQUE_CONSTRAINTS: Record<string, string> = Object.fromEntries(
  Object.entries(NODE_LABEL_UNIQUE_KEYS).map(([label, key]) => [label, key])
);

// =============================================================================
// File Extensions
// =============================================================================

export const EXT_PY = '.py';
export const EXT_JS = '.js';
export const EXT_JSX = '.jsx';
export const EXT_TS = '.ts';
export const EXT_TSX = '.tsx';
export const EXT_RS = '.rs';
export const EXT_GO = '.go';
export const EXT_SCALA = '.scala';
export const EXT_SC = '.sc';
export const EXT_JAVA = '.java';
export const EXT_CLASS = '.class';
export const EXT_CPP = '.cpp';
export const EXT_H = '.h';
export const EXT_HPP = '.hpp';
export const EXT_CC = '.cc';
export const EXT_CXX = '.cxx';
export const EXT_HXX = '.hxx';
export const EXT_HH = '.hh';
export const EXT_IXX = '.ixx';
export const EXT_CPPM = '.cppm';
export const EXT_CCM = '.ccm';
export const EXT_C = '.c';
export const EXT_CS = '.cs';
export const EXT_PHP = '.php';
export const EXT_LUA = '.lua';

// File extension tuples by language
export const PY_EXTENSIONS = [EXT_PY] as const;
export const JS_EXTENSIONS = [EXT_JS, EXT_JSX] as const;
export const TS_EXTENSIONS = [EXT_TS, EXT_TSX] as const;
export const RS_EXTENSIONS = [EXT_RS] as const;
export const GO_EXTENSIONS = [EXT_GO] as const;
export const SCALA_EXTENSIONS = [EXT_SCALA, EXT_SC] as const;
export const JAVA_EXTENSIONS = [EXT_JAVA] as const;
export const C_EXTENSIONS = [EXT_C] as const;
export const CPP_EXTENSIONS = [
  EXT_CPP, EXT_H, EXT_HPP, EXT_CC, EXT_CXX, EXT_HXX, EXT_HH, EXT_IXX, EXT_CPPM, EXT_CCM,
] as const;
export const CS_EXTENSIONS = [EXT_CS] as const;
export const PHP_EXTENSIONS = [EXT_PHP] as const;
export const LUA_EXTENSIONS = [EXT_LUA] as const;

export const BINARY_EXTENSIONS = new Set([
  '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.tiff', '.webp',
]);

// =============================================================================
// Package Indicators
// =============================================================================

export const PKG_INIT_PY = '__init__.py';
export const PKG_CARGO_TOML = 'Cargo.toml';
export const PKG_CMAKE_LISTS = 'CMakeLists.txt';
export const PKG_MAKEFILE = 'Makefile';
export const PKG_VCXPROJ_GLOB = '*.vcxproj';
export const PKG_CONANFILE = 'conanfile.txt';

// =============================================================================
// Index File Names
// =============================================================================

export const INDEX_INIT = '__init__';
export const INDEX_INDEX = 'index';
export const INDEX_MOD = 'mod';
export const INIT_PY = '__init__.py';

// =============================================================================
// Separators & Path Constants
// =============================================================================

export const SEPARATOR_DOT = '.';
export const SEPARATOR_SLASH = '/';
export const SEPARATOR_DOUBLE_COLON = '::';
export const SEPARATOR_COLON = ':';
export const SEPARATOR_PROTOTYPE = '.prototype.';
export const SEPARATOR_COMMA_SPACE = ', ';

export const PATH_CURRENT_DIR = '.';
export const PATH_PARENT_DIR = '..';
export const GLOB_ALL = '*';
export const PATH_RELATIVE_PREFIX = './';
export const PATH_PARENT_PREFIX = '../';

// =============================================================================
// Trie Keys
// =============================================================================

export const TRIE_TYPE_KEY = '__type__';
export const TRIE_QN_KEY = '__qn__';
export const TRIE_INTERNAL_PREFIX = '__';

// =============================================================================
// Property Keys
// =============================================================================

export const KEY_NODES = 'nodes';
export const KEY_RELATIONSHIPS = 'relationships';
export const KEY_NODE_ID = 'node_id';
export const KEY_LABELS = 'labels';
export const KEY_PROPERTIES = 'properties';
export const KEY_FROM_ID = 'from_id';
export const KEY_TO_ID = 'to_id';
export const KEY_TYPE = 'type';
export const KEY_METADATA = 'metadata';
export const KEY_TOTAL_NODES = 'total_nodes';
export const KEY_TOTAL_RELATIONSHIPS = 'total_relationships';
export const KEY_NODE_LABELS = 'node_labels';
export const KEY_RELATIONSHIP_TYPES = 'relationship_types';
export const KEY_EXPORTED_AT = 'exported_at';
export const KEY_PARSER = 'parser';
export const KEY_NAME = 'name';
export const KEY_QUALIFIED_NAME = 'qualified_name';
export const KEY_PROJECT = 'project';
export const KEY_FILE_PATH = 'file_path';
export const KEY_LOCAL_NAME = 'local_name';
export const KEY_START_LINE = 'start_line';
export const KEY_END_LINE = 'end_line';
export const KEY_PATH = 'path';
export const KEY_ABSOLUTE_PATH = 'absolute_path';
export const KEY_EXTENSION = 'extension';
export const KEY_MODULE_TYPE = 'module_type';
export const KEY_IMPLEMENTS_MODULE = 'implements_module';
export const KEY_PROPS = 'props';
export const KEY_CREATED = 'created';
export const KEY_FROM_VAL = 'from_val';
export const KEY_TO_VAL = 'to_val';
export const KEY_VERSION_SPEC = 'version_spec';
export const KEY_PREFIX = 'prefix';
export const KEY_PROJECT_NAME = 'project_name';
export const KEY_IS_EXTERNAL = 'is_external';
export const KEY_PARAMETERS = 'parameters';
export const KEY_DECORATORS = 'decorators';
export const KEY_DOCSTRING = 'docstring';
export const KEY_IS_EXPORTED = 'is_exported';

// =============================================================================
// Encoding & Defaults
// =============================================================================

export const ENCODING_UTF8 = 'utf-8';
export const DEFAULT_REGION = 'us-central1';
export const DEFAULT_MODEL = 'llama3.2';
export const DEFAULT_API_KEY = 'ollama';
export const DEFAULT_NAME = 'Unknown';
export const TEXT_UNKNOWN = 'unknown';

// =============================================================================
// Environment Variables
// =============================================================================

export const ENV_OPENAI_API_KEY = 'OPENAI_API_KEY';
export const ENV_GOOGLE_API_KEY = 'GOOGLE_API_KEY';
export const ENV_ANTHROPIC_API_KEY = 'ANTHROPIC_API_KEY';
export const ENV_AZURE_API_KEY = 'AZURE_API_KEY';
export const ENV_AZURE_ENDPOINT = 'AZURE_OPENAI_ENDPOINT';
export const ENV_AZURE_API_VERSION = 'AZURE_API_VERSION';

// =============================================================================
// Provider Endpoints
// =============================================================================

export const OPENAI_DEFAULT_ENDPOINT = 'https://api.openai.com/v1';
export const OLLAMA_HEALTH_PATH = '/api/tags';
export const GOOGLE_CLOUD_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
export const V1_PATH = '/v1';
export const HTTP_OK = 200;

// =============================================================================
// Embedding Constants
// =============================================================================

export const UNIXCODER_MODEL = 'microsoft/unixcoder-base';
export const EMBEDDING_DEFAULT_BATCH_SIZE = 32;
export const EMBEDDING_CACHE_FILENAME = '.embedding_cache.json';
export const UNIXCODER_MASK_TOKEN = '<mask0>';
export const UNIXCODER_BUFFER_BIAS = 'bias';
export const UNIXCODER_MAX_CONTEXT = 1024;
export const SEMANTIC_BATCH_SIZE = 100;
export const SEMANTIC_TYPE_UNKNOWN = 'Unknown';

// =============================================================================
// Tree-sitter Node Types
// =============================================================================

// Function nodes
export const FUNCTION_NODES_BASIC = ['function_declaration', 'function_definition'] as const;
export const FUNCTION_NODES_LAMBDA = [
  'lambda_expression', 'arrow_function', 'anonymous_function', 'closure_expression',
] as const;
export const FUNCTION_NODES_METHOD = [
  'method_declaration', 'constructor_declaration', 'destructor_declaration',
] as const;
export const FUNCTION_NODES_TEMPLATE = [
  'template_declaration', 'function_signature_item', 'function_signature',
] as const;
export const FUNCTION_NODES_GENERATOR = [
  'generator_function_declaration', 'function_expression',
] as const;

// Class nodes
export const CLASS_NODES_BASIC = ['class_declaration', 'class_definition'] as const;
export const CLASS_NODES_STRUCT = [
  'struct_declaration', 'struct_specifier', 'struct_item',
] as const;
export const CLASS_NODES_INTERFACE = [
  'interface_declaration', 'trait_declaration', 'trait_item',
] as const;
export const CLASS_NODES_ENUM = [
  'enum_declaration', 'enum_item', 'enum_specifier',
] as const;
export const CLASS_NODES_TYPE_ALIAS = ['type_alias_declaration', 'type_item'] as const;
export const CLASS_NODES_UNION = ['union_specifier', 'union_item'] as const;

// Call nodes
export const CALL_NODES_BASIC = ['call_expression', 'function_call'] as const;
export const CALL_NODES_METHOD = [
  'method_invocation', 'member_call_expression', 'field_expression',
] as const;
export const CALL_NODES_OPERATOR = [
  'binary_expression', 'unary_expression', 'update_expression',
] as const;
export const CALL_NODES_SPECIAL = [
  'new_expression', 'delete_expression', 'macro_invocation',
] as const;

// Import nodes
export const IMPORT_NODES_STANDARD = ['import_declaration', 'import_statement'] as const;
export const IMPORT_NODES_FROM = ['import_from_statement'] as const;
export const IMPORT_NODES_MODULE = ['lexical_declaration', 'export_statement'] as const;
export const IMPORT_NODES_INCLUDE = ['preproc_include'] as const;
export const IMPORT_NODES_USING = ['using_directive'] as const;

// JS/TS specific
export const JS_TS_FUNCTION_NODES = [
  'function_declaration', 'generator_function_declaration',
  'function_expression', 'arrow_function', 'method_definition',
] as const;
export const JS_TS_CLASS_NODES = ['class_declaration', 'class'] as const;
export const JS_TS_IMPORT_NODES = [
  'import_statement', 'lexical_declaration', 'export_statement',
] as const;
export const JS_TS_LANGUAGES = new Set([SupportedLanguage.JS, SupportedLanguage.TS]);

export const CPP_IMPORT_NODES = ['preproc_include', 'template_function', 'declaration'] as const;

// =============================================================================
// AST Field Names
// =============================================================================

export const NAME_FIELDS = ['identifier', 'name', 'id'] as const;

export const FIELD_OBJECT = 'object';
export const FIELD_PROPERTY = 'property';
export const FIELD_NAME = 'name';
export const FIELD_ALIAS = 'alias';
export const FIELD_MODULE_NAME = 'module_name';
export const FIELD_ARGUMENTS = 'arguments';
export const FIELD_BODY = 'body';
export const FIELD_CONSTRUCTOR = 'constructor';
export const FIELD_DECLARATOR = 'declarator';
export const FIELD_PARAMETERS = 'parameters';
export const FIELD_TYPE = 'type';
export const FIELD_VALUE = 'value';
export const FIELD_LEFT = 'left';
export const FIELD_RIGHT = 'right';
export const FIELD_FIELD = 'field';
export const FIELD_SUPERCLASS = 'superclass';
export const FIELD_SUPERCLASSES = 'superclasses';
export const FIELD_INTERFACES = 'interfaces';

// =============================================================================
// Query Keys
// =============================================================================

export const QUERY_FUNCTIONS = 'functions';
export const QUERY_CLASSES = 'classes';
export const QUERY_CALLS = 'calls';
export const QUERY_IMPORTS = 'imports';
export const QUERY_LOCALS = 'locals';
export const QUERY_CONFIG = 'config';
export const QUERY_LANGUAGE = 'language';

// Capture names
export const CAPTURE_FUNCTION = 'function';
export const CAPTURE_CLASS = 'class';
export const CAPTURE_CALL = 'call';
export const CAPTURE_IMPORT = 'import';
export const CAPTURE_IMPORT_FROM = 'import_from';

// =============================================================================
// Query Patterns
// =============================================================================

export const JS_LOCALS_PATTERN = `
; Variable definitions
(variable_declarator name: (identifier) @local.definition)
(function_declaration name: (identifier) @local.definition)
(class_declaration name: (identifier) @local.definition)

; Variable references
(identifier) @local.reference
`;

export const TS_LOCALS_PATTERN = `
; Variable definitions (TypeScript has multiple declaration types)
(variable_declarator name: (identifier) @local.definition)
(lexical_declaration (variable_declarator name: (identifier) @local.definition))
(variable_declaration (variable_declarator name: (identifier) @local.definition))

; Function definitions
(function_declaration name: (identifier) @local.definition)

; Class definitions (uses type_identifier for class names)
(class_declaration name: (type_identifier) @local.definition)

; Variable references
(identifier) @local.reference
`;

// =============================================================================
// Ignore Patterns
// =============================================================================

export const IGNORE_PATTERNS = new Set([
  '.cache', '.claude', '.eclipse', '.eggs', '.env', '.git', '.gradle', '.hg',
  '.idea', '.maven', '.mypy_cache', '.nox', '.npm', '.nyc_output', '.pnpm-store',
  '.pytest_cache', '.qdrant_code_embeddings', '.ruff_cache', '.svn', '.tmp',
  '.tox', '.venv', '.vs', '.vscode', '.yarn', '__pycache__', 'bin',
  'bower_components', 'build', 'coverage', 'dist', 'env', 'htmlcov',
  'node_modules', 'obj', 'out', 'Pods', 'site-packages', 'target', 'temp',
  'tmp', 'vendor', 'venv',
]);

export const IGNORE_SUFFIXES = new Set([
  '.tmp', '~', '.pyc', '.pyo', '.o', '.a', '.so', '.dll', '.class',
]);

// =============================================================================
// Dependency Files
// =============================================================================

export const DEPENDENCY_FILES = new Set([
  'pyproject.toml', 'requirements.txt', 'package.json', 'cargo.toml',
  'go.mod', 'gemfile', 'composer.json',
]);

export const CSPROJ_SUFFIX = '.csproj';
export const EXCLUDED_DEPENDENCY_NAMES = new Set(['python', 'php']);

// =============================================================================
// Cypher Constants
// =============================================================================

export const CYPHER_DEFAULT_LIMIT = 50;
export const CYPHER_PREFIX = 'cypher';
export const CYPHER_SEMICOLON = ';';
export const CYPHER_BACKTICK = '`';
export const CYPHER_MATCH_KEYWORD = 'MATCH';

export const CYPHER_DANGEROUS_KEYWORDS = new Set([
  'DELETE', 'DETACH', 'DROP', 'CREATE INDEX', 'CREATE CONSTRAINT',
  'REMOVE', 'SET', 'MERGE', 'CREATE', 'CALL', 'LOAD CSV', 'FOREACH',
]);

// =============================================================================
// Call Processor Constants
// =============================================================================

export const MOD_RS = 'mod.rs';
export const RUST_CRATE_PREFIX = 'crate::';
export const BUILTIN_PREFIX = 'builtin';
export const IIFE_FUNC_PREFIX = 'iife_func_';
export const IIFE_ARROW_PREFIX = 'iife_arrow_';
export const OPERATOR_PREFIX = 'operator';
export const KEYWORD_SUPER = 'super';
export const KEYWORD_SELF = 'self';
export const KEYWORD_CONSTRUCTOR = 'constructor';
export const CPP_IMPORT_PARTITION_PREFIX = 'import :';
export const CPP_PARTITION_PREFIX = 'partition_';

// =============================================================================
// JavaScript Built-ins
// =============================================================================

export const JS_BUILTIN_TYPES = new Set([
  'Array', 'Object', 'String', 'Number', 'Date', 'RegExp', 'Function',
  'Map', 'Set', 'Promise', 'Error', 'Boolean',
]);

export const JS_BUILTIN_PATTERNS = new Set([
  'Object.create', 'Object.keys', 'Object.values', 'Object.entries',
  'Object.assign', 'Object.freeze', 'Object.seal', 'Object.defineProperty',
  'Object.getPrototypeOf', 'Object.setPrototypeOf', 'Array.from', 'Array.of',
  'Array.isArray', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'encodeURIComponent', 'decodeURIComponent', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'console.log', 'console.error',
  'console.warn', 'console.info', 'console.debug', 'JSON.parse',
  'JSON.stringify', 'Math.random', 'Math.floor', 'Math.ceil', 'Math.round',
  'Math.abs', 'Math.max', 'Math.min', 'Date.now', 'Date.parse',
]);

export const JS_METHOD_BIND = 'bind';
export const JS_METHOD_CALL = 'call';
export const JS_METHOD_APPLY = 'apply';
export const JS_SUFFIX_BIND = '.bind';
export const JS_SUFFIX_CALL = '.call';
export const JS_SUFFIX_APPLY = '.apply';

export const JS_FUNCTION_PROTOTYPE_SUFFIXES: Record<string, string> = {
  [JS_SUFFIX_BIND]: JS_METHOD_BIND,
  [JS_SUFFIX_CALL]: JS_METHOD_CALL,
  [JS_SUFFIX_APPLY]: JS_METHOD_APPLY,
};

// =============================================================================
// C++ Constants
// =============================================================================

export const CPP_OPERATORS: Record<string, string> = {
  operator_plus: 'builtin.cpp.operator_plus',
  operator_minus: 'builtin.cpp.operator_minus',
  operator_multiply: 'builtin.cpp.operator_multiply',
  operator_divide: 'builtin.cpp.operator_divide',
  operator_modulo: 'builtin.cpp.operator_modulo',
  operator_equal: 'builtin.cpp.operator_equal',
  operator_not_equal: 'builtin.cpp.operator_not_equal',
  operator_less: 'builtin.cpp.operator_less',
  operator_greater: 'builtin.cpp.operator_greater',
  operator_less_equal: 'builtin.cpp.operator_less_equal',
  operator_greater_equal: 'builtin.cpp.operator_greater_equal',
  operator_assign: 'builtin.cpp.operator_assign',
  operator_plus_assign: 'builtin.cpp.operator_plus_assign',
  operator_minus_assign: 'builtin.cpp.operator_minus_assign',
  operator_multiply_assign: 'builtin.cpp.operator_multiply_assign',
  operator_divide_assign: 'builtin.cpp.operator_divide_assign',
  operator_modulo_assign: 'builtin.cpp.operator_modulo_assign',
  operator_increment: 'builtin.cpp.operator_increment',
  operator_decrement: 'builtin.cpp.operator_decrement',
  operator_left_shift: 'builtin.cpp.operator_left_shift',
  operator_right_shift: 'builtin.cpp.operator_right_shift',
  operator_bitwise_and: 'builtin.cpp.operator_bitwise_and',
  operator_bitwise_or: 'builtin.cpp.operator_bitwise_or',
  operator_bitwise_xor: 'builtin.cpp.operator_bitwise_xor',
  operator_bitwise_not: 'builtin.cpp.operator_bitwise_not',
  operator_logical_and: 'builtin.cpp.operator_logical_and',
  operator_logical_or: 'builtin.cpp.operator_logical_or',
  operator_logical_not: 'builtin.cpp.operator_logical_not',
  operator_subscript: 'builtin.cpp.operator_subscript',
  operator_call: 'builtin.cpp.operator_call',
};

export const CPP_MODULE_EXTENSIONS = ['.ixx', '.cppm', '.ccm', '.mxx'] as const;
export const CPP_MODULE_PATH_MARKERS = new Set(['interfaces', 'modules']);

export const CPP_EXPORT_MODULE_PREFIX = 'export module ';
export const CPP_MODULE_PREFIX = 'module ';
export const CPP_MODULE_PRIVATE_PREFIX = 'module ;';
export const CPP_IMPL_SUFFIX = '_impl';
export const CPP_MODULE_TYPE_INTERFACE = 'interface';
export const CPP_MODULE_TYPE_IMPLEMENTATION = 'implementation';

export const CPP_EXPORT_CLASS_PREFIX = 'export class ';
export const CPP_EXPORT_STRUCT_PREFIX = 'export struct ';
export const CPP_EXPORT_UNION_PREFIX = 'export union ';
export const CPP_EXPORT_TEMPLATE_PREFIX = 'export template';
export const CPP_EXPORT_PREFIXES = [
  CPP_EXPORT_CLASS_PREFIX, CPP_EXPORT_STRUCT_PREFIX,
  CPP_EXPORT_UNION_PREFIX, CPP_EXPORT_TEMPLATE_PREFIX,
] as const;

export const CPP_KEYWORD_CLASS = 'class';
export const CPP_KEYWORD_STRUCT = 'struct';
export const CPP_EXPORTED_CLASS_KEYWORDS = new Set([CPP_KEYWORD_CLASS, CPP_KEYWORD_STRUCT]);

export const CPP_FALLBACK_OPERATOR = 'operator_unknown';
export const CPP_FALLBACK_DESTRUCTOR = '~destructor';
export const CPP_OPERATOR_TEXT_PREFIX = 'operator';
export const CPP_DESTRUCTOR_PREFIX = '~';

export const CPP_OPERATOR_SYMBOL_MAP: Record<string, string> = {
  '+': 'operator_plus',
  '-': 'operator_minus',
  '*': 'operator_multiply',
  '/': 'operator_divide',
  '%': 'operator_modulo',
  '=': 'operator_assign',
  '==': 'operator_equal',
  '!=': 'operator_not_equal',
  '<': 'operator_less',
  '>': 'operator_greater',
  '<=': 'operator_less_equal',
  '>=': 'operator_greater_equal',
  '&&': 'operator_logical_and',
  '||': 'operator_logical_or',
  '&': 'operator_bitwise_and',
  '|': 'operator_bitwise_or',
  '^': 'operator_bitwise_xor',
  '~': 'operator_bitwise_not',
  '!': 'operator_not',
  '<<': 'operator_left_shift',
  '>>': 'operator_right_shift',
  '++': 'operator_increment',
  '--': 'operator_decrement',
  '+=': 'operator_plus_assign',
  '-=': 'operator_minus_assign',
  '*=': 'operator_multiply_assign',
  '/=': 'operator_divide_assign',
  '%=': 'operator_modulo_assign',
  '&=': 'operator_and_assign',
  '|=': 'operator_or_assign',
  '^=': 'operator_xor_assign',
  '<<=': 'operator_left_shift_assign',
  '>>=': 'operator_right_shift_assign',
  '[]': 'operator_subscript',
  '()': 'operator_call',
};

// =============================================================================
// Character Constants
// =============================================================================

export const CHAR_SEMICOLON = ';';
export const CHAR_COMMA = ',';
export const CHAR_COLON = ':';
export const CHAR_ANGLE_OPEN = '<';
export const CHAR_ANGLE_CLOSE = '>';
export const CHAR_PAREN_OPEN = '(';
export const CHAR_PAREN_CLOSE = ')';
export const CHAR_UNDERSCORE = '_';
export const CHAR_SPACE = ' ';
export const CHAR_HYPHEN = '-';
export const PUNCTUATION_TYPES = [CHAR_PAREN_OPEN, CHAR_PAREN_CLOSE, CHAR_COMMA] as const;

// =============================================================================
// Formatting Constants
// =============================================================================

export const EMPTY_PARENS = '()';
export const DOCSTRING_STRIP_CHARS = '\'" \n';
export const INLINE_MODULE_PATH_PREFIX = 'inline_module_';
export const JSON_INDENT = 2;
export const BYTES_PER_MB = 1024 * 1024;

// =============================================================================
// Watcher Constants
// =============================================================================

export const WATCHER_SLEEP_INTERVAL = 1;
export const LOG_LEVEL_INFO = 'INFO';
export const LOG_LEVEL_ERROR = 'ERROR';
export const DEFAULT_DEBOUNCE_SECONDS = 5;
export const DEFAULT_MAX_WAIT_SECONDS = 30;

// =============================================================================
// Error Substrings
// =============================================================================

export const ERR_SUBSTR_ALREADY_EXISTS = 'already exists';
export const ERR_SUBSTR_CONSTRAINT = 'constraint';

// Relationship type constant for CALLS (used in logging)
export const REL_TYPE_CALLS = 'CALLS';

// =============================================================================
// Regex Patterns
// =============================================================================

export const REGEX_METHOD_CHAIN_SUFFIX = /\)\.[^)]*$/;
export const REGEX_FINAL_METHOD_CAPTURE = /\.([^.()]+)$/;

// =============================================================================
// Payload Keys
// =============================================================================

export const PAYLOAD_NODE_ID = 'node_id';
export const PAYLOAD_QUALIFIED_NAME = 'qualified_name';

// =============================================================================
// Method Names
// =============================================================================

export const METHOD_FIND_WITH_PREFIX = 'find_with_prefix';
export const METHOD_ITEMS = 'items';

// =============================================================================
// Image Extensions
// =============================================================================

export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif'] as const;

// =============================================================================
// Tiktoken
// =============================================================================

export const TIKTOKEN_ENCODING = 'cl100k_base';
export const DICT_KEY_RESULTS = 'results';

// =============================================================================
// Cypher Embedding Queries
// =============================================================================

const CYPHER_EMBEDDING_BASE = `
MATCH (m:Module)-[:DEFINES]->(n)
WHERE (n:Function OR n:Method)
  AND m.qualified_name STARTS WITH ($project_name + '.')
`;

export const CYPHER_QUERY_EMBEDDINGS = CYPHER_EMBEDDING_BASE + `
RETURN id(n) AS node_id, n.qualified_name AS qualified_name,
       n.start_line AS start_line, n.end_line AS end_line,
       m.path AS path
`;

export const CYPHER_QUERY_PROJECT_NODE_IDS = CYPHER_EMBEDDING_BASE + 'RETURN id(n) AS node_id\n';
