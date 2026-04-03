/**
 * Java-specific language handler
 * Ported from codebase_rag/parsers/handlers/java.py and codebase_rag/parsers/java/utils.py
 */

import type { Node as TreeSitterNode } from 'web-tree-sitter';
import { SEPARATOR_DOT, SEPARATOR_COMMA_SPACE, FIELD_NAME, FIELD_TYPE, FIELD_PARAMETERS } from '../../constants.js';
import { BaseLanguageHandler } from './base.js';

// =============================================================================
// Java Tree-sitter Node Types
// =============================================================================

const TS_PACKAGE_DECLARATION = 'package_declaration';
const TS_IMPORT_DECLARATION = 'import_declaration';
const TS_SCOPED_IDENTIFIER = 'scoped_identifier';
const TS_IDENTIFIER = 'identifier';
const TS_ASTERISK = 'asterisk';
const TS_STATIC = 'static';
const TS_TYPE_IDENTIFIER = 'type_identifier';
const TS_GENERIC_TYPE = 'generic_type';
const TS_TYPE_LIST = 'type_list';
const TS_TYPE_PARAMETER = 'type_parameter';
const TS_MODIFIERS = 'modifiers';
const TS_ANNOTATION = 'annotation';
const TS_MARKER_ANNOTATION = 'marker_annotation';
const TS_METHOD_DECLARATION = 'method_declaration';
const TS_CONSTRUCTOR_DECLARATION = 'constructor_declaration';
const TS_FIELD_DECLARATION = 'field_declaration';
const TS_VARIABLE_DECLARATOR = 'variable_declarator';
const TS_FORMAL_PARAMETER = 'formal_parameter';
const TS_SPREAD_PARAMETER = 'spread_parameter';
const TS_METHOD_INVOCATION = 'method_invocation';
const TS_THIS = 'this';
const TS_SUPER = 'super';
const TS_FIELD_ACCESS = 'field_access';
const TS_PROGRAM = 'program';
const TS_VOID_TYPE = 'void_type';

// Java class node types
const JAVA_CLASS_NODE_TYPES = new Set([
  'class_declaration',
  'interface_declaration',
  'enum_declaration',
  'record_declaration',
  'annotation_type_declaration',
]);

// Java method node types
const JAVA_METHOD_NODE_TYPES = new Set([
  'method_declaration',
  'constructor_declaration',
]);

// Java modifiers
const JAVA_CLASS_MODIFIERS = new Set([
  'public', 'private', 'protected', 'abstract', 'final', 'static', 'strictfp',
]);

const JAVA_METHOD_MODIFIERS = new Set([
  'public', 'private', 'protected', 'abstract', 'final', 'static',
  'synchronized', 'native', 'strictfp', 'default',
]);

const JAVA_FIELD_MODIFIERS = new Set([
  'public', 'private', 'protected', 'static', 'final', 'transient', 'volatile',
]);

// Delimiter tokens to skip
const DELIMITER_TOKENS = new Set(['(', ')', ',', '{', '}', ';']);

// =============================================================================
// Java Language Handler
// =============================================================================

export class JavaHandler extends BaseLanguageHandler {
  /**
   * Extract annotations from a Java node
   */
  override extractDecorators(node: TreeSitterNode): string[] {
    return extractFromModifiersNode(node).annotations;
  }

  /**
   * Build method qualified name with parameter signature
   */
  override buildMethodQualifiedName(
    classQn: string,
    methodName: string,
    methodNode: TreeSitterNode
  ): string {
    const methodInfo = extractMethodInfo(methodNode);
    
    if (methodInfo && methodInfo.parameters.length > 0) {
      const paramSig = methodInfo.parameters.join(SEPARATOR_COMMA_SPACE);
      return `${classQn}${SEPARATOR_DOT}${methodName}(${paramSig})`;
    }
    
    return `${classQn}${SEPARATOR_DOT}${methodName}`;
  }

  /**
   * Check if a node is a class method
   */
  override isClassMethod(node: TreeSitterNode): boolean {
    let current = node.parent;
    while (current) {
      if (JAVA_CLASS_NODE_TYPES.has(current.type)) {
        return true;
      }
      if (current.type === TS_PROGRAM) {
        return false;
      }
      current = current.parent;
    }
    return false;
  }
}

// =============================================================================
// Java Types
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
  argumentCount: number;
}

interface ModifiersAndAnnotations {
  modifiers: string[];
  annotations: string[];
}

// =============================================================================
// Java Utility Functions
// =============================================================================

/**
 * Extract package name from a package declaration
 */
export function extractPackageName(packageNode: TreeSitterNode): string | null {
  if (packageNode.type !== TS_PACKAGE_DECLARATION) {
    return null;
  }

  for (const child of packageNode.children) {
    if (child.type === TS_SCOPED_IDENTIFIER || child.type === TS_IDENTIFIER) {
      return child.text ?? null;
    }
  }

  return null;
}

/**
 * Extract import path from an import declaration
 */
export function extractImportPath(importNode: TreeSitterNode): Map<string, string> {
  const imports = new Map<string, string>();

  if (importNode.type !== TS_IMPORT_DECLARATION) {
    return imports;
  }

  let importedPath: string | null = null;
  let isWildcard = false;

  for (const child of importNode.children) {
    switch (child.type) {
      case TS_STATIC:
        // Static import - handle separately if needed
        break;
      case TS_SCOPED_IDENTIFIER:
      case TS_IDENTIFIER:
        importedPath = child.text ?? null;
        break;
      case TS_ASTERISK:
        isWildcard = true;
        break;
    }
  }

  if (!importedPath) return imports;

  if (isWildcard) {
    const wildcardKey = `*${importedPath}`;
    imports.set(wildcardKey, importedPath);
  } else {
    const parts = importedPath.split(SEPARATOR_DOT);
    const importedName = parts[parts.length - 1];
    imports.set(importedName, importedPath);
  }

  return imports;
}

/**
 * Extract modifiers and annotations from a node
 */
export function extractFromModifiersNode(
  node: TreeSitterNode,
  allowedModifiers: Set<string> = JAVA_METHOD_MODIFIERS
): ModifiersAndAnnotations {
  const result: ModifiersAndAnnotations = { modifiers: [], annotations: [] };

  const modifiersNode = node.children.find(child => child.type === TS_MODIFIERS);
  if (!modifiersNode) return result;

  for (const child of modifiersNode.children) {
    if (allowedModifiers.has(child.type)) {
      const modifier = child.text;
      if (modifier) result.modifiers.push(modifier);
    } else if (child.type === TS_ANNOTATION || child.type === TS_MARKER_ANNOTATION) {
      const annotation = child.text;
      if (annotation) result.annotations.push(annotation);
    }
  }

  return result;
}

/**
 * Extract superclass from a class node
 */
function extractSuperclass(classNode: TreeSitterNode): string | null {
  const superclassNode = classNode.childForFieldName('superclass');
  if (!superclassNode) return null;

  switch (superclassNode.type) {
    case TS_TYPE_IDENTIFIER:
      return superclassNode.text ?? null;
    case TS_GENERIC_TYPE: {
      for (const child of superclassNode.children) {
        if (child.type === TS_TYPE_IDENTIFIER) {
          return child.text ?? null;
        }
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Extract interface name from a type node
 */
function extractInterfaceName(typeChild: TreeSitterNode): string | null {
  switch (typeChild.type) {
    case TS_TYPE_IDENTIFIER:
      return typeChild.text ?? null;
    case TS_GENERIC_TYPE: {
      for (const child of typeChild.children) {
        if (child.type === TS_TYPE_IDENTIFIER) {
          return child.text ?? null;
        }
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Extract interfaces from a class node
 */
function extractInterfaces(classNode: TreeSitterNode): string[] {
  const interfacesNode = classNode.childForFieldName('interfaces');
  if (!interfacesNode) return [];

  const interfaces: string[] = [];
  for (const child of interfacesNode.children) {
    if (child.type === TS_TYPE_LIST) {
      for (const typeChild of child.children) {
        const interfaceName = extractInterfaceName(typeChild);
        if (interfaceName) {
          interfaces.push(interfaceName);
        }
      }
    }
  }

  return interfaces;
}

/**
 * Extract type parameters from a class node
 */
function extractTypeParameters(classNode: TreeSitterNode): string[] {
  const typeParamsNode = classNode.childForFieldName('type_parameters');
  if (!typeParamsNode) return [];

  const typeParameters: string[] = [];
  for (const child of typeParamsNode.children) {
    if (child.type === TS_TYPE_PARAMETER) {
      const paramName = child.childForFieldName(FIELD_NAME)?.text;
      if (paramName) typeParameters.push(paramName);
    }
  }

  return typeParameters;
}

/**
 * Extract class modifiers
 */
function extractClassModifiers(classNode: TreeSitterNode): string[] {
  return extractFromModifiersNode(classNode, JAVA_CLASS_MODIFIERS).modifiers;
}

/**
 * Extract class info from a class declaration
 */
export function extractClassInfo(classNode: TreeSitterNode): JavaClassInfo {
  if (!JAVA_CLASS_NODE_TYPES.has(classNode.type)) {
    return {
      name: null,
      type: '',
      superclass: null,
      interfaces: [],
      modifiers: [],
      typeParameters: [],
    };
  }

  const nameNode = classNode.childForFieldName(FIELD_NAME);
  const name = nameNode?.text ?? null;

  return {
    name,
    type: classNode.type.replace('_declaration', ''),
    superclass: extractSuperclass(classNode),
    interfaces: extractInterfaces(classNode),
    modifiers: extractClassModifiers(classNode),
    typeParameters: extractTypeParameters(classNode),
  };
}

/**
 * Get method type (constructor or method)
 */
function getMethodType(methodNode: TreeSitterNode): string {
  if (methodNode.type === TS_CONSTRUCTOR_DECLARATION) {
    return 'constructor';
  }
  return 'method';
}

/**
 * Extract method return type
 */
function extractMethodReturnType(methodNode: TreeSitterNode): string | null {
  if (methodNode.type !== TS_METHOD_DECLARATION) return null;
  const typeNode = methodNode.childForFieldName(FIELD_TYPE);
  return typeNode?.text ?? null;
}

/**
 * Extract formal parameter type
 */
function extractFormalParamType(paramNode: TreeSitterNode): string | null {
  const typeNode = paramNode.childForFieldName(FIELD_TYPE);
  return typeNode?.text ?? null;
}

/**
 * Extract spread parameter type (varargs)
 */
function extractSpreadParamType(spreadNode: TreeSitterNode): string | null {
  for (const child of spreadNode.children) {
    if (child.type === TS_TYPE_IDENTIFIER) {
      const paramTypeText = child.text;
      if (paramTypeText) return `${paramTypeText}...`;
    }
  }
  return null;
}

/**
 * Extract method parameters
 */
function extractMethodParameters(methodNode: TreeSitterNode): string[] {
  const paramsNode = methodNode.childForFieldName(FIELD_PARAMETERS);
  if (!paramsNode) return [];

  const parameters: string[] = [];
  for (const child of paramsNode.children) {
    let paramType: string | null = null;
    switch (child.type) {
      case TS_FORMAL_PARAMETER:
        paramType = extractFormalParamType(child);
        break;
      case TS_SPREAD_PARAMETER:
        paramType = extractSpreadParamType(child);
        break;
    }
    if (paramType) parameters.push(paramType);
  }

  return parameters;
}

/**
 * Extract method info from a method declaration
 */
export function extractMethodInfo(methodNode: TreeSitterNode): JavaMethodInfo {
  if (!JAVA_METHOD_NODE_TYPES.has(methodNode.type)) {
    return {
      name: null,
      type: '',
      returnType: null,
      parameters: [],
      modifiers: [],
      typeParameters: [],
      annotations: [],
    };
  }

  const modsAndAnnots = extractFromModifiersNode(methodNode, JAVA_METHOD_MODIFIERS);

  return {
    name: methodNode.childForFieldName(FIELD_NAME)?.text ?? null,
    type: getMethodType(methodNode),
    returnType: extractMethodReturnType(methodNode),
    parameters: extractMethodParameters(methodNode),
    modifiers: modsAndAnnots.modifiers,
    typeParameters: [],
    annotations: modsAndAnnots.annotations,
  };
}

/**
 * Extract field info from a field declaration
 */
export function extractFieldInfo(fieldNode: TreeSitterNode): JavaFieldInfo {
  if (fieldNode.type !== TS_FIELD_DECLARATION) {
    return {
      name: null,
      type: null,
      modifiers: [],
      annotations: [],
    };
  }

  const typeNode = fieldNode.childForFieldName(FIELD_TYPE);
  const fieldType = typeNode?.text ?? null;

  let name: string | null = null;
  const declaratorNode = fieldNode.childForFieldName('declarator');
  if (declaratorNode?.type === TS_VARIABLE_DECLARATOR) {
    name = declaratorNode.childForFieldName(FIELD_NAME)?.text ?? null;
  }

  const modsAndAnnots = extractFromModifiersNode(fieldNode, JAVA_FIELD_MODIFIERS);

  return {
    name,
    type: fieldType,
    modifiers: modsAndAnnots.modifiers,
    annotations: modsAndAnnots.annotations,
  };
}

/**
 * Extract method call info
 */
export function extractMethodCallInfo(callNode: TreeSitterNode): JavaMethodCallInfo | null {
  if (callNode.type !== TS_METHOD_INVOCATION) return null;

  const nameNode = callNode.childForFieldName(FIELD_NAME);
  const name = nameNode?.text ?? null;

  let object: string | null = null;
  const objectNode = callNode.childForFieldName('object');
  if (objectNode) {
    switch (objectNode.type) {
      case TS_THIS:
        object = 'this';
        break;
      case TS_SUPER:
        object = 'super';
        break;
      case TS_IDENTIFIER:
      case TS_FIELD_ACCESS:
        object = objectNode.text ?? null;
        break;
    }
  }

  let argumentCount = 0;
  const argsNode = callNode.childForFieldName('arguments');
  if (argsNode) {
    for (const child of argsNode.children) {
      if (!DELIMITER_TOKENS.has(child.type)) {
        argumentCount++;
      }
    }
  }

  return { name, object, argumentCount };
}

/**
 * Check if a method is the main method
 */
export function isMainMethod(methodNode: TreeSitterNode): boolean {
  if (methodNode.type !== TS_METHOD_DECLARATION) return false;

  // Check name
  const nameNode = methodNode.childForFieldName(FIELD_NAME);
  if (!nameNode || nameNode.text !== 'main') return false;

  // Check return type
  const typeNode = methodNode.childForFieldName(FIELD_TYPE);
  if (!typeNode || typeNode.type !== TS_VOID_TYPE) return false;

  // Check modifiers (must be public static)
  let hasPublic = false;
  let hasStatic = false;
  const modsNode = methodNode.children.find(c => c.type === TS_MODIFIERS);
  if (modsNode) {
    for (const child of modsNode.children) {
      if (child.type === 'public') hasPublic = true;
      if (child.type === 'static') hasStatic = true;
    }
  }
  if (!hasPublic || !hasStatic) return false;

  // Check parameters (must be String[])
  const paramsNode = methodNode.childForFieldName(FIELD_PARAMETERS);
  if (!paramsNode) return false;

  let paramCount = 0;
  let validParam = false;
  for (const child of paramsNode.children) {
    if (child.type === TS_FORMAL_PARAMETER) {
      paramCount++;
      const typeText = child.childForFieldName(FIELD_TYPE)?.text;
      if (typeText?.includes('String[]') || typeText?.includes('String...')) {
        validParam = true;
      }
    } else if (child.type === TS_SPREAD_PARAMETER) {
      paramCount++;
      for (const grandChild of child.children) {
        if (grandChild.type === TS_TYPE_IDENTIFIER && grandChild.text === 'String') {
          validParam = true;
        }
      }
    }
  }

  return paramCount === 1 && validParam;
}

/**
 * Get Java visibility modifier
 */
export function getJavaVisibility(node: TreeSitterNode): string {
  const modsNode = node.children.find(c => c.type === TS_MODIFIERS);
  if (modsNode) {
    for (const child of modsNode.children) {
      if (child.type === 'public') return 'public';
      if (child.type === 'protected') return 'protected';
      if (child.type === 'private') return 'private';
    }
  }
  return 'package'; // default package-private
}

/**
 * Build qualified name path from node's ancestors
 */
export function buildQualifiedName(
  node: TreeSitterNode,
  options: {
    includeClasses?: boolean;
    includeMethods?: boolean;
  } = {}
): string[] {
  const { includeClasses = true, includeMethods = false } = options;

  const pathParts: string[] = [];
  let current = node.parent;

  while (current && current.type !== TS_PROGRAM) {
    if (JAVA_CLASS_NODE_TYPES.has(current.type) && includeClasses) {
      const className = current.childForFieldName(FIELD_NAME)?.text;
      if (className) pathParts.push(className);
    } else if (JAVA_METHOD_NODE_TYPES.has(current.type) && includeMethods) {
      const methodName = current.childForFieldName(FIELD_NAME)?.text;
      if (methodName) pathParts.push(methodName);
    }
    current = current.parent;
  }

  pathParts.reverse();
  return pathParts;
}

/**
 * Find package start index from path parts
 */
export function findPackageStartIndex(parts: string[]): number | null {
  const jvmLanguages = new Set(['java', 'kotlin', 'scala', 'groovy']);
  const srcFolders = new Set(['main', 'test']);

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];

    // Check for JVM language folder
    if (jvmLanguages.has(part) && i > 0) {
      return i + 1;
    }

    // Check for 'src' folder
    if (part === 'src' && i + 1 < parts.length) {
      const nextPart = parts[i + 1];

      if (!jvmLanguages.has(nextPart) && !srcFolders.has(nextPart)) {
        return i + 1;
      }

      // Handle non-standard layout (e.g., src/main/code instead of src/main/java)
      if (i + 2 < parts.length) {
        const partAfterNext = parts[i + 2];
        if (srcFolders.has(nextPart) && !jvmLanguages.has(partAfterNext)) {
          return i + 1;
        }
      }
    }
  }

  return null;
}

/**
 * Extract annotation info
 */
export function extractAnnotationInfo(annotationNode: TreeSitterNode): JavaAnnotationInfo {
  if (annotationNode.type !== TS_ANNOTATION) {
    return { name: null, arguments: [] };
  }

  const name = annotationNode.childForFieldName(FIELD_NAME)?.text ?? null;

  const args: string[] = [];
  const argsNode = annotationNode.childForFieldName('arguments');
  if (argsNode) {
    for (const child of argsNode.children) {
      if (!DELIMITER_TOKENS.has(child.type) && child.text) {
        args.push(child.text);
      }
    }
  }

  return { name, arguments: args };
}
