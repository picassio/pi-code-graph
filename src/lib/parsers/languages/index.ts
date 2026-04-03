/**
 * Language-specific handlers registry
 * Ported from codebase_rag/parsers/handlers/
 */

import { SupportedLanguage } from '../../constants.js';

// Re-export base types and classes
export { LanguageHandler, BaseLanguageHandler } from './base.js';

// Import language handlers
import { PythonHandler } from './python.js';
import { TypeScriptHandler } from './typescript.js';
import { RustHandler } from './rust.js';
import { JavaHandler } from './java.js';
import { CppHandler } from './cpp.js';
import { GoHandler } from './go.js';
import { BaseLanguageHandler, type LanguageHandler } from './base.js';

// =============================================================================
// Handler Registry
// =============================================================================

const HANDLERS: Map<SupportedLanguage, new () => LanguageHandler> = new Map([
  [SupportedLanguage.PYTHON, PythonHandler],
  [SupportedLanguage.JS, TypeScriptHandler],
  [SupportedLanguage.TS, TypeScriptHandler],
  [SupportedLanguage.CPP, CppHandler],
  [SupportedLanguage.C, CppHandler],  // C uses similar logic to C++
  [SupportedLanguage.RUST, RustHandler],
  [SupportedLanguage.JAVA, JavaHandler],
  [SupportedLanguage.GO, GoHandler],
]);

// Cache for handler instances
const handlerCache = new Map<SupportedLanguage, LanguageHandler>();
const defaultHandler = new BaseLanguageHandler();

/**
 * Get the language handler for a specific language
 */
export function getHandler(language: SupportedLanguage): LanguageHandler {
  // Check cache first
  let handler = handlerCache.get(language);
  if (handler) {
    return handler;
  }

  // Create new handler instance
  const HandlerClass = HANDLERS.get(language);
  if (HandlerClass) {
    handler = new HandlerClass();
    handlerCache.set(language, handler);
    return handler;
  }

  // Return default handler for unsupported languages
  return defaultHandler;
}

/**
 * Check if a language has a specific handler
 */
export function hasHandler(language: SupportedLanguage): boolean {
  return HANDLERS.has(language);
}

/**
 * Get all supported languages with handlers
 */
export function getSupportedLanguages(): SupportedLanguage[] {
  return Array.from(HANDLERS.keys());
}

/**
 * Clear the handler cache (useful for testing)
 */
export function clearHandlerCache(): void {
  handlerCache.clear();
}

// =============================================================================
// Re-exports for individual handlers
// =============================================================================

export { PythonHandler } from './python.js';
export { TypeScriptHandler } from './typescript.js';
export { RustHandler } from './rust.js';
export { JavaHandler } from './java.js';
export { CppHandler } from './cpp.js';
export { GoHandler } from './go.js';

// =============================================================================
// Re-export utility functions from language modules
// =============================================================================

// Python utilities
export {
  isDunderMethod,
  isPrivateMethod,
  hasInitMethod,
  extractPythonBaseClasses,
  extractPythonDocstring,
  extractPythonParameters,
  isPythonAsyncFunction,
  extractPythonImports,
  extractPythonCallInfo,
  type PythonCallInfo,
} from './python.js';

// TypeScript/JavaScript utilities
export {
  isExported as isTsExported,
  isAsyncFunction as isTsAsyncFunction,
  isGeneratorFunction,
  extractBaseClasses as extractTsBaseClasses,
  extractImplementedInterfaces,
  extractParameters as extractTsParameters,
  extractReturnType as extractTsReturnType,
  extractImports as extractTsImports,
  extractExports as extractTsExports,
  extractCallInfo as extractTsCallInfo,
  isBuiltinCall,
  type TsParameter,
  type JsImport,
  type JsExport,
  type JsCallInfo,
} from './typescript.js';

// Rust utilities
export {
  extractImplTarget,
  extractUseImports,
  buildModulePath,
  extractRustParameters,
  isAsyncFunction as isRustAsyncFunction,
  isPublicFunction,
  extractReturnType as extractRustReturnType,
  extractTraitBounds,
  isTraitImpl,
  extractStructFields as extractRustStructFields,
  extractEnumVariants,
  type RustField,
  type RustEnumVariant,
} from './rust.js';

// Java utilities
export {
  extractPackageName,
  extractImportPath,
  extractFromModifiersNode,
  extractClassInfo,
  extractMethodInfo,
  extractFieldInfo,
  extractMethodCallInfo,
  isMainMethod,
  getJavaVisibility,
  buildQualifiedName as buildJavaQualifiedName,
  findPackageStartIndex,
  extractAnnotationInfo,
  type JavaClassInfo,
  type JavaMethodInfo,
  type JavaFieldInfo,
  type JavaAnnotationInfo,
  type JavaMethodCallInfo,
} from './java.js';

// C++ utilities
export {
  convertOperatorSymbolToName,
  buildQualifiedName as buildCppQualifiedName,
  isExported as isCppExported,
  extractExportedClassName,
  extractOperatorName,
  extractDestructorName,
  extractFunctionName as extractCppFunctionName,
  isOutOfClassMethodDefinition,
  extractClassNameFromOutOfClassMethod,
  extractCppParameters,
  extractCppBaseClasses,
  isTemplateClass,
  extractTemplateParameters,
  isConstFunction,
  isVirtualFunction,
  isPureVirtualFunction,
  type CppParameter,
} from './cpp.js';

// Go utilities
export {
  isExportedName,
  extractPackageName as extractGoPackageName,
  extractImports as extractGoImports,
  extractReceiverType,
  isPointerReceiver,
  extractParameters as extractGoParameters,
  extractReturnTypes,
  extractStructFields as extractGoStructFields,
  extractInterfaceMethods,
  extractTypeInfo,
  extractCallInfo as extractGoCallInfo,
  extractDocstring as extractGoDocstring,
  type GoImport,
  type GoParameter,
  type GoReturnType,
  type GoStructField,
  type GoInterfaceMethod,
  type GoTypeInfo,
  type GoCallInfo,
} from './go.js';
