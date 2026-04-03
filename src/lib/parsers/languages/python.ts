/**
 * Python-specific language handler
 * Ported from codebase_rag/parsers/handlers/python.py
 */

import type { Node as TreeSitterNode } from 'web-tree-sitter';
import type { LanguageSpec } from '../../types.js';
import { BaseLanguageHandler } from './base.js';

// =============================================================================
// Python Tree-sitter Node Types
// =============================================================================

const TS_PY_DECORATED_DEFINITION = 'decorated_definition';
const TS_PY_DECORATOR = 'decorator';
const TS_PY_FUNCTION_DEFINITION = 'function_definition';
const TS_PY_CLASS_DEFINITION = 'class_definition';
const TS_PY_ASYNC_FUNCTION_DEFINITION = 'async_function_definition';

// =============================================================================
// Python Language Handler
// =============================================================================

export class PythonHandler extends BaseLanguageHandler {
  /**
   * Extract decorators from a Python function or class node
   * 
   * Python decorators are siblings within a decorated_definition node:
   * ```
   * decorated_definition
   *   decorator: @decorator1
   *   decorator: @decorator2
   *   function_definition or class_definition
   * ```
   */
  override extractDecorators(node: TreeSitterNode): string[] {
    // The actual function/class is inside a decorated_definition
    if (!node.parent || node.parent.type !== TS_PY_DECORATED_DEFINITION) {
      return [];
    }

    const decorators: string[] = [];
    for (const child of node.parent.children) {
      if (child.type === TS_PY_DECORATOR && child.text) {
        decorators.push(child.text);
      }
    }
    return decorators;
  }

  /**
   * Check if a node is a class method in Python
   */
  override isClassMethod(node: TreeSitterNode): boolean {
    let current = node.parent;
    while (current) {
      if (current.type === TS_PY_CLASS_DEFINITION) {
        return true;
      }
      // Stop at module level
      if (current.type === 'module') {
        return false;
      }
      current = current.parent;
    }
    return false;
  }

  /**
   * Extract function name, handling async functions
   */
  override extractFunctionName(node: TreeSitterNode): string | null {
    // Handle both regular and async function definitions
    if (
      node.type === TS_PY_FUNCTION_DEFINITION ||
      node.type === TS_PY_ASYNC_FUNCTION_DEFINITION
    ) {
      const nameNode = node.childForFieldName('name');
      if (nameNode?.text) {
        return nameNode.text;
      }
    }
    return super.extractFunctionName(node);
  }
}

// =============================================================================
// Python Utility Functions
// =============================================================================

/**
 * Check if a Python function is a dunder method (magic method)
 */
export function isDunderMethod(name: string): boolean {
  return name.startsWith('__') && name.endsWith('__');
}

/**
 * Check if a Python function is a private method
 */
export function isPrivateMethod(name: string): boolean {
  return name.startsWith('_') && !name.startsWith('__');
}

/**
 * Check if a Python class has __init__ method
 */
export function hasInitMethod(classNode: TreeSitterNode): boolean {
  const body = classNode.childForFieldName('body');
  if (!body) return false;

  for (const child of body.children) {
    if (
      (child.type === TS_PY_FUNCTION_DEFINITION ||
        child.type === TS_PY_ASYNC_FUNCTION_DEFINITION) &&
      child.childForFieldName('name')?.text === '__init__'
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Extract base classes from a Python class definition
 */
export function extractPythonBaseClasses(classNode: TreeSitterNode): string[] {
  const baseClasses: string[] = [];
  const superclassNode = classNode.childForFieldName('superclasses');
  
  if (!superclassNode) return baseClasses;

  // argument_list contains the base classes
  for (const child of superclassNode.children) {
    // Skip punctuation (parentheses, commas)
    if (child.type === '(' || child.type === ')' || child.type === ',') {
      continue;
    }
    
    if (child.type === 'identifier' || child.type === 'attribute') {
      if (child.text) {
        baseClasses.push(child.text);
      }
    }
  }
  
  return baseClasses;
}

/**
 * Extract docstring from a Python function or class
 */
export function extractPythonDocstring(node: TreeSitterNode): string | null {
  const body = node.childForFieldName('body');
  if (!body) return null;

  // In Python, docstring is the first statement in the body
  // and must be an expression_statement containing a string
  for (const child of body.children) {
    if (child.type === 'expression_statement') {
      const stringNode = child.firstChild;
      if (
        stringNode &&
        (stringNode.type === 'string' || stringNode.type === 'concatenated_string')
      ) {
        const text = stringNode.text;
        if (text) {
          // Remove quotes and clean up
          return cleanPythonDocstring(text);
        }
      }
    }
    // If first statement is not a docstring, there's no docstring
    break;
  }
  return null;
}

/**
 * Clean up a Python docstring by removing quotes
 */
function cleanPythonDocstring(docstring: string): string {
  // Remove triple quotes (''' or """)
  if (docstring.startsWith('"""') || docstring.startsWith("'''")) {
    docstring = docstring.slice(3, -3);
  }
  // Remove single quotes (' or ")
  else if (docstring.startsWith('"') || docstring.startsWith("'")) {
    docstring = docstring.slice(1, -1);
  }
  return docstring.trim();
}

/**
 * Extract parameter names from a Python function
 */
export function extractPythonParameters(funcNode: TreeSitterNode): string[] {
  const params: string[] = [];
  const paramsNode = funcNode.childForFieldName('parameters');
  
  if (!paramsNode) return params;

  for (const child of paramsNode.children) {
    switch (child.type) {
      case 'identifier':
        if (child.text) params.push(child.text);
        break;
      case 'default_parameter':
      case 'typed_parameter':
      case 'typed_default_parameter': {
        const nameNode = child.childForFieldName('name');
        if (nameNode?.text) params.push(nameNode.text);
        break;
      }
      case 'list_splat_pattern':  // *args
      case 'dictionary_splat_pattern':  // **kwargs
        if (child.text) params.push(child.text);
        break;
    }
  }

  return params;
}

/**
 * Check if a Python function is async
 */
export function isPythonAsyncFunction(funcNode: TreeSitterNode): boolean {
  return funcNode.type === TS_PY_ASYNC_FUNCTION_DEFINITION;
}

/**
 * Extract imports from a Python import statement
 */
export function extractPythonImports(
  importNode: TreeSitterNode
): Map<string, string> {
  const imports = new Map<string, string>();

  if (importNode.type === 'import_statement') {
    // import foo, bar as baz
    for (const child of importNode.children) {
      if (child.type === 'dotted_name') {
        const name = child.text;
        if (name) {
          imports.set(name, name);
        }
      } else if (child.type === 'aliased_import') {
        const nameNode = child.childForFieldName('name');
        const aliasNode = child.childForFieldName('alias');
        const name = nameNode?.text;
        const alias = aliasNode?.text;
        if (name) {
          imports.set(alias ?? name, name);
        }
      }
    }
  } else if (importNode.type === 'import_from_statement') {
    // from foo import bar, baz as qux
    const moduleNode = importNode.childForFieldName('module_name');
    const moduleName = moduleNode?.text ?? '';

    for (const child of importNode.children) {
      if (child.type === 'dotted_name') {
        // The imported names (after 'import')
        const name = child.text;
        if (name && name !== moduleName) {
          const fullPath = moduleName ? `${moduleName}.${name}` : name;
          imports.set(name, fullPath);
        }
      } else if (child.type === 'aliased_import') {
        const nameNode = child.childForFieldName('name');
        const aliasNode = child.childForFieldName('alias');
        const name = nameNode?.text;
        const alias = aliasNode?.text;
        if (name) {
          const fullPath = moduleName ? `${moduleName}.${name}` : name;
          imports.set(alias ?? name, fullPath);
        }
      } else if (child.type === 'wildcard_import') {
        // from foo import *
        imports.set(`*${moduleName}`, moduleName);
      }
    }
  }

  return imports;
}

/**
 * Extract method calls from a Python call expression
 */
export interface PythonCallInfo {
  name: string;
  object: string | null;
  isMethod: boolean;
}

export function extractPythonCallInfo(
  callNode: TreeSitterNode
): PythonCallInfo | null {
  if (callNode.type !== 'call') return null;

  const funcNode = callNode.childForFieldName('function');
  if (!funcNode) return null;

  if (funcNode.type === 'identifier') {
    // Simple function call: foo()
    return {
      name: funcNode.text ?? '',
      object: null,
      isMethod: false,
    };
  } else if (funcNode.type === 'attribute') {
    // Method call: obj.method()
    const objectNode = funcNode.childForFieldName('object');
    const attrNode = funcNode.childForFieldName('attribute');
    return {
      name: attrNode?.text ?? '',
      object: objectNode?.text ?? null,
      isMethod: true,
    };
  }

  return null;
}
