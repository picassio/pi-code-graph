/**
 * Base language handler with default implementations
 * All language-specific handlers extend from this class
 */

import type { Node as TreeSitterNode } from 'web-tree-sitter';
import type { LanguageSpec } from '../../types.js';
import { SEPARATOR_DOT, FIELD_NAME, FIELD_BODY } from '../../constants.js';

// =============================================================================
// Language Handler Protocol
// =============================================================================

/**
 * Interface for language-specific AST handling
 */
export interface LanguageHandler {
  /**
   * Check if a function node is inside a method with object literals (JS/TS specific)
   */
  isInsideMethodWithObjectLiterals(node: TreeSitterNode): boolean;

  /**
   * Check if a function node is a class method
   */
  isClassMethod(node: TreeSitterNode): boolean;

  /**
   * Check if an export is inside a function (JS/TS specific)
   */
  isExportInsideFunction(node: TreeSitterNode): boolean;

  /**
   * Extract function name from a node
   */
  extractFunctionName(node: TreeSitterNode): string | null;

  /**
   * Build qualified name for a function
   */
  buildFunctionQualifiedName(
    node: TreeSitterNode,
    moduleQn: string,
    funcName: string,
    langConfig: LanguageSpec | null,
    filePath: string | null,
    repoPath: string,
    projectName: string
  ): string;

  /**
   * Check if a function is exported (JS/TS, C++ modules)
   */
  isFunctionExported(node: TreeSitterNode): boolean;

  /**
   * Check if a node should be processed as an impl block (Rust)
   */
  shouldProcessAsImplBlock(node: TreeSitterNode): boolean;

  /**
   * Extract impl block target type (Rust)
   */
  extractImplTarget(node: TreeSitterNode): string | null;

  /**
   * Build method qualified name
   */
  buildMethodQualifiedName(
    classQn: string,
    methodName: string,
    methodNode: TreeSitterNode
  ): string;

  /**
   * Extract base class name from a base node
   */
  extractBaseClassName(baseNode: TreeSitterNode): string | null;

  /**
   * Extract decorators/annotations from a node
   */
  extractDecorators(node: TreeSitterNode): string[];

  /**
   * Build nested function qualified name
   */
  buildNestedFunctionQn(
    funcNode: TreeSitterNode,
    moduleQn: string,
    funcName: string,
    langConfig: LanguageSpec
  ): string | null;
}

// =============================================================================
// Base Language Handler
// =============================================================================

/**
 * Base implementation with default behavior for all methods
 */
export class BaseLanguageHandler implements LanguageHandler {
  isInsideMethodWithObjectLiterals(_node: TreeSitterNode): boolean {
    return false;
  }

  isClassMethod(_node: TreeSitterNode): boolean {
    return false;
  }

  isExportInsideFunction(_node: TreeSitterNode): boolean {
    return false;
  }

  extractFunctionName(node: TreeSitterNode): string | null {
    const nameNode = node.childForFieldName(FIELD_NAME);
    if (nameNode?.text) {
      return nameNode.text;
    }
    return null;
  }

  buildFunctionQualifiedName(
    _node: TreeSitterNode,
    moduleQn: string,
    funcName: string,
    _langConfig: LanguageSpec | null,
    _filePath: string | null,
    _repoPath: string,
    _projectName: string
  ): string {
    return `${moduleQn}${SEPARATOR_DOT}${funcName}`;
  }

  isFunctionExported(_node: TreeSitterNode): boolean {
    return false;
  }

  shouldProcessAsImplBlock(_node: TreeSitterNode): boolean {
    return false;
  }

  extractImplTarget(_node: TreeSitterNode): string | null {
    return null;
  }

  buildMethodQualifiedName(
    classQn: string,
    methodName: string,
    _methodNode: TreeSitterNode
  ): string {
    return `${classQn}${SEPARATOR_DOT}${methodName}`;
  }

  extractBaseClassName(baseNode: TreeSitterNode): string | null {
    return baseNode.text ?? null;
  }

  extractDecorators(_node: TreeSitterNode): string[] {
    return [];
  }

  buildNestedFunctionQn(
    funcNode: TreeSitterNode,
    moduleQn: string,
    funcName: string,
    langConfig: LanguageSpec
  ): string | null {
    const pathParts = this._collectAncestorPathParts(funcNode, langConfig);
    if (pathParts === null) {
      return null;
    }
    return this._formatNestedQn(moduleQn, pathParts, funcName);
  }

  // ===========================================================================
  // Protected Helper Methods
  // ===========================================================================

  protected _collectAncestorPathParts(
    funcNode: TreeSitterNode,
    langConfig: LanguageSpec
  ): string[] | null {
    const pathParts: string[] = [];
    let current = funcNode.parent;

    while (current && !langConfig.moduleNodeTypes.includes(current.type)) {
      if (langConfig.functionNodeTypes.includes(current.type)) {
        const name = this._extractNodeName(current);
        if (name) {
          pathParts.push(name);
        }
      } else if (langConfig.classNodeTypes.includes(current.type)) {
        // Inside a class - don't process as nested function
        return null;
      }
      current = current.parent;
    }

    pathParts.reverse();
    return pathParts;
  }

  protected _extractNodeName(node: TreeSitterNode): string | null {
    const nameNode = node.childForFieldName(FIELD_NAME);
    if (nameNode?.text) {
      return nameNode.text;
    }
    return null;
  }

  protected _formatNestedQn(
    moduleQn: string,
    pathParts: string[],
    funcName: string
  ): string {
    if (pathParts.length > 0) {
      return `${moduleQn}${SEPARATOR_DOT}${pathParts.join(SEPARATOR_DOT)}${SEPARATOR_DOT}${funcName}`;
    }
    return `${moduleQn}${SEPARATOR_DOT}${funcName}`;
  }
}
