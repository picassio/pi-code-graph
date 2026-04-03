/**
 * Go-specific language handler
 * Created for go parsing support
 */

import type { Node as TreeSitterNode } from 'web-tree-sitter';
import type { LanguageSpec } from '../../types.js';
import { SEPARATOR_DOT, FIELD_NAME, FIELD_TYPE, FIELD_BODY } from '../../constants.js';
import { BaseLanguageHandler } from './base.js';

// =============================================================================
// Go Tree-sitter Node Types
// =============================================================================

const TS_GO_SOURCE_FILE = 'source_file';
const TS_GO_PACKAGE_CLAUSE = 'package_clause';
const TS_GO_IMPORT_DECLARATION = 'import_declaration';
const TS_GO_IMPORT_SPEC = 'import_spec';
const TS_GO_IMPORT_SPEC_LIST = 'import_spec_list';
const TS_GO_FUNCTION_DECLARATION = 'function_declaration';
const TS_GO_METHOD_DECLARATION = 'method_declaration';
const TS_GO_TYPE_DECLARATION = 'type_declaration';
const TS_GO_TYPE_SPEC = 'type_spec';
const TS_GO_STRUCT_TYPE = 'struct_type';
const TS_GO_INTERFACE_TYPE = 'interface_type';
const TS_GO_FIELD_DECLARATION = 'field_declaration';
const TS_GO_METHOD_SPEC = 'method_spec';
const TS_GO_PARAMETER_LIST = 'parameter_list';
const TS_GO_PARAMETER_DECLARATION = 'parameter_declaration';
const TS_GO_IDENTIFIER = 'identifier';
const TS_GO_BLANK_IDENTIFIER = 'blank_identifier';
const TS_GO_TYPE_IDENTIFIER = 'type_identifier';
const TS_GO_PACKAGE_IDENTIFIER = 'package_identifier';
const TS_GO_QUALIFIED_TYPE = 'qualified_type';
const TS_GO_POINTER_TYPE = 'pointer_type';
const TS_GO_CALL_EXPRESSION = 'call_expression';
const TS_GO_SELECTOR_EXPRESSION = 'selector_expression';
const TS_GO_INTERPRETED_STRING_LITERAL = 'interpreted_string_literal';
const TS_GO_RAW_STRING_LITERAL = 'raw_string_literal';
const TS_GO_COMMENT = 'comment';

// =============================================================================
// Go Language Handler
// =============================================================================

export class GoHandler extends BaseLanguageHandler {
  /**
   * Extract function name from a Go function or method declaration
   */
  override extractFunctionName(node: TreeSitterNode): string | null {
    const nameNode = node.childForFieldName(FIELD_NAME);
    if (nameNode?.text) {
      return nameNode.text;
    }
    return null;
  }

  /**
   * Build qualified name for a Go function
   * Go uses package.Function format
   */
  override buildFunctionQualifiedName(
    node: TreeSitterNode,
    moduleQn: string,
    funcName: string,
    _langConfig: LanguageSpec | null,
    _filePath: string | null,
    _repoPath: string,
    _projectName: string
  ): string {
    // For methods, include the receiver type
    if (node.type === TS_GO_METHOD_DECLARATION) {
      const receiverType = extractReceiverType(node);
      if (receiverType) {
        return `${moduleQn}${SEPARATOR_DOT}${receiverType}${SEPARATOR_DOT}${funcName}`;
      }
    }
    return `${moduleQn}${SEPARATOR_DOT}${funcName}`;
  }

  /**
   * Check if a Go function is exported (starts with uppercase)
   */
  override isFunctionExported(node: TreeSitterNode): boolean {
    const name = this.extractFunctionName(node);
    if (!name) return false;
    return isExportedName(name);
  }

  /**
   * Check if a node is a method (has a receiver)
   */
  override isClassMethod(node: TreeSitterNode): boolean {
    return node.type === TS_GO_METHOD_DECLARATION;
  }

  /**
   * Build method qualified name for Go
   */
  override buildMethodQualifiedName(
    classQn: string,
    methodName: string,
    _methodNode: TreeSitterNode
  ): string {
    return `${classQn}${SEPARATOR_DOT}${methodName}`;
  }
}

// =============================================================================
// Go Utility Functions
// =============================================================================

/**
 * Check if a Go identifier is exported (starts with uppercase)
 */
export function isExportedName(name: string): boolean {
  if (!name || name.length === 0) return false;
  const firstChar = name.charAt(0);
  return firstChar === firstChar.toUpperCase() && firstChar !== firstChar.toLowerCase();
}

/**
 * Extract package name from a Go file
 */
export function extractPackageName(sourceFile: TreeSitterNode): string | null {
  for (const child of sourceFile.children) {
    if (child.type === TS_GO_PACKAGE_CLAUSE) {
      const nameNode = child.childForFieldName(FIELD_NAME) ??
        child.children.find(c => c.type === TS_GO_PACKAGE_IDENTIFIER || c.type === TS_GO_IDENTIFIER);
      return nameNode?.text ?? null;
    }
  }
  return null;
}

/**
 * Extract imports from a Go import declaration
 */
export interface GoImport {
  path: string;
  alias: string | null;
  isBlank: boolean;  // _ import (side effects only)
  isDot: boolean;    // . import (import into current namespace)
}

export function extractImports(importNode: TreeSitterNode): GoImport[] {
  const imports: GoImport[] = [];

  if (importNode.type !== TS_GO_IMPORT_DECLARATION) {
    return imports;
  }

  const processImportSpec = (spec: TreeSitterNode): GoImport | null => {
    let path: string | null = null;
    let alias: string | null = null;
    let isBlank = false;
    let isDot = false;

    for (const child of spec.children) {
      switch (child.type) {
        case TS_GO_INTERPRETED_STRING_LITERAL:
        case TS_GO_RAW_STRING_LITERAL:
          // Remove quotes from path
          path = child.text?.replace(/^["'`]|["'`]$/g, '') ?? null;
          break;
        case TS_GO_IDENTIFIER:
        case TS_GO_PACKAGE_IDENTIFIER:
          alias = child.text ?? null;
          break;
        case TS_GO_BLANK_IDENTIFIER:
          isBlank = true;
          break;
        case 'dot':
          isDot = true;
          break;
      }
    }

    if (path) {
      return { path, alias, isBlank, isDot };
    }
    return null;
  };

  for (const child of importNode.children) {
    if (child.type === TS_GO_IMPORT_SPEC) {
      const imp = processImportSpec(child);
      if (imp) imports.push(imp);
    } else if (child.type === TS_GO_IMPORT_SPEC_LIST) {
      for (const spec of child.children) {
        if (spec.type === TS_GO_IMPORT_SPEC) {
          const imp = processImportSpec(spec);
          if (imp) imports.push(imp);
        }
      }
    }
  }

  return imports;
}

/**
 * Extract receiver type from a method declaration
 */
export function extractReceiverType(methodNode: TreeSitterNode): string | null {
  if (methodNode.type !== TS_GO_METHOD_DECLARATION) {
    return null;
  }

  const receiver = methodNode.childForFieldName('receiver');
  if (!receiver) return null;

  // Find the type in the parameter declaration
  for (const child of receiver.children) {
    if (child.type === TS_GO_PARAMETER_DECLARATION) {
      const typeNode = child.childForFieldName(FIELD_TYPE);
      if (typeNode) {
        // Handle pointer types (*Type)
        if (typeNode.type === TS_GO_POINTER_TYPE) {
          for (const grandchild of typeNode.children) {
            if (grandchild.type === TS_GO_TYPE_IDENTIFIER) {
              return grandchild.text ?? null;
            }
          }
        } else if (typeNode.type === TS_GO_TYPE_IDENTIFIER) {
          return typeNode.text ?? null;
        }
      }
    }
  }

  return null;
}

/**
 * Check if a method receiver is a pointer
 */
export function isPointerReceiver(methodNode: TreeSitterNode): boolean {
  if (methodNode.type !== TS_GO_METHOD_DECLARATION) {
    return false;
  }

  const receiver = methodNode.childForFieldName('receiver');
  if (!receiver) return false;

  for (const child of receiver.children) {
    if (child.type === TS_GO_PARAMETER_DECLARATION) {
      const typeNode = child.childForFieldName(FIELD_TYPE);
      if (typeNode?.type === TS_GO_POINTER_TYPE) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Extract function parameters
 */
export interface GoParameter {
  name: string | null;
  type: string;
  isVariadic: boolean;
}

export function extractParameters(funcNode: TreeSitterNode): GoParameter[] {
  const params: GoParameter[] = [];
  
  const paramsNode = funcNode.childForFieldName('parameters');
  if (!paramsNode) return params;

  for (const child of paramsNode.children) {
    if (child.type === TS_GO_PARAMETER_DECLARATION) {
      const typeNode = child.childForFieldName(FIELD_TYPE);
      const isVariadic = typeNode?.type === 'variadic_parameter_declaration';
      
      // Get parameter names (can be multiple names with same type)
      const names: string[] = [];
      for (const grandchild of child.children) {
        if (grandchild.type === TS_GO_IDENTIFIER) {
          if (grandchild.text) names.push(grandchild.text);
        }
      }

      const typeName = typeNode?.text ?? 'unknown';

      if (names.length > 0) {
        // Multiple names share the same type
        for (const name of names) {
          params.push({ name, type: typeName, isVariadic });
        }
      } else {
        // Anonymous parameter (just type)
        params.push({ name: null, type: typeName, isVariadic });
      }
    }
  }

  return params;
}

/**
 * Extract return types from a function
 */
export interface GoReturnType {
  name: string | null;
  type: string;
}

export function extractReturnTypes(funcNode: TreeSitterNode): GoReturnType[] {
  const returns: GoReturnType[] = [];
  
  const resultNode = funcNode.childForFieldName('result');
  if (!resultNode) return returns;

  // Single return type
  if (resultNode.type === TS_GO_TYPE_IDENTIFIER || resultNode.type === TS_GO_POINTER_TYPE) {
    returns.push({ name: null, type: resultNode.text ?? 'unknown' });
    return returns;
  }

  // Named returns or multiple returns
  if (resultNode.type === TS_GO_PARAMETER_LIST) {
    for (const child of resultNode.children) {
      if (child.type === TS_GO_PARAMETER_DECLARATION) {
        const typeNode = child.childForFieldName(FIELD_TYPE);
        
        // Get parameter names
        const names: string[] = [];
        for (const grandchild of child.children) {
          if (grandchild.type === TS_GO_IDENTIFIER) {
            if (grandchild.text) names.push(grandchild.text);
          }
        }

        const typeName = typeNode?.text ?? 'unknown';

        if (names.length > 0) {
          for (const name of names) {
            returns.push({ name, type: typeName });
          }
        } else {
          returns.push({ name: null, type: typeName });
        }
      }
    }
  }

  return returns;
}

/**
 * Extract struct fields from a struct type
 */
export interface GoStructField {
  name: string | null;
  type: string;
  tag: string | null;
  isEmbedded: boolean;
  isExported: boolean;
}

export function extractStructFields(structNode: TreeSitterNode): GoStructField[] {
  const fields: GoStructField[] = [];
  
  const body = structNode.childForFieldName('body') ?? 
    structNode.children.find(c => c.type === 'field_declaration_list');
  if (!body) return fields;

  for (const child of body.children) {
    if (child.type === TS_GO_FIELD_DECLARATION) {
      const typeNode = child.childForFieldName(FIELD_TYPE);
      
      // Check for tag
      let tag: string | null = null;
      for (const grandchild of child.children) {
        if (grandchild.type === TS_GO_INTERPRETED_STRING_LITERAL ||
            grandchild.type === TS_GO_RAW_STRING_LITERAL) {
          tag = grandchild.text?.replace(/^["'`]|["'`]$/g, '') ?? null;
        }
      }

      // Get field names
      const names: string[] = [];
      for (const grandchild of child.children) {
        if (grandchild.type === TS_GO_IDENTIFIER) {
          if (grandchild.text) names.push(grandchild.text);
        }
      }

      const typeName = typeNode?.text ?? 'unknown';

      if (names.length > 0) {
        for (const name of names) {
          fields.push({
            name,
            type: typeName,
            tag,
            isEmbedded: false,
            isExported: isExportedName(name),
          });
        }
      } else {
        // Embedded field (anonymous, type serves as name)
        fields.push({
          name: null,
          type: typeName,
          tag,
          isEmbedded: true,
          isExported: isExportedName(typeName.replace(/^\*/, '')),
        });
      }
    }
  }

  return fields;
}

/**
 * Extract interface methods from an interface type
 */
export interface GoInterfaceMethod {
  name: string;
  parameters: GoParameter[];
  returns: GoReturnType[];
  isExported: boolean;
}

export function extractInterfaceMethods(interfaceNode: TreeSitterNode): GoInterfaceMethod[] {
  const methods: GoInterfaceMethod[] = [];
  
  const body = interfaceNode.childForFieldName('body') ??
    interfaceNode.children.find(c => c.type === 'method_spec_list');
  if (!body) return methods;

  for (const child of body.children) {
    if (child.type === TS_GO_METHOD_SPEC) {
      const nameNode = child.childForFieldName(FIELD_NAME);
      const name = nameNode?.text;
      
      if (name) {
        // Extract parameters and returns from method spec
        const params: GoParameter[] = [];
        const returns: GoReturnType[] = [];

        const paramsNode = child.childForFieldName('parameters');
        if (paramsNode) {
          // Simplified parameter extraction for interface methods
          for (const grandchild of paramsNode.children) {
            if (grandchild.type === TS_GO_PARAMETER_DECLARATION) {
              const typeNode = grandchild.childForFieldName(FIELD_TYPE);
              params.push({
                name: null,
                type: typeNode?.text ?? 'unknown',
                isVariadic: false,
              });
            }
          }
        }

        const resultNode = child.childForFieldName('result');
        if (resultNode) {
          if (resultNode.type === TS_GO_TYPE_IDENTIFIER) {
            returns.push({ name: null, type: resultNode.text ?? 'unknown' });
          }
        }

        methods.push({
          name,
          parameters: params,
          returns,
          isExported: isExportedName(name),
        });
      }
    }
  }

  return methods;
}

/**
 * Extract type info from a type declaration
 */
export interface GoTypeInfo {
  name: string;
  kind: 'struct' | 'interface' | 'alias' | 'newtype';
  isExported: boolean;
}

export function extractTypeInfo(typeSpec: TreeSitterNode): GoTypeInfo | null {
  if (typeSpec.type !== TS_GO_TYPE_SPEC) return null;

  const nameNode = typeSpec.childForFieldName(FIELD_NAME);
  const name = nameNode?.text;
  if (!name) return null;

  const typeNode = typeSpec.childForFieldName(FIELD_TYPE);
  let kind: GoTypeInfo['kind'] = 'newtype';

  if (typeNode) {
    switch (typeNode.type) {
      case TS_GO_STRUCT_TYPE:
        kind = 'struct';
        break;
      case TS_GO_INTERFACE_TYPE:
        kind = 'interface';
        break;
      case TS_GO_TYPE_IDENTIFIER:
        kind = 'alias';
        break;
    }
  }

  return {
    name,
    kind,
    isExported: isExportedName(name),
  };
}

/**
 * Extract call info from a Go call expression
 */
export interface GoCallInfo {
  name: string;
  package: string | null;
  receiver: string | null;
  isMethod: boolean;
}

export function extractCallInfo(callNode: TreeSitterNode): GoCallInfo | null {
  if (callNode.type !== TS_GO_CALL_EXPRESSION) return null;

  const funcNode = callNode.childForFieldName('function');
  if (!funcNode) return null;

  if (funcNode.type === TS_GO_IDENTIFIER) {
    // Simple function call: foo()
    return {
      name: funcNode.text ?? '',
      package: null,
      receiver: null,
      isMethod: false,
    };
  } else if (funcNode.type === TS_GO_SELECTOR_EXPRESSION) {
    // Could be pkg.Function() or obj.Method()
    const operandNode = funcNode.childForFieldName('operand');
    const fieldNode = funcNode.childForFieldName('field');

    const operand = operandNode?.text ?? null;
    const name = fieldNode?.text ?? '';

    // Heuristic: if operand starts with lowercase, it's likely a package
    // if it starts with uppercase, it's likely a type/receiver
    const isPackage = operand && operand.length > 0 &&
      operand.charAt(0) === operand.charAt(0).toLowerCase();

    return {
      name,
      package: isPackage ? operand : null,
      receiver: isPackage ? null : operand,
      isMethod: !isPackage,
    };
  }

  return null;
}

/**
 * Extract docstring/comment from a Go function or type
 */
export function extractDocstring(node: TreeSitterNode): string | null {
  // In Go, doc comments are the comments immediately preceding a declaration
  let sibling = node.previousNamedSibling;
  const comments: string[] = [];

  while (sibling && sibling.type === TS_GO_COMMENT) {
    const text = sibling.text;
    if (text) {
      // Remove comment markers
      let cleanText = text;
      if (text.startsWith('//')) {
        cleanText = text.substring(2).trim();
      } else if (text.startsWith('/*') && text.endsWith('*/')) {
        cleanText = text.slice(2, -2).trim();
      }
      comments.unshift(cleanText);
    }
    sibling = sibling.previousNamedSibling;
  }

  return comments.length > 0 ? comments.join('\n') : null;
}
