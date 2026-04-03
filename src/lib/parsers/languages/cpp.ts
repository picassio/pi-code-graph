/**
 * C/C++-specific language handler
 * Ported from codebase_rag/parsers/handlers/cpp.py and codebase_rag/parsers/cpp/utils.py
 */

import type { Node as TreeSitterNode } from 'web-tree-sitter';
import type { LanguageSpec } from '../../types.js';
import {
  SEPARATOR_DOT,
  FIELD_NAME,
  FIELD_DECLARATOR,
  CPP_MODULE_PATH_MARKERS,
  CPP_MODULE_EXTENSIONS,
  CPP_OPERATOR_SYMBOL_MAP,
  CPP_FALLBACK_OPERATOR,
  CPP_FALLBACK_DESTRUCTOR,
  CPP_OPERATOR_TEXT_PREFIX,
  CPP_DESTRUCTOR_PREFIX,
} from '../../constants.js';
import { BaseLanguageHandler } from './base.js';

// =============================================================================
// C++ Tree-sitter Node Types
// =============================================================================

const TS_TRANSLATION_UNIT = 'translation_unit';
const TS_NAMESPACE_DEFINITION = 'namespace_definition';
const TS_NAMESPACE_IDENTIFIER = 'namespace_identifier';
const TS_IDENTIFIER = 'identifier';
const TS_EXPORT = 'export';
const TS_EXPORT_KEYWORD = 'export_keyword';
const TS_PRIMITIVE_TYPE = 'primitive_type';
const TS_DECLARATION = 'declaration';
const TS_FUNCTION_DEFINITION = 'function_definition';
const TS_TEMPLATE_DECLARATION = 'template_declaration';
const TS_CLASS_SPECIFIER = 'class_specifier';
const TS_FUNCTION_DECLARATOR = 'function_declarator';
const TS_POINTER_DECLARATOR = 'pointer_declarator';
const TS_REFERENCE_DECLARATOR = 'reference_declarator';
const TS_FIELD_DECLARATION = 'field_declaration';
const TS_FIELD_IDENTIFIER = 'field_identifier';
const TS_QUALIFIED_IDENTIFIER = 'qualified_identifier';
const TS_OPERATOR_NAME = 'operator_name';
const TS_DESTRUCTOR_NAME = 'destructor_name';
const TS_CONSTRUCTOR_OR_DESTRUCTOR_DEFINITION = 'constructor_or_destructor_definition';
const TS_CONSTRUCTOR_OR_DESTRUCTOR_DECLARATION = 'constructor_or_destructor_declaration';
const TS_INLINE_METHOD_DEFINITION = 'inline_method_definition';
const TS_OPERATOR_CAST_DEFINITION = 'operator_cast_definition';
const TS_LAMBDA_EXPRESSION = 'lambda_expression';
const TS_TEMPLATE_TYPE = 'template_type';
const TS_TYPE_IDENTIFIER = 'type_identifier';

// =============================================================================
// C++ Language Handler
// =============================================================================

export class CppHandler extends BaseLanguageHandler {
  /**
   * Extract function name from C++ node
   */
  override extractFunctionName(node: TreeSitterNode): string | null {
    const funcName = extractFunctionName(node);
    if (funcName) return funcName;

    // Handle lambda expressions
    if (node.type === TS_LAMBDA_EXPRESSION) {
      return `lambda_${node.startPosition.row}_${node.startPosition.column}`;
    }

    return null;
  }

  /**
   * Build qualified name for a C++ function
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
    return buildQualifiedName(node, moduleQn, funcName);
  }

  /**
   * Check if a C++ function is exported (C++20 modules)
   */
  override isFunctionExported(node: TreeSitterNode): boolean {
    return isExported(node);
  }

  /**
   * Extract base class name, handling template types
   */
  override extractBaseClassName(baseNode: TreeSitterNode): string | null {
    if (baseNode.type === TS_TEMPLATE_TYPE) {
      const nameNode = baseNode.childForFieldName(FIELD_NAME);
      if (nameNode?.text) {
        return nameNode.text;
      }
    }

    return baseNode.text ?? null;
  }

  /**
   * Extract decorators (C++ attributes)
   */
  override extractDecorators(node: TreeSitterNode): string[] {
    const decorators: string[] = [];
    
    // C++ attributes appear as siblings before the node
    let sibling = node.previousNamedSibling;
    while (sibling && sibling.type === 'attribute_declaration') {
      if (sibling.text) {
        decorators.push(sibling.text);
      }
      sibling = sibling.previousNamedSibling;
    }

    return decorators.reverse();
  }
}

// =============================================================================
// C++ Utility Functions
// =============================================================================

/**
 * Convert operator symbol to name
 */
export function convertOperatorSymbolToName(symbol: string): string {
  const mapped = CPP_OPERATOR_SYMBOL_MAP[symbol];
  if (mapped) return mapped;

  // Fallback: create name from symbol
  return `operator_${symbol.replace(/\s+/g, '_')}`;
}

/**
 * Build qualified name for a C++ function
 */
export function buildQualifiedName(
  node: TreeSitterNode,
  moduleQn: string,
  name: string
): string {
  const moduleParts = moduleQn.split(SEPARATOR_DOT);

  // Check if this is a C++20 module file
  const isModuleFile = moduleParts.length >= 3 && (
    CPP_MODULE_PATH_MARKERS.has(moduleParts.join('/')) ||
    moduleParts.some(part => 
      CPP_MODULE_EXTENSIONS.some(ext => part.endsWith(ext))
    )
  );

  if (isModuleFile) {
    const projectName = moduleParts[0];
    const filename = moduleParts[moduleParts.length - 1];
    return [projectName, filename, name].join(SEPARATOR_DOT);
  }

  // Build path from namespace hierarchy
  const pathParts: string[] = [];
  let current = node.parent;

  while (current && current.type !== TS_TRANSLATION_UNIT) {
    if (current.type === TS_NAMESPACE_DEFINITION) {
      let namespaceName: string | null = null;
      
      const nameNode = current.childForFieldName('name');
      if (nameNode?.text) {
        namespaceName = nameNode.text;
      } else {
        // Look for identifier in children
        for (const child of current.children) {
          if (
            (child.type === TS_NAMESPACE_IDENTIFIER || child.type === TS_IDENTIFIER) &&
            child.text
          ) {
            namespaceName = child.text;
            break;
          }
        }
      }
      
      if (namespaceName) {
        pathParts.push(namespaceName);
      }
    }
    current = current.parent;
  }

  pathParts.reverse();

  if (pathParts.length > 0) {
    return [moduleQn, ...pathParts, name].join(SEPARATOR_DOT);
  }
  return [moduleQn, name].join(SEPARATOR_DOT);
}

/**
 * Check if a C++ node is exported
 */
export function isExported(node: TreeSitterNode): boolean {
  let current: TreeSitterNode | null = node;
  
  while (current && current.parent) {
    const parent: TreeSitterNode = current.parent;
    let foundExport = false;

    // Check siblings before current node
    for (const child of parent.children) {
      if (child === current) break;
      
      if (child.text) {
        const childText = child.text;
        if (
          childText === 'export' &&
          (child.type === TS_EXPORT ||
            child.type === TS_EXPORT_KEYWORD ||
            child.type === TS_IDENTIFIER ||
            child.type === TS_PRIMITIVE_TYPE)
        ) {
          foundExport = true;
        }
      }
    }

    if (foundExport) return true;

    // Stop at certain node types
    if (
      current.type === TS_DECLARATION ||
      current.type === TS_FUNCTION_DEFINITION ||
      current.type === TS_TEMPLATE_DECLARATION ||
      current.type === TS_CLASS_SPECIFIER ||
      current.type === TS_TRANSLATION_UNIT
    ) {
      break;
    }
    
    current = current.parent;
  }

  return false;
}

/**
 * Extract exported class name
 */
export function extractExportedClassName(classNode: TreeSitterNode): string | null {
  for (const child of classNode.children) {
    if (child.type === TS_IDENTIFIER && child.text) {
      return child.text;
    }
  }
  return null;
}

/**
 * Extract operator name from operator_name node
 */
export function extractOperatorName(operatorNode: TreeSitterNode): string {
  if (!operatorNode.text) return CPP_FALLBACK_OPERATOR;

  const operatorText = operatorNode.text.trim();

  if (operatorText.startsWith(CPP_OPERATOR_TEXT_PREFIX)) {
    const symbol = operatorText.substring(CPP_OPERATOR_TEXT_PREFIX.length).trim();
    return convertOperatorSymbolToName(symbol);
  }

  return CPP_FALLBACK_OPERATOR;
}

/**
 * Extract destructor name
 */
export function extractDestructorName(destructorNode: TreeSitterNode): string {
  for (const child of destructorNode.children) {
    if (child.type === TS_IDENTIFIER && child.text) {
      return `${CPP_DESTRUCTOR_PREFIX}${child.text}`;
    }
  }
  return CPP_FALLBACK_DESTRUCTOR;
}

/**
 * Find function declarator and extract name
 */
function findFunctionDeclaratorName(node: TreeSitterNode): string | null {
  if (node.type === TS_FUNCTION_DECLARATOR) {
    return extractFunctionName(node);
  }

  for (const child of node.children) {
    if (
      child.type === TS_POINTER_DECLARATOR ||
      child.type === TS_REFERENCE_DECLARATOR ||
      child.type === TS_FUNCTION_DECLARATOR
    ) {
      const result = findFunctionDeclaratorName(child);
      if (result) return result;
    }
  }
  return null;
}

/**
 * Extract function name from a function definition
 */
function extractNameFromFunctionDefinition(funcNode: TreeSitterNode): string | null {
  return findFunctionDeclaratorName(funcNode);
}

/**
 * Extract function name from a declaration
 */
function extractNameFromDeclaration(funcNode: TreeSitterNode): string | null {
  for (const child of funcNode.children) {
    if (child.type === TS_FUNCTION_DECLARATOR) {
      return extractFunctionName(child);
    }
  }
  return null;
}

/**
 * Extract function name from a field declaration
 */
function extractNameFromFieldDeclaration(funcNode: TreeSitterNode): string | null {
  // First check if it's actually a function (has function_declarator)
  const hasFunctionDeclarator = funcNode.children.some(
    child => child.type === TS_FUNCTION_DECLARATOR
  );
  if (!hasFunctionDeclarator) return null;

  for (const child of funcNode.children) {
    if (child.type === TS_FUNCTION_DECLARATOR) {
      const declarator = child.childForFieldName(FIELD_DECLARATOR);
      if (declarator?.type === TS_FIELD_IDENTIFIER && declarator.text) {
        return declarator.text;
      }

      for (const grandchild of child.children) {
        if (grandchild.type === TS_FIELD_IDENTIFIER && grandchild.text) {
          return grandchild.text;
        }
      }
    }
  }
  return null;
}

/**
 * Find rightmost name in a qualified identifier
 */
function findRightmostName(node: TreeSitterNode): string | null {
  let lastName: string | null = null;

  for (const child of node.children) {
    switch (child.type) {
      case TS_IDENTIFIER:
      case TS_FIELD_IDENTIFIER:
        lastName = child.text ?? null;
        break;
      case TS_OPERATOR_NAME:
        lastName = extractOperatorName(child);
        break;
      case TS_DESTRUCTOR_NAME:
        lastName = extractDestructorName(child);
        break;
      case TS_QUALIFIED_IDENTIFIER: {
        const nested = findRightmostName(child);
        if (nested) lastName = nested;
        break;
      }
    }
  }

  return lastName;
}

/**
 * Extract function name from a function declarator
 */
function extractNameFromFunctionDeclarator(funcNode: TreeSitterNode): string | null {
  for (const child of funcNode.children) {
    if ((child.type === TS_IDENTIFIER || child.type === TS_FIELD_IDENTIFIER) && child.text) {
      return child.text;
    }
    if (child.type === TS_QUALIFIED_IDENTIFIER) {
      return findRightmostName(child);
    }
    if (child.type === TS_OPERATOR_NAME) {
      return extractOperatorName(child);
    }
    if (child.type === TS_DESTRUCTOR_NAME) {
      return extractDestructorName(child);
    }
  }
  return null;
}

/**
 * Extract function name from a template declaration
 */
function extractNameFromTemplateDeclaration(funcNode: TreeSitterNode): string | null {
  for (const child of funcNode.children) {
    if (
      child.type === TS_FUNCTION_DEFINITION ||
      child.type === TS_FUNCTION_DECLARATOR ||
      child.type === TS_DECLARATION
    ) {
      return extractFunctionName(child);
    }
  }
  return null;
}

/**
 * Extract function name from various C++ function node types
 */
export function extractFunctionName(funcNode: TreeSitterNode): string | null {
  switch (funcNode.type) {
    case TS_FUNCTION_DEFINITION:
    case TS_CONSTRUCTOR_OR_DESTRUCTOR_DEFINITION:
    case TS_INLINE_METHOD_DEFINITION:
    case TS_OPERATOR_CAST_DEFINITION:
      return extractNameFromFunctionDefinition(funcNode);
    
    case TS_DECLARATION:
    case TS_CONSTRUCTOR_OR_DESTRUCTOR_DECLARATION:
      return extractNameFromDeclaration(funcNode);
    
    case TS_FIELD_DECLARATION:
      return extractNameFromDeclaration(funcNode) ?? extractNameFromFieldDeclaration(funcNode);
    
    case TS_FUNCTION_DECLARATOR:
      return extractNameFromFunctionDeclarator(funcNode);
    
    case TS_TEMPLATE_DECLARATION:
      return extractNameFromTemplateDeclaration(funcNode);
    
    default:
      return null;
  }
}

/**
 * Get inner function node from a template declaration
 */
function getInnerFunctionNode(node: TreeSitterNode): TreeSitterNode {
  if (node.type === TS_TEMPLATE_DECLARATION) {
    for (const child of node.children) {
      if (child.type === TS_FUNCTION_DEFINITION) {
        return child;
      }
    }
  }
  return node;
}

/**
 * Find qualified identifier in a declarator
 */
function findQualifiedIdentifierInDeclarator(funcNode: TreeSitterNode): TreeSitterNode | null {
  const innerNode = getInnerFunctionNode(funcNode);
  const declarator = innerNode.childForFieldName(FIELD_DECLARATOR);
  
  if (!declarator) return null;

  if (declarator.type === TS_FUNCTION_DECLARATOR) {
    for (const child of declarator.children) {
      if (child.type === TS_QUALIFIED_IDENTIFIER) {
        return child;
      }
    }
  }

  return null;
}

/**
 * Check if a function is an out-of-class method definition
 */
export function isOutOfClassMethodDefinition(funcNode: TreeSitterNode): boolean {
  if (funcNode.type === TS_TEMPLATE_DECLARATION) {
    const inner = getInnerFunctionNode(funcNode);
    if (inner.type !== TS_FUNCTION_DEFINITION) return false;
  } else if (
    funcNode.type !== TS_FUNCTION_DEFINITION &&
    funcNode.type !== TS_CONSTRUCTOR_OR_DESTRUCTOR_DEFINITION
  ) {
    return false;
  }

  return findQualifiedIdentifierInDeclarator(funcNode) !== null;
}

/**
 * Extract class name from template type
 */
function extractClassNameFromTemplateType(templateTypeNode: TreeSitterNode): string | null {
  for (const child of templateTypeNode.children) {
    if (child.type === TS_TYPE_IDENTIFIER && child.text) {
      return child.text;
    }
  }
  return null;
}

/**
 * Collect all names from a qualified identifier
 */
function collectAllNamesFromQualifiedId(node: TreeSitterNode): string[] {
  const names: string[] = [];
  
  for (const child of node.children) {
    if (
      child.type === TS_NAMESPACE_IDENTIFIER ||
      child.type === TS_IDENTIFIER ||
      child.type === TS_TYPE_IDENTIFIER
    ) {
      const name = child.text;
      if (name) names.push(name);
    } else if (child.type === TS_QUALIFIED_IDENTIFIER) {
      names.push(...collectAllNamesFromQualifiedId(child));
    }
  }

  return names;
}

/**
 * Extract class name from nested qualified identifier
 */
function extractClassNameFromQualified(qualifiedId: TreeSitterNode): string | null {
  const names = collectAllNamesFromQualifiedId(qualifiedId);
  if (names.length >= 2) {
    return names.slice(0, -1).join('::');
  }
  return null;
}

/**
 * Extract class name from an out-of-class method definition
 */
export function extractClassNameFromOutOfClassMethod(funcNode: TreeSitterNode): string | null {
  const qualifiedId = findQualifiedIdentifierInDeclarator(funcNode);
  if (!qualifiedId) return null;

  // Check for nested qualified identifier
  const hasNestedQualified = qualifiedId.children.some(
    child => child.type === TS_QUALIFIED_IDENTIFIER
  );

  if (hasNestedQualified) {
    return extractClassNameFromQualified(qualifiedId);
  }

  for (const child of qualifiedId.children) {
    if (child.type === TS_TEMPLATE_TYPE) {
      return extractClassNameFromTemplateType(child);
    }
    if (
      child.type === TS_NAMESPACE_IDENTIFIER ||
      child.type === TS_IDENTIFIER ||
      child.type === TS_TYPE_IDENTIFIER
    ) {
      if (child.text) return child.text;
    }
  }

  return null;
}

/**
 * Extract parameters from a C++ function
 */
export interface CppParameter {
  name: string | null;
  type: string;
}

export function extractCppParameters(funcNode: TreeSitterNode): CppParameter[] {
  const params: CppParameter[] = [];
  
  // Find parameter list
  const paramsList = funcNode.childForFieldName('parameters') ??
    funcNode.children.find(c => c.type === 'parameter_list');
  
  if (!paramsList) return params;

  for (const child of paramsList.children) {
    if (child.type === 'parameter_declaration') {
      const typeNode = child.childForFieldName('type');
      const declarator = child.childForFieldName(FIELD_DECLARATOR);
      
      let name: string | null = null;
      if (declarator) {
        // Extract name from declarator
        if (declarator.type === TS_IDENTIFIER) {
          name = declarator.text ?? null;
        } else {
          // Handle pointer/reference declarators
          for (const grandchild of declarator.children) {
            if (grandchild.type === TS_IDENTIFIER) {
              name = grandchild.text ?? null;
              break;
            }
          }
        }
      }

      params.push({
        name,
        type: typeNode?.text ?? 'unknown',
      });
    }
  }

  return params;
}

/**
 * Extract base classes from a C++ class
 */
export function extractCppBaseClasses(classNode: TreeSitterNode): string[] {
  const baseClasses: string[] = [];
  
  // Find base_class_clause
  const baseClause = classNode.children.find(c => c.type === 'base_class_clause');
  if (!baseClause) return baseClasses;

  for (const child of baseClause.children) {
    if (child.type === 'base_class_specifier' || child.type === 'type_descriptor') {
      // Extract the type name
      for (const grandchild of child.children) {
        if (grandchild.type === TS_TYPE_IDENTIFIER || grandchild.type === TS_IDENTIFIER) {
          if (grandchild.text) baseClasses.push(grandchild.text);
        } else if (grandchild.type === TS_TEMPLATE_TYPE) {
          const name = extractClassNameFromTemplateType(grandchild);
          if (name) baseClasses.push(name);
        }
      }
    }
  }

  return baseClasses;
}

/**
 * Check if a class is a template class
 */
export function isTemplateClass(classNode: TreeSitterNode): boolean {
  return classNode.parent?.type === TS_TEMPLATE_DECLARATION;
}

/**
 * Extract template parameters
 */
export function extractTemplateParameters(node: TreeSitterNode): string[] {
  const params: string[] = [];
  
  // Find template_parameter_list
  const templateParams = node.children.find(c => c.type === 'template_parameter_list');
  if (!templateParams) return params;

  for (const child of templateParams.children) {
    if (
      child.type === 'type_parameter_declaration' ||
      child.type === 'variadic_type_parameter_declaration'
    ) {
      const nameNode = child.childForFieldName('name');
      if (nameNode?.text) {
        params.push(nameNode.text);
      }
    }
  }

  return params;
}

/**
 * Check if a node is const-qualified
 */
export function isConstFunction(funcNode: TreeSitterNode): boolean {
  // Look for 'const' after the parameter list
  const declarator = funcNode.childForFieldName(FIELD_DECLARATOR);
  if (!declarator) return false;

  let foundParams = false;
  for (const child of declarator.children) {
    if (child.type === 'parameter_list') {
      foundParams = true;
    } else if (foundParams && child.type === 'type_qualifier' && child.text === 'const') {
      return true;
    }
  }

  return false;
}

/**
 * Check if a function is virtual
 */
export function isVirtualFunction(funcNode: TreeSitterNode): boolean {
  for (const child of funcNode.children) {
    if (child.type === 'virtual_specifier' || child.text === 'virtual') {
      return true;
    }
    // Stop after return type
    if (child.type === 'type_identifier' || child.type === TS_PRIMITIVE_TYPE) {
      break;
    }
  }
  return false;
}

/**
 * Check if a function is pure virtual
 */
export function isPureVirtualFunction(funcNode: TreeSitterNode): boolean {
  if (!isVirtualFunction(funcNode)) return false;
  
  // Look for '= 0' at the end
  const children = Array.from(funcNode.children);
  for (let i = 0; i < children.length - 1; i++) {
    if (children[i].text === '=' && children[i + 1].text === '0') {
      return true;
    }
  }
  return false;
}
