/**
 * Minimal per-file type environment for TypeScript/JavaScript.
 *
 * Inspired by GitNexus's type-env.ts but dramatically simplified.
 * Focuses on the 80% case: resolving variable types so that deep
 * property chains like `this.session.modelRegistry.authStorage.login()`
 * can be traced through the call graph.
 *
 * Three tiers of inference (run in order per file):
 *   Tier 0: Explicit annotations       const x: User = ...
 *   Tier 1: Constructor inference      const x = new User()
 *   Tier 2: Assignment chain           const y = x (x already typed)
 *
 * Plus class field type tracking so `this.field` resolves.
 */

import { logger } from '../logger.js';
import type { Node as TreeSitterNode } from 'web-tree-sitter';

/** Per-file type env: scope → varName → typeName */
export type TypeEnv = Map<string, Map<string, string>>;

/** File-level scope key */
const FILE_SCOPE = '';

/** Per-class field info: fieldName → typeName */
export type ClassFieldTypes = Map<string, string>;

/** Project-wide: className (short) → fieldTypes */
export type ClassFieldRegistry = Map<string, ClassFieldTypes>;

export interface TypeEnvironment {
  /** Look up a variable's type, handling self/this → enclosing class. */
  lookup(varName: string, callNode: TreeSitterNode): string | undefined;

  /** Resolve a dotted chain like 'this.a.b.c' → final type name. */
  resolveChain(chain: string[], callNode: TreeSitterNode): string | undefined;

  /** Get all bindings (for diagnostics/tests). */
  allBindings(): ReadonlyMap<string, ReadonlyMap<string, string>>;
}

// ============================================================================
// AST walking helpers
// ============================================================================

/** Class-like node types in TS/JS grammars that can contain `this`. */
const CLASS_NODE_TYPES = new Set([
  'class_declaration',
  'class',
  'abstract_class_declaration',
  'interface_declaration',
]);

/** Function-like node types that create a new scope. */
const FUNCTION_NODE_TYPES = new Set([
  'function_declaration',
  'generator_function_declaration',
  'function_expression',
  'arrow_function',
  'method_definition',
  'function_signature',
]);

/** Walk up from a node to find the enclosing class name. */
function findEnclosingClassName(node: TreeSitterNode): string | undefined {
  let current: TreeSitterNode | null = node.parent;
  while (current) {
    if (CLASS_NODE_TYPES.has(current.type)) {
      const nameNode = current.childForFieldName('name');
      if (nameNode) {
        return nameNode.text;
      }
    }
    current = current.parent;
  }
  return undefined;
}

/** Walk up to find the enclosing function name for scope-keying. */
function findEnclosingScopeKey(node: TreeSitterNode): string {
  let current: TreeSitterNode | null = node.parent;
  while (current) {
    if (FUNCTION_NODE_TYPES.has(current.type)) {
      // method_definition and function_declaration have 'name' field
      const nameNode = current.childForFieldName('name');
      if (nameNode) {
        return nameNode.text;
      }
      // Anonymous arrow functions: use position-based key
      return `__anon_${current.startPosition.row}_${current.startPosition.column}`;
    }
    current = current.parent;
  }
  return FILE_SCOPE;
}

// ============================================================================
// Type string helpers
// ============================================================================

/** Strip wrappers like `| null`, `| undefined`, `?` to get the base type name. */
export function stripNullable(typeText: string): string {
  let t = typeText.trim();
  // Remove leading/trailing |
  t = t.replace(/^\|+|\|+$/g, '').trim();
  // Split on | and take first non-null/undefined part
  if (t.includes('|')) {
    const parts = t
      .split('|')
      .map((p) => p.trim())
      .filter((p) => p !== 'null' && p !== 'undefined' && p !== 'void');
    if (parts.length > 0) {
      t = parts[0];
    }
  }
  // Remove trailing ?
  t = t.replace(/\?$/, '').trim();
  return t;
}

/** Extract a simple type name from a type annotation node.
 * Handles: 'User', 'User[]', 'Array<User>', 'User | null', etc. */
export function extractSimpleTypeName(typeNode: TreeSitterNode | null): string | undefined {
  if (!typeNode) return undefined;

  const text = typeNode.text;
  if (!text) return undefined;

  let stripped = stripNullable(text);
  // Strip [] suffix
  stripped = stripped.replace(/\[\]$/, '').trim();
  // Strip generic wrapper: Array<User> → User, Promise<User> → User
  const genericMatch = stripped.match(/^(?:Array|Promise|Map|Set|Record|Partial|Readonly)<(.+)>$/);
  if (genericMatch) {
    stripped = stripNullable(genericMatch[1]);
    // If it's a Map<K,V>, take the value type (last param)
    if (stripped.includes(',')) {
      const parts = stripped.split(',').map((p) => p.trim());
      stripped = parts[parts.length - 1];
    }
  }
  // Strip any remaining generic args: Foo<T> → Foo
  stripped = stripped.replace(/<.*$/, '').trim();

  // Must be a simple identifier
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(stripped)) {
    return stripped;
  }
  return undefined;
}

// ============================================================================
// Type extraction from AST nodes
// ============================================================================

/** Extract the declared type from a variable declarator.
 *  Handles: const x: User = ..., let x: User, var x: User */
function extractVarAnnotation(declaratorNode: TreeSitterNode): string | undefined {
  // TypeScript: variable_declarator > type_annotation > type
  const typeAnnNode = declaratorNode.childForFieldName('type');
  if (typeAnnNode) {
    // type_annotation wraps the actual type node
    const innerType = typeAnnNode.childForFieldName('type') ?? typeAnnNode.namedChild(0);
    if (innerType) {
      return extractSimpleTypeName(innerType);
    }
  }
  // Alternative: walk children looking for type_annotation
  for (let i = 0; i < declaratorNode.childCount; i++) {
    const child = declaratorNode.child(i);
    if (child && child.type === 'type_annotation') {
      const inner = child.namedChild(0);
      if (inner) return extractSimpleTypeName(inner);
    }
  }
  return undefined;
}

/** Extract the type from a new_expression: new User(...) → "User" */
function extractNewExpressionType(valueNode: TreeSitterNode): string | undefined {
  if (valueNode.type !== 'new_expression') return undefined;
  const constructorNode = valueNode.childForFieldName('constructor');
  if (constructorNode) {
    return extractSimpleTypeName(constructorNode);
  }
  // Fallback: first named child
  const firstChild = valueNode.namedChild(0);
  if (firstChild) {
    return extractSimpleTypeName(firstChild);
  }
  return undefined;
}

/** Extract variable name from a declarator. */
function extractVarName(declaratorNode: TreeSitterNode): string | undefined {
  const nameNode = declaratorNode.childForFieldName('name');
  if (nameNode && nameNode.type === 'identifier') {
    return nameNode.text;
  }
  return undefined;
}

// ============================================================================
// Class field extraction
// ============================================================================

/**
 * Extract field type declarations from a class body.
 * Returns a map of fieldName → typeName.
 *
 * Handles TypeScript:
 *   class Foo {
 *     bar: Baz;
 *     private qux: Quux;
 *     public readonly zed: Zed = new Zed();
 *   }
 */
export function extractClassFields(classNode: TreeSitterNode): ClassFieldTypes {
  const fields = new Map<string, string>();

  const bodyNode = classNode.childForFieldName('body');
  if (!bodyNode) return fields;

  // Walk class_body children looking for field declarations
  for (let i = 0; i < bodyNode.childCount; i++) {
    const child = bodyNode.child(i);
    if (!child) continue;

    // TypeScript: public_field_definition
    // JavaScript: field_definition
    if (child.type === 'public_field_definition' || child.type === 'field_definition') {
      const nameNode = child.childForFieldName('name');
      if (!nameNode) continue;
      const fieldName = nameNode.text;
      if (!fieldName) continue;

      // Look for type annotation
      let fieldType: string | undefined;

      // Option 1: 'type' field (type_annotation)
      const typeAnnNode = child.childForFieldName('type');
      if (typeAnnNode) {
        const inner = typeAnnNode.namedChild(0) ?? typeAnnNode;
        fieldType = extractSimpleTypeName(inner);
      }

      // Option 2: walk children for type_annotation
      if (!fieldType) {
        for (let j = 0; j < child.childCount; j++) {
          const c = child.child(j);
          if (c && c.type === 'type_annotation') {
            const inner = c.namedChild(0);
            if (inner) {
              fieldType = extractSimpleTypeName(inner);
              break;
            }
          }
        }
      }

      // Option 3: initializer is a new_expression
      if (!fieldType) {
        const valueNode = child.childForFieldName('value');
        if (valueNode) {
          fieldType = extractNewExpressionType(valueNode);
        }
      }

      if (fieldType) {
        fields.set(fieldName, fieldType);
      }
    }

    // Constructor with property parameters: constructor(private readonly foo: Foo) { ... }
    if (child.type === 'method_definition') {
      const methodName = child.childForFieldName('name');
      const methodNameText = methodName?.text;

      // Constructor property params
      if (methodNameText === 'constructor') {
        const params = child.childForFieldName('parameters');
        if (params) {
          for (let k = 0; k < params.childCount; k++) {
            const param = params.child(k);
            if (param && param.type === 'required_parameter') {
              // Check for modifiers (public/private/readonly)
              let hasModifier = false;
              for (let m = 0; m < param.childCount; m++) {
                const mc = param.child(m);
                if (mc && (mc.type === 'accessibility_modifier' || mc.text === 'readonly')) {
                  hasModifier = true;
                  break;
                }
              }
              if (hasModifier) {
                // Extract name and type
                const pName = param.childForFieldName('pattern') ?? param.namedChild(0);
                if (pName) {
                  const paramName = pName.text;
                  const paramType = extractVarAnnotation(param);
                  if (paramName && paramType) {
                    fields.set(paramName, paramType);
                  }
                }
              }
            }
          }
        }
      }

      // Getters with return type: get foo(): Foo { ... }
      // Check for 'get' keyword by looking at children
      if (methodNameText) {
        let isGetter = false;
        for (let g = 0; g < child.childCount; g++) {
          const gc = child.child(g);
          if (gc && gc.type === 'get') {
            isGetter = true;
            break;
          }
        }
        if (isGetter) {
          // Return type annotation
          const returnTypeNode = child.childForFieldName('return_type');
          if (returnTypeNode) {
            const inner = returnTypeNode.namedChild(0) ?? returnTypeNode;
            const returnType = extractSimpleTypeName(inner);
            if (returnType) {
              fields.set(methodNameText, returnType);
            }
          }
        }
      }
    }

    // Interface body: property_signature (for interface declarations)
    if (child.type === 'property_signature') {
      const nameNode = child.childForFieldName('name');
      if (nameNode) {
        const fieldName = nameNode.text;
        // Walk children for type_annotation
        for (let j = 0; j < child.childCount; j++) {
          const c = child.child(j);
          if (c && c.type === 'type_annotation') {
            const inner = c.namedChild(0);
            if (inner) {
              const fieldType = extractSimpleTypeName(inner);
              if (fieldType) {
                fields.set(fieldName, fieldType);
              }
              break;
            }
          }
        }
      }
    }
  }

  return fields;
}

// ============================================================================
// TypeEnv building
// ============================================================================

/**
 * Build a per-file type environment by walking the AST.
 * Extracts variable types from annotations, constructor calls, and assignment chains.
 */
export function buildTypeEnv(
  rootNode: TreeSitterNode,
  classFieldRegistry: ClassFieldRegistry,
): TypeEnvironment {
  const env: TypeEnv = new Map();

  function getScope(key: string): Map<string, string> {
    let scope = env.get(key);
    if (!scope) {
      scope = new Map();
      env.set(key, scope);
    }
    return scope;
  }

  /** Process a variable_declarator node. */
  function processDeclarator(declNode: TreeSitterNode): void {
    const varName = extractVarName(declNode);
    if (!varName) return;

    const scopeKey = findEnclosingScopeKey(declNode);
    const scope = getScope(scopeKey);

    // Tier 0: explicit type annotation
    const annotatedType = extractVarAnnotation(declNode);
    if (annotatedType) {
      scope.set(varName, annotatedType);
      return;
    }

    // Tier 1: constructor inference
    const valueNode = declNode.childForFieldName('value');
    if (valueNode) {
      // new User()
      if (valueNode.type === 'new_expression') {
        const typeName = extractNewExpressionType(valueNode);
        if (typeName) {
          scope.set(varName, typeName);
          return;
        }
      }

      // Tier 2: assignment chain — const y = x where x has a known type
      if (valueNode.type === 'identifier') {
        const sourceVar = valueNode.text;
        if (sourceVar) {
          // Look up source var in same scope first, then file scope
          const sourceType = scope.get(sourceVar) ?? env.get(FILE_SCOPE)?.get(sourceVar);
          if (sourceType) {
            scope.set(varName, sourceType);
            return;
          }
        }
      }
    }
  }

  /** Recursive walk. */
  function walk(node: TreeSitterNode): void {
    // Variable declarations: const/let/var x = ...
    if (
      node.type === 'lexical_declaration' ||
      node.type === 'variable_declaration'
    ) {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child && child.type === 'variable_declarator') {
          processDeclarator(child);
        }
      }
    }

    // Recurse into children
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) walk(child);
    }
  }

  walk(rootNode);

  // Build the TypeEnvironment interface
  const environment: TypeEnvironment = {
    lookup(varName, callNode) {
      // Self/this: resolve to enclosing class
      if (varName === 'this' || varName === 'self') {
        return findEnclosingClassName(callNode);
      }

      // Function-local scope first, then file scope
      const scopeKey = findEnclosingScopeKey(callNode);
      if (scopeKey !== FILE_SCOPE) {
        const scope = env.get(scopeKey);
        if (scope) {
          const t = scope.get(varName);
          if (t) return t;
        }
      }

      const fileScope = env.get(FILE_SCOPE);
      return fileScope?.get(varName);
    },

    resolveChain(chain, callNode) {
      if (chain.length === 0) return undefined;

      // Start by resolving the first element as a variable
      let currentType = this.lookup(chain[0], callNode);
      if (!currentType) return undefined;

      // Walk the chain, using classFieldRegistry to resolve each field
      for (let i = 1; i < chain.length; i++) {
        const fieldName = chain[i];
        const fields = classFieldRegistry.get(currentType);
        if (!fields) {
          logger.debug(`[type-env] No fields for class ${currentType} in chain lookup`);
          return undefined;
        }
        const nextType = fields.get(fieldName);
        if (!nextType) {
          logger.debug(`[type-env] No field ${fieldName} in class ${currentType}`);
          return undefined;
        }
        currentType = nextType;
      }

      return currentType;
    },

    allBindings() {
      return env;
    },
  };

  return environment;
}
