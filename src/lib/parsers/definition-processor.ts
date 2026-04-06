import { logger } from '../logger.js';
/**
 * Definition processor for extracting function/class definitions
 * Ported from codebase_rag/parsers/definition_processor.py
 */

import type { Node as TreeSitterNode, Query } from 'web-tree-sitter';
import { SupportedLanguage } from '../constants.js';
import type { LanguageQueries, LanguageSpec, FunctionRegistryTrie, SimpleNameLookup, NodeType } from '../types.js';
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

  constructor(
    ingestor: IngestorProtocol,
    repoPath: string,
    projectName: string,
    functionRegistry: FunctionRegistryTrie,
    simpleNameLookup: SimpleNameLookup,
    importProcessor: ImportProcessorProtocol,
    moduleQnToFilePath: Map<string, string>,
    classFieldRegistry?: ClassFieldRegistry
  ) {
    this.ingestor = ingestor;
    this.repoPath = repoPath;
    this.projectName = projectName;
    this.functionRegistry = functionRegistry;
    this.simpleNameLookup = simpleNameLookup;
    this.importProcessor = importProcessor;
    this.moduleQnToFilePath = moduleQnToFilePath;
    this.classFieldRegistry = classFieldRegistry ?? new Map();
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
      await this.ingestAllFunctions(rootNode, moduleQn, language, queries);

      // Ingest all classes and their methods
      await this.ingestClassesAndMethods(rootNode, moduleQn, language, queries);

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
    rootNode: TreeSitterNode,
    moduleQn: string,
    language: SupportedLanguage,
    queries: Map<SupportedLanguage, LanguageQueries>
  ): Promise<void> {
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
    language: SupportedLanguage,
    queries: Map<SupportedLanguage, LanguageQueries>
  ): Promise<void> {
    const langQueries = queries.get(language);
    if (!langQueries?.classes) return;

    const matches = langQueries.classes.matches(rootNode);
    const captures = this.extractCaptures(matches);
    const classNodes = captures[cs.CAPTURE_CLASS] ?? [];
    const config = langQueries.config;

    for (const classNode of classNodes) {
      const className = this.extractClassName(classNode, language);
      if (!className) continue;

      const classQn = `${moduleQn}${cs.SEPARATOR_DOT}${className}`;

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
      await this.ingestMethodsInClass(classNode, classQn, moduleQn, language, queries, nodeLabel);
    }
  }

  private async ingestMethodsInClass(
    classNode: TreeSitterNode,
    classQn: string,
    moduleQn: string,
    language: SupportedLanguage,
    queries: Map<SupportedLanguage, LanguageQueries>,
    classLabel: string = cs.NodeLabel.CLASS
  ): Promise<void> {
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

  private buildModuleQn(relativePath: string, fileName: string): string {
    // Remove extension and build qualified name
    const parts = relativePath.replace(/\.[^.]+$/, '').split('/').filter(Boolean);

    // Handle special files like __init__.py
    if (fileName === cs.INIT_PY || fileName === cs.MOD_RS) {
      return [this.projectName, ...parts.slice(0, -1)].join(cs.SEPARATOR_DOT);
    }

    return [this.projectName, ...parts].join(cs.SEPARATOR_DOT);
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
    const localQn = `${moduleQn}${cs.SEPARATOR_DOT}${baseClassName}`;
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
    if (pathParts.length > 0) {
      return `${moduleQn}${cs.SEPARATOR_DOT}${pathParts.join(cs.SEPARATOR_DOT)}${cs.SEPARATOR_DOT}${funcName}`;
    }
    return `${moduleQn}${cs.SEPARATOR_DOT}${funcName}`;
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
