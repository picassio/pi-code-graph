import { logger } from '../logger.js';
/**
 * Definition processor for extracting function/class definitions
 * Ported from codebase_rag/parsers/definition_processor.py
 */

import type { Node as TreeSitterNode, Query } from 'web-tree-sitter';
import { SupportedLanguage } from '../constants.js';
import type { LanguageQueries, LanguageSpec, FunctionRegistryTrie, SimpleNameLookup } from '../types.js';
import { NodeType } from '../types.js';
import type {
  IngestorProtocol,
  DefinitionProcessorProtocol,
  ImportProcessorProtocol,
  ClassInheritance,
  QueryCaptures,
  FunctionInfo,
  ClassInfo,
  MethodInfo,
  DependencyInfo,
} from './base.js';
import {
  safeDecodeText,
  safeDecodeWithFallback,
  sortedCaptures,
  isMethodNode,
  getNodeName,
} from './base.js';
import * as cs from '../constants.js';
import { readFile, stat } from 'node:fs/promises';
import { relative, dirname, basename, extname, resolve } from 'node:path';
import { parse } from '../tree-sitter/index.js';
import { extractClassFields, type ClassFieldRegistry } from './type-env.js';
import { buildMethodLocalName, buildQualifiedName, buildModuleQualifiedName, normalizeFilePath, QN_PATH_SEP } from './node-id.js';

// =============================================================================
// Definition Processor Implementation
// =============================================================================

export class DefinitionProcessor implements DefinitionProcessorProtocol {
  readonly repoPath: string;
  readonly projectName: string;
  readonly ingestor: IngestorProtocol;
  readonly functionRegistry: FunctionRegistryTrie;
  readonly simpleNameLookup: SimpleNameLookup;
  readonly importProcessor: ImportProcessorProtocol;
  readonly moduleQnToFilePath: Map<string, string>;
  readonly classInheritance: ClassInheritance = {};
  /** Project-wide class field registry (shared with CallProcessor) */
  readonly classFieldRegistry: ClassFieldRegistry;
  /** Project-wide function return type registry: localName → returnType */
  readonly returnTypeRegistry: Map<string, string>;
  /** Pending interface impls to resolve after all files are processed.
   *  Key: implementer Function QN, Value: short interface name */
  private pendingInterfaceImpls: Array<{ implQn: string; interfaceName: string }> = [];

  constructor(
    ingestor: IngestorProtocol,
    repoPath: string,
    projectName: string,
    functionRegistry: FunctionRegistryTrie,
    simpleNameLookup: SimpleNameLookup,
    importProcessor: ImportProcessorProtocol,
    moduleQnToFilePath: Map<string, string>,
    classFieldRegistry?: ClassFieldRegistry,
    returnTypeRegistry?: Map<string, string>,
  ) {
    this.ingestor = ingestor;
    this.repoPath = repoPath;
    this.projectName = projectName;
    this.functionRegistry = functionRegistry;
    this.simpleNameLookup = simpleNameLookup;
    this.importProcessor = importProcessor;
    this.moduleQnToFilePath = moduleQnToFilePath;
    this.classFieldRegistry = classFieldRegistry ?? new Map();
    this.returnTypeRegistry = returnTypeRegistry ?? new Map();
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  async processFile(
    filePath: string,
    language: SupportedLanguage,
    queries: Map<SupportedLanguage, LanguageQueries>,
    structuralElements: Map<string, string | null>
  ): Promise<[TreeSitterNode, SupportedLanguage] | null> {
    const relativePath = relative(this.repoPath, filePath);
    const fileName = basename(filePath);

    logger.info(`Parsing ${language} AST: ${relativePath}`);

    try {
      const langQueries = queries.get(language);
      if (!langQueries) {
        logger.warn(`Unsupported language ${language} for ${filePath}`);
        return null;
      }

      // Read and parse the file
      const sourceCode = await readFile(filePath, 'utf-8');
      const tree = await parse(sourceCode, language);
      const rootNode = tree.rootNode;

      // Build module qualified name
      let moduleQn = this.buildModuleQn(relativePath, fileName);
      this.moduleQnToFilePath.set(moduleQn, filePath);

      // Create module node
      this.ingestor.ensureNodeBatch(cs.NodeLabel.MODULE, {
        [cs.KEY_QUALIFIED_NAME]: moduleQn,
        [cs.KEY_NAME]: fileName,
        [cs.KEY_PATH]: relativePath,
        [cs.KEY_ABSOLUTE_PATH]: resolve(filePath),
        [cs.KEY_PROJECT]: this.projectName,
        [cs.KEY_FILE_PATH]: relativePath,
      });

      // Link module to parent container
      const parentRelPath = dirname(relativePath);
      const parentContainerQn = structuralElements.get(parentRelPath) ?? null;
      const parentIdentifier = this.getParentIdentifier(parentRelPath, parentContainerQn);

      this.ingestor.ensureRelationshipBatch(
        parentIdentifier,
        cs.RelationshipType.CONTAINS_MODULE,
        [cs.NodeLabel.MODULE, cs.KEY_QUALIFIED_NAME, moduleQn]
      );

      // Parse imports
      this.importProcessor.parseImports(rootNode, moduleQn, language, queries);

      // Ingest all functions
      await this.ingestAllFunctions(rootNode, moduleQn, relativePath, language, queries);

      // Ingest all classes and their methods
      await this.ingestClassesAndMethods(rootNode, moduleQn, relativePath, language, queries);

      // Ingest module-level typed constants that implement interfaces via object literal
      // (Bug #5 fix): `export const foo: SomeInterface = { ... }`
      if (language === SupportedLanguage.TS || language === SupportedLanguage.JS) {
        await this.ingestInterfaceObjectLiterals(rootNode, moduleQn, relativePath, language);
      }

      return [rootNode, language];
    } catch (error) {
      logger.error(`Failed to parse ${filePath}:`, error);
      return null;
    }
  }

  async processDependencies(filepath: string): Promise<void> {
    logger.info(`Parsing dependency file: ${filepath}`);

    try {
      const dependencies = await this.parseDependencyFile(filepath);

      for (const dep of dependencies) {
        this.addDependency(dep.name, dep.spec, dep.properties);
      }
    } catch (error) {
      logger.error(`Failed to parse dependencies from ${filepath}:`, error);
    }
  }

  // ===========================================================================
  // Function Ingestion
  // ===========================================================================

  private async ingestAllFunctions(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    rootNode: TreeSitterNode,
    moduleQn: string,
    relativePath: string,
    language: SupportedLanguage,
    queries: Map<SupportedLanguage, LanguageQueries>
  ): Promise<void> {
    const normalizedFilePath = normalizeFilePath(relativePath);
    const langQueries = queries.get(language);
    if (!langQueries?.functions) return;

    const matches = langQueries.functions.matches(rootNode);
    const captures = this.extractCaptures(matches);
    const funcNodes = captures[cs.CAPTURE_FUNCTION] ?? [];
    const config = langQueries.config;

    for (const funcNode of funcNodes) {
      // Skip methods (inside classes)
      if (isMethodNode(funcNode, config)) {
        continue;
      }

      const funcName = this.extractFunctionName(funcNode, language);
      if (!funcName) continue;

      // Build qualified name (handling nested functions)
      const funcQn = this.buildNestedQualifiedName(funcNode, moduleQn, funcName, config);
      if (!funcQn) continue;

      // Extract function info
      const info = this.extractFunctionInfo(funcNode, funcName, funcQn, config);

      // Register function
      this.functionRegistry.set(funcQn, 'Function' as NodeType);
      this.registerSimpleName(funcName, funcQn);

      // Extract return type for Tier 3 variable inference
      // (used by CallProcessor: const x = fn() → x: ReturnType)
      if (language === SupportedLanguage.TS || language === SupportedLanguage.JS) {
        const returnType = this.extractFunctionReturnType(funcNode);
        if (returnType) {
          this.returnTypeRegistry.set(funcName, returnType);
        }
      }

      // Create function node
      this.ingestor.ensureNodeBatch(cs.NodeLabel.FUNCTION, {
        [cs.KEY_QUALIFIED_NAME]: funcQn,
        [cs.KEY_NAME]: funcName,
        [cs.KEY_START_LINE]: info.startLine,
        [cs.KEY_END_LINE]: info.endLine,
        [cs.KEY_PARAMETERS]: info.parameters.join(', '),
        [cs.KEY_DECORATORS]: info.decorators.join(', '),
        [cs.KEY_DOCSTRING]: info.docstring,
        [cs.KEY_IS_EXPORTED]: info.isExported,
        [cs.KEY_PROJECT]: this.projectName,
        [cs.KEY_FILE_PATH]: normalizedFilePath,
        [cs.KEY_LOCAL_NAME]: funcName,
      });

      // Link to module
      this.ingestor.ensureRelationshipBatch(
        [cs.NodeLabel.MODULE, cs.KEY_QUALIFIED_NAME, moduleQn],
        cs.RelationshipType.DEFINES,
        [cs.NodeLabel.FUNCTION, cs.KEY_QUALIFIED_NAME, funcQn]
      );

      logger.debug(`Found function: ${funcQn}`);
    }
  }

  // ===========================================================================
  // Class Ingestion
  // ===========================================================================

  private async ingestClassesAndMethods(
    rootNode: TreeSitterNode,
    moduleQn: string,
    relativePath: string,
    language: SupportedLanguage,
    queries: Map<SupportedLanguage, LanguageQueries>
  ): Promise<void> {
    const normalizedFilePath = normalizeFilePath(relativePath);
    const langQueries = queries.get(language);
    if (!langQueries?.classes) return;

    const matches = langQueries.classes.matches(rootNode);
    const captures = this.extractCaptures(matches);
    const classNodes = captures[cs.CAPTURE_CLASS] ?? [];
    const config = langQueries.config;

    for (const classNode of classNodes) {
      const className = this.extractClassName(classNode, language);
      if (!className) continue;

      const classQn = buildQualifiedName(normalizedFilePath, className);

      // Extract class info
      const info = this.extractClassInfo(classNode, className, classQn, config, language);

      // Determine the appropriate node label
      const nodeLabel = this.getClassNodeLabel(classNode, language);

      // Register class
      this.functionRegistry.set(classQn, nodeLabel as unknown as NodeType);
      this.registerSimpleName(className, classQn);

      // Track inheritance
      if (info.baseClasses.length > 0) {
        this.classInheritance[classQn] = info.baseClasses;
      }

      // Create class node
      this.ingestor.ensureNodeBatch(nodeLabel, {
        [cs.KEY_QUALIFIED_NAME]: classQn,
        [cs.KEY_NAME]: className,
        [cs.KEY_START_LINE]: info.startLine,
        [cs.KEY_END_LINE]: info.endLine,
        [cs.KEY_DECORATORS]: info.decorators.join(', '),
        [cs.KEY_DOCSTRING]: info.docstring,
        [cs.KEY_IS_EXPORTED]: info.isExported,
        [cs.KEY_PROJECT]: this.projectName,
        [cs.KEY_FILE_PATH]: normalizedFilePath,
        [cs.KEY_LOCAL_NAME]: className,
      });

      // Link to module
      this.ingestor.ensureRelationshipBatch(
        [cs.NodeLabel.MODULE, cs.KEY_QUALIFIED_NAME, moduleQn],
        cs.RelationshipType.DEFINES,
        [nodeLabel, cs.KEY_QUALIFIED_NAME, classQn]
      );

      // Create inheritance relationships
      for (const baseClass of info.baseClasses) {
        const baseClassQn = this.resolveBaseClass(baseClass, moduleQn);
        this.ingestor.ensureRelationshipBatch(
          [nodeLabel, cs.KEY_QUALIFIED_NAME, classQn],
          cs.RelationshipType.INHERITS,
          [cs.NodeLabel.CLASS, cs.KEY_QUALIFIED_NAME, baseClassQn]
        );
      }

      // Create interface implementation relationships
      for (const iface of info.interfaces) {
        const ifaceQn = this.resolveBaseClass(iface, moduleQn);
        this.ingestor.ensureRelationshipBatch(
          [nodeLabel, cs.KEY_QUALIFIED_NAME, classQn],
          cs.RelationshipType.IMPLEMENTS,
          [cs.NodeLabel.INTERFACE, cs.KEY_QUALIFIED_NAME, ifaceQn]
        );
      }

      logger.debug(`Found class: ${classQn}`);

      // Extract class field types for type inference (TS/JS only for now)
      if (language === SupportedLanguage.TS || language === SupportedLanguage.JS) {
        const fields = extractClassFields(classNode);
        if (fields.size > 0) {
          // Store by short class name (for lookup during call resolution)
          this.classFieldRegistry.set(className, fields);
          logger.debug(`Extracted ${fields.size} fields for ${className}`);
        }
      }

      // Process methods inside the class
      logger.info(`Processing methods for class: ${classQn} (label=${nodeLabel})`);
      await this.ingestMethodsInClass(classNode, classQn, className, moduleQn, relativePath, language, queries, nodeLabel);
    }
  }

  private async ingestMethodsInClass(
    classNode: TreeSitterNode,
    classQn: string,
    className: string,
    moduleQn: string,
    relativePath: string,
    language: SupportedLanguage,
    queries: Map<SupportedLanguage, LanguageQueries>,
    classLabel: string = cs.NodeLabel.CLASS
  ): Promise<void> {
    const normalizedFilePath = normalizeFilePath(relativePath);
    const langQueries = queries.get(language);
    if (!langQueries?.functions) return;

    const bodyNode = classNode.childForFieldName('body');
    const searchNode = bodyNode ?? classNode;

    const matches = langQueries.functions.matches(searchNode);
    const captures = this.extractCaptures(matches);
    const methodNodes = captures[cs.CAPTURE_FUNCTION] ?? [];
    const config = langQueries.config;

    logger.info(`  Methods query found ${methodNodes.length} nodes in ${classQn} (bodyNode=${bodyNode?.type ?? 'null'}, searchNode=${searchNode.type})`);

    for (const methodNode of methodNodes) {
      const methodName = this.extractFunctionName(methodNode, language);
      if (!methodName) {
        logger.info(`  Skipping unnamed method node: ${methodNode.type}`);
        continue;
      }

      // Ensure this method is a direct child of this class (not nested in another)
      const isDirect = this.isDirectMethodOfClass(methodNode, classNode, config);
      if (!isDirect) {
        logger.info(`  Skipping non-direct method: ${methodName} (type=${methodNode.type}, parent=${methodNode.parent?.type})`);
        continue;
      }

      const methodQn = `${classQn}${cs.SEPARATOR_DOT}${methodName}`;

      // Extract method info
      const info = this.extractFunctionInfo(methodNode, methodName, methodQn, config);

      // Register method
      this.functionRegistry.set(methodQn, 'Method' as NodeType);
      this.registerSimpleName(methodName, methodQn);

      // Extract return type for Tier 3 variable inference
      if (language === SupportedLanguage.TS || language === SupportedLanguage.JS) {
        const returnType = this.extractFunctionReturnType(methodNode);
        if (returnType) {
          // Store by both Class.method and bare methodName for flexible lookup
          this.returnTypeRegistry.set(`${className}${cs.SEPARATOR_DOT}${methodName}`, returnType);
          // Only register bare name if not a common name that would collide
          if (!this.returnTypeRegistry.has(methodName)) {
            this.returnTypeRegistry.set(methodName, returnType);
          }
        }
      }

      // Create method node
      this.ingestor.ensureNodeBatch(cs.NodeLabel.METHOD, {
        [cs.KEY_QUALIFIED_NAME]: methodQn,
        [cs.KEY_NAME]: methodName,
        [cs.KEY_START_LINE]: info.startLine,
        [cs.KEY_END_LINE]: info.endLine,
        [cs.KEY_PARAMETERS]: info.parameters.join(', '),
        [cs.KEY_DECORATORS]: info.decorators.join(', '),
        [cs.KEY_DOCSTRING]: info.docstring,
        [cs.KEY_IS_EXPORTED]: info.isExported,
        [cs.KEY_PROJECT]: this.projectName,
        [cs.KEY_FILE_PATH]: normalizedFilePath,
        [cs.KEY_LOCAL_NAME]: buildMethodLocalName(className, methodName),
      });

      // Link to class (use actual label, not hardcoded CLASS)
      this.ingestor.ensureRelationshipBatch(
        [classLabel, cs.KEY_QUALIFIED_NAME, classQn],
        cs.RelationshipType.DEFINES_METHOD,
        [cs.NodeLabel.METHOD, cs.KEY_QUALIFIED_NAME, methodQn]
      );

      logger.info(`Found method: ${methodQn} (class=${classQn})`);
    }
  }

  // ===========================================================================
  // Helper Methods
  // ===========================================================================

  /**
   * Called after all files are processed in pass 2. Resolves pending
   * IMPLEMENTS relationships from object literal const declarations to interfaces
   * (which may have been defined in files processed later).
   */
  resolveDeferredInterfaceImpls(): number {
    // Dedup pending impls (the AST walk can visit the same node multiple times,
    // and files can be visited through multiple paths in monorepos)
    const seenPairs = new Set<string>();
    let resolved = 0;
    for (const { implQn, interfaceName } of this.pendingInterfaceImpls) {
      const pairKey = `${implQn}|${interfaceName}`;
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);

      const allCandidates = this.functionRegistry.findEndingWith(interfaceName);
      const ifaceCandidates = allCandidates.filter((qn) => {
        const t = this.functionRegistry.get(qn);
        return t === NodeType.INTERFACE || String(t) === 'Interface';
      });
      // Dedup interface candidates
      const uniqueIfaces = Array.from(new Set(ifaceCandidates));
      for (const ifaceQn of uniqueIfaces) {
        this.ingestor.ensureRelationshipBatch(
          [cs.NodeLabel.FUNCTION, cs.KEY_QUALIFIED_NAME, implQn],
          cs.RelationshipType.IMPLEMENTS,
          [cs.NodeLabel.INTERFACE, cs.KEY_QUALIFIED_NAME, ifaceQn],
        );
        resolved++;
      }
    }
    this.pendingInterfaceImpls = [];
    return resolved;
  }

  private buildModuleQn(relativePath: string, _fileName: string): string {
    // New format: module QN is the normalized file path (e.g., 'src/lib/foo.ts')
    return buildModuleQualifiedName(relativePath);
  }

  /**
   * Walk the AST to find module-level typed constants that are object literals
   * annotated with an interface type, and create IMPLEMENTS relationships.
   *
   * Handles the idiomatic TypeScript pattern:
   *   export const anthropicOAuthProvider: OAuthProviderInterface = {
   *     id: 'anthropic',
   *     login(...) { ... },
   *     refreshToken(...) { ... }
   *   }
   *
   * Creates:
   *  - A Function node for the const (treating it as a module-level export)
   *  - An IMPLEMENTS relationship from the Function node to the Interface
   *  - Method nodes for each property that is a function/arrow (e.g. login, refreshToken)
   *  - DEFINES_METHOD relationships from the Function to the methods
   */
  private async ingestInterfaceObjectLiterals(
    rootNode: TreeSitterNode,
    moduleQn: string,
    relativePath: string,
    language: SupportedLanguage,
  ): Promise<void> {
    const normalizedFilePath = normalizeFilePath(relativePath);

    // Find const declarations with interface types throughout the file.
    // We descend into function/method bodies AND into class method bodies to catch:
    //   function foo() { const provider: SomeInterface = { ... }; return provider; }
    //   class Foo { method() { const x: Interface = { ... }; ... } }
    // We only skip interface_declaration (no nested const can exist inside an interface).
    const walk = (node: TreeSitterNode, isExported: boolean): void => {
      // Skip interface body — it has no executable code, only type signatures
      if (node.type === 'interface_declaration') {
        return;
      }

      // Handle export statements: `export const x: Interface = {}`
      if (node.type === 'export_statement') {
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child) walk(child, true);
        }
        return;
      }

      // Look for lexical_declaration / variable_declaration
      if (
        node.type === 'lexical_declaration' ||
        node.type === 'variable_declaration'
      ) {
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child && child.type === 'variable_declarator') {
            this.processInterfaceConstDeclarator(
              child,
              moduleQn,
              normalizedFilePath,
              isExported,
            );
          }
        }
        // Note: do NOT return here — the declarator's value (e.g. a function expression
        // initializer) might also contain nested interface impls. Fall through to recurse.
      }

      // Recurse into children (including function/method bodies)
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) walk(child, isExported);
      }
    };

    walk(rootNode, false);
  }

  /**
   * Process a single variable_declarator to check if it's an interface-typed object literal.
   */
  private processInterfaceConstDeclarator(
    declNode: TreeSitterNode,
    moduleQn: string,
    normalizedFilePath: string,
    isExported: boolean,
  ): void {
    // Get variable name
    const nameNode = declNode.childForFieldName('name');
    if (!nameNode || nameNode.type !== 'identifier') return;
    const varName = nameNode.text;
    if (!varName) return;

    // Must have an interface type annotation
    const interfaceName = this.extractDeclaratorInterfaceType(declNode);
    if (!interfaceName) return;

    // Must initialize with an object literal
    const valueNode = declNode.childForFieldName('value');
    if (!valueNode || valueNode.type !== 'object') return;

    // We have a valid pattern: const varName: Interface = { ... }
    const varQn = `${normalizedFilePath}${QN_PATH_SEP}${varName}`;

    // Create a Function node for the const (treat it as a module-level definition)
    const startLine = declNode.startPosition.row + 1;
    const endLine = declNode.endPosition.row + 1;

    this.functionRegistry.set(varQn, 'Function' as NodeType);
    this.registerSimpleName(varName, varQn);

    // Track the interface implementation in the class field registry so deep
    // chain resolution can walk through instances of this type
    // (e.g. provider.refreshToken() when provider is assigned this const)
    this.returnTypeRegistry.set(varName, interfaceName);

    this.ingestor.ensureNodeBatch(cs.NodeLabel.FUNCTION, {
      [cs.KEY_QUALIFIED_NAME]: varQn,
      [cs.KEY_NAME]: varName,
      [cs.KEY_START_LINE]: startLine,
      [cs.KEY_END_LINE]: endLine,
      [cs.KEY_PARAMETERS]: '',
      [cs.KEY_DECORATORS]: '',
      [cs.KEY_DOCSTRING]: `Object literal implementing ${interfaceName}`,
      [cs.KEY_IS_EXPORTED]: isExported,
      [cs.KEY_PROJECT]: this.projectName,
      [cs.KEY_FILE_PATH]: normalizedFilePath,
      [cs.KEY_LOCAL_NAME]: varName,
    });

    // Link to module
    this.ingestor.ensureRelationshipBatch(
      [cs.NodeLabel.MODULE, cs.KEY_QUALIFIED_NAME, moduleQn],
      cs.RelationshipType.DEFINES,
      [cs.NodeLabel.FUNCTION, cs.KEY_QUALIFIED_NAME, varQn],
    );

    // Defer IMPLEMENTS resolution: the interface might be defined in a file that
    // hasn't been processed yet. We resolve all pending impls at the end of pass 2.
    this.pendingInterfaceImpls.push({ implQn: varQn, interfaceName });

    // Walk the object literal body and extract method-like properties
    this.extractObjectLiteralMethods(
      valueNode,
      varQn,
      varName,
      normalizedFilePath,
    );

    logger.debug(
      `Found object-literal interface impl: ${varName}: ${interfaceName}`,
    );
  }

  /**
   * Extract the interface name from a variable_declarator's type annotation.
   * Only returns a name if the type looks like an interface (simple identifier).
   */
  private extractDeclaratorInterfaceType(declNode: TreeSitterNode): string | null {
    // Try 'type' field first
    const typeAnnNode = declNode.childForFieldName('type');
    if (typeAnnNode) {
      const inner = typeAnnNode.namedChild(0) ?? typeAnnNode;
      return this.simplifyType(inner.text);
    }
    // Walk children for type_annotation
    for (let i = 0; i < declNode.childCount; i++) {
      const c = declNode.child(i);
      if (c && c.type === 'type_annotation') {
        const inner = c.namedChild(0);
        if (inner) return this.simplifyType(inner.text);
      }
    }
    return null;
  }

  /**
   * Walk an object literal and create Method nodes for each property that is a function.
   * Handles:
   *  { foo() { ... } }     — method_definition
   *  { foo: () => { } }    — arrow_function
   *  { foo: function() {} } — function_expression
   */
  private extractObjectLiteralMethods(
    objectNode: TreeSitterNode,
    containerQn: string,
    containerName: string,
    normalizedFilePath: string,
  ): void {
    for (let i = 0; i < objectNode.childCount; i++) {
      const child = objectNode.child(i);
      if (!child) continue;

      // Shorthand method: { foo() { ... } }
      if (child.type === 'method_definition') {
        const nameNode = child.childForFieldName('name');
        if (nameNode && nameNode.text) {
          this.registerObjectLiteralMethod(
            child,
            nameNode.text,
            containerQn,
            containerName,
            normalizedFilePath,
          );
        }
        continue;
      }

      // Property: foo: fn
      if (child.type === 'pair') {
        const keyNode = child.childForFieldName('key');
        const valueNode = child.childForFieldName('value');
        if (!keyNode || !valueNode) continue;
        const propName = keyNode.text;
        if (!propName) continue;

        if (
          valueNode.type === 'arrow_function' ||
          valueNode.type === 'function_expression'
        ) {
          this.registerObjectLiteralMethod(
            valueNode,
            propName,
            containerQn,
            containerName,
            normalizedFilePath,
          );
        }
      }
    }
  }

  /**
   * Register a single method from an object literal.
   */
  private registerObjectLiteralMethod(
    methodNode: TreeSitterNode,
    methodName: string,
    containerQn: string,
    containerName: string,
    normalizedFilePath: string,
  ): void {
    const localName = `${containerName}${cs.SEPARATOR_DOT}${methodName}`;
    const methodQn = `${normalizedFilePath}${QN_PATH_SEP}${localName}`;

    this.functionRegistry.set(methodQn, 'Method' as NodeType);
    this.registerSimpleName(methodName, methodQn);

    const startLine = methodNode.startPosition.row + 1;
    const endLine = methodNode.endPosition.row + 1;

    this.ingestor.ensureNodeBatch(cs.NodeLabel.METHOD, {
      [cs.KEY_QUALIFIED_NAME]: methodQn,
      [cs.KEY_NAME]: methodName,
      [cs.KEY_START_LINE]: startLine,
      [cs.KEY_END_LINE]: endLine,
      [cs.KEY_PARAMETERS]: '',
      [cs.KEY_DECORATORS]: '',
      [cs.KEY_DOCSTRING]: null,
      [cs.KEY_IS_EXPORTED]: false,
      [cs.KEY_PROJECT]: this.projectName,
      [cs.KEY_FILE_PATH]: normalizedFilePath,
      [cs.KEY_LOCAL_NAME]: localName,
    });

    // Link method to the container (as if container were a class)
    this.ingestor.ensureRelationshipBatch(
      [cs.NodeLabel.FUNCTION, cs.KEY_QUALIFIED_NAME, containerQn],
      cs.RelationshipType.DEFINES_METHOD,
      [cs.NodeLabel.METHOD, cs.KEY_QUALIFIED_NAME, methodQn],
    );
  }

  /**
   * Extract the return type annotation from a function/method node.
   * Returns null if no annotation present or type can't be simplified.
   *
   * Handles common TypeScript patterns:
   *   function foo(): User { ... }              → 'User'
   *   async function foo(): Promise<User> { }  → 'User'  (unwraps Promise)
   *   method(): User | null { }                 → 'User'  (strips nullable)
   *   function foo(): User[] { }                → 'User'  (strips array)
   */
  private extractFunctionReturnType(funcNode: TreeSitterNode): string | null {
    // TypeScript grammar uses 'return_type' field
    const returnTypeNode = funcNode.childForFieldName('return_type');
    if (!returnTypeNode) return null;

    // return_type is usually a type_annotation wrapping the actual type
    const typeNode = returnTypeNode.namedChild(0) ?? returnTypeNode;
    if (!typeNode) return null;

    return this.simplifyType(typeNode.text);
  }

  /**
   * Simplify a type string to a base identifier.
   * Strips Promise/Array wrappers, nullable markers, and generic args.
   */
  private simplifyType(text: string): string | null {
    if (!text) return null;
    let t = text.trim();

    // Strip union with null/undefined: 'User | null' → 'User'
    if (t.includes('|')) {
      const parts = t
        .split('|')
        .map((p) => p.trim())
        .filter((p) => p && p !== 'null' && p !== 'undefined' && p !== 'void');
      if (parts.length > 0) t = parts[0]!;
    }
    // Strip trailing ?
    t = t.replace(/\?$/, '').trim();
    // Strip array suffix
    t = t.replace(/\[\]$/, '').trim();
    // Strip Promise/Array/Awaited wrapper: 'Promise<User>' → 'User'
    const m = t.match(/^(?:Promise|Array|Awaited|Readonly|Partial)<(.+)>$/);
    if (m) {
      t = m[1]!.trim();
      if (t.includes('|')) {
        const parts = t
          .split('|')
          .map((p) => p.trim())
          .filter((p) => p && p !== 'null' && p !== 'undefined' && p !== 'void');
        if (parts.length > 0) t = parts[0]!;
      }
    }
    // Strip any remaining generic args: 'Foo<T>' → 'Foo'
    t = t.replace(/<.*$/, '').trim();
    // Must be simple identifier
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(t)) return t;
    return null;
  }

  private getParentIdentifier(
    parentRelPath: string,
    parentContainerQn: string | null
  ): [cs.NodeLabel, string, string] {
    if (!parentRelPath || parentRelPath === cs.PATH_CURRENT_DIR) {
      return [cs.NodeLabel.PROJECT, cs.KEY_NAME, this.projectName];
    }

    if (parentContainerQn) {
      return [cs.NodeLabel.PACKAGE, cs.KEY_QUALIFIED_NAME, parentContainerQn];
    }

    return [cs.NodeLabel.FOLDER, cs.KEY_PATH, parentRelPath];
  }

  private extractFunctionName(funcNode: TreeSitterNode, language: SupportedLanguage): string | null {
    // Try standard 'name' field
    const nameNode = funcNode.childForFieldName('name');
    if (nameNode) {
      return safeDecodeText(nameNode);
    }

    // Language-specific handling
    if (language === SupportedLanguage.CPP) {
      // For C++, look for function_declarator
      const declarator = funcNode.childForFieldName('declarator');
      if (declarator) {
        const declName = declarator.childForFieldName('declarator');
        if (declName) {
          return safeDecodeText(declName);
        }
      }
    }

    return null;
  }

  private extractClassName(classNode: TreeSitterNode, language: SupportedLanguage): string | null {
    // Try standard 'name' field
    const nameNode = classNode.childForFieldName('name');
    if (nameNode) {
      return safeDecodeText(nameNode);
    }

    // For Rust impl blocks
    if (language === SupportedLanguage.RUST && classNode.type === 'impl_item') {
      const typeNode = classNode.childForFieldName('type');
      if (typeNode) {
        return safeDecodeText(typeNode);
      }

      // Try finding type_identifier child
      for (const child of classNode.children) {
        if (child.type === 'type_identifier' && child.isNamed) {
          return safeDecodeText(child);
        }
      }
    }

    return null;
  }

  private extractFunctionInfo(
    funcNode: TreeSitterNode,
    funcName: string,
    funcQn: string,
    config: LanguageSpec
  ): FunctionInfo {
    return {
      name: funcName,
      qualifiedName: funcQn,
      startLine: funcNode.startPosition.row + 1,
      endLine: funcNode.endPosition.row + 1,
      parameters: this.extractParameters(funcNode),
      decorators: this.extractDecorators(funcNode),
      docstring: this.extractDocstring(funcNode),
      isExported: this.checkIfExported(funcNode),
      isAsync: this.checkIfAsync(funcNode),
    };
  }

  private extractClassInfo(
    classNode: TreeSitterNode,
    className: string,
    classQn: string,
    config: LanguageSpec,
    language: SupportedLanguage
  ): ClassInfo {
    return {
      name: className,
      qualifiedName: classQn,
      startLine: classNode.startPosition.row + 1,
      endLine: classNode.endPosition.row + 1,
      baseClasses: this.extractBaseClasses(classNode, language),
      interfaces: this.extractInterfaces(classNode, language),
      decorators: this.extractDecorators(classNode),
      docstring: this.extractDocstring(classNode),
      isExported: this.checkIfExported(classNode),
    };
  }

  private extractParameters(funcNode: TreeSitterNode): string[] {
    const paramsNode = funcNode.childForFieldName('parameters');
    if (!paramsNode) return [];

    const params: string[] = [];
    for (const child of paramsNode.namedChildren) {
      // Get parameter name
      const nameNode = child.childForFieldName('name') ?? child;
      const name = safeDecodeText(nameNode);
      if (name) {
        params.push(name);
      }
    }
    return params;
  }

  private extractDecorators(node: TreeSitterNode): string[] {
    const decorators: string[] = [];

    // Look for decorator nodes as siblings or children
    let sibling = node.previousNamedSibling;
    while (sibling) {
      if (sibling.type === 'decorator' || sibling.type === 'annotation') {
        const text = safeDecodeText(sibling);
        if (text) {
          decorators.push(text);
        }
      } else if (!sibling.type.includes('decorator') && !sibling.type.includes('annotation')) {
        break;
      }
      sibling = sibling.previousNamedSibling;
    }

    return decorators.reverse();
  }

  private extractDocstring(node: TreeSitterNode): string | null {
    const bodyNode = node.childForFieldName('body');
    if (!bodyNode || !bodyNode.children.length) return null;

    const firstStatement = bodyNode.children[0];
    if (
      firstStatement.type === 'expression_statement' &&
      firstStatement.children[0]?.type === 'string'
    ) {
      const text = safeDecodeWithFallback(firstStatement.children[0]);
      return text.replace(/^['"`]{1,3}|['"`]{1,3}$/g, '').trim();
    }

    return null;
  }

  private checkIfExported(node: TreeSitterNode): boolean {
    // Check if the node or its parent has export keywords
    let current: TreeSitterNode | null = node;
    while (current) {
      if (current.type === 'export_statement' || current.type === 'export') {
        return true;
      }
      // Check for 'pub' keyword in Rust
      for (const child of current.children) {
        if (child.type === 'visibility_modifier' || child.type === 'pub') {
          return true;
        }
      }
      current = current.parent;
    }
    return false;
  }

  private checkIfAsync(funcNode: TreeSitterNode): boolean {
    // Check for async keyword
    for (const child of funcNode.children) {
      if (child.type === 'async') {
        return true;
      }
    }
    // Also check the type
    return funcNode.type.includes('async');
  }

  private extractBaseClasses(classNode: TreeSitterNode, language: SupportedLanguage): string[] {
    const bases: string[] = [];

    // Python: superclasses field
    const superclassesNode = classNode.childForFieldName('superclasses');
    if (superclassesNode) {
      for (const child of superclassesNode.namedChildren) {
        const name = safeDecodeText(child);
        if (name) bases.push(name);
      }
      return bases;
    }

    // Java/TypeScript: superclass/extends
    const superclassNode = classNode.childForFieldName('superclass');
    if (superclassNode) {
      const name = safeDecodeText(superclassNode);
      if (name) bases.push(name);
    }

    // Look for extends clause
    for (const child of classNode.children) {
      if (child.type === 'extends_clause' || child.type === 'superclass') {
        for (const grandchild of child.namedChildren) {
          const name = safeDecodeText(grandchild);
          if (name) bases.push(name);
        }
      }
    }

    return bases;
  }

  private extractInterfaces(classNode: TreeSitterNode, language: SupportedLanguage): string[] {
    const interfaces: string[] = [];

    // Java/TypeScript: implements clause
    const interfacesNode = classNode.childForFieldName('interfaces');
    if (interfacesNode) {
      for (const child of interfacesNode.namedChildren) {
        const name = safeDecodeText(child);
        if (name) interfaces.push(name);
      }
      return interfaces;
    }

    // Look for implements clause
    for (const child of classNode.children) {
      if (child.type === 'implements_clause' || child.type === 'super_interfaces') {
        for (const grandchild of child.namedChildren) {
          const name = safeDecodeText(grandchild);
          if (name) interfaces.push(name);
        }
      }
    }

    return interfaces;
  }

  private getClassNodeLabel(classNode: TreeSitterNode, language: SupportedLanguage): cs.NodeLabel {
    const type = classNode.type;

    if (type.includes('interface')) return cs.NodeLabel.INTERFACE;
    if (type.includes('enum')) return cs.NodeLabel.ENUM;
    if (type.includes('struct') || type.includes('union')) return cs.NodeLabel.CLASS;
    if (type.includes('trait')) return cs.NodeLabel.INTERFACE;
    if (type.includes('type_alias') || type.includes('type_item')) return cs.NodeLabel.TYPE;

    return cs.NodeLabel.CLASS;
  }

  private resolveBaseClass(baseClassName: string, moduleQn: string): string {
    // Try to resolve via imports
    const resolved = this.importProcessor.resolveImport(baseClassName, moduleQn);
    if (resolved) return resolved;

    // Check if it's a local class
    const localQn = buildQualifiedName(moduleQn, baseClassName);
    if (this.functionRegistry.has(localQn)) {
      return localQn;
    }

    // Return as-is (might be a builtin or external)
    return baseClassName;
  }

  private isDirectMethodOfClass(
    methodNode: TreeSitterNode,
    classNode: TreeSitterNode,
    config: LanguageSpec
  ): boolean {
    // Walk up from the method node to find if it's a direct child of classNode
    // Use node ID comparison since tree-sitter .parent returns new wrapper objects
    const classId = classNode.id;
    let current = methodNode.parent;
    while (current) {
      if (current.parent?.id === classId) {
        return true;
      }
      // If we hit another class before the target class, we're nested
      if (config.classNodeTypes.includes(current.type) && current.id !== classId) {
        return false;
      }
      current = current.parent;
    }
    return false;
  }

  private buildNestedQualifiedName(
    funcNode: TreeSitterNode,
    moduleQn: string,
    funcName: string,
    config: LanguageSpec
  ): string | null {
    const pathParts: string[] = [];
    let current = funcNode.parent;

    while (current && !config.moduleNodeTypes.includes(current.type)) {
      if (config.functionNodeTypes.includes(current.type)) {
        const parentName = current.childForFieldName('name');
        if (parentName?.text) {
          pathParts.push(parentName.text);
        }
      } else if (config.classNodeTypes.includes(current.type)) {
        // Function is inside a class - skip (handled as method)
        return null;
      }
      current = current.parent;
    }

    pathParts.reverse();
    const localName = pathParts.length > 0
      ? `${pathParts.join(cs.SEPARATOR_DOT)}${cs.SEPARATOR_DOT}${funcName}`
      : funcName;
    return buildQualifiedName(moduleQn, localName);
  }

  private registerSimpleName(simpleName: string, qualifiedName: string): void {
    let qnSet = this.simpleNameLookup.get(simpleName);
    if (!qnSet) {
      qnSet = new Set();
      this.simpleNameLookup.set(simpleName, qnSet);
    }
    qnSet.add(qualifiedName);
  }

  private addDependency(
    depName: string,
    depSpec: string,
    properties: Record<string, string | number | boolean | string[] | null> | null
  ): void {
    if (!depName || cs.EXCLUDED_DEPENDENCY_NAMES.has(depName.toLowerCase())) {
      return;
    }

    logger.info(`Found dependency: ${depName} (${depSpec})`);

    this.ingestor.ensureNodeBatch(cs.NodeLabel.EXTERNAL_PACKAGE, {
      [cs.KEY_NAME]: depName,
    });

    const relProperties: Record<string, string | number | boolean | null> = {};
    if (depSpec) {
      relProperties[cs.KEY_VERSION_SPEC] = depSpec;
    }
    if (properties) {
      Object.assign(relProperties, properties);
    }

    this.ingestor.ensureRelationshipBatch(
      [cs.NodeLabel.PROJECT, cs.KEY_NAME, this.projectName],
      cs.RelationshipType.DEPENDS_ON_EXTERNAL,
      [cs.NodeLabel.EXTERNAL_PACKAGE, cs.KEY_NAME, depName],
      relProperties
    );
  }

  private async parseDependencyFile(filepath: string): Promise<DependencyInfo[]> {
    const fileName = basename(filepath).toLowerCase();
    const content = await readFile(filepath, 'utf-8');

    switch (fileName) {
      case 'package.json':
        return this.parsePackageJson(content);
      case 'requirements.txt':
        return this.parseRequirementsTxt(content);
      case 'pyproject.toml':
        return this.parsePyprojectToml(content);
      case 'cargo.toml':
        return this.parseCargoToml(content);
      case 'go.mod':
        return this.parseGoMod(content);
      case 'composer.json':
        return this.parseComposerJson(content);
      default:
        if (fileName.endsWith('.csproj')) {
          return this.parseCsproj(content);
        }
        return [];
    }
  }

  // Dependency parsing helpers (simplified implementations)

  private parsePackageJson(content: string): DependencyInfo[] {
    try {
      const pkg = JSON.parse(content);
      const deps: DependencyInfo[] = [];

      for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
        deps.push({ name, spec: String(version), properties: null });
      }
      for (const [name, version] of Object.entries(pkg.devDependencies ?? {})) {
        deps.push({ name, spec: String(version), properties: { dev: true } });
      }
      for (const [name, version] of Object.entries(pkg.peerDependencies ?? {})) {
        deps.push({ name, spec: String(version), properties: { peer: true } });
      }

      return deps;
    } catch {
      return [];
    }
  }

  private parseRequirementsTxt(content: string): DependencyInfo[] {
    const deps: DependencyInfo[] = [];
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;

      // Parse name[extras]>=version format
      const match = trimmed.match(/^([a-zA-Z0-9_-]+)(?:\[.*?\])?(.*)$/);
      if (match) {
        deps.push({ name: match[1], spec: match[2].trim(), properties: null });
      }
    }

    return deps;
  }

  private parsePyprojectToml(content: string): DependencyInfo[] {
    // Simplified TOML parsing - would need a proper TOML parser in production
    const deps: DependencyInfo[] = [];

    // Simple regex-based extraction
    const depSection = content.match(/\[project\][\s\S]*?dependencies\s*=\s*\[([\s\S]*?)\]/);
    if (depSection) {
      const depsString = depSection[1];
      const depLines = depsString.match(/"([^"]+)"/g) ?? [];
      for (const dep of depLines) {
        const cleanDep = dep.replace(/"/g, '');
        const match = cleanDep.match(/^([a-zA-Z0-9_-]+)(.*)$/);
        if (match) {
          deps.push({ name: match[1], spec: match[2].trim(), properties: null });
        }
      }
    }

    return deps;
  }

  private parseCargoToml(content: string): DependencyInfo[] {
    const deps: DependencyInfo[] = [];

    // Simple regex-based extraction for [dependencies] section
    const depSection = content.match(/\[dependencies\]([\s\S]*?)(?:\[|$)/);
    if (depSection) {
      const lines = depSection[1].split('\n');
      for (const line of lines) {
        const match = line.match(/^([a-zA-Z0-9_-]+)\s*=\s*["']?([^"'\n]+)["']?/);
        if (match) {
          deps.push({ name: match[1], spec: match[2], properties: null });
        }
      }
    }

    return deps;
  }

  private parseGoMod(content: string): DependencyInfo[] {
    const deps: DependencyInfo[] = [];
    const lines = content.split('\n');

    for (const line of lines) {
      const match = line.match(/^\s+([^\s]+)\s+v?([^\s]+)/);
      if (match) {
        deps.push({ name: match[1], spec: match[2], properties: null });
      }
    }

    return deps;
  }

  private parseComposerJson(content: string): DependencyInfo[] {
    try {
      const composer = JSON.parse(content);
      const deps: DependencyInfo[] = [];

      for (const [name, version] of Object.entries(composer.require ?? {})) {
        deps.push({ name, spec: String(version), properties: null });
      }
      for (const [name, version] of Object.entries(composer['require-dev'] ?? {})) {
        deps.push({ name, spec: String(version), properties: { dev: true } });
      }

      return deps;
    } catch {
      return [];
    }
  }

  private parseCsproj(content: string): DependencyInfo[] {
    const deps: DependencyInfo[] = [];

    const packageRefs = content.matchAll(/<PackageReference\s+Include="([^"]+)"(?:\s+Version="([^"]+)")?/g);
    for (const match of packageRefs) {
      deps.push({ name: match[1], spec: match[2] ?? '', properties: null });
    }

    return deps;
  }

  private extractCaptures(
    matches: Array<{ captures: Array<{ node: TreeSitterNode; name: string }> }>
  ): QueryCaptures {
    const allCaptures: Array<{ node: TreeSitterNode; name: string }> = [];
    for (const match of matches) {
      for (const capture of match.captures) {
        allCaptures.push({ node: capture.node, name: capture.name });
      }
    }
    return sortedCaptures(allCaptures);
  }
}

// =============================================================================
// Factory Function
// =============================================================================

export function createDefinitionProcessor(
  ingestor: IngestorProtocol,
  repoPath: string,
  projectName: string,
  functionRegistry: FunctionRegistryTrie,
  simpleNameLookup: SimpleNameLookup,
  importProcessor: ImportProcessorProtocol,
  moduleQnToFilePath: Map<string, string>
): DefinitionProcessor {
  return new DefinitionProcessor(
    ingestor,
    repoPath,
    projectName,
    functionRegistry,
    simpleNameLookup,
    importProcessor,
    moduleQnToFilePath
  );
}
