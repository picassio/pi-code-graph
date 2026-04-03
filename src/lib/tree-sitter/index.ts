import { logger } from '../logger.js';
/**
 * Tree-sitter parser initialization and management
 * Provides async initialization, language loading, and query compilation
 */

import { Parser, Language, Query, Tree, Node } from 'web-tree-sitter';
import { SupportedLanguage } from '../constants.js';
import type { LanguageQueries, LanguageSpec } from '../types.js';
import { LANGUAGE_WASM_CONFIG, LANGUAGE_SPECS, getLanguageForExtension, hasWasmSupport, getWasmSupportedLanguages } from './languages.js';
import { LANGUAGE_QUERIES, type LanguageQuerySet } from './queries.js';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

// =============================================================================
// Types
// =============================================================================

/** Re-export Node as SyntaxNode for compatibility */
export type SyntaxNode = Node;

export interface ParserManager {
  /** Get or create a parser for a language */
  getParser(language: SupportedLanguage): Promise<Parser>;
  /** Get the language object for a language */
  getLanguage(language: SupportedLanguage): Promise<Language>;
  /** Parse source code into an AST */
  parse(source: string, language: SupportedLanguage): Promise<Tree>;
  /** Parse a file by extension */
  parseByExtension(source: string, extension: string): Promise<Tree | null>;
  /** Get compiled queries for a language */
  getQueries(language: SupportedLanguage): Promise<LanguageQueries>;
  /** Get available languages */
  getAvailableLanguages(): SupportedLanguage[];
  /** Check if a language is loaded */
  isLanguageLoaded(language: SupportedLanguage): boolean;
  /** Dispose all resources */
  dispose(): void;
}

// =============================================================================
// State
// =============================================================================

let isTreeSitterInitialized = false;
const loadedLanguages = new Map<SupportedLanguage, Language>();
const languageParsers = new Map<SupportedLanguage, Parser>();
const compiledQueries = new Map<SupportedLanguage, LanguageQueries>();

// =============================================================================
// WASM Path Resolution
// =============================================================================

/**
 * Resolve the path to the tree-sitter WASM file
 */
function resolveTreeSitterWasmPath(): string {
  // Try different resolution strategies
  const require = createRequire(import.meta.url);

  try {
    // Strategy 1: Resolve from node_modules
    const webTreeSitterPath = require.resolve('web-tree-sitter');
    const wasmPath = join(dirname(webTreeSitterPath), 'web-tree-sitter.wasm');
    if (existsSync(wasmPath)) {
      return wasmPath;
    }
  } catch {
    // Fall through to next strategy
  }

  // Strategy 2: Try relative to this file
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(thisDir, '..', '..', '..', 'node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm'),
    join(thisDir, '..', '..', '..', '..', 'node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm'),
    join(process.cwd(), 'node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm'),
  ];

  for (const candidate of candidates) {
    const resolved = resolve(candidate);
    if (existsSync(resolved)) {
      return resolved;
    }
  }

  throw new Error('Could not find web-tree-sitter.wasm');
}

/**
 * Resolve the path to a language WASM file
 */
function resolveLanguageWasmPath(language: SupportedLanguage): string {
  const config = LANGUAGE_WASM_CONFIG[language];
  if (!config) {
    throw new Error(`No WASM file configured for language: ${language}`);
  }

  const { wasmName, packagePath } = config;
  const require = createRequire(import.meta.url);

  try {
    // Strategy 1: Resolve from the configured package
    const packageName = packagePath.split('/')[0];
    const subPath = packagePath.split('/').slice(1).join('/');
    const pkgJsonPath = require.resolve(`${packageName}/package.json`);
    const wasmPath = join(dirname(pkgJsonPath), subPath, wasmName);
    if (existsSync(wasmPath)) {
      return wasmPath;
    }
  } catch {
    // Fall through to next strategy
  }

  // Strategy 2: Try relative to this file
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(thisDir, '..', '..', '..', 'node_modules', packagePath, wasmName),
    join(thisDir, '..', '..', '..', '..', 'node_modules', packagePath, wasmName),
    join(process.cwd(), 'node_modules', packagePath, wasmName),
  ];

  for (const candidate of candidates) {
    const resolved = resolve(candidate);
    if (existsSync(resolved)) {
      return resolved;
    }
  }

  throw new Error(`Could not find WASM file for language: ${language} (${packagePath}/${wasmName})`);
}

// =============================================================================
// Initialization
// =============================================================================

/**
 * Initialize the tree-sitter parser engine
 * Must be called before any parsing operations
 */
export async function initTreeSitter(): Promise<void> {
  if (isTreeSitterInitialized) {
    return;
  }

  try {
    const wasmPath = resolveTreeSitterWasmPath();
    await Parser.init({
      locateFile: () => wasmPath,
    });
    isTreeSitterInitialized = true;
  } catch (error) {
    throw new Error(`Failed to initialize tree-sitter: ${error}`);
  }
}

/**
 * Ensure tree-sitter is initialized
 */
async function ensureInitialized(): Promise<void> {
  if (!isTreeSitterInitialized) {
    await initTreeSitter();
  }
}

// =============================================================================
// Language Loading
// =============================================================================

/**
 * Load a language grammar from its WASM file
 */
export async function loadLanguage(language: SupportedLanguage): Promise<Language> {
  // Return cached language if already loaded
  if (loadedLanguages.has(language)) {
    return loadedLanguages.get(language)!;
  }

  await ensureInitialized();

  let wasmPath: string;
  try {
    wasmPath = resolveLanguageWasmPath(language);
  } catch (error) {
    throw new Error(`Failed to resolve WASM path for ${language}: ${error}`);
  }

  try {
    const lang = await Language.load(wasmPath);
    loadedLanguages.set(language, lang);
    return lang;
  } catch (error) {
    throw new Error(`Failed to load language ${language} from ${wasmPath}: ${error}`);
  }
}

/**
 * Load all supported languages
 */
export async function loadAllLanguages(): Promise<Map<SupportedLanguage, Language>> {
  await ensureInitialized();

  const results = new Map<SupportedLanguage, Language>();
  // Only load languages that have WASM files configured
  const languages = getWasmSupportedLanguages();

  // Load languages in parallel
  const loadPromises = languages.map(async (lang) => {
    try {
      const loaded = await loadLanguage(lang);
      results.set(lang, loaded);
    } catch (error) {
      logger.warn(`Failed to load ${lang}: ${error}`);
    }
  });

  await Promise.all(loadPromises);
  return results;
}

// =============================================================================
// Parser Management
// =============================================================================

/**
 * Get or create a parser for a language
 */
export async function getParser(language: SupportedLanguage): Promise<Parser> {
  // Return cached parser if available
  if (languageParsers.has(language)) {
    return languageParsers.get(language)!;
  }

  await ensureInitialized();

  const lang = await loadLanguage(language);
  const parser = new Parser();
  parser.setLanguage(lang);
  languageParsers.set(language, parser);

  return parser;
}

/**
 * Parse source code into an AST
 */
export async function parse(source: string, language: SupportedLanguage): Promise<Tree> {
  const parser = await getParser(language);
  const tree = parser.parse(source);
  if (!tree) {
    throw new Error(`Failed to parse source code for language: ${language}`);
  }
  return tree;
}

/**
 * Parse source code based on file extension
 */
export async function parseByExtension(source: string, extension: string): Promise<Tree | null> {
  const language = getLanguageForExtension(extension);
  if (!language) {
    return null;
  }
  return parse(source, language);
}

// =============================================================================
// Query Compilation
// =============================================================================

/**
 * Compile a tree-sitter query for a language
 */
export async function compileQuery(language: SupportedLanguage, queryString: string): Promise<Query | null> {
  if (!queryString || queryString.trim() === '') {
    return null;
  }

  const lang = await loadLanguage(language);

  try {
    return new Query(lang, queryString);
  } catch (error) {
    logger.warn(`Failed to compile query for ${language}: ${error}`);
    return null;
  }
}

/**
 * Get compiled queries for a language
 */
export async function getQueries(language: SupportedLanguage): Promise<LanguageQueries> {
  // Return cached queries if available
  if (compiledQueries.has(language)) {
    return compiledQueries.get(language)!;
  }

  const lang = await loadLanguage(language);
  const parser = await getParser(language);
  const spec = LANGUAGE_SPECS[language];
  const querySet = LANGUAGE_QUERIES[language];

  const queries: LanguageQueries = {
    functions: await compileQuery(language, querySet.functions),
    classes: await compileQuery(language, querySet.classes),
    calls: await compileQuery(language, querySet.calls),
    imports: await compileQuery(language, querySet.imports),
    locals: await compileQuery(language, querySet.locals),
    config: spec,
    language: lang,
    parser,
  };

  compiledQueries.set(language, queries);
  return queries;
}

/**
 * Load queries for all supported languages
 */
export async function loadAllQueries(): Promise<Map<SupportedLanguage, LanguageQueries>> {
  const results = new Map<SupportedLanguage, LanguageQueries>();
  // Only load queries for languages that have WASM files configured
  const languages = getWasmSupportedLanguages();

  const loadPromises = languages.map(async (lang) => {
    try {
      const queries = await getQueries(lang);
      results.set(lang, queries);
    } catch (error) {
      logger.warn(`Failed to load queries for ${lang}: ${error}`);
    }
  });

  await Promise.all(loadPromises);
  return results;
}

// =============================================================================
// Parser Manager
// =============================================================================

/**
 * Create a parser manager instance
 */
export async function createParserManager(): Promise<ParserManager> {
  await initTreeSitter();

  return {
    async getParser(language: SupportedLanguage): Promise<Parser> {
      return getParser(language);
    },

    async getLanguage(language: SupportedLanguage): Promise<Language> {
      return loadLanguage(language);
    },

    async parse(source: string, language: SupportedLanguage): Promise<Tree> {
      return parse(source, language);
    },

    async parseByExtension(source: string, extension: string): Promise<Tree | null> {
      return parseByExtension(source, extension);
    },

    async getQueries(language: SupportedLanguage): Promise<LanguageQueries> {
      return getQueries(language);
    },

    getAvailableLanguages(): SupportedLanguage[] {
      return Array.from(loadedLanguages.keys());
    },

    isLanguageLoaded(language: SupportedLanguage): boolean {
      return loadedLanguages.has(language);
    },

    dispose(): void {
      // Clear all caches
      languageParsers.clear();
      loadedLanguages.clear();
      compiledQueries.clear();
    },
  };
}

// =============================================================================
// Convenience Functions
// =============================================================================

/**
 * Get the name of a node (from 'name' field or text content)
 */
export function getNodeName(node: Node): string | null {
  // Try to get name from 'name' field
  const nameNode = node.childForFieldName('name');
  if (nameNode) {
    return nameNode.text;
  }

  // For some languages, try 'identifier' field
  const identNode = node.childForFieldName('identifier');
  if (identNode) {
    return identNode.text;
  }

  return null;
}

/**
 * Get the text content of a node, decoded as UTF-8
 */
export function getNodeText(node: Node): string {
  return node.text;
}

/**
 * Get the start and end line numbers of a node (1-indexed)
 */
export function getNodeLines(node: Node): { startLine: number; endLine: number } {
  return {
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  };
}

/**
 * Check if the tree-sitter engine is initialized
 */
export function isInitialized(): boolean {
  return isTreeSitterInitialized;
}

/**
 * Get the spec for a language
 */
export function getLanguageSpec(language: SupportedLanguage): LanguageSpec {
  return LANGUAGE_SPECS[language];
}

// =============================================================================
// Re-exports
// =============================================================================

export {
  LANGUAGE_SPECS,
  LANGUAGE_WASM_NAMES,
  LANGUAGE_WASM_CONFIG,
  getLanguageForExtension,
  getLanguageSpecForExtension,
  getSupportedExtensions,
  getSupportedLanguages,
  getWasmSupportedLanguages,
  hasWasmSupport,
  isSupportedExtension,
} from './languages.js';

export {
  LANGUAGE_QUERIES,
  CAPTURE,
  buildQueryPattern,
  getQueriesForLanguage,
  getQuery,
  type LanguageQuerySet,
} from './queries.js';

export { Tree, Language, Query, Node, Parser };
