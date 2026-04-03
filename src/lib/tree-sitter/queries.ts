/**
 * Tree-sitter query patterns for each supported language
 * Used for extracting functions, classes, calls, imports, and local definitions
 */

import { SupportedLanguage } from '../constants.js';
import { LANGUAGE_SPECS } from './languages.js';

// =============================================================================
// Query Capture Names
// =============================================================================

export const CAPTURE = {
  FUNCTION: 'function',
  CLASS: 'class',
  MODULE: 'module',
  CALL: 'call',
  IMPORT: 'import',
  IMPORT_FROM: 'import_from',
  NAME: 'name',
  LOCAL_DEFINITION: 'local.definition',
  LOCAL_REFERENCE: 'local.reference',
} as const;

// =============================================================================
// Default Query Generators
// =============================================================================

/**
 * Build a query pattern that captures specified node types
 */
export function buildQueryPattern(nodeTypes: readonly string[], captureName: string): string {
  return nodeTypes.map((type) => `(${type}) @${captureName}`).join('\n');
}

/**
 * Build combined import pattern from spec
 */
export function buildImportPattern(spec: { importNodeTypes: readonly string[] }): string {
  return buildQueryPattern(spec.importNodeTypes, CAPTURE.IMPORT);
}

// =============================================================================
// Python Queries
// =============================================================================

export const PYTHON_QUERIES = {
  functions: `
    (function_definition
      name: (identifier) @name) @function
  `,
  classes: `
    (class_definition
      name: (identifier) @name) @class
  `,
  calls: `
    (call
      function: (identifier) @name) @call
    (call
      function: (attribute
        attribute: (identifier) @name)) @call
  `,
  imports: `
    (import_statement
      name: (dotted_name) @name) @import
    (import_from_statement
      module_name: (dotted_name) @name) @import_from
  `,
  locals: `
    ; Variable definitions
    (assignment left: (identifier) @local.definition)
    (for_statement left: (identifier) @local.definition)

    ; Function and class definitions
    (function_definition name: (identifier) @local.definition)
    (class_definition name: (identifier) @local.definition)

    ; References
    (identifier) @local.reference
  `,
} as const;

// =============================================================================
// JavaScript Queries
// =============================================================================

export const JAVASCRIPT_QUERIES = {
  functions: `
    (function_declaration
      name: (identifier) @name) @function
    (generator_function_declaration
      name: (identifier) @name) @function
    (function_expression
      name: (identifier)? @name) @function
    (arrow_function) @function
    (method_definition
      name: (property_identifier) @name) @function
  `,
  classes: `
    (class_declaration
      name: (identifier) @name) @class
    (class
      name: (identifier)? @name) @class
  `,
  calls: `
    (call_expression
      function: (identifier) @name) @call
    (call_expression
      function: (member_expression
        property: (property_identifier) @name)) @call
    (new_expression
      constructor: (identifier) @name) @call
  `,
  imports: `
    (import_statement
      source: (string) @name) @import
    (export_statement
      source: (string) @name) @import
  `,
  locals: `
    ; Variable definitions
    (variable_declarator name: (identifier) @local.definition)
    (function_declaration name: (identifier) @local.definition)
    (class_declaration name: (identifier) @local.definition)

    ; Variable references
    (identifier) @local.reference
  `,
} as const;

// =============================================================================
// TypeScript Queries
// =============================================================================

export const TYPESCRIPT_QUERIES = {
  functions: `
    (function_declaration
      name: (identifier) @name) @function
    (generator_function_declaration
      name: (identifier) @name) @function
    (function_expression
      name: (identifier)? @name) @function
    (arrow_function) @function
    (method_definition
      name: (property_identifier) @name) @function
    (function_signature
      name: (identifier) @name) @function
  `,
  classes: `
    (class_declaration
      name: (type_identifier) @name) @class
    (abstract_class_declaration
      name: (type_identifier) @name) @class
    (interface_declaration
      name: (type_identifier) @name) @class
    (enum_declaration
      name: (identifier) @name) @class
    (type_alias_declaration
      name: (type_identifier) @name) @class
  `,
  calls: `
    (call_expression
      function: (identifier) @name) @call
    (call_expression
      function: (member_expression
        property: (property_identifier) @name)) @call
    (new_expression
      constructor: (identifier) @name) @call
  `,
  imports: `
    (import_statement
      source: (string) @name) @import
    (export_statement
      source: (string) @name) @import
  `,
  locals: `
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
  `,
} as const;

// =============================================================================
// Rust Queries
// =============================================================================

export const RUST_QUERIES = {
  functions: `
    (function_item
      name: (identifier) @name) @function
    (function_signature_item
      name: (identifier) @name) @function
    (closure_expression) @function
  `,
  classes: `
    (struct_item
      name: (type_identifier) @name) @class
    (enum_item
      name: (type_identifier) @name) @class
    (union_item
      name: (type_identifier) @name) @class
    (trait_item
      name: (type_identifier) @name) @class
    (type_item
      name: (type_identifier) @name) @class
    (impl_item) @class
    (mod_item
      name: (identifier) @name) @module
  `,
  calls: `
    (call_expression
      function: (identifier) @name) @call
    (call_expression
      function: (field_expression
        field: (field_identifier) @name)) @call
    (call_expression
      function: (scoped_identifier
        "::"
        name: (identifier) @name)) @call
    (macro_invocation
      macro: (identifier) @name) @call
  `,
  imports: `
    (use_declaration
      argument: (scoped_identifier) @name) @import
    (use_declaration
      argument: (identifier) @name) @import
  `,
  locals: `
    ; Let bindings
    (let_declaration pattern: (identifier) @local.definition)

    ; Function definitions
    (function_item name: (identifier) @local.definition)

    ; References
    (identifier) @local.reference
  `,
} as const;

// =============================================================================
// Go Queries
// =============================================================================

export const GO_QUERIES = {
  functions: `
    (function_declaration
      name: (identifier) @name) @function
    (method_declaration
      name: (field_identifier) @name) @function
    (func_literal) @function
  `,
  classes: `
    (type_declaration
      (type_spec
        name: (type_identifier) @name)) @class
  `,
  calls: `
    (call_expression
      function: (identifier) @name) @call
    (call_expression
      function: (selector_expression
        field: (field_identifier) @name)) @call
  `,
  imports: `
    (import_declaration
      (import_spec
        path: (interpreted_string_literal) @name)) @import
    (import_declaration
      (import_spec_list
        (import_spec
          path: (interpreted_string_literal) @name))) @import
  `,
  locals: `
    ; Variable declarations
    (short_var_declaration left: (expression_list (identifier) @local.definition))
    (var_declaration (var_spec name: (identifier) @local.definition))

    ; Function definitions
    (function_declaration name: (identifier) @local.definition)

    ; References
    (identifier) @local.reference
  `,
} as const;

// =============================================================================
// Java Queries
// =============================================================================

export const JAVA_QUERIES = {
  functions: `
    (method_declaration
      name: (identifier) @name) @function
    (constructor_declaration
      name: (identifier) @name) @function
  `,
  classes: `
    (class_declaration
      name: (identifier) @name) @class
    (interface_declaration
      name: (identifier) @name) @class
    (enum_declaration
      name: (identifier) @name) @class
    (annotation_type_declaration
      name: (identifier) @name) @class
    (record_declaration
      name: (identifier) @name) @class
  `,
  calls: `
    (method_invocation
      name: (identifier) @name) @call
    (object_creation_expression
      type: (type_identifier) @name) @call
  `,
  imports: `
    (import_declaration
      (scoped_identifier) @name) @import
  `,
  locals: `
    ; Variable declarations
    (local_variable_declaration
      declarator: (variable_declarator
        name: (identifier) @local.definition))

    ; Method definitions
    (method_declaration name: (identifier) @local.definition)

    ; References
    (identifier) @local.reference
  `,
} as const;

// =============================================================================
// C Queries
// =============================================================================

export const C_QUERIES = {
  functions: `
    (function_definition
      declarator: (function_declarator
        declarator: (identifier) @name)) @function
    (function_definition
      declarator: (pointer_declarator
        declarator: (function_declarator
          declarator: (identifier) @name))) @function
  `,
  classes: `
    (struct_specifier
      name: (type_identifier) @name) @class
    (union_specifier
      name: (type_identifier) @name) @class
    (enum_specifier
      name: (type_identifier) @name) @class
  `,
  calls: `
    (call_expression
      function: (identifier) @name) @call
    (call_expression
      function: (field_expression
        field: (field_identifier) @name)) @call
  `,
  imports: `
    (preproc_include
      path: (string_literal) @name) @import
    (preproc_include
      path: (system_lib_string) @name) @import
  `,
  locals: `
    ; Variable declarations
    (declaration
      declarator: (init_declarator
        declarator: (identifier) @local.definition))

    ; Function definitions
    (function_definition
      declarator: (function_declarator
        declarator: (identifier) @local.definition))

    ; References
    (identifier) @local.reference
  `,
} as const;

// =============================================================================
// C++ Queries
// =============================================================================

export const CPP_QUERIES = {
  functions: `
    (function_definition
      declarator: (function_declarator
        declarator: (identifier) @name)) @function
    (function_definition
      declarator: (function_declarator
        declarator: (qualified_identifier) @name)) @function
    (field_declaration
      declarator: (function_declarator
        declarator: (field_identifier) @name)) @function
    (declaration
      declarator: (function_declarator
        declarator: (identifier) @name)) @function
    (template_declaration
      (function_definition
        declarator: (function_declarator
          declarator: (identifier) @name))) @function
    (lambda_expression) @function
  `,
  classes: `
    (class_specifier
      name: (type_identifier) @name) @class
    (struct_specifier
      name: (type_identifier) @name) @class
    (union_specifier
      name: (type_identifier) @name) @class
    (enum_specifier
      name: (type_identifier) @name) @class
    (template_declaration
      (class_specifier
        name: (type_identifier) @name)) @class
    (template_declaration
      (struct_specifier
        name: (type_identifier) @name)) @class
  `,
  calls: `
    (call_expression
      function: (identifier) @name) @call
    (call_expression
      function: (field_expression
        field: (field_identifier) @name)) @call
    (call_expression
      function: (qualified_identifier) @name) @call
    (new_expression
      type: (type_identifier) @name) @call
    (delete_expression) @call
  `,
  imports: `
    (preproc_include
      path: (string_literal) @name) @import
    (preproc_include
      path: (system_lib_string) @name) @import
  `,
  locals: `
    ; Variable declarations
    (declaration
      declarator: (init_declarator
        declarator: (identifier) @local.definition))

    ; Function definitions
    (function_definition
      declarator: (function_declarator
        declarator: (identifier) @local.definition))

    ; References
    (identifier) @local.reference
  `,
} as const;

// =============================================================================
// C# Queries
// =============================================================================

export const CSHARP_QUERIES = {
  functions: `
    (method_declaration
      name: (identifier) @name) @function
    (constructor_declaration
      name: (identifier) @name) @function
    (local_function_statement
      name: (identifier) @name) @function
    (lambda_expression) @function
  `,
  classes: `
    (class_declaration
      name: (identifier) @name) @class
    (interface_declaration
      name: (identifier) @name) @class
    (struct_declaration
      name: (identifier) @name) @class
    (enum_declaration
      name: (identifier) @name) @class
    (record_declaration
      name: (identifier) @name) @class
  `,
  calls: `
    (invocation_expression
      function: (identifier) @name) @call
    (invocation_expression
      function: (member_access_expression
        name: (identifier) @name)) @call
    (object_creation_expression
      type: (identifier) @name) @call
  `,
  imports: `
    (using_directive
      (qualified_name) @name) @import
    (using_directive
      (identifier) @name) @import
  `,
  locals: `
    ; Variable declarations
    (variable_declaration
      (variable_declarator
        (identifier) @local.definition))

    ; Method definitions
    (method_declaration name: (identifier) @local.definition)

    ; References
    (identifier) @local.reference
  `,
} as const;

// =============================================================================
// Scala Queries
// =============================================================================

export const SCALA_QUERIES = {
  functions: `
    (function_definition
      name: (identifier) @name) @function
    (val_definition
      pattern: (identifier) @name) @function
    (var_definition
      pattern: (identifier) @name) @function
  `,
  classes: `
    (class_definition
      name: (identifier) @name) @class
    (trait_definition
      name: (identifier) @name) @class
    (object_definition
      name: (identifier) @name) @class
  `,
  calls: `
    (call_expression
      function: (identifier) @name) @call
    (call_expression
      function: (field_expression
        field: (identifier) @name)) @call
    (infix_expression
      operator: (identifier) @name) @call
  `,
  imports: `
    (import_declaration
      path: (stable_identifier) @name) @import
  `,
  locals: `
    ; Value definitions
    (val_definition pattern: (identifier) @local.definition)
    (var_definition pattern: (identifier) @local.definition)

    ; Function definitions
    (function_definition name: (identifier) @local.definition)

    ; References
    (identifier) @local.reference
  `,
} as const;

// =============================================================================
// PHP Queries
// =============================================================================

export const PHP_QUERIES = {
  functions: `
    (function_definition
      name: (name) @name) @function
    (method_declaration
      name: (name) @name) @function
    (anonymous_function) @function
    (arrow_function) @function
  `,
  classes: `
    (class_declaration
      name: (name) @name) @class
    (interface_declaration
      name: (name) @name) @class
    (trait_declaration
      name: (name) @name) @class
    (enum_declaration
      name: (name) @name) @class
  `,
  calls: `
    (function_call_expression
      function: (name) @name) @call
    (function_call_expression
      function: (qualified_name) @name) @call
    (member_call_expression
      name: (name) @name) @call
    (scoped_call_expression
      name: (name) @name) @call
    (nullsafe_member_call_expression
      name: (name) @name) @call
    (object_creation_expression
      (name) @name) @call
    (object_creation_expression
      (qualified_name) @name) @call
  `,
  imports: `
    (namespace_use_declaration
      (namespace_use_clause
        (qualified_name) @name)) @import
  `,
  locals: `
    ; Variable definitions
    (variable_name) @local.definition

    ; Function definitions
    (function_definition name: (name) @local.definition)

    ; References
    (name) @local.reference
  `,
} as const;

// =============================================================================
// Lua Queries
// =============================================================================

export const LUA_QUERIES = {
  functions: `
    (function_declaration
      name: (identifier) @name) @function
    (local_function_declaration
      name: (identifier) @name) @function
    (function_definition) @function
  `,
  classes: `
    (assignment_statement
      (variable_list
        (identifier) @name)
      (expression_list
        (table_constructor))) @class
  `,
  calls: `
    (function_call
      name: (identifier) @name) @call
    (function_call
      name: (method_index
        (identifier) @name)) @call
  `,
  imports: `
    (function_call
      name: (identifier) @name
      (#eq? @name "require")
      arguments: (arguments
        (string) @import)) @import
  `,
  locals: `
    ; Local variable declarations
    (local_declaration name: (identifier) @local.definition)

    ; Function definitions
    (function_declaration name: (identifier) @local.definition)
    (local_function_declaration name: (identifier) @local.definition)

    ; References
    (identifier) @local.reference
  `,
} as const;

// =============================================================================
// Language Query Map
// =============================================================================

export interface LanguageQuerySet {
  functions: string;
  classes: string;
  calls: string;
  imports: string;
  locals: string;
}

export const LANGUAGE_QUERIES: Record<SupportedLanguage, LanguageQuerySet> = {
  [SupportedLanguage.PYTHON]: PYTHON_QUERIES,
  [SupportedLanguage.JS]: JAVASCRIPT_QUERIES,
  [SupportedLanguage.TS]: TYPESCRIPT_QUERIES,
  [SupportedLanguage.RUST]: RUST_QUERIES,
  [SupportedLanguage.GO]: GO_QUERIES,
  [SupportedLanguage.JAVA]: JAVA_QUERIES,
  [SupportedLanguage.C]: C_QUERIES,
  [SupportedLanguage.CPP]: CPP_QUERIES,
  [SupportedLanguage.CSHARP]: CSHARP_QUERIES,
  [SupportedLanguage.SCALA]: SCALA_QUERIES,
  [SupportedLanguage.PHP]: PHP_QUERIES,
  [SupportedLanguage.LUA]: LUA_QUERIES,
};

/**
 * Get the query set for a language
 */
export function getQueriesForLanguage(language: SupportedLanguage): LanguageQuerySet {
  return LANGUAGE_QUERIES[language];
}

/**
 * Get a specific query for a language
 * Falls back to auto-generated query from spec if not defined
 */
export function getQuery(
  language: SupportedLanguage,
  queryType: keyof LanguageQuerySet
): string {
  const queries = LANGUAGE_QUERIES[language];
  if (queries[queryType]) {
    return queries[queryType];
  }

  // Fallback to auto-generated query from spec
  const spec = LANGUAGE_SPECS[language];
  switch (queryType) {
    case 'functions':
      return spec.functionsQuery ?? buildQueryPattern(spec.functionNodeTypes, CAPTURE.FUNCTION);
    case 'classes':
      return spec.classesQuery ?? buildQueryPattern(spec.classNodeTypes, CAPTURE.CLASS);
    case 'calls':
      return spec.callsQuery ?? buildQueryPattern(spec.callNodeTypes, CAPTURE.CALL);
    case 'imports':
      return spec.importsQuery ?? buildQueryPattern(spec.importNodeTypes, CAPTURE.IMPORT);
    case 'locals':
      return spec.localsQuery ?? '';
    default:
      return '';
  }
}
