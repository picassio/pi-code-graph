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
import { buildQualifiedName, buildModuleQualifiedName, buildMethodLocalName, parseQualifiedName } from './node-id.js';

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
  /** Project-wide class field registry for deep chain resolution */
  public classFieldRegistry: import('./type-env.js').ClassFieldRegistry | null = null;
  /** Project-wide function return type registry for Tier 3 variable inference */
  public returnTypeRegistry: Map<string, string> | null = null;
  /** Current class name for this.field resolution */
  public currentClassName: string | null = null;

  constructor(
    functionRegistry: FunctionRegistryTrie,
    importProcessor: ImportProcessorProtocol,
    typeInference: TypeInferenceProtocol | null,
    classInheritance: ClassInheritance,
    classFieldRegistry: import('./type-env.js').ClassFieldRegistry | null = null,
    returnTypeRegistry: Map<string, string> | null = null,
  ) {
    this.functionRegistry = functionRegistry;
    this.importProcessor = importProcessor;
    this.typeInference = typeInference;
    this.classInheritance = classInheritance;
    this.classFieldRegistry = classFieldRegistry;
    this.returnTypeRegistry = returnTypeRegistry;
  }

  /**
   * Resolve a deep chain like ['this', 'a', 'b', 'c', 'method']
   * via the class field registry. Returns the final method's qualified name
   * if every step in the chain resolves to a known type.
   */
  private resolveDeepChain(
    parts: string[],
    classContext: string | null,
    localVarTypes?: Map<string, string>,
  ): [NodeLabel, string, number] | null {
    if (!this.classFieldRegistry || parts.length < 3) return null;

    // Resolve the first part to a type:
    //  - 'this'/'self' → enclosing class
    //  - identifier → lookup in localVarTypes (Bug #3/#4 fix — handles 'authStorage.x.y' patterns)
    let currentType: string | undefined;
    if (parts[0] === 'this' || parts[0] === 'self') {
      if (classContext) {
        const parsed = parseQualifiedName(classContext);
        const local = parsed ? parsed.localName : classContext;
        currentType = local.split(cs.SEPARATOR_DOT).pop();
      }
    } else if (localVarTypes && localVarTypes.has(parts[0])) {
      // Variable with known type — use it as the chain start
      currentType = localVarTypes.get(parts[0]);
    } else {
      return null;
    }
    if (!currentType) return null;

    // Walk chain through field types: this.a.b.c.method
    // The registry is still keyed by short class name (backwards-compatible).
    for (let i = 1; i < parts.length - 1; i++) {
      const fieldName = parts[i];
      const fields = this.classFieldRegistry.get(currentType);
      if (!fields) return null;
      const nextType = fields.get(fieldName);
      if (!nextType) return null;
      currentType = nextType;
    }

    // Final part is the method name
    const methodName = parts[parts.length - 1];
    // New-format QN: `path:ClassName.method` — we want anything that ends with
    // either `:{ClassName}.{methodName}` (top of file) or `.{ClassName}.{methodName}` (nested)
    const colonSuffix = `:${currentType}.${methodName}`;
    const dotSuffix = `.${currentType}.${methodName}`;
    const candidates = this.functionRegistry.findEndingWith(methodName);
    for (const qn of candidates) {
      if (qn.endsWith(colonSuffix) || qn.endsWith(dotSuffix)) {
        const funcType = this.functionRegistry.get(qn);
        return [this.nodeTypeToLabel(funcType!), qn, 0.9];
      }
    }
    return null;
  }

  /**
   * Resolve a function call to its qualified name and type
   */
  resolveFunctionCall(
    callName: string,
    moduleQn: string,
    localVarTypes: Map<string, string>,
    classContext: string | null
  ): [NodeLabel, string, number] | null {
    // Handle chained calls like obj.method
    const parts = callName.split(cs.SEPARATOR_DOT);

    if (parts.length === 1) {
      // Simple call: functionName()
      return this.resolveSimpleCall(callName, moduleQn, classContext);
    }

    // Deep chain resolution via class field registry
    // Handles: this.a.b.c.method() — walks field types through the registry
    // Deep chain resolution: this.a.b.c.method() OR localVar.a.b.c.method()
    // Tries class field registry to walk through the chain.
    if (parts.length >= 3) {
      const isThis = parts[0] === 'this' || parts[0] === 'self';
      const isKnownVar = localVarTypes.has(parts[0]);
      if (isThis || isKnownVar) {
        const deepResult = this.resolveDeepChain(parts, classContext, localVarTypes);
        if (deepResult) {
          return deepResult;
        }
      }
    }

    // 2-part variable chain: localVar.field.method() (length 2 isn't deep, but check for 1-step field access)
    // Skip for now — the existing 2-part objType lookup below handles direct method calls.


    // Method call: obj.method() or module.function()
    const objName = parts.slice(0, -1).join(cs.SEPARATOR_DOT);
    const methodName = parts[parts.length - 1];

    // Check if obj is a local variable with known type.
    // objType is a short class name; look up by suffix match on the registry.
    // Now uses both `:Class.method` (top-of-file) and `.Class.method` (nested) suffixes.
    const objType = localVarTypes.get(objName);
    if (objType) {
      const colonSuffix = `:${objType}.${methodName}`;
      const dotSuffix = `.${objType}.${methodName}`;
      const candidates = this.functionRegistry.findEndingWith(methodName)
        .filter(qn => qn.endsWith(colonSuffix) || qn.endsWith(dotSuffix));
      if (candidates.length >= 1) {
        return [NodeLabel.METHOD, candidates[0], 1.0];
      }
    }

    // Check if obj is an imported module.
    // importedModule is either a module QN (file path like 'src/lib/foo.ts') or
    // a full QN (file path + `:local_name`).
    const importedModule = this.importProcessor.resolveImport(objName, moduleQn);
    if (importedModule) {
      const funcQn = importedModule.includes(':')
        ? `${importedModule}${cs.SEPARATOR_DOT}${methodName}`
        : buildQualifiedName(importedModule, methodName);
      if (this.functionRegistry.has(funcQn)) {
        const funcType = this.functionRegistry.get(funcQn);
        return [this.nodeTypeToLabel(funcType!), funcQn, 1.0];
      }
      // Try re-export resolution by name within the same top-level dir
      const parsed = parseQualifiedName(importedModule.includes(':') ? importedModule : `${importedModule}:x`);
      const topDir = parsed ? parsed.filePath.split('/')[0] + '/' : '';
      const candidates = this.functionRegistry.findEndingWith(methodName)
        .filter(qn => topDir && qn.startsWith(topDir));
      if (candidates.length === 1) {
        const funcType = this.functionRegistry.get(candidates[0]);
        return [this.nodeTypeToLabel(funcType!), candidates[0], 0.6];
      }
      return [NodeLabel.FUNCTION, funcQn, 0.8];
    }

    // Check if it's a method on self/this
    if (objName === cs.KEYWORD_SELF || objName === 'this') {
      if (classContext) {
        const methodQn = `${classContext}${cs.SEPARATOR_DOT}${methodName}`;
        if (this.functionRegistry.has(methodQn)) {
          return [NodeLabel.METHOD, methodQn, 1.0];
        }
        // Check inherited methods
        const bases = this.classInheritance[classContext];
        if (bases) {
          for (const base of bases) {
            const baseMethodQn = `${base}${cs.SEPARATOR_DOT}${methodName}`;
            if (this.functionRegistry.has(baseMethodQn)) {
              return [NodeLabel.METHOD, baseMethodQn, 1.0];
            }
          }
        }
      }
    }

    // Check if it's a static method call (ClassName.method) inside the same file.
    const staticMethodQn = buildQualifiedName(moduleQn, callName);
    if (this.functionRegistry.has(staticMethodQn)) {
      return [NodeLabel.METHOD, staticMethodQn, 1.0];
    }

    return null;
  }

  private resolveSimpleCall(
    callName: string,
    moduleQn: string,
    classContext: string | null
  ): [NodeLabel, string, number] | null {
    // Check local scope first
    const localQn = buildQualifiedName(moduleQn, callName);
    if (this.functionRegistry.has(localQn)) {
      const funcType = this.functionRegistry.get(localQn);
      return [this.nodeTypeToLabel(funcType!), localQn, 1.0];
    }

    // Check if it's a method in current class
    if (classContext) {
      const methodQn = `${classContext}${cs.SEPARATOR_DOT}${callName}`;
      if (this.functionRegistry.has(methodQn)) {
        return [NodeLabel.METHOD, methodQn, 1.0];
      }
    }

    // Check imports
    const importedQn = this.importProcessor.resolveImport(callName, moduleQn);
    if (importedQn) {
      if (this.functionRegistry.has(importedQn)) {
        const funcType = this.functionRegistry.get(importedQn);
        return [this.nodeTypeToLabel(funcType!), importedQn, 1.0];
      }
      // Import target not in registry — might be a re-export.
      // Try finding the function by name in the same top-level dir.
      const parsed = parseQualifiedName(importedQn.includes(':') ? importedQn : `${importedQn}:x`);
      const topDir = parsed ? parsed.filePath.split('/')[0] + '/' : '';
      const candidates = this.functionRegistry.findEndingWith(callName)
        .filter(qn => topDir && qn.startsWith(topDir));
      if (candidates.length === 1) {
        const funcType = this.functionRegistry.get(candidates[0]);
        return [this.nodeTypeToLabel(funcType!), candidates[0], 0.6];
      }
      return [NodeLabel.FUNCTION, importedQn, 0.8];
    }

    // Check for wildcard imports
    const moduleImports = this.importProcessor.importMapping[moduleQn];
    if (moduleImports) {
      for (const [key, value] of Object.entries(moduleImports)) {
        if (key.startsWith('*')) {
          const wildcardModule = value;
          const funcQn = wildcardModule.includes(':')
            ? `${wildcardModule}${cs.SEPARATOR_DOT}${callName}`
            : buildQualifiedName(wildcardModule, callName);
          if (this.functionRegistry.has(funcQn)) {
            const funcType = this.functionRegistry.get(funcQn);
            return [this.nodeTypeToLabel(funcType!), funcQn, 1.0];
          }
        }
      }
    }

    return null;
  }

  /**
   * Resolve a builtin function call
   */
  resolveBuiltinCall(callName: string): [NodeLabel, string, number] | null {
    // Check JavaScript builtins
    if (cs.JS_BUILTIN_PATTERNS.has(callName)) {
      return [NodeLabel.FUNCTION, `${cs.BUILTIN_PREFIX}${cs.SEPARATOR_DOT}${callName}`, 0.3];
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
      return [NodeLabel.FUNCTION, `${cs.BUILTIN_PREFIX}${cs.SEPARATOR_DOT}${callName}`, 0.3];
    }

    return null;
  }

  /**
   * Resolve C++ operator call
   */
  resolveCppOperatorCall(callName: string, moduleQn: string): [NodeLabel, string, number] | null {
    if (callName.startsWith(cs.OPERATOR_PREFIX)) {
      const operatorQn = cs.CPP_OPERATORS[callName];
      if (operatorQn) {
        return [NodeLabel.FUNCTION, operatorQn, 0.3];
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
  ): [NodeLabel, string, number] | null {
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
            return [NodeLabel.METHOD, methodQn, 1.0];
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
  /** Return type registry (shared with CallResolver) — used by extractLocalVarTypes */
  private readonly returnTypeRegistry: Map<string, string> | null;

  constructor(
    ingestor: IngestorProtocol,
    repoPath: string,
    projectName: string,
    functionRegistry: FunctionRegistryTrie,
    importProcessor: ImportProcessorProtocol,
    typeInference: TypeInferenceProtocol | null,
    classInheritance: ClassInheritance,
    classFieldRegistry: import('./type-env.js').ClassFieldRegistry | null = null,
    returnTypeRegistry: Map<string, string> | null = null,
  ) {
    this.ingestor = ingestor;
    this.repoPath = repoPath;
    this.projectName = projectName;
    this.returnTypeRegistry = returnTypeRegistry;
    this.resolver = new CallResolver(
      functionRegistry,
      importProcessor,
      typeInference,
      classInheritance,
      classFieldRegistry,
      returnTypeRegistry,
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
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
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

      const classQn = buildQualifiedName(moduleQn, className);

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

      const methodQn = `${classQn}${cs.SEPARATOR_DOT}${methodName}`; // classQn is 'path:Class', append '.method'

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

    // Build local variable type map by walking the function body for declarations
    // Handles: const x: Type = ..., let x = new Type(), const x = SomeStaticFactory.create()
    const localVarTypes = this.extractLocalVarTypes(callerNode, language);

    const matches = langQueries.calls.matches(callerNode);
    const captures = this.extractCaptures(matches);
    const callNodes = captures[cs.CAPTURE_CALL] ?? [];

    logger.debug(`Found ${callNodes.length} call nodes in ${callerQn}`);

    for (const callNode of callNodes) {
      const callName = this.getCallTargetName(callNode);
      if (!callName) continue;

      // Try different resolution strategies
      let calleeInfo: [NodeLabel, string, number] | null = null;

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

      const [calleeType, calleeQn, confidence] = calleeInfo;

      // Skip constructor calls (treated as class references)
      if (calleeType === NodeLabel.CLASS) {
        logger.debug(`Skipping class constructor call: ${callName} -> ${calleeQn}`);
        continue;
      }

      logger.debug(`Found call: ${callerQn} -> ${calleeQn} (${calleeType}, conf=${confidence})`);

      // Create CALLS relationship with confidence score
      this.ingestor.ensureRelationshipBatch(
        [callerType, cs.KEY_QUALIFIED_NAME, callerQn],
        cs.RelationshipType.CALLS,
        [calleeType, cs.KEY_QUALIFIED_NAME, calleeQn],
        { confidence }
      );
    }
  }

  /**
   * Walk a function/method body to extract local variable types.
   * Used by ingestFunctionCalls to populate localVarTypes for the call resolver.
   *
   * Handles common TypeScript/JavaScript patterns:
   *   const x: User = ...               → x: User
   *   const x = new User()              → x: User
   *   const x = await new User()        → x: User
   *   const x = SomeFactory.create(...) → x: SomeFactory (best effort, less precise)
   *
   * Only TS/JS for now.
   */
  private extractLocalVarTypes(
    bodyNode: TreeSitterNode,
    language: SupportedLanguage,
  ): Map<string, string> {
    const types = new Map<string, string>();
    if (
      language !== SupportedLanguage.TS &&
      language !== SupportedLanguage.JS
    ) {
      return types;
    }

    // First, extract function parameters from the root body's enclosing function
    // (handles: function foo(x: Type) { x.method() })
    this.extractParamTypes(bodyNode, types);

    const walk = (node: TreeSitterNode): void => {
      // Don't descend into nested function/class definitions — they have their own scope
      // (we'll process them separately)
      const nestedScope =
        node.type === 'function_declaration' ||
        node.type === 'method_definition' ||
        node.type === 'class_declaration' ||
        node.type === 'class' ||
        node.type === 'interface_declaration';

      if (nestedScope && node !== bodyNode) {
        return;
      }

      if (
        node.type === 'lexical_declaration' ||
        node.type === 'variable_declaration'
      ) {
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child && child.type === 'variable_declarator') {
            this.processDeclaratorForTypes(child, types);
          }
        }
      }

      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (c) walk(c);
      }
    };

    walk(bodyNode);
    return types;
  }

  /**
   * Extract typed parameters from a function body node.
   * Handles: function foo(x: Type), const f = (x: Type) => ..., class method(x: Type)
   */
  private extractParamTypes(
    bodyNode: TreeSitterNode,
    types: Map<string, string>,
  ): void {
    // The bodyNode is usually the function/method node itself (when ingestFunctionCalls
    // is called with the function node). Look for its 'parameters' field.
    const paramsNode = bodyNode.childForFieldName('parameters');
    if (!paramsNode) return;

    for (let i = 0; i < paramsNode.childCount; i++) {
      const param = paramsNode.child(i);
      if (!param) continue;

      // TS: required_parameter, optional_parameter
      if (
        param.type === 'required_parameter' ||
        param.type === 'optional_parameter'
      ) {
        // Get name
        const patternNode = param.childForFieldName('pattern') ?? param.namedChild(0);
        if (!patternNode || patternNode.type !== 'identifier') continue;
        const paramName = patternNode.text;
        if (!paramName) continue;

        // Get type
        const paramType = this.extractParamType(param);
        if (paramType) {
          types.set(paramName, paramType);
        }
      }
      // JS: formal_parameter (no types, skip)
    }
  }

  /**
   * Extract a type annotation from a parameter node.
   */
  private extractParamType(paramNode: TreeSitterNode): string | null {
    // Walk children for type_annotation
    for (let i = 0; i < paramNode.childCount; i++) {
      const c = paramNode.child(i);
      if (c && c.type === 'type_annotation') {
        const inner = c.namedChild(0);
        if (inner) {
          return this.extractTypeFromNode(inner);
        }
      }
    }
    return null;
  }

  /**
   * Extract a (varName, type) pair from a variable_declarator node, if possible.
   */
  private processDeclaratorForTypes(
    declNode: TreeSitterNode,
    types: Map<string, string>,
  ): void {
    // Get var name
    const nameNode = declNode.childForFieldName('name');
    if (!nameNode || nameNode.type !== 'identifier') return;
    const varName = nameNode.text;
    if (!varName) return;

    // Tier 0: explicit type annotation
    const typeAnnNode = declNode.childForFieldName('type');
    if (typeAnnNode) {
      const inner = typeAnnNode.namedChild(0) ?? typeAnnNode;
      const t = this.extractTypeFromNode(inner);
      if (t) {
        types.set(varName, t);
        return;
      }
    }
    // Walk children for type_annotation (alternative)
    for (let i = 0; i < declNode.childCount; i++) {
      const c = declNode.child(i);
      if (c && c.type === 'type_annotation') {
        const inner = c.namedChild(0);
        if (inner) {
          const t = this.extractTypeFromNode(inner);
          if (t) {
            types.set(varName, t);
            return;
          }
        }
      }
    }

    // Tier 1: constructor inference — const x = new User()
    const valueNode = declNode.childForFieldName('value');
    if (!valueNode) return;

    let target = valueNode;
    // Unwrap await: const x = await new User()
    if (target.type === 'await_expression') {
      const inner = target.namedChild(0);
      if (inner) target = inner;
    }

    if (target.type === 'new_expression') {
      const ctor = target.childForFieldName('constructor');
      if (ctor) {
        const t = this.extractTypeFromNode(ctor);
        if (t) {
          types.set(varName, t);
          return;
        }
      }
      const first = target.namedChild(0);
      if (first) {
        const t = this.extractTypeFromNode(first);
        if (t) {
          types.set(varName, t);
          return;
        }
      }
    }

    // Tier 2: static factory call — const x = ClassName.create(...)
    if (target.type === 'call_expression') {
      const callee = target.childForFieldName('function');

      // Tier 2a: member expression — ClassName.create() or obj.method()
      if (callee && callee.type === 'member_expression') {
        const obj = callee.childForFieldName('object');
        const prop = callee.childForFieldName('property');
        if (obj && obj.type === 'identifier' && prop) {
          const className = obj.text;
          const methodName = prop.text;
          // Heuristic: factory methods like create, of, from, fromX, build, getInstance
          if (
            className &&
            /^[A-Z]/.test(className) &&
            methodName &&
            /^(create|of|from|build|getInstance|inMemory|new)/.test(methodName)
          ) {
            types.set(varName, className);
            return;
          }
          // Tier 3a: Class.method() — lookup return type in registry
          if (className && methodName && this.returnTypeRegistry) {
            const methodKey = `${className}.${methodName}`;
            const retType = this.returnTypeRegistry.get(methodKey);
            if (retType) {
              types.set(varName, retType);
              return;
            }
          }
          // Tier 3b: obj.method() — check if obj is already typed; lookup obj's class method return type
          if (obj.type === 'identifier' && prop) {
            const objName = obj.text;
            const methodName2 = prop.text;
            const objType = types.get(objName);
            if (objType && this.returnTypeRegistry) {
              const methodKey = `${objType}.${methodName2}`;
              const retType = this.returnTypeRegistry.get(methodKey);
              if (retType) {
                types.set(varName, retType);
                return;
              }
            }
          }
        }
      }

      // Tier 3c: bare function call — const user = getUser()
      if (callee && callee.type === 'identifier' && this.returnTypeRegistry) {
        const fnName = callee.text;
        if (fnName) {
          const retType = this.returnTypeRegistry.get(fnName);
          if (retType) {
            types.set(varName, retType);
            return;
          }
        }
      }
    }
  }

  /**
   * Extract a simple type name from a type/identifier node.
   *  Strips generics, nullable wrappers, and array suffixes.
   */
  private extractTypeFromNode(node: TreeSitterNode): string | null {
    if (!node) return null;
    let text = node.text;
    if (!text) return null;

    // Strip union with null/undefined: 'User | null' → 'User'
    if (text.includes('|')) {
      const parts = text.split('|').map((p) => p.trim()).filter(
        (p) => p && p !== 'null' && p !== 'undefined' && p !== 'void',
      );
      if (parts.length > 0) text = parts[0]!;
    }
    // Strip trailing ?
    text = text.replace(/\?$/, '').trim();
    // Strip array suffix
    text = text.replace(/\[\]$/, '').trim();
    // Strip generic wrappers: 'Promise<User>' → 'User', 'Array<User>' → 'User'
    const m = text.match(/^(?:Promise|Array|Map|Set|Record|Partial|Readonly|Awaited)<(.+)>$/);
    if (m) {
      text = m[1]!.trim();
      // For Map<K,V>, take last (value type)
      if (text.includes(',')) {
        const parts = text.split(',').map((p) => p.trim());
        text = parts[parts.length - 1]!;
      }
      // Recurse-strip nullable
      text = text.split('|')[0]!.trim();
    }
    // Strip remaining generic args: 'Foo<T>' → 'Foo'
    text = text.replace(/<.*$/, '').trim();

    // Must be simple identifier
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(text)) {
      return text;
    }
    return null;
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

  private buildModuleQn(relativePath: string, _fileName: string): string {
    return buildModuleQualifiedName(relativePath);
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
    const localName = pathParts.length > 0
      ? `${pathParts.join(cs.SEPARATOR_DOT)}${cs.SEPARATOR_DOT}${funcName}`
      : funcName;
    return buildQualifiedName(moduleQn, localName);
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
