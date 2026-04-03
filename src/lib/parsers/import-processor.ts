import { logger } from '../logger.js';
/**
 * Import processor for parsing import statements across languages
 * Ported from codebase_rag/parsers/import_processor.py
 */

import type { Node as TreeSitterNode, Query } from 'web-tree-sitter';
import { SupportedLanguage } from '../constants.js';
import type { LanguageQueries, LanguageSpec } from '../types.js';
import type { FunctionRegistryTrie } from '../types.js';
import type {
  IngestorProtocol,
  ImportProcessorProtocol,
  ImportMapping,
  QueryCaptures,
} from './base.js';
import { safeDecodeText, safeDecodeWithFallback, sortedCaptures } from './base.js';
import * as cs from '../constants.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkspaceMap } from './workspace-resolver.js';

// =============================================================================
// Cache Functions
// =============================================================================

type LocalModuleCache = (moduleName: string) => boolean;

function createLocalModuleCache(repoPath: string): LocalModuleCache {
  const cache = new Map<string, boolean>();

  return (moduleName: string): boolean => {
    const cached = cache.get(moduleName);
    if (cached !== undefined) {
      return cached;
    }

    const isLocal =
      existsSync(join(repoPath, moduleName)) ||
      existsSync(join(repoPath, `${moduleName}${cs.EXT_PY}`)) ||
      existsSync(join(repoPath, moduleName, cs.INIT_PY));

    cache.set(moduleName, isLocal);
    return isLocal;
  };
}

function createLocalJavaImportCache(repoPath: string): LocalModuleCache {
  const cache = new Map<string, boolean>();

  return (importPath: string): boolean => {
    const cached = cache.get(importPath);
    if (cached !== undefined) {
      return cached;
    }

    const topLevel = importPath.split(cs.SEPARATOR_DOT)[0];
    const isLocal = existsSync(join(repoPath, topLevel));
    cache.set(importPath, isLocal);
    return isLocal;
  };
}

// =============================================================================
// Import Processor Implementation
// =============================================================================

export class ImportProcessor implements ImportProcessorProtocol {
  readonly repoPath: string;
  readonly projectName: string;
  readonly ingestor: IngestorProtocol;
  readonly functionRegistry: FunctionRegistryTrie | null;
  readonly importMapping: ImportMapping = {};

  private isLocalModule: LocalModuleCache;
  private isLocalJavaImport: LocalModuleCache;
  private workspaceMap: WorkspaceMap | null;

  constructor(
    repoPath: string,
    projectName: string,
    ingestor: IngestorProtocol,
    functionRegistry: FunctionRegistryTrie | null = null,
    workspaceMap: WorkspaceMap | null = null
  ) {
    this.repoPath = repoPath;
    this.projectName = projectName;
    this.ingestor = ingestor;
    this.functionRegistry = functionRegistry;
    this.isLocalModule = createLocalModuleCache(repoPath);
    this.isLocalJavaImport = createLocalJavaImportCache(repoPath);
    this.workspaceMap = workspaceMap;
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  parseImports(
    rootNode: TreeSitterNode,
    moduleQn: string,
    language: SupportedLanguage,
    queries: Map<SupportedLanguage, LanguageQueries>
  ): void {
    const langQueries = queries.get(language);
    if (!langQueries?.imports) {
      return;
    }

    const config = langQueries.config;
    this.importMapping[moduleQn] = {};

    try {
      const matches = langQueries.imports.matches(rootNode);
      const captures = this.extractCaptures(matches);

      switch (language) {
        case SupportedLanguage.PYTHON:
          this.parsePythonImports(captures, moduleQn);
          break;
        case SupportedLanguage.JS:
        case SupportedLanguage.TS:
          this.parseJsTsImports(captures, moduleQn);
          break;
        case SupportedLanguage.JAVA:
          this.parseJavaImports(captures, moduleQn);
          break;
        case SupportedLanguage.RUST:
          this.parseRustImports(captures, moduleQn);
          break;
        case SupportedLanguage.GO:
          this.parseGoImports(captures, moduleQn);
          break;
        case SupportedLanguage.CPP:
        case SupportedLanguage.C:
          this.parseCppImports(captures, moduleQn);
          break;
        case SupportedLanguage.PHP:
          this.parsePhpImports(captures, moduleQn);
          break;
        case SupportedLanguage.LUA:
          this.parseLuaImports(captures, moduleQn);
          break;
        default:
          this.parseGenericImports(captures, moduleQn, config);
      }

      // Create IMPORTS relationships
      for (const fullName of Object.values(this.importMapping[moduleQn])) {
        const modulePath = this.resolveModulePath(fullName, moduleQn, language);
        this.ingestor.ensureRelationshipBatch(
          [cs.NodeLabel.MODULE, cs.KEY_QUALIFIED_NAME, moduleQn],
          cs.RelationshipType.IMPORTS,
          [cs.NodeLabel.MODULE, cs.KEY_QUALIFIED_NAME, modulePath]
        );
      }
    } catch (error) {
      logger.warn(`Failed to parse imports for ${moduleQn}:`, error);
    }
  }

  resolveImport(localName: string, moduleQn: string): string | null {
    const moduleImports = this.importMapping[moduleQn];
    if (!moduleImports) {
      return null;
    }
    return moduleImports[localName] ?? null;
  }

  // ===========================================================================
  // Python Import Parsing
  // ===========================================================================

  private parsePythonImports(captures: QueryCaptures, moduleQn: string): void {
    const importNodes = [
      ...(captures[cs.CAPTURE_IMPORT] ?? []),
      ...(captures[cs.CAPTURE_IMPORT_FROM] ?? []),
    ];

    for (const importNode of importNodes) {
      if (importNode.type === 'import_statement') {
        this.handlePythonImportStatement(importNode, moduleQn);
      } else if (importNode.type === 'import_from_statement') {
        this.handlePythonImportFromStatement(importNode, moduleQn);
      }
    }
  }

  private handlePythonImportStatement(importNode: TreeSitterNode, moduleQn: string): void {
    for (const child of importNode.namedChildren) {
      if (child.type === 'dotted_name') {
        const moduleName = safeDecodeText(child) ?? '';
        const localName = moduleName.split(cs.SEPARATOR_DOT)[0];
        const fullName = this.resolveImportFullName(moduleName, localName);
        this.importMapping[moduleQn][localName] = fullName;
      } else if (child.type === 'aliased_import') {
        const moduleNameNode = child.childForFieldName('name');
        const aliasNode = child.childForFieldName('alias');
        if (moduleNameNode && aliasNode) {
          const moduleName = safeDecodeText(moduleNameNode) ?? '';
          const alias = safeDecodeText(aliasNode) ?? '';
          const topLevel = moduleName.split(cs.SEPARATOR_DOT)[0];
          const fullName = this.resolveImportFullName(moduleName, topLevel);
          this.importMapping[moduleQn][alias] = fullName;
        }
      }
    }
  }

  private handlePythonImportFromStatement(importNode: TreeSitterNode, moduleQn: string): void {
    const moduleNameNode = importNode.childForFieldName('module_name');
    if (!moduleNameNode) return;

    let moduleName: string | null = null;
    if (moduleNameNode.type === 'dotted_name') {
      moduleName = safeDecodeText(moduleNameNode);
    } else if (moduleNameNode.type === 'relative_import') {
      moduleName = this.resolveRelativeImport(moduleNameNode, moduleQn);
    }
    if (!moduleName) return;

    // Check for wildcard import
    const isWildcard = importNode.children.some((c) => c.type === 'wildcard_import');
    if (isWildcard) {
      const baseModule = this.resolvePythonBaseModule(moduleName);
      const wildcardKey = `*${baseModule}`;
      this.importMapping[moduleQn][wildcardKey] = baseModule;
      return;
    }

    // Extract imported items
    const importedItems: Array<[string, string]> = [];
    for (const nameNode of importNode.childrenForFieldName('name')) {
      const item = this.extractSinglePythonImport(nameNode);
      if (item) {
        importedItems.push(item);
      }
    }

    if (importedItems.length === 0) return;

    const baseModule = this.resolvePythonBaseModule(moduleName);
    for (const [localName, originalName] of importedItems) {
      const fullName = `${baseModule}${cs.SEPARATOR_DOT}${originalName}`;
      this.importMapping[moduleQn][localName] = fullName;
    }
  }

  private extractSinglePythonImport(nameNode: TreeSitterNode): [string, string] | null {
    if (nameNode.type === 'dotted_name') {
      const name = safeDecodeText(nameNode);
      if (name) return [name, name];
    } else if (nameNode.type === 'aliased_import') {
      const originalNode = nameNode.childForFieldName('name');
      const aliasNode = nameNode.childForFieldName('alias');
      if (originalNode && aliasNode) {
        const original = safeDecodeText(originalNode);
        const alias = safeDecodeText(aliasNode);
        if (original && alias) return [alias, original];
      }
    }
    return null;
  }

  private resolveRelativeImport(relativeNode: TreeSitterNode, moduleQn: string): string {
    const moduleParts = moduleQn.split(cs.SEPARATOR_DOT).slice(1);
    let dots = 0;
    let moduleName = '';

    for (const child of relativeNode.children) {
      if (child.type === 'import_prefix') {
        const text = safeDecodeText(child);
        if (text) dots = text.length;
      } else if (child.type === 'dotted_name') {
        moduleName = safeDecodeText(child) ?? '';
      }
    }

    const targetParts = dots > 0 ? moduleParts.slice(0, -dots) : [...moduleParts];
    if (moduleName) {
      targetParts.push(...moduleName.split(cs.SEPARATOR_DOT));
    }
    return targetParts.join(cs.SEPARATOR_DOT);
  }

  private resolvePythonBaseModule(moduleName: string): string {
    if (moduleName.startsWith(this.projectName)) {
      return moduleName;
    }
    const topLevel = moduleName.split(cs.SEPARATOR_DOT)[0];
    return this.resolveImportFullName(moduleName, topLevel);
  }

  private resolveImportFullName(moduleName: string, topLevel: string): string {
    if (this.isLocalModule(topLevel)) {
      return `${this.projectName}${cs.SEPARATOR_DOT}${moduleName}`;
    }
    return moduleName;
  }

  // ===========================================================================
  // JavaScript/TypeScript Import Parsing
  // ===========================================================================

  private parseJsTsImports(captures: QueryCaptures, moduleQn: string): void {
    const importNodes = captures[cs.CAPTURE_IMPORT] ?? [];

    for (const importNode of importNodes) {
      if (importNode.type === 'import_statement') {
        let sourceModule: string | null = null;

        for (const child of importNode.children) {
          if (child.type === 'string') {
            const sourceText = safeDecodeWithFallback(child).replace(/^['"]|['"]$/g, '');
            sourceModule = this.resolveJsModulePath(sourceText, moduleQn);
            break;
          }
        }

        if (!sourceModule) continue;

        for (const child of importNode.children) {
          if (child.type === 'import_clause') {
            this.parseJsImportClause(child, sourceModule, moduleQn);
          }
        }
      } else if (importNode.type === 'lexical_declaration') {
        this.parseJsRequire(importNode, moduleQn);
      } else if (importNode.type === 'export_statement') {
        this.parseJsReexport(importNode, moduleQn);
      }
    }
  }

  private resolveJsModulePath(importPath: string, currentModule: string): string {
    if (!importPath.startsWith(cs.PATH_CURRENT_DIR)) {
      // Check workspace map for monorepo cross-package imports
      if (this.workspaceMap) {
        const resolved = this.workspaceMap.resolve(importPath);
        if (resolved) {
          logger.info(`[import] Workspace resolved: ${importPath} → ${resolved}`);
          return resolved;
        }
      }
      return importPath.replace(/\//g, cs.SEPARATOR_DOT);
    }

    const currentParts = currentModule.split(cs.SEPARATOR_DOT).slice(0, -1);
    const importParts = importPath.split(cs.SEPARATOR_SLASH);

    for (const part of importParts) {
      if (part === cs.PATH_CURRENT_DIR) continue;
      if (part === cs.PATH_PARENT_DIR) {
        if (currentParts.length > 0) currentParts.pop();
      } else if (part) {
        currentParts.push(part);
      }
    }

    return currentParts.join(cs.SEPARATOR_DOT);
  }

  private parseJsImportClause(
    clauseNode: TreeSitterNode,
    sourceModule: string,
    currentModule: string
  ): void {
    for (const child of clauseNode.children) {
      if (child.type === 'identifier') {
        // Default import
        const importedName = safeDecodeWithFallback(child);
        this.importMapping[currentModule][importedName] = `${sourceModule}.default`;
      } else if (child.type === 'named_imports') {
        for (const grandchild of child.children) {
          if (grandchild.type === 'import_specifier') {
            const nameNode = grandchild.childForFieldName('name');
            const aliasNode = grandchild.childForFieldName('alias');
            if (nameNode) {
              const importedName = safeDecodeWithFallback(nameNode);
              const localName = aliasNode ? safeDecodeWithFallback(aliasNode) : importedName;
              this.importMapping[currentModule][localName] =
                `${sourceModule}${cs.SEPARATOR_DOT}${importedName}`;
            }
          }
        }
      } else if (child.type === 'namespace_import') {
        for (const grandchild of child.children) {
          if (grandchild.type === 'identifier') {
            const namespaceName = safeDecodeWithFallback(grandchild);
            this.importMapping[currentModule][namespaceName] = sourceModule;
            break;
          }
        }
      }
    }
  }

  private parseJsRequire(declNode: TreeSitterNode, currentModule: string): void {
    for (const declarator of declNode.children) {
      if (declarator.type === 'variable_declarator') {
        const nameNode = declarator.childForFieldName('name');
        const valueNode = declarator.childForFieldName('value');

        if (
          nameNode?.type === 'identifier' &&
          valueNode?.type === 'call_expression'
        ) {
          const funcNode = valueNode.childForFieldName('function');
          const argsNode = valueNode.childForFieldName('arguments');

          if (
            funcNode?.type === 'identifier' &&
            safeDecodeText(funcNode) === 'require' &&
            argsNode
          ) {
            for (const arg of argsNode.children) {
              if (arg.type === 'string') {
                const varName = safeDecodeWithFallback(nameNode);
                const requiredModule = safeDecodeWithFallback(arg).replace(/^['"]|['"]$/g, '');
                const resolvedModule = this.resolveJsModulePath(requiredModule, currentModule);
                this.importMapping[currentModule][varName] = resolvedModule;
                break;
              }
            }
          }
        }
      }
    }
  }

  private parseJsReexport(exportNode: TreeSitterNode, currentModule: string): void {
    let sourceModule: string | null = null;

    for (const child of exportNode.children) {
      if (child.type === 'string') {
        const sourceText = safeDecodeWithFallback(child).replace(/^['"]|['"]$/g, '');
        sourceModule = this.resolveJsModulePath(sourceText, currentModule);
        break;
      }
    }

    if (!sourceModule) return;

    for (const child of exportNode.children) {
      if (child.type === '*') {
        // Wildcard re-export
        const wildcardKey = `*${sourceModule}`;
        this.importMapping[currentModule][wildcardKey] = sourceModule;
      } else if (child.type === 'export_clause') {
        for (const grandchild of child.children) {
          if (grandchild.type === 'export_specifier') {
            const nameNode = grandchild.childForFieldName('name');
            const aliasNode = grandchild.childForFieldName('alias');
            if (nameNode) {
              const originalName = safeDecodeWithFallback(nameNode);
              const exportedName = aliasNode
                ? safeDecodeWithFallback(aliasNode)
                : originalName;
              this.importMapping[currentModule][exportedName] =
                `${sourceModule}${cs.SEPARATOR_DOT}${originalName}`;
            }
          }
        }
      }
    }
  }

  // ===========================================================================
  // Java Import Parsing
  // ===========================================================================

  private parseJavaImports(captures: QueryCaptures, moduleQn: string): void {
    const importNodes = captures[cs.CAPTURE_IMPORT] ?? [];

    for (const importNode of importNodes) {
      if (importNode.type !== 'import_declaration') continue;

      let isStatic = false;
      let importedPath: string | null = null;
      let isWildcard = false;

      for (const child of importNode.children) {
        if (child.type === 'static') {
          isStatic = true;
        } else if (child.type === 'scoped_identifier') {
          importedPath = safeDecodeWithFallback(child);
        } else if (child.type === '*') {
          isWildcard = true;
        }
      }

      if (!importedPath) continue;

      const resolvedPath = this.resolveJavaImportPath(importedPath);

      if (isWildcard) {
        this.importMapping[moduleQn][`*${resolvedPath}`] = resolvedPath;
      } else {
        const parts = resolvedPath.split(cs.SEPARATOR_DOT);
        const importedName = parts[parts.length - 1];
        this.importMapping[moduleQn][importedName] = resolvedPath;
      }
    }
  }

  private resolveJavaImportPath(importPath: string): string {
    if (this.isLocalJavaImport(importPath)) {
      return `${this.projectName}${cs.SEPARATOR_DOT}${importPath}`;
    }
    return importPath;
  }

  // ===========================================================================
  // Rust Import Parsing
  // ===========================================================================

  private parseRustImports(captures: QueryCaptures, moduleQn: string): void {
    const importNodes = captures[cs.CAPTURE_IMPORT] ?? [];

    for (const importNode of importNodes) {
      if (importNode.type === 'use_declaration') {
        const imports = this.extractRustUseImports(importNode);
        for (const [importedName, fullPath] of Object.entries(imports)) {
          this.importMapping[moduleQn][importedName] = fullPath;
        }
      }
    }
  }

  private extractRustUseImports(useNode: TreeSitterNode): Record<string, string> {
    const imports: Record<string, string> = {};

    // Simple extraction - would need more sophisticated handling for use groups
    const argNode = useNode.childForFieldName('argument');
    if (!argNode) return imports;

    const fullPath = safeDecodeWithFallback(argNode);
    const parts = fullPath.split(cs.SEPARATOR_DOUBLE_COLON);
    const name = parts[parts.length - 1];
    imports[name] = fullPath;

    return imports;
  }

  // ===========================================================================
  // Go Import Parsing
  // ===========================================================================

  private parseGoImports(captures: QueryCaptures, moduleQn: string): void {
    const importNodes = captures[cs.CAPTURE_IMPORT] ?? [];

    for (const importNode of importNodes) {
      if (importNode.type === 'import_declaration') {
        this.parseGoImportDeclaration(importNode, moduleQn);
      }
    }
  }

  private parseGoImportDeclaration(importNode: TreeSitterNode, moduleQn: string): void {
    for (const child of importNode.children) {
      if (child.type === 'import_spec') {
        this.parseGoImportSpec(child, moduleQn);
      } else if (child.type === 'import_spec_list') {
        for (const grandchild of child.children) {
          if (grandchild.type === 'import_spec') {
            this.parseGoImportSpec(grandchild, moduleQn);
          }
        }
      }
    }
  }

  private parseGoImportSpec(specNode: TreeSitterNode, moduleQn: string): void {
    let aliasName: string | null = null;
    let importPath: string | null = null;

    for (const child of specNode.children) {
      if (child.type === 'package_identifier') {
        aliasName = safeDecodeWithFallback(child);
      } else if (child.type === 'interpreted_string_literal') {
        importPath = safeDecodeWithFallback(child).replace(/"/g, '');
      }
    }

    if (importPath) {
      const packageName = aliasName ?? importPath.split(cs.SEPARATOR_SLASH).pop() ?? importPath;
      this.importMapping[moduleQn][packageName] = importPath;
    }
  }

  // ===========================================================================
  // C/C++ Import Parsing
  // ===========================================================================

  private parseCppImports(captures: QueryCaptures, moduleQn: string): void {
    const importNodes = captures[cs.CAPTURE_IMPORT] ?? [];

    for (const importNode of importNodes) {
      if (importNode.type === 'preproc_include') {
        this.parseCppInclude(importNode, moduleQn);
      }
    }
  }

  private parseCppInclude(includeNode: TreeSitterNode, moduleQn: string): void {
    let includePath: string | null = null;
    let isSystemInclude = false;

    for (const child of includeNode.children) {
      if (child.type === 'string_literal') {
        includePath = safeDecodeWithFallback(child).replace(/"/g, '');
        isSystemInclude = false;
      } else if (child.type === 'system_lib_string') {
        includePath = safeDecodeWithFallback(child).replace(/[<>]/g, '');
        isSystemInclude = true;
      }
    }

    if (!includePath) return;

    const headerName = includePath.split(cs.SEPARATOR_SLASH).pop() ?? includePath;
    let localName: string;
    if (headerName.endsWith(cs.EXT_H) || headerName.endsWith(cs.EXT_HPP)) {
      localName = headerName.split(cs.SEPARATOR_DOT)[0];
    } else {
      localName = headerName;
    }

    let fullName: string;
    if (isSystemInclude) {
      fullName = `std.${includePath}`;
    } else {
      const pathParts = includePath
        .replace(/\//g, cs.SEPARATOR_DOT)
        .replace(cs.EXT_H, '')
        .replace(cs.EXT_HPP, '');
      fullName = `${this.projectName}${cs.SEPARATOR_DOT}${pathParts}`;
    }

    this.importMapping[moduleQn][localName] = fullName;
  }

  // ===========================================================================
  // PHP Import Parsing
  // ===========================================================================

  private parsePhpImports(captures: QueryCaptures, moduleQn: string): void {
    const importNodes = [
      ...(captures[cs.CAPTURE_IMPORT] ?? []),
      ...(captures[cs.CAPTURE_IMPORT_FROM] ?? []),
    ];

    for (const importNode of importNodes) {
      if (importNode.type === 'namespace_use_declaration') {
        this.handlePhpUseDeclaration(importNode, moduleQn);
      }
    }
  }

  private handlePhpUseDeclaration(useNode: TreeSitterNode, moduleQn: string): void {
    for (const child of useNode.namedChildren) {
      if (child.type !== 'namespace_use_clause') continue;

      const qnNode = child.namedChildren.find((c) => c.type === 'qualified_name');
      if (!qnNode) continue;

      const importedPath = safeDecodeWithFallback(qnNode).replace(/\\/g, cs.SEPARATOR_DOT);
      if (!importedPath) continue;

      const aliasNode = child.childForFieldName('alias');
      let localName: string;
      if (aliasNode?.text) {
        localName = safeDecodeWithFallback(aliasNode);
      } else {
        const parts = importedPath.split(cs.SEPARATOR_DOT);
        localName = parts[parts.length - 1] ?? importedPath;
      }

      this.importMapping[moduleQn][localName] = importedPath;
    }
  }

  // ===========================================================================
  // Lua Import Parsing
  // ===========================================================================

  private parseLuaImports(captures: QueryCaptures, moduleQn: string): void {
    const callNodes = captures[cs.CAPTURE_IMPORT] ?? [];

    for (const callNode of callNodes) {
      if (this.isLuaRequireCall(callNode)) {
        const modulePath = this.extractLuaRequireArg(callNode);
        if (modulePath) {
          const localName = this.extractLuaAssignmentLhs(callNode) ??
            modulePath.split(cs.SEPARATOR_DOT).pop() ?? modulePath;
          const resolved = this.resolveLuaModulePath(modulePath, moduleQn);
          this.importMapping[moduleQn][localName] = resolved;
        }
      }
    }
  }

  private isLuaRequireCall(callNode: TreeSitterNode): boolean {
    const firstChild = callNode.children[0];
    return firstChild?.type === 'identifier' && safeDecodeText(firstChild) === 'require';
  }

  private extractLuaRequireArg(callNode: TreeSitterNode): string | null {
    const argsNode = callNode.childForFieldName('arguments');
    const candidates = argsNode ? argsNode.children : callNode.children;

    for (const node of candidates) {
      if (node.type === 'string' || node.type === 'string_literal') {
        return safeDecodeText(node)?.replace(/^['"]|['"]$/g, '') ?? null;
      }
    }
    return null;
  }

  private extractLuaAssignmentLhs(callNode: TreeSitterNode): string | null {
    // Walk up to find assignment statement
    let current = callNode.parent;
    while (current) {
      if (current.type === 'assignment_statement' || current.type === 'local_declaration') {
        const varList = current.children.find(
          (c) => c.type === 'variable_list' || c.type === 'identifier'
        );
        if (varList?.type === 'identifier') {
          return safeDecodeText(varList);
        }
        if (varList?.type === 'variable_list' && varList.children[0]) {
          return safeDecodeText(varList.children[0]);
        }
      }
      current = current.parent;
    }
    return null;
  }

  private resolveLuaModulePath(importPath: string, currentModule: string): string {
    if (importPath.startsWith(cs.PATH_RELATIVE_PREFIX) || importPath.startsWith(cs.PATH_PARENT_PREFIX)) {
      const parts = currentModule.split(cs.SEPARATOR_DOT).slice(0, -1);
      const relParts = importPath.replace(/\\/g, cs.SEPARATOR_SLASH).split(cs.SEPARATOR_SLASH);

      for (const p of relParts) {
        if (p === cs.PATH_CURRENT_DIR) continue;
        if (p === cs.PATH_PARENT_DIR) {
          if (parts.length > 0) parts.pop();
        } else if (p) {
          parts.push(p);
        }
      }
      return parts.join(cs.SEPARATOR_DOT);
    }

    const dotted = importPath.replace(/\//g, cs.SEPARATOR_DOT);

    // Check if local
    try {
      const relativeFile = dotted.replace(/\./g, cs.SEPARATOR_SLASH) + cs.EXT_LUA;
      if (existsSync(join(this.repoPath, relativeFile))) {
        return `${this.projectName}${cs.SEPARATOR_DOT}${dotted}`;
      }
    } catch {
      // Ignore
    }

    return dotted;
  }

  // ===========================================================================
  // Generic Import Parsing
  // ===========================================================================

  private parseGenericImports(
    captures: QueryCaptures,
    moduleQn: string,
    config: LanguageSpec
  ): void {
    // Generic fallback - just log that we can't parse imports for this language
    const importNodes = captures[cs.CAPTURE_IMPORT] ?? [];
    for (const importNode of importNodes) {
      logger.debug(`Generic import parsing not implemented for ${config.language}:`, importNode.type);
    }
  }

  // ===========================================================================
  // Module Path Resolution
  // ===========================================================================

  private resolveModulePath(
    fullName: string,
    moduleQn: string,
    language: SupportedLanguage
  ): string {
    const projectPrefix = `${this.projectName}${cs.SEPARATOR_DOT}`;

    switch (language) {
      case SupportedLanguage.JAVA:
        if (fullName.startsWith(projectPrefix)) {
          return fullName;
        }
        break;
      case SupportedLanguage.JS:
      case SupportedLanguage.TS:
        if (this.isLocalJsImport(fullName)) {
          return this.resolveJsInternalModule(fullName);
        }
        break;
      case SupportedLanguage.RUST:
        return this.resolveRustImportPath(fullName, moduleQn);
    }

    // Extract module path (strip function/class names)
    const modulePath = this.extractModulePath(fullName, language);

    if (!modulePath.startsWith(projectPrefix)) {
      this.ensureExternalModuleNode(modulePath, fullName);
    }

    return modulePath;
  }

  private isLocalJsImport(fullName: string): boolean {
    return fullName.startsWith(`${this.projectName}${cs.SEPARATOR_DOT}`);
  }

  private resolveJsInternalModule(fullName: string): string {
    if (fullName.endsWith('.default')) {
      return fullName.slice(0, -8); // Remove '.default'
    }

    const parts = fullName.split(cs.SEPARATOR_DOT);
    if (parts.length <= 2) {
      return fullName;
    }

    const potentialModule = parts.slice(0, -1).join(cs.SEPARATOR_DOT);
    const relativePath = parts.slice(1, -1).join(cs.SEPARATOR_SLASH);

    for (const ext of [cs.EXT_JS, cs.EXT_TS, cs.EXT_JSX, cs.EXT_TSX]) {
      if (existsSync(join(this.repoPath, `${relativePath}${ext}`))) {
        return potentialModule;
      }
      const indexPath = join(this.repoPath, relativePath, `index${ext}`);
      if (existsSync(indexPath)) {
        return potentialModule;
      }
    }

    return fullName;
  }

  private resolveRustImportPath(importPath: string, moduleQn: string): string {
    if (importPath.startsWith(cs.RUST_CRATE_PREFIX)) {
      const pathWithoutCrate = importPath.slice(cs.RUST_CRATE_PREFIX.length);
      const moduleParts = moduleQn.split(cs.SEPARATOR_DOT);
      let srcIndex = moduleParts.indexOf('src');
      const crateRootQn = srcIndex >= 0
        ? moduleParts.slice(0, srcIndex + 1).join(cs.SEPARATOR_DOT)
        : this.projectName;
      const modulePart = pathWithoutCrate.split(cs.SEPARATOR_DOUBLE_COLON)[0];
      return `${crateRootQn}${cs.SEPARATOR_DOT}${modulePart}`;
    }

    const parts = importPath.split(cs.SEPARATOR_DOUBLE_COLON);
    const modulePath = parts.length > 1
      ? parts.slice(0, -1).join(cs.SEPARATOR_DOUBLE_COLON)
      : parts[0];

    this.ensureExternalModuleNode(modulePath, importPath);
    return modulePath;
  }

  private extractModulePath(fullName: string, language: SupportedLanguage): string {
    // For most cases, the module path is the parent of the final identifier
    const parts = fullName.split(cs.SEPARATOR_DOT);
    if (parts.length <= 1) {
      return fullName;
    }

    // Check if the last part is a class or function (starts with uppercase or is a symbol)
    const last = parts[parts.length - 1];
    if (/^[A-Z]/.test(last) || last === 'default' || last.startsWith('*')) {
      return parts.slice(0, -1).join(cs.SEPARATOR_DOT);
    }

    return fullName;
  }

  private ensureExternalModuleNode(modulePath: string, fullName: string): void {
    if (!modulePath) return;

    let name: string;
    if (modulePath.includes(cs.SEPARATOR_DOUBLE_COLON)) {
      name = modulePath.split(cs.SEPARATOR_DOUBLE_COLON).pop() ?? modulePath;
    } else {
      name = modulePath.split(cs.SEPARATOR_DOT).pop() ?? modulePath;
    }

    this.ingestor.ensureNodeBatch(cs.NodeLabel.MODULE, {
      [cs.KEY_NAME]: name,
      [cs.KEY_QUALIFIED_NAME]: modulePath,
      [cs.KEY_PATH]: fullName,
      [cs.KEY_IS_EXTERNAL]: true,
    });
  }

  // ===========================================================================
  // Helper Methods
  // ===========================================================================

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
