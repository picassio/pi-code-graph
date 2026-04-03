/**
 * TypeScript/JavaScript-specific language handler
 * Ported from codebase_rag/parsers/handlers/js_ts.py
 */

import type { Node as TreeSitterNode } from 'web-tree-sitter';
import type { LanguageSpec } from '../../types.js';
import { SEPARATOR_DOT, FIELD_NAME } from '../../constants.js';
import { BaseLanguageHandler } from './base.js';

// =============================================================================
// TypeScript/JavaScript Tree-sitter Node Types
// =============================================================================

const TS_DECORATOR = 'decorator';
const TS_OBJECT = 'object';
const TS_METHOD_DEFINITION = 'method_definition';
const TS_CLASS_BODY = 'class_body';
const TS_PROGRAM = 'program';
const TS_MODULE = 'module';
const TS_FUNCTION_DECLARATION = 'function_declaration';
const TS_FUNCTION_EXPRESSION = 'function_expression';
const TS_ARROW_FUNCTION = 'arrow_function';
const TS_GENERATOR_FUNCTION_DECLARATION = 'generator_function_declaration';
const TS_VARIABLE_DECLARATOR = 'variable_declarator';
const TS_IDENTIFIER = 'identifier';
const TS_CLASS_DECLARATION = 'class_declaration';
const TS_CLASS = 'class';

// =============================================================================
// TypeScript/JavaScript Language Handler
// =============================================================================

export class TypeScriptHandler extends BaseLanguageHandler {
  /**
   * Extract decorators from a TypeScript/JavaScript node
   * 
   * TS decorators are direct children of the decorated element:
   * ```
   * class_declaration
   *   decorator: @decorator1
   *   decorator: @decorator2
   *   name: identifier
   *   body: class_body
   * ```
   */
  override extractDecorators(node: TreeSitterNode): string[] {
    const decorators: string[] = [];
    for (const child of node.children) {
      if (child.type === TS_DECORATOR && child.text) {
        decorators.push(child.text);
      }
    }
    return decorators;
  }

  /**
   * Check if a function is inside a method that contains object literals
   * This is specific to JS patterns like:
   * ```
   * class Foo {
   *   bar() {
   *     return { baz: () => {} }
   *   }
   * }
   * ```
   */
  override isInsideMethodWithObjectLiterals(node: TreeSitterNode): boolean {
    let current = node.parent;
    let foundObject = false;

    while (current) {
      if (current.type === TS_OBJECT) {
        foundObject = true;
      } else if (current.type === TS_METHOD_DEFINITION && foundObject) {
        return true;
      } else if (current.type === TS_CLASS_BODY) {
        break;
      }
      current = current.parent;
    }

    return false;
  }

  /**
   * Check if a function node is a class method
   */
  override isClassMethod(node: TreeSitterNode): boolean {
    let current = node.parent;
    while (current) {
      if (current.type === TS_CLASS_BODY) {
        return true;
      }
      if (current.type === TS_PROGRAM || current.type === TS_MODULE) {
        return false;
      }
      current = current.parent;
    }
    return false;
  }

  /**
   * Check if an export statement is inside a function
   */
  override isExportInsideFunction(node: TreeSitterNode): boolean {
    let current = node.parent;
    while (current) {
      if (
        current.type === TS_FUNCTION_DECLARATION ||
        current.type === TS_FUNCTION_EXPRESSION ||
        current.type === TS_ARROW_FUNCTION ||
        current.type === TS_METHOD_DEFINITION
      ) {
        return true;
      }
      if (current.type === TS_PROGRAM || current.type === TS_MODULE) {
        return false;
      }
      current = current.parent;
    }
    return false;
  }

  /**
   * Extract function name, handling arrow functions assigned to variables
   */
  override extractFunctionName(node: TreeSitterNode): string | null {
    // Try standard name field first
    const nameNode = node.childForFieldName(FIELD_NAME);
    if (nameNode?.text) {
      return nameNode.text;
    }

    // Handle arrow functions assigned to variables
    if (node.type === TS_ARROW_FUNCTION) {
      let current = node.parent;
      while (current) {
        if (current.type === TS_VARIABLE_DECLARATOR) {
          for (const child of current.children) {
            if (child.type === TS_IDENTIFIER && child.text) {
              return child.text;
            }
          }
        }
        current = current.parent;
      }
    }

    return null;
  }

  /**
   * Build nested function qualified name for JS/TS
   */
  override buildNestedFunctionQn(
    funcNode: TreeSitterNode,
    moduleQn: string,
    funcName: string,
    langConfig: LanguageSpec
  ): string | null {
    const pathParts = this._collectJsAncestorPathParts(funcNode, langConfig);
    if (pathParts === null) {
      return null;
    }
    return this._formatNestedQn(moduleQn, pathParts, funcName);
  }

  // ===========================================================================
  // Private Helper Methods
  // ===========================================================================

  private _collectJsAncestorPathParts(
    funcNode: TreeSitterNode,
    langConfig: LanguageSpec
  ): string[] | null {
    const pathParts: string[] = [];
    let current = funcNode.parent;

    while (current && !langConfig.moduleNodeTypes.includes(current.type)) {
      if (langConfig.functionNodeTypes.includes(current.type)) {
        const name = this._extractNodeName(current) ?? this.extractFunctionName(current);
        if (name) {
          pathParts.push(name);
        }
      } else if (langConfig.classNodeTypes.includes(current.type)) {
        // If inside an object literal within a method, continue
        if (!this.isInsideMethodWithObjectLiterals(funcNode)) {
          return null;
        }
        const name = this._extractNodeName(current);
        if (name) {
          pathParts.push(name);
        }
      } else if (current.type === TS_METHOD_DEFINITION) {
        const name = this._extractNodeName(current);
        if (name) {
          pathParts.push(name);
        }
      }
      current = current.parent;
    }

    pathParts.reverse();
    return pathParts;
  }
}

// =============================================================================
// TypeScript/JavaScript Utility Functions
// =============================================================================

/**
 * Check if a node represents an exported function/class
 */
export function isExported(node: TreeSitterNode): boolean {
  // Check if parent is an export statement
  const parent = node.parent;
  if (!parent) return false;

  if (
    parent.type === 'export_statement' ||
    parent.type === 'export_declaration'
  ) {
    return true;
  }

  // Check for 'export' keyword as sibling
  for (const child of parent.children) {
    if (child === node) break;
    if (child.type === 'export' || child.text === 'export') {
      return true;
    }
  }

  return false;
}

/**
 * Check if a function is async
 */
export function isAsyncFunction(node: TreeSitterNode): boolean {
  // Check for 'async' keyword as first child or field
  for (const child of node.children) {
    if (child.type === 'async' || child.text === 'async') {
      return true;
    }
    // Stop after seeing a significant node
    if (child.type === TS_IDENTIFIER || child.type === 'formal_parameters') {
      break;
    }
  }
  return false;
}

/**
 * Check if a function is a generator function
 */
export function isGeneratorFunction(node: TreeSitterNode): boolean {
  return (
    node.type === TS_GENERATOR_FUNCTION_DECLARATION ||
    node.type === 'generator_function'
  );
}

/**
 * Extract base classes from a JS/TS class declaration
 */
export function extractBaseClasses(classNode: TreeSitterNode): string[] {
  const baseClasses: string[] = [];
  
  // Check for 'extends' clause
  for (const child of classNode.children) {
    if (child.type === 'class_heritage' || child.type === 'extends_clause') {
      // Find the extended class name
      for (const heritageChild of child.children) {
        if (
          heritageChild.type === TS_IDENTIFIER ||
          heritageChild.type === 'type_identifier' ||
          heritageChild.type === 'member_expression'
        ) {
          if (heritageChild.text) {
            baseClasses.push(heritageChild.text);
          }
        }
      }
    }
  }

  return baseClasses;
}

/**
 * Extract interfaces from a TypeScript class declaration
 */
export function extractImplementedInterfaces(classNode: TreeSitterNode): string[] {
  const interfaces: string[] = [];

  for (const child of classNode.children) {
    if (child.type === 'implements_clause') {
      for (const implChild of child.children) {
        if (
          implChild.type === 'type_identifier' ||
          implChild.type === 'generic_type'
        ) {
          if (implChild.type === 'generic_type') {
            // Extract name from generic type: Interface<T>
            const nameNode = implChild.childForFieldName('name');
            if (nameNode?.text) {
              interfaces.push(nameNode.text);
            }
          } else if (implChild.text) {
            interfaces.push(implChild.text);
          }
        }
      }
    }
  }

  return interfaces;
}

/**
 * Extract function parameters with their types (TypeScript)
 */
export interface TsParameter {
  name: string;
  type: string | null;
  optional: boolean;
  hasDefault: boolean;
}

export function extractParameters(funcNode: TreeSitterNode): TsParameter[] {
  const params: TsParameter[] = [];
  const paramsNode = funcNode.childForFieldName('parameters');
  
  if (!paramsNode) return params;

  for (const child of paramsNode.children) {
    switch (child.type) {
      case 'required_parameter':
      case 'optional_parameter': {
        const nameNode = child.childForFieldName('pattern') ?? 
                        child.childForFieldName('name');
        const typeNode = child.childForFieldName('type');
        const valueNode = child.childForFieldName('value');
        
        if (nameNode?.text) {
          params.push({
            name: nameNode.text,
            type: typeNode?.text ?? null,
            optional: child.type === 'optional_parameter',
            hasDefault: valueNode !== null,
          });
        }
        break;
      }
      case 'rest_pattern':
      case 'rest_parameter': {
        const nameNode = child.children.find(c => c.type === TS_IDENTIFIER);
        if (nameNode?.text) {
          params.push({
            name: `...${nameNode.text}`,
            type: null,
            optional: false,
            hasDefault: false,
          });
        }
        break;
      }
      case TS_IDENTIFIER:
        // Simple parameter (JavaScript)
        if (child.text) {
          params.push({
            name: child.text,
            type: null,
            optional: false,
            hasDefault: false,
          });
        }
        break;
    }
  }

  return params;
}

/**
 * Extract return type from a TypeScript function
 */
export function extractReturnType(funcNode: TreeSitterNode): string | null {
  const returnType = funcNode.childForFieldName('return_type');
  return returnType?.text ?? null;
}

/**
 * Extract imports from a JS/TS import statement
 */
export interface JsImport {
  localName: string;
  importedName: string;
  modulePath: string;
  isDefault: boolean;
  isNamespace: boolean;
}

export function extractImports(importNode: TreeSitterNode): JsImport[] {
  const imports: JsImport[] = [];
  
  if (importNode.type !== 'import_statement') return imports;

  // Get the module path (source)
  const sourceNode = importNode.childForFieldName('source');
  const modulePath = sourceNode?.text?.replace(/['"]/g, '') ?? '';

  for (const child of importNode.children) {
    switch (child.type) {
      case 'import_clause': {
        // Default import: import foo from 'module'
        const defaultImport = child.children.find(c => c.type === TS_IDENTIFIER);
        if (defaultImport?.text) {
          imports.push({
            localName: defaultImport.text,
            importedName: 'default',
            modulePath,
            isDefault: true,
            isNamespace: false,
          });
        }

        // Named imports: import { foo, bar as baz } from 'module'
        const namedImports = child.children.find(c => c.type === 'named_imports');
        if (namedImports) {
          for (const spec of namedImports.children) {
            if (spec.type === 'import_specifier') {
              const nameNode = spec.childForFieldName('name');
              const aliasNode = spec.childForFieldName('alias');
              const importedName = nameNode?.text ?? '';
              const localName = aliasNode?.text ?? importedName;
              
              if (importedName) {
                imports.push({
                  localName,
                  importedName,
                  modulePath,
                  isDefault: false,
                  isNamespace: false,
                });
              }
            }
          }
        }

        // Namespace import: import * as foo from 'module'
        const namespaceImport = child.children.find(c => c.type === 'namespace_import');
        if (namespaceImport) {
          const aliasNode = namespaceImport.children.find(c => c.type === TS_IDENTIFIER);
          if (aliasNode?.text) {
            imports.push({
              localName: aliasNode.text,
              importedName: '*',
              modulePath,
              isDefault: false,
              isNamespace: true,
            });
          }
        }
        break;
      }
    }
  }

  return imports;
}

/**
 * Extract exports from a JS/TS export statement
 */
export interface JsExport {
  localName: string;
  exportedName: string;
  isDefault: boolean;
  isReExport: boolean;
  sourceModule: string | null;
}

export function extractExports(exportNode: TreeSitterNode): JsExport[] {
  const exports: JsExport[] = [];

  if (!exportNode.type.startsWith('export')) return exports;

  // Check for re-export source
  const sourceNode = exportNode.childForFieldName('source');
  const sourceModule = sourceNode?.text?.replace(/['"]/g, '') ?? null;

  // Default export
  if (exportNode.type === 'export_statement') {
    for (const child of exportNode.children) {
      if (child.type === 'export_clause') {
        // Named exports: export { foo, bar as baz }
        for (const spec of child.children) {
          if (spec.type === 'export_specifier') {
            const nameNode = spec.childForFieldName('name');
            const aliasNode = spec.childForFieldName('alias');
            const localName = nameNode?.text ?? '';
            const exportedName = aliasNode?.text ?? localName;

            if (localName) {
              exports.push({
                localName,
                exportedName,
                isDefault: false,
                isReExport: sourceModule !== null,
                sourceModule,
              });
            }
          }
        }
      } else if (child.text === 'default') {
        // Default export found
        continue;
      } else if (
        child.type === TS_FUNCTION_DECLARATION ||
        child.type === TS_CLASS_DECLARATION ||
        child.type === TS_IDENTIFIER
      ) {
        const name = child.childForFieldName('name')?.text ?? child.text;
        if (name) {
          // Check if previous sibling was 'default'
          const isDefault = exportNode.children.some(
            c => c.text === 'default' && c.startIndex < child.startIndex
          );
          exports.push({
            localName: name,
            exportedName: isDefault ? 'default' : name,
            isDefault,
            isReExport: false,
            sourceModule: null,
          });
        }
      }
    }
  }

  return exports;
}

/**
 * Extract method call information from a JS/TS call expression
 */
export interface JsCallInfo {
  name: string;
  object: string | null;
  isMethod: boolean;
  isOptionalChain: boolean;
}

export function extractCallInfo(callNode: TreeSitterNode): JsCallInfo | null {
  if (callNode.type !== 'call_expression') return null;

  const funcNode = callNode.childForFieldName('function');
  if (!funcNode) return null;

  let isOptionalChain = false;

  if (funcNode.type === TS_IDENTIFIER) {
    // Simple function call: foo()
    return {
      name: funcNode.text ?? '',
      object: null,
      isMethod: false,
      isOptionalChain: false,
    };
  } else if (
    funcNode.type === 'member_expression' ||
    funcNode.type === 'optional_chain_expression'
  ) {
    // Method call: obj.method() or obj?.method()
    isOptionalChain = funcNode.type === 'optional_chain_expression';
    const actualExpr = isOptionalChain
      ? funcNode.children.find(c => c.type === 'member_expression') ?? funcNode
      : funcNode;

    const objectNode = actualExpr.childForFieldName('object');
    const propertyNode = actualExpr.childForFieldName('property');
    
    return {
      name: propertyNode?.text ?? '',
      object: objectNode?.text ?? null,
      isMethod: true,
      isOptionalChain,
    };
  }

  return null;
}

/**
 * Check if a call is to a built-in method
 */
export function isBuiltinCall(name: string, object: string | null): boolean {
  const builtinTypes = new Set([
    'Array', 'Object', 'String', 'Number', 'Date', 'RegExp',
    'Function', 'Map', 'Set', 'Promise', 'Error', 'Boolean',
    'JSON', 'Math', 'console',
  ]);

  if (object && builtinTypes.has(object)) {
    return true;
  }

  const builtinFunctions = new Set([
    'parseInt', 'parseFloat', 'isNaN', 'isFinite',
    'encodeURIComponent', 'decodeURIComponent',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    'require', 'import',
  ]);

  return builtinFunctions.has(name);
}
