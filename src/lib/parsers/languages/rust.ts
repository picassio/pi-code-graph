/**
 * Rust-specific language handler
 * Ported from codebase_rag/parsers/handlers/rust.py and codebase_rag/parsers/rs/utils.py
 */

import type { Node as TreeSitterNode } from 'web-tree-sitter';
import type { LanguageSpec } from '../../types.js';
import { SEPARATOR_DOT, SEPARATOR_DOUBLE_COLON, FIELD_NAME, FIELD_BODY, FIELD_TYPE } from '../../constants.js';
import { BaseLanguageHandler } from './base.js';

// =============================================================================
// Rust Tree-sitter Node Types
// =============================================================================

const TS_RS_ATTRIBUTE_ITEM = 'attribute_item';
const TS_RS_INNER_ATTRIBUTE_ITEM = 'inner_attribute_item';
const TS_RS_SOURCE_FILE = 'source_file';
const TS_RS_MOD_ITEM = 'mod_item';
const TS_RS_IMPL_ITEM = 'impl_item';
const TS_RS_USE_DECLARATION = 'use_declaration';
const TS_RS_USE_AS_CLAUSE = 'use_as_clause';
const TS_RS_USE_WILDCARD = 'use_wildcard';
const TS_RS_USE_LIST = 'use_list';
const TS_RS_SCOPED_USE_LIST = 'scoped_use_list';
const TS_RS_SCOPED_TYPE_IDENTIFIER = 'scoped_type_identifier';
const TS_RS_CRATE = 'crate';
const TS_RS_KEYWORD_AS = 'as';
const TS_RS_FIELD_ARGUMENT = 'argument';
const TS_IDENTIFIER = 'identifier';
const TS_TYPE_IDENTIFIER = 'type_identifier';
const TS_SCOPED_IDENTIFIER = 'scoped_identifier';
const TS_GENERIC_TYPE = 'generic_type';
const KEYWORD_SUPER = 'super';
const KEYWORD_SELF = 'self';

// Use list delimiter types to skip
const RS_USE_LIST_DELIMITERS = new Set(['{', '}', ',']);
const RS_WILDCARD_PREFIX = '*';

// =============================================================================
// Rust Language Handler
// =============================================================================

export class RustHandler extends BaseLanguageHandler {
  /**
   * Extract decorators (attributes) from a Rust node
   * 
   * Rust attributes can be:
   * - Outer attributes (#[...]) - siblings before the item
   * - Inner attributes (#![...]) - inside the item body
   */
  override extractDecorators(node: TreeSitterNode): string[] {
    const outerDecorators: string[] = [];
    
    // Collect outer attributes from previous siblings
    let sibling = node.previousNamedSibling;
    while (sibling && sibling.type === TS_RS_ATTRIBUTE_ITEM) {
      if (sibling.text) {
        outerDecorators.push(sibling.text);
      }
      sibling = sibling.previousNamedSibling;
    }

    // Reverse to maintain declaration order
    const decorators = outerDecorators.reverse();

    // Collect inner attributes from node body
    const nodesToSearch: TreeSitterNode[] = [node];
    const bodyNode = node.childForFieldName(FIELD_BODY);
    if (bodyNode) {
      nodesToSearch.push(bodyNode);
    }

    for (const searchNode of nodesToSearch) {
      for (const child of searchNode.children) {
        if (child.type === TS_RS_INNER_ATTRIBUTE_ITEM && child.text) {
          decorators.push(child.text);
        }
      }
    }

    return decorators;
  }

  /**
   * Build qualified name for a Rust function
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
    const pathParts = buildModulePath(node);
    if (pathParts.length > 0) {
      return `${moduleQn}${SEPARATOR_DOT}${pathParts.join(SEPARATOR_DOT)}${SEPARATOR_DOT}${funcName}`;
    }
    return `${moduleQn}${SEPARATOR_DOT}${funcName}`;
  }

  /**
   * Check if a node should be processed as an impl block
   */
  override shouldProcessAsImplBlock(node: TreeSitterNode): boolean {
    return node.type === TS_RS_IMPL_ITEM;
  }

  /**
   * Extract the target type from an impl block
   */
  override extractImplTarget(node: TreeSitterNode): string | null {
    return extractImplTarget(node);
  }
}

// =============================================================================
// Rust Utility Functions - Path Collection
// =============================================================================

/**
 * Collect path parts from a node recursively
 */
function collectPathParts(node: TreeSitterNode, parts: string[]): void {
  switch (node.type) {
    case TS_IDENTIFIER:
    case TS_TYPE_IDENTIFIER: {
      const part = node.text;
      if (part) parts.push(part);
      break;
    }
    case TS_SCOPED_IDENTIFIER:
    case TS_RS_SCOPED_TYPE_IDENTIFIER: {
      for (const child of node.children) {
        if (child.type !== SEPARATOR_DOUBLE_COLON) {
          collectPathParts(child, parts);
        }
      }
      break;
    }
    case TS_RS_CRATE:
    case KEYWORD_SUPER:
    case KEYWORD_SELF: {
      const part = node.text;
      if (part) parts.push(part);
      break;
    }
  }
}

/**
 * Extract path from a node as a string
 */
function extractPathFromNode(node: TreeSitterNode): string {
  switch (node.type) {
    case TS_IDENTIFIER:
    case TS_TYPE_IDENTIFIER:
      return node.text ?? '';
    case TS_SCOPED_IDENTIFIER:
    case TS_RS_SCOPED_TYPE_IDENTIFIER: {
      const parts: string[] = [];
      collectPathParts(node, parts);
      return parts.join(SEPARATOR_DOUBLE_COLON);
    }
    case TS_RS_CRATE:
    case KEYWORD_SUPER:
    case KEYWORD_SELF:
      return node.text ?? '';
    default:
      return '';
  }
}

// =============================================================================
// Rust Utility Functions - Use Tree Processing
// =============================================================================

/**
 * Process a Rust use tree and extract imports
 */
function processUseTree(
  node: TreeSitterNode,
  basePath: string,
  imports: Map<string, string>
): void {
  switch (node.type) {
    case TS_IDENTIFIER:
    case TS_TYPE_IDENTIFIER: {
      const name = node.text;
      if (name) {
        const fullPath = basePath
          ? `${basePath}${SEPARATOR_DOUBLE_COLON}${name}`
          : name;
        imports.set(name, fullPath);
      }
      break;
    }
    case TS_SCOPED_IDENTIFIER:
    case TS_RS_SCOPED_TYPE_IDENTIFIER: {
      const fullPath = extractPathFromNode(node);
      if (fullPath) {
        const parts = fullPath.split(SEPARATOR_DOUBLE_COLON);
        const importedName = parts[parts.length - 1];
        imports.set(importedName, fullPath);
      }
      break;
    }
    case TS_RS_USE_AS_CLAUSE: {
      processUseAsClause(node, basePath, imports);
      break;
    }
    case TS_RS_USE_WILDCARD: {
      processUseWildcard(node, basePath, imports);
      break;
    }
    case TS_RS_USE_LIST: {
      for (const child of node.children) {
        if (!RS_USE_LIST_DELIMITERS.has(child.type)) {
          processUseTree(child, basePath, imports);
        }
      }
      break;
    }
    case TS_RS_SCOPED_USE_LIST: {
      processScopedUseList(node, basePath, imports);
      break;
    }
    case KEYWORD_SELF: {
      imports.set(KEYWORD_SELF, basePath || KEYWORD_SELF);
      break;
    }
    default: {
      for (const child of node.children) {
        processUseTree(child, basePath, imports);
      }
    }
  }
}

/**
 * Process a use_as_clause (import with alias)
 */
function processUseAsClause(
  node: TreeSitterNode,
  basePath: string,
  imports: Map<string, string>
): void {
  let originalPath = '';
  let aliasName = '';

  const children = node.children.filter(c => c.type !== TS_RS_KEYWORD_AS);
  
  if (children.length === 2) {
    const [pathNode, aliasNode] = children;

    if (pathNode.type === KEYWORD_SELF) {
      originalPath = basePath || KEYWORD_SELF;
    } else {
      originalPath = extractPathFromNode(pathNode);
      if (basePath && originalPath) {
        originalPath = `${basePath}${SEPARATOR_DOUBLE_COLON}${originalPath}`;
      } else if (basePath) {
        originalPath = basePath;
      }
    }

    aliasName = aliasNode.text ?? '';
  }

  if (aliasName && originalPath) {
    imports.set(aliasName, originalPath);
  }
}

/**
 * Process a use_wildcard (glob import)
 */
function processUseWildcard(
  node: TreeSitterNode,
  basePath: string,
  imports: Map<string, string>
): void {
  let wildcardBase = '';

  for (const child of node.children) {
    if (child.type !== RS_WILDCARD_PREFIX) {
      wildcardBase = extractPathFromNode(child);
      break;
    }
  }

  if (wildcardBase) {
    const wildcardKey = `${RS_WILDCARD_PREFIX}${wildcardBase}`;
    imports.set(wildcardKey, wildcardBase);
  } else if (basePath) {
    const wildcardKey = `${RS_WILDCARD_PREFIX}${basePath}`;
    imports.set(wildcardKey, basePath);
  }
}

/**
 * Process a scoped_use_list
 */
function processScopedUseList(
  node: TreeSitterNode,
  basePath: string,
  imports: Map<string, string>
): void {
  let newBasePath = '';

  for (const child of node.children) {
    switch (child.type) {
      case TS_IDENTIFIER:
      case TS_SCOPED_IDENTIFIER:
      case TS_RS_CRATE:
      case KEYWORD_SUPER:
      case KEYWORD_SELF:
        newBasePath = extractPathFromNode(child);
        break;
      case TS_RS_USE_LIST: {
        const finalBase = basePath
          ? `${basePath}${SEPARATOR_DOUBLE_COLON}${newBasePath}`
          : newBasePath;
        processUseTree(child, finalBase, imports);
        break;
      }
    }
  }
}

// =============================================================================
// Rust Utility Functions - Public API
// =============================================================================

/**
 * Extract the target type from a Rust impl block
 */
export function extractImplTarget(implNode: TreeSitterNode): string | null {
  if (implNode.type !== TS_RS_IMPL_ITEM) {
    return null;
  }

  for (let i = 0; i < implNode.childCount; i++) {
    if (implNode.fieldNameForChild(i) === FIELD_TYPE) {
      const typeNode = implNode.child(i);
      if (!typeNode) continue;

      switch (typeNode.type) {
        case TS_GENERIC_TYPE: {
          for (const child of typeNode.children) {
            if (child.type === TS_TYPE_IDENTIFIER) {
              return child.text ?? null;
            }
          }
          break;
        }
        case TS_TYPE_IDENTIFIER:
          return typeNode.text ?? null;
        case TS_RS_SCOPED_TYPE_IDENTIFIER: {
          for (const child of typeNode.children) {
            if (child.type === TS_TYPE_IDENTIFIER) {
              return child.text ?? null;
            }
          }
          break;
        }
      }
    }
  }

  return null;
}

/**
 * Extract imports from a Rust use declaration
 */
export function extractUseImports(useNode: TreeSitterNode): Map<string, string> {
  if (useNode.type !== TS_RS_USE_DECLARATION) {
    return new Map();
  }

  const imports = new Map<string, string>();
  const argumentNode = useNode.childForFieldName(TS_RS_FIELD_ARGUMENT);
  
  if (argumentNode) {
    processUseTree(argumentNode, '', imports);
  }

  return imports;
}

/**
 * Build the module path from a node's ancestors
 */
export function buildModulePath(
  node: TreeSitterNode,
  options: {
    includeImplTargets?: boolean;
    includeClasses?: boolean;
    classNodeTypes?: readonly string[];
  } = {}
): string[] {
  const {
    includeImplTargets = false,
    includeClasses = false,
    classNodeTypes = [],
  } = options;

  const pathParts: string[] = [];
  let current = node.parent;

  while (current && current.type !== TS_RS_SOURCE_FILE) {
    switch (current.type) {
      case TS_RS_MOD_ITEM: {
        const nameNode = current.childForFieldName(FIELD_NAME);
        if (nameNode?.text) {
          pathParts.push(nameNode.text);
        }
        break;
      }
      case TS_RS_IMPL_ITEM: {
        if (includeImplTargets) {
          const implTarget = extractImplTarget(current);
          if (implTarget) {
            pathParts.push(implTarget);
          }
        }
        break;
      }
      default: {
        if (
          includeClasses &&
          classNodeTypes.length > 0 &&
          classNodeTypes.includes(current.type)
        ) {
          if (current.type !== TS_RS_IMPL_ITEM) {
            const nameNode = current.childForFieldName(FIELD_NAME);
            if (nameNode?.text) {
              pathParts.push(nameNode.text);
            }
          }
        }
      }
    }
    current = current.parent;
  }

  pathParts.reverse();
  return pathParts;
}

/**
 * Extract function parameters from a Rust function
 */
export function extractRustParameters(funcNode: TreeSitterNode): string[] {
  const params: string[] = [];
  const paramsNode = funcNode.childForFieldName('parameters');
  
  if (!paramsNode) return params;

  for (const child of paramsNode.children) {
    switch (child.type) {
      case 'parameter': {
        const patternNode = child.childForFieldName('pattern');
        if (patternNode?.text) {
          params.push(patternNode.text);
        }
        break;
      }
      case 'self_parameter':
        params.push('self');
        break;
    }
  }

  return params;
}

/**
 * Check if a Rust function is async
 */
export function isAsyncFunction(funcNode: TreeSitterNode): boolean {
  for (const child of funcNode.children) {
    if (child.type === 'async') {
      return true;
    }
    // Stop after 'fn' keyword
    if (child.type === 'fn') {
      break;
    }
  }
  return false;
}

/**
 * Check if a Rust function is public
 */
export function isPublicFunction(funcNode: TreeSitterNode): boolean {
  for (const child of funcNode.children) {
    if (child.type === 'visibility_modifier') {
      // Check for 'pub' or 'pub(crate)' etc.
      return child.text?.startsWith('pub') ?? false;
    }
    // Stop after 'fn' keyword
    if (child.type === 'fn') {
      break;
    }
  }
  return false;
}

/**
 * Extract return type from a Rust function
 */
export function extractReturnType(funcNode: TreeSitterNode): string | null {
  const returnType = funcNode.childForFieldName('return_type');
  return returnType?.text ?? null;
}

/**
 * Extract trait bounds from a Rust impl block
 */
export function extractTraitBounds(implNode: TreeSitterNode): string | null {
  if (implNode.type !== TS_RS_IMPL_ITEM) {
    return null;
  }

  // Look for trait in 'for' clause
  for (const child of implNode.children) {
    if (child.type === 'trait') {
      return child.text ?? null;
    }
  }

  return null;
}

/**
 * Check if an impl block is a trait implementation
 */
export function isTraitImpl(implNode: TreeSitterNode): boolean {
  return extractTraitBounds(implNode) !== null;
}

/**
 * Extract struct fields from a Rust struct definition
 */
export interface RustField {
  name: string;
  type: string;
  isPublic: boolean;
}

export function extractStructFields(structNode: TreeSitterNode): RustField[] {
  const fields: RustField[] = [];
  
  const body = structNode.childForFieldName(FIELD_BODY);
  if (!body) return fields;

  for (const child of body.children) {
    if (child.type === 'field_declaration') {
      const nameNode = child.childForFieldName(FIELD_NAME);
      const typeNode = child.childForFieldName(FIELD_TYPE);
      
      // Check visibility
      let isPublic = false;
      for (const grandChild of child.children) {
        if (grandChild.type === 'visibility_modifier') {
          isPublic = grandChild.text?.startsWith('pub') ?? false;
          break;
        }
      }

      if (nameNode?.text && typeNode?.text) {
        fields.push({
          name: nameNode.text,
          type: typeNode.text,
          isPublic,
        });
      }
    }
  }

  return fields;
}

/**
 * Extract enum variants from a Rust enum definition
 */
export interface RustEnumVariant {
  name: string;
  hasData: boolean;
}

export function extractEnumVariants(enumNode: TreeSitterNode): RustEnumVariant[] {
  const variants: RustEnumVariant[] = [];
  
  const body = enumNode.childForFieldName(FIELD_BODY);
  if (!body) return variants;

  for (const child of body.children) {
    if (child.type === 'enum_variant') {
      const nameNode = child.childForFieldName(FIELD_NAME);
      if (nameNode?.text) {
        // Check if variant has associated data
        const hasData = child.children.some(
          c => c.type === 'field_declaration_list' || c.type === 'ordered_field_declaration_list'
        );
        variants.push({
          name: nameNode.text,
          hasData,
        });
      }
    }
  }

  return variants;
}
