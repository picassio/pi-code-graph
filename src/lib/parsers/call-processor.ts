import { logger } from '../logger.js';
/**
 * Call processor for extracting function calls from code
 * Ported from codebase_rag/parsers/call_processor.py
 */

import type { Node as TreeSitterNode } from 'web-tree-sitter';
import { SupportedLanguage, NodeLabel } from '../constants.js';
import type { LanguageQueries, LanguageSpec, FunctionRegistryTrie, NodeType } from '../types.js';
import type {
  IngestorProtocol,
  CallProcessorProtocol,
  ImportProcessorProtocol,
  TypeInferenceProtocol,
  ClassInheritance,
  QueryCaptures,
} from './base.js';
import {
  safeDecodeText,
  safeDecodeWithFallback,
  sortedCaptures,
  isMethodNode,
  getNodeName,
  getFunctionCaptures,
} from './base.js';
import * as cs from '../constants.js';
import { relative, dirname, basename } from 'node:path';

// =============================================================================
// Call Resolver
// =============================================================================

/**
 * Resolves function call targets to their qualified names
 */
export class CallResolver {
  private readonly functionRegistry: FunctionRegistryTrie;
  private readonly importProcessor: ImportProcessorProtocol;
  private readonly typeInference: TypeInferenceProtocol | null;
  private readonly classInheritance: ClassInheritance;

  constructor(
    functionRegistry: FunctionRegistryTrie,
    importProcessor: ImportProcessorProtocol,
    typeInference: TypeInferenceProtocol | null,
    classInheritance: ClassInheritance
  ) {
    this.functionRegistry = functionRegistry;
    this.importProcessor = importProcessor;
    this.typeInference = typeInference;
    this.classInheritance = classInheritance;
  }

  /**
   * Resolve a function call to its qualified name and type
   */
  resolveFunctionCall(
    callName: string,
    moduleQn: string,
    localVarTypes: Map<string, string>,
    classContext: string | null
  ): [NodeLabel, string] | null {
    // Handle chained calls like obj.method
    const parts = callName.split(cs.SEPARATOR_DOT);

    if (parts.length === 1) {
      // Simple call: functionName()
      return this.resolveSimpleCall(callName, moduleQn, classContext);
    }

    // Method call: obj.method() or module.function()
    const objName = parts.slice(0, -1).join(cs.SEPARATOR_DOT);
    const methodName = parts[parts.length - 1];

    // Check if obj is a local variable with known type
    const objType = localVarTypes.get(objName);
    if (objType) {
      const methodQn = `${objType}${cs.SEPARATOR_DOT}${methodName}`;
      if (this.functionRegistry.has(methodQn)) {
        return [NodeLabel.METHOD, methodQn];
      }
    }

    // Check if obj is an imported module
    const importedModule = this.importProcessor.resolveImport(objName, moduleQn);
    if (importedModule) {
      const funcQn = `${importedModule}${cs.SEPARATOR_DOT}${methodName}`;
      if (this.functionRegistry.has(funcQn)) {
        const funcType = this.functionRegistry.get(funcQn);
        return [this.nodeTypeToLabel(funcType!), funcQn];
      }
      // Return as potential external call
      return [NodeLabel.FUNCTION, funcQn];
    }

    // Check if it's a method on self/this
    if (objName === cs.KEYWORD_SELF || objName === 'this') {
      if (classContext) {
        const methodQn = `${classContext}${cs.SEPARATOR_DOT}${methodName}`;
        if (this.functionRegistry.has(methodQn)) {
          return [NodeLabel.METHOD, methodQn];
        }
        // Check inherited methods
        const bases = this.classInheritance[classContext];
        if (bases) {
          for (const base of bases) {
            const baseMethodQn = `${base}${cs.SEPARATOR_DOT}${methodName}`;
            if (this.functionRegistry.has(baseMethodQn)) {
              return [NodeLabel.METHOD, baseMethodQn];
            }
          }
        }
      }
    }

    // Check if it's a static method call (ClassName.method)
    const staticMethodQn = `${moduleQn}${cs.SEPARATOR_DOT}${callName}`;
    if (this.functionRegistry.has(staticMethodQn)) {
      return [NodeLabel.METHOD, staticMethodQn];
    }

    return null;
  }

  private resolveSimpleCall(
    callName: string,
    moduleQn: string,
    classContext: string | null
  ): [NodeLabel, string] | null {
    // Check local scope first
    const localQn = `${moduleQn}${cs.SEPARATOR_DOT}${callName}`;
    if (this.functionRegistry.has(localQn)) {
      const funcType = this.functionRegistry.get(localQn);
      return [this.nodeTypeToLabel(funcType!), localQn];
    }

    // Check if it's a method in current class
    if (classContext) {
      const methodQn = `${classContext}${cs.SEPARATOR_DOT}${callName}`;
      if (this.functionRegistry.has(methodQn)) {
        return [NodeLabel.METHOD, methodQn];
      }
    }

    // Check imports
    const importedQn = this.importProcessor.resolveImport(callName, moduleQn);
    if (importedQn) {
      if (this.functionRegistry.has(importedQn)) {
        const funcType = this.functionRegistry.get(importedQn);
        return [this.nodeTypeToLabel(funcType!), importedQn];
      }
      return [NodeLabel.FUNCTION, importedQn];
    }

    // Check for wildcard imports
    const moduleImports = this.importProcessor.importMapping[moduleQn];
    if (moduleImports) {
      for (const [key, value] of Object.entries(moduleImports)) {
        if (key.startsWith('*')) {
          const wildcardModule = value;
          const funcQn = `${wildcardModule}${cs.SEPARATOR_DOT}${callName}`;
          if (this.functionRegistry.has(funcQn)) {
            const funcType = this.functionRegistry.get(funcQn);
            return [this.nodeTypeToLabel(funcType!), funcQn];
          }
        }
      }
    }

    return null;
  }

  /**
   * Resolve a builtin function call
   */
  resolveBuiltinCall(callName: string): [NodeLabel, string] | null {
    // Check JavaScript builtins
    if (cs.JS_BUILTIN_PATTERNS.has(callName)) {
      return [NodeLabel.FUNCTION, `${cs.BUILTIN_PREFIX}${cs.SEPARATOR_DOT}${callName}`];
    }

    // Simple builtin names
    const simpleBuiltins = new Set([
      'print', 'len', 'str', 'int', 'float', 'list', 'dict', 'set', 'tuple',
      'range', 'enumerate', 'zip', 'map', 'filter', 'sorted', 'reversed',
      'min', 'max', 'sum', 'abs', 'round', 'pow', 'isinstance', 'issubclass',
      'hasattr', 'getattr', 'setattr', 'delattr', 'callable', 'type', 'id',
      'repr', 'hash', 'open', 'input', 'eval', 'exec', 'compile',
      'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
      'fetch', 'Promise', 'async', 'await',
    ]);

    if (simpleBuiltins.has(callName)) {
      return [NodeLabel.FUNCTION, `${cs.BUILTIN_PREFIX}${cs.SEPARATOR_DOT}${callName}`];
    }

    return null;
  }

  /**
   * Resolve C++ operator call
   */
  resolveCppOperatorCall(callName: string, moduleQn: string): [NodeLabel, string] | null {
    if (callName.startsWith(cs.OPERATOR_PREFIX)) {
      const operatorQn = cs.CPP_OPERATORS[callName];
      if (operatorQn) {
        return [NodeLabel.FUNCTION, operatorQn];
      }
    }
    return null;
  }

  /**
   * Resolve Java method call with receiver type analysis
   */
  resolveJavaMethodCall(
    callNode: TreeSitterNode,
    moduleQn: string,
    localVarTypes: Map<string, string>
  ): [NodeLabel, string] | null {
    const objectNode = callNode.childForFieldName('object');
    const nameNode = callNode.childForFieldName('name');

    if (!nameNode) return null;

    const methodName = safeDecodeText(nameNode);
    if (!methodName) return null;

    // Check object type
    if (objectNode) {
      const objText = safeDecodeText(objectNode);
      if (objText) {
        const objType = localVarTypes.get(objText);
        if (objType) {
          const methodQn = `${objType}${cs.SEPARATOR_DOT}${methodName}`;
          if (this.functionRegistry.has(methodQn)) {
            return [NodeLabel.METHOD, methodQn];
          }
        }
      }
    }

    return null;
  }

  private nodeTypeToLabel(nodeType: NodeType): NodeLabel {
    switch (nodeType) {
      case 'Method':
        return NodeLabel.METHOD;
      case 'Class':
        return NodeLabel.CLASS;
      case 'Function':
      default:
        return NodeLabel.FUNCTION;
    }
  }
}

// =============================================================================
// Call Processor Implementation
// =============================================================================

export class CallProcessor implements CallProcessorProtocol {
  readonly repoPath: string;
  readonly projectName: string;
  readonly ingestor: IngestorProtocol;
  private readonly resolver: CallResolver;

  constructor(
    ingestor: IngestorProtocol,
    repoPath: string,
    projectName: string,
    functionRegistry: FunctionRegistryTrie,
    importProcessor: ImportProcessorProtocol,
    typeInference: TypeInferenceProtocol | null,
    classInheritance: ClassInheritance
  ) {
    this.ingestor = ingestor;
    this.repoPath = repoPath;
    this.projectName = projectName;
    this.resolver = new CallResolver(
      functionRegistry,
      importProcessor,
      typeInference,
      classInheritance
    );
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  processCallsInFile(
    filePath: string,
    rootNode: TreeSitterNode,
    language: SupportedLanguage,
    queries: Map<SupportedLanguage, LanguageQueries>
  ): void {
    const relativePath = relative(this.repoPath, filePath);
    logger.debug(`Processing calls in: ${relativePath}`);

    try {
      const fileName = basename(filePath);
      let moduleQn = this.buildModuleQn(relativePath, fileName);

      // Process calls in top-level functions
      this.processCallsInFunctions(rootNode, moduleQn, language, queries);

      // Process calls in classes
      this.processCallsInClasses(rootNode, moduleQn, language, queries);

      // Process module-level calls
      this.processModuleLevelCalls(rootNode, moduleQn, language, queries);
    } catch (error) {
      logger.error(`Failed to process calls in ${filePath}:`, error);
    }
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private processCallsInFunctions(
    rootNode: TreeSitterNode,
    moduleQn: string,
    language: SupportedLanguage,
    queries: Map<SupportedLanguage, LanguageQueries>
  ): void {
    const result = getFunctionCaptures(rootNode, language, queries);
    if (!result) return;

    const [config, captures] = result;
    const funcNodes = captures[cs.CAPTURE_FUNCTION] ?? [];

    for (const funcNode of funcNodes) {
      // Skip methods
      if (isMethodNode(funcNode, config)) {
        continue;
      }

      const funcName = this.extractFunctionName(funcNode, language);
      if (!funcName) continue;

      const funcQn = this.buildNestedQualifiedName(funcNode, moduleQn, funcName, config);
      if (!funcQn) continue;

      this.ingestFunctionCalls(
        funcNode,
        funcQn,
        NodeLabel.FUNCTION,
        moduleQn,
        language,
        queries,
        null
      );
    }
  }

  private processCallsInClasses(
    rootNode: TreeSitterNode,
    moduleQn: string,
    language: SupportedLanguage,
    queries: Map<SupportedLanguage, LanguageQueries>
  ): void {
    const langQueries = queries.get(language);
    if (!langQueries?.classes) return;

    const matches = langQueries.classes.matches(rootNode);
    const captures = this.extractCaptures(matches);
    const classNodes = captures[cs.CAPTURE_CLASS] ?? [];

    for (const classNode of classNodes) {
      const className = this.getClassNameForNode(classNode, language);
      if (!className) continue;

      const classQn = `${moduleQn}${cs.SEPARATOR_DOT}${className}`;

      const bodyNode = classNode.childForFieldName('body');
      if (bodyNode) {
        this.processMethodsInClass(bodyNode, classQn, moduleQn, language, queries);
      }
    }
  }

  private processMethodsInClass(
    bodyNode: TreeSitterNode,
    classQn: string,
    moduleQn: string,
    language: SupportedLanguage,
    queries: Map<SupportedLanguage, LanguageQueries>
  ): void {
    const langQueries = queries.get(language);
    if (!langQueries?.functions) return;

    const matches = langQueries.functions.matches(bodyNode);
    const captures = this.extractCaptures(matches);
    const methodNodes = captures[cs.CAPTURE_FUNCTION] ?? [];

    for (const methodNode of methodNodes) {
      const methodName = this.extractFunctionName(methodNode, language);
      if (!methodName) continue;

      const methodQn = `${classQn}${cs.SEPARATOR_DOT}${methodName}`;

      this.ingestFunctionCalls(
        methodNode,
        methodQn,
        NodeLabel.METHOD,
        moduleQn,
        language,
        queries,
        classQn
      );
    }
  }

  private processModuleLevelCalls(
    rootNode: TreeSitterNode,
    moduleQn: string,
    language: SupportedLanguage,
    queries: Map<SupportedLanguage, LanguageQueries>
  ): void {
    this.ingestFunctionCalls(
      rootNode,
      moduleQn,
      NodeLabel.MODULE,
      moduleQn,
      language,
      queries,
      null
    );
  }

  private ingestFunctionCalls(
    callerNode: TreeSitterNode,
    callerQn: string,
    callerType: NodeLabel,
    moduleQn: string,
    language: SupportedLanguage,
    queries: Map<SupportedLanguage, LanguageQueries>,
    classContext: string | null
  ): void {
    const langQueries = queries.get(language);
    if (!langQueries?.calls) return;

    // Build local variable type map (simplified - would need type inference in production)
    const localVarTypes = new Map<string, string>();

    const matches = langQueries.calls.matches(callerNode);
    const captures = this.extractCaptures(matches);
    const callNodes = captures[cs.CAPTURE_CALL] ?? [];

    logger.debug(`Found ${callNodes.length} call nodes in ${callerQn}`);

    for (const callNode of callNodes) {
      const callName = this.getCallTargetName(callNode);
      if (!callName) continue;

      // Try different resolution strategies
      let calleeInfo: [NodeLabel, string] | null = null;

      // Java method invocation has special handling
      if (language === SupportedLanguage.JAVA && callNode.type === 'method_invocation') {
        calleeInfo = this.resolver.resolveJavaMethodCall(callNode, moduleQn, localVarTypes);
      }

      // General function call resolution
      if (!calleeInfo) {
        calleeInfo = this.resolver.resolveFunctionCall(
          callName,
          moduleQn,
          localVarTypes,
          classContext
        );
      }

      // Try builtin resolution
      if (!calleeInfo) {
        calleeInfo = this.resolver.resolveBuiltinCall(callName);
      }

      // Try C++ operator resolution
      if (!calleeInfo) {
        calleeInfo = this.resolver.resolveCppOperatorCall(callName, moduleQn);
      }

      if (!calleeInfo) continue;

      const [calleeType, calleeQn] = calleeInfo;

      // Skip constructor calls (treated as class references)
      if (calleeType === NodeLabel.CLASS) {
        logger.debug(`Skipping class constructor call: ${callName} -> ${calleeQn}`);
        continue;
      }

      logger.debug(`Found call: ${callerQn} -> ${calleeQn} (${calleeType})`);

      // Create CALLS relationship
      this.ingestor.ensureRelationshipBatch(
        [callerType, cs.KEY_QUALIFIED_NAME, callerQn],
        cs.RelationshipType.CALLS,
        [calleeType, cs.KEY_QUALIFIED_NAME, calleeQn]
      );
    }
  }

  private getCallTargetName(callNode: TreeSitterNode): string | null {
    // Try 'function' field for call_expression
    const funcChild = callNode.childForFieldName('function');
    if (funcChild) {
      switch (funcChild.type) {
        case 'identifier':
        case 'attribute':
        case 'member_expression':
        case 'qualified_identifier':
        case 'scoped_identifier':
          return safeDecodeText(funcChild);

        case 'field_expression':
          const fieldNode = funcChild.childForFieldName('field');
          if (fieldNode) return safeDecodeText(fieldNode);
          break;

        case 'parenthesized_expression':
          return this.getIifeTargetName(funcChild);
      }
    }

    // Handle C++ operators
    switch (callNode.type) {
      case 'binary_expression':
      case 'unary_expression':
      case 'update_expression':
        const operatorNode = callNode.childForFieldName('operator');
        if (operatorNode?.text) {
          return this.convertOperatorSymbolToName(operatorNode.text);
        }
        break;

      case 'method_invocation':
        const objectNode = callNode.childForFieldName('object');
        const nameNode = callNode.childForFieldName('name');
        if (nameNode?.text) {
          const methodName = nameNode.text;
          if (!objectNode?.text) return methodName;
          return `${objectNode.text}${cs.SEPARATOR_DOT}${methodName}`;
        }
        break;
    }

    // Try 'name' field
    const nameChild = callNode.childForFieldName('name');
    if (nameChild) {
      return safeDecodeText(nameChild);
    }

    return null;
  }

  private getIifeTargetName(parenthesizedExpr: TreeSitterNode): string | null {
    for (const child of parenthesizedExpr.children) {
      if (child.type === 'function_expression') {
        return `${cs.IIFE_FUNC_PREFIX}${child.startPosition.row}_${child.startPosition.column}`;
      }
      if (child.type === 'arrow_function') {
        return `${cs.IIFE_ARROW_PREFIX}${child.startPosition.row}_${child.startPosition.column}`;
      }
    }
    return null;
  }

  private convertOperatorSymbolToName(operator: string): string {
    return cs.CPP_OPERATOR_SYMBOL_MAP[operator] ?? cs.CPP_FALLBACK_OPERATOR;
  }

  private buildModuleQn(relativePath: string, fileName: string): string {
    const parts = relativePath.replace(/\.[^.]+$/, '').split('/').filter(Boolean);

    if (fileName === cs.INIT_PY || fileName === cs.MOD_RS) {
      return [this.projectName, ...parts.slice(0, -1)].join(cs.SEPARATOR_DOT);
    }

    return [this.projectName, ...parts].join(cs.SEPARATOR_DOT);
  }

  private extractFunctionName(funcNode: TreeSitterNode, language: SupportedLanguage): string | null {
    const nameNode = funcNode.childForFieldName('name');
    if (nameNode) {
      return safeDecodeText(nameNode);
    }

    if (language === SupportedLanguage.CPP) {
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

  private getClassNameForNode(classNode: TreeSitterNode, language: SupportedLanguage): string | null {
    if (language === SupportedLanguage.RUST && classNode.type === 'impl_item') {
      const typeNode = classNode.childForFieldName('type');
      if (typeNode) return safeDecodeText(typeNode);

      for (const child of classNode.children) {
        if (child.type === 'type_identifier' && child.isNamed) {
          return safeDecodeText(child);
        }
      }
      return null;
    }

    return getNodeName(classNode);
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

export function createCallProcessor(
  ingestor: IngestorProtocol,
  repoPath: string,
  projectName: string,
  functionRegistry: FunctionRegistryTrie,
  importProcessor: ImportProcessorProtocol,
  typeInference: TypeInferenceProtocol | null,
  classInheritance: ClassInheritance
): CallProcessor {
  return new CallProcessor(
    ingestor,
    repoPath,
    projectName,
    functionRegistry,
    importProcessor,
    typeInference,
    classInheritance
  );
}
