/**
 * Language grammar configuration for web-tree-sitter
 * Maps supported languages to their WASM files and configurations
 */

import { SupportedLanguage } from '../constants.js';
import type { LanguageSpec } from '../types.js';
import * as cs from '../constants.js';

// =============================================================================
// WASM File Paths
// =============================================================================

/**
 * Get the path to a language WASM file
 * @param language - The language to get the WASM path for
 * @returns The relative path from node_modules to the WASM file
 */
export function getWasmPath(language: SupportedLanguage): string {
  const config = LANGUAGE_WASM_CONFIG[language];
  if (!config) {
    throw new Error(`No WASM file configured for language: ${language}`);
  }
  return `${config.packagePath}/${config.wasmName}`;
}

/**
 * Configuration for locating language WASM files
 */
interface WasmConfig {
  /** Name of the WASM file */
  wasmName: string;
  /** Path within node_modules to the package containing the WASM */
  packagePath: string;
}

/**
 * Mapping of supported languages to their WASM file configurations
 * Uses @vscode/tree-sitter-wasm package which has pre-built compatible WASM files
 */
export const LANGUAGE_WASM_CONFIG: Partial<Record<SupportedLanguage, WasmConfig>> = {
  [SupportedLanguage.PYTHON]: {
    wasmName: 'tree-sitter-python.wasm',
    packagePath: '@vscode/tree-sitter-wasm/wasm',
  },
  [SupportedLanguage.JS]: {
    wasmName: 'tree-sitter-javascript.wasm',
    packagePath: '@vscode/tree-sitter-wasm/wasm',
  },
  [SupportedLanguage.TS]: {
    wasmName: 'tree-sitter-typescript.wasm',
    packagePath: '@vscode/tree-sitter-wasm/wasm',
  },
  [SupportedLanguage.RUST]: {
    wasmName: 'tree-sitter-rust.wasm',
    packagePath: '@vscode/tree-sitter-wasm/wasm',
  },
  [SupportedLanguage.GO]: {
    wasmName: 'tree-sitter-go.wasm',
    packagePath: '@vscode/tree-sitter-wasm/wasm',
  },
  [SupportedLanguage.JAVA]: {
    wasmName: 'tree-sitter-java.wasm',
    packagePath: '@vscode/tree-sitter-wasm/wasm',
  },
  [SupportedLanguage.CPP]: {
    wasmName: 'tree-sitter-cpp.wasm',
    packagePath: '@vscode/tree-sitter-wasm/wasm',
  },
  [SupportedLanguage.CSHARP]: {
    wasmName: 'tree-sitter-c-sharp.wasm',
    packagePath: '@vscode/tree-sitter-wasm/wasm',
  },
  [SupportedLanguage.PHP]: {
    wasmName: 'tree-sitter-php.wasm',
    packagePath: '@vscode/tree-sitter-wasm/wasm',
  },
  // Note: C, Scala, Lua not available in @vscode/tree-sitter-wasm
  // They will be loaded from alternative sources when available
};

/**
 * Legacy mapping for backward compatibility
 */
export const LANGUAGE_WASM_NAMES: Partial<Record<SupportedLanguage, string>> = {
  [SupportedLanguage.PYTHON]: 'tree-sitter-python.wasm',
  [SupportedLanguage.JS]: 'tree-sitter-javascript.wasm',
  [SupportedLanguage.TS]: 'tree-sitter-typescript.wasm',
  [SupportedLanguage.RUST]: 'tree-sitter-rust.wasm',
  [SupportedLanguage.GO]: 'tree-sitter-go.wasm',
  [SupportedLanguage.JAVA]: 'tree-sitter-java.wasm',
  [SupportedLanguage.CPP]: 'tree-sitter-cpp.wasm',
  [SupportedLanguage.CSHARP]: 'tree-sitter-c-sharp.wasm',
  [SupportedLanguage.PHP]: 'tree-sitter-php.wasm',
};

/**
 * Check if a language has WASM support available
 */
export function hasWasmSupport(language: SupportedLanguage): boolean {
  return language in LANGUAGE_WASM_CONFIG;
}

/**
 * Get all languages with available WASM support
 */
export function getWasmSupportedLanguages(): SupportedLanguage[] {
  return Object.keys(LANGUAGE_WASM_CONFIG) as SupportedLanguage[];
}

// =============================================================================
// Language Specifications
// =============================================================================

/**
 * Complete language specifications for all supported languages
 * Includes node types, queries, and file patterns
 */
export const LANGUAGE_SPECS: Record<SupportedLanguage, LanguageSpec> = {
  [SupportedLanguage.PYTHON]: {
    language: SupportedLanguage.PYTHON,
    extensions: cs.PY_EXTENSIONS,
    functionNodeTypes: ['function_definition', 'async_function_definition'],
    classNodeTypes: ['class_definition'],
    callNodeTypes: ['call', 'attribute'],
    importNodeTypes: ['import_statement', 'import_from_statement'],
    moduleNodeTypes: ['module'],
    indexFiles: [cs.INIT_PY],
    packageIndicators: [cs.PKG_INIT_PY],
  },

  [SupportedLanguage.JS]: {
    language: SupportedLanguage.JS,
    extensions: cs.JS_EXTENSIONS,
    functionNodeTypes: [
      'function_declaration',
      'generator_function_declaration',
      'function_expression',
      'arrow_function',
      'method_definition',
    ],
    classNodeTypes: ['class_declaration', 'class'],
    callNodeTypes: ['call_expression', 'new_expression'],
    importNodeTypes: ['import_statement', 'export_statement', 'lexical_declaration'],
    moduleNodeTypes: ['program'],
    indexFiles: ['index.js', 'index.jsx'],
    packageIndicators: ['package.json'],
  },

  [SupportedLanguage.TS]: {
    language: SupportedLanguage.TS,
    extensions: cs.TS_EXTENSIONS,
    functionNodeTypes: [
      'function_declaration',
      'generator_function_declaration',
      'function_expression',
      'arrow_function',
      'method_definition',
      'function_signature',
    ],
    classNodeTypes: [
      'class_declaration',
      'class',
      'abstract_class_declaration',
      'interface_declaration',
      'enum_declaration',
      'type_alias_declaration',
      'internal_module',
    ],
    callNodeTypes: ['call_expression', 'new_expression'],
    importNodeTypes: ['import_statement', 'export_statement', 'lexical_declaration'],
    moduleNodeTypes: ['program'],
    indexFiles: ['index.ts', 'index.tsx'],
    packageIndicators: ['package.json', 'tsconfig.json'],
  },

  [SupportedLanguage.RUST]: {
    language: SupportedLanguage.RUST,
    extensions: cs.RS_EXTENSIONS,
    functionNodeTypes: ['function_item', 'function_signature_item', 'closure_expression'],
    classNodeTypes: [
      'struct_item',
      'enum_item',
      'union_item',
      'trait_item',
      'type_item',
      'impl_item',
      'mod_item',
    ],
    callNodeTypes: ['call_expression', 'macro_invocation'],
    importNodeTypes: ['use_declaration'],
    moduleNodeTypes: ['source_file'],
    indexFiles: ['mod.rs', 'lib.rs', 'main.rs'],
    packageIndicators: [cs.PKG_CARGO_TOML],
    functionsQuery: `
      (function_item name: (identifier) @name) @function
      (function_signature_item name: (identifier) @name) @function
      (closure_expression) @function
    `,
    classesQuery: `
      (struct_item name: (type_identifier) @name) @class
      (enum_item name: (type_identifier) @name) @class
      (union_item name: (type_identifier) @name) @class
      (trait_item name: (type_identifier) @name) @class
      (type_item name: (type_identifier) @name) @class
      (impl_item) @class
      (mod_item name: (identifier) @name) @module
    `,
    callsQuery: `
      (call_expression function: (identifier) @name) @call
      (call_expression function: (field_expression field: (field_identifier) @name)) @call
      (call_expression function: (scoped_identifier "::" name: (identifier) @name)) @call
      (macro_invocation macro: (identifier) @name) @call
    `,
  },

  [SupportedLanguage.GO]: {
    language: SupportedLanguage.GO,
    extensions: cs.GO_EXTENSIONS,
    functionNodeTypes: ['function_declaration', 'method_declaration', 'func_literal'],
    classNodeTypes: ['type_declaration', 'type_spec'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['import_declaration', 'import_spec'],
    moduleNodeTypes: ['source_file'],
    indexFiles: [],
    packageIndicators: ['go.mod', 'go.sum'],
  },

  [SupportedLanguage.JAVA]: {
    language: SupportedLanguage.JAVA,
    extensions: cs.JAVA_EXTENSIONS,
    functionNodeTypes: ['method_declaration', 'constructor_declaration'],
    classNodeTypes: [
      'class_declaration',
      'interface_declaration',
      'enum_declaration',
      'annotation_type_declaration',
      'record_declaration',
    ],
    callNodeTypes: ['method_invocation', 'object_creation_expression'],
    importNodeTypes: ['import_declaration'],
    moduleNodeTypes: ['program'],
    indexFiles: [],
    packageIndicators: ['pom.xml', 'build.gradle', 'build.gradle.kts'],
    functionsQuery: `
      (method_declaration name: (identifier) @name) @function
      (constructor_declaration name: (identifier) @name) @function
    `,
    classesQuery: `
      (class_declaration name: (identifier) @name) @class
      (interface_declaration name: (identifier) @name) @class
      (enum_declaration name: (identifier) @name) @class
      (annotation_type_declaration name: (identifier) @name) @class
      (record_declaration name: (identifier) @name) @class
    `,
    callsQuery: `
      (method_invocation name: (identifier) @name) @call
      (object_creation_expression type: (type_identifier) @name) @call
    `,
  },

  [SupportedLanguage.C]: {
    language: SupportedLanguage.C,
    extensions: cs.C_EXTENSIONS,
    functionNodeTypes: ['function_definition'],
    classNodeTypes: ['struct_specifier', 'union_specifier', 'enum_specifier'],
    callNodeTypes: ['call_expression'],
    importNodeTypes: ['preproc_include'],
    moduleNodeTypes: ['translation_unit'],
    indexFiles: [],
    packageIndicators: [cs.PKG_CMAKE_LISTS, cs.PKG_MAKEFILE],
    functionsQuery: `(function_definition) @function`,
    classesQuery: `
      (struct_specifier) @class
      (union_specifier) @class
      (enum_specifier) @class
    `,
    callsQuery: `(call_expression) @call`,
  },

  [SupportedLanguage.CPP]: {
    language: SupportedLanguage.CPP,
    extensions: cs.CPP_EXTENSIONS,
    functionNodeTypes: [
      'function_definition',
      'declaration',
      'field_declaration',
      'template_declaration',
      'lambda_expression',
    ],
    classNodeTypes: [
      'class_specifier',
      'struct_specifier',
      'union_specifier',
      'enum_specifier',
    ],
    callNodeTypes: [
      'call_expression',
      'binary_expression',
      'unary_expression',
      'update_expression',
      'field_expression',
      'subscript_expression',
      'new_expression',
      'delete_expression',
    ],
    importNodeTypes: ['preproc_include', 'template_function', 'declaration'],
    moduleNodeTypes: ['translation_unit'],
    indexFiles: [],
    packageIndicators: [cs.PKG_CMAKE_LISTS, cs.PKG_MAKEFILE],
    functionsQuery: `
      (field_declaration) @function
      (declaration) @function
      (function_definition) @function
      (template_declaration (function_definition)) @function
      (lambda_expression) @function
    `,
    classesQuery: `
      (class_specifier) @class
      (struct_specifier) @class
      (union_specifier) @class
      (enum_specifier) @class
      (template_declaration (class_specifier)) @class
      (template_declaration (struct_specifier)) @class
      (template_declaration (union_specifier)) @class
      (template_declaration (enum_specifier)) @class
    `,
    callsQuery: `
      (call_expression) @call
      (binary_expression) @call
      (unary_expression) @call
      (update_expression) @call
      (field_expression) @call
      (subscript_expression) @call
      (new_expression) @call
      (delete_expression) @call
    `,
  },

  [SupportedLanguage.CSHARP]: {
    language: SupportedLanguage.CSHARP,
    extensions: cs.CS_EXTENSIONS,
    functionNodeTypes: ['method_declaration', 'constructor_declaration', 'lambda_expression'],
    classNodeTypes: [
      'class_declaration',
      'interface_declaration',
      'struct_declaration',
      'enum_declaration',
      'record_declaration',
    ],
    callNodeTypes: ['invocation_expression', 'object_creation_expression'],
    importNodeTypes: ['using_directive'],
    moduleNodeTypes: ['compilation_unit'],
    indexFiles: [],
    packageIndicators: ['*.csproj'],
  },

  [SupportedLanguage.SCALA]: {
    language: SupportedLanguage.SCALA,
    extensions: cs.SCALA_EXTENSIONS,
    functionNodeTypes: ['function_definition', 'val_definition', 'var_definition'],
    classNodeTypes: [
      'class_definition',
      'trait_definition',
      'object_definition',
      'enum_definition',
    ],
    callNodeTypes: ['call_expression', 'infix_expression'],
    importNodeTypes: ['import_declaration'],
    moduleNodeTypes: ['compilation_unit'],
    indexFiles: [],
    packageIndicators: ['build.sbt', 'build.sc'],
  },

  [SupportedLanguage.PHP]: {
    language: SupportedLanguage.PHP,
    extensions: cs.PHP_EXTENSIONS,
    functionNodeTypes: [
      'function_definition',
      'method_declaration',
      'anonymous_function',
      'arrow_function',
    ],
    classNodeTypes: [
      'class_declaration',
      'interface_declaration',
      'trait_declaration',
      'enum_declaration',
    ],
    callNodeTypes: [
      'function_call_expression',
      'member_call_expression',
      'scoped_call_expression',
      'nullsafe_member_call_expression',
      'object_creation_expression',
    ],
    importNodeTypes: ['namespace_use_declaration'],
    moduleNodeTypes: ['program'],
    indexFiles: [],
    packageIndicators: ['composer.json'],
    functionsQuery: `
      (function_definition name: (name) @name) @function
      (method_declaration name: (name) @name) @function
      (anonymous_function) @function
      (arrow_function) @function
    `,
    classesQuery: `
      (class_declaration name: (name) @name) @class
      (interface_declaration name: (name) @name) @class
      (trait_declaration name: (name) @name) @class
      (enum_declaration name: (name) @name) @class
    `,
    callsQuery: `
      (function_call_expression function: (name) @name) @call
      (function_call_expression function: (qualified_name) @name) @call
      (member_call_expression name: (name) @name) @call
      (scoped_call_expression name: (name) @name) @call
      (nullsafe_member_call_expression name: (name) @name) @call
      (object_creation_expression (name) @name) @call
      (object_creation_expression (qualified_name) @name) @call
    `,
  },

  [SupportedLanguage.LUA]: {
    language: SupportedLanguage.LUA,
    extensions: cs.LUA_EXTENSIONS,
    functionNodeTypes: ['function_declaration', 'local_function', 'function'],
    classNodeTypes: ['table_constructor'],
    callNodeTypes: ['function_call'],
    importNodeTypes: ['function_call'], // require() calls
    moduleNodeTypes: ['chunk'],
    indexFiles: ['init.lua'],
    packageIndicators: [],
  },
};

// =============================================================================
// Extension to Language Mapping
// =============================================================================

/**
 * Build extension-to-language mapping from LANGUAGE_SPECS
 */
const EXTENSION_TO_LANGUAGE: Map<string, SupportedLanguage> = new Map();

for (const [lang, spec] of Object.entries(LANGUAGE_SPECS)) {
  for (const ext of spec.extensions) {
    EXTENSION_TO_LANGUAGE.set(ext, lang as SupportedLanguage);
  }
}

/**
 * Get the supported language for a file extension
 */
export function getLanguageForExtension(extension: string): SupportedLanguage | null {
  return EXTENSION_TO_LANGUAGE.get(extension) ?? null;
}

/**
 * Get the language spec for a file extension
 */
export function getLanguageSpecForExtension(extension: string): LanguageSpec | null {
  const language = getLanguageForExtension(extension);
  if (!language) return null;
  return LANGUAGE_SPECS[language];
}

/**
 * Get the language spec for a language
 */
export function getLanguageSpec(language: SupportedLanguage): LanguageSpec {
  return LANGUAGE_SPECS[language];
}

/**
 * Check if a file extension is supported
 */
export function isSupportedExtension(extension: string): boolean {
  return EXTENSION_TO_LANGUAGE.has(extension);
}

/**
 * Get all supported file extensions
 */
export function getSupportedExtensions(): string[] {
  return Array.from(EXTENSION_TO_LANGUAGE.keys());
}

/**
 * Get all supported languages
 */
export function getSupportedLanguages(): SupportedLanguage[] {
  return Object.values(SupportedLanguage);
}
