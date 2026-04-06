/**
 * Suffix-based import resolution.
 *
 * Ported (and adapted) from GitNexus's `suffixResolve` algorithm:
 *   /import-resolvers/utils.ts
 *
 * Idea: when primary import resolution fails (e.g., re-export chains or
 * ambiguous package paths), try progressively shorter suffixes of the
 * import path against an index built from all known module qualified names.
 *
 * Unlike GitNexus we operate on dotted module qualified names (not file
 * paths) because that is the canonical key our graph uses, but the
 * underlying suffix-trie idea is identical.
 */

import { relative } from 'node:path';
import { SEPARATOR_DOT } from '../constants.js';

/** Source-file extensions we strip when converting a path to a module qn. */
const STRIP_EXT_RE = /\.(tsx?|jsx?|mjs|cjs|vue|py|java|kt|kts|c|h|cpp|hpp|cc|cxx|hxx|hh|cs|go|rs|php|phtml|swift|rb|lua)$/i;

/** Strip "/index" suffix when present (after extension stripping). */
function normalizeModulePart(p: string): string {
  return p.replace(/\/index$/i, '').replace(/\\/g, '/');
}

export interface SuffixIndex {
  /** Look up a (dotted) suffix and return the canonical module qn. */
  get(suffix: string): string | undefined;
  /** Case-insensitive variant. */
  getInsensitive(suffix: string): string | undefined;
  /** Number of entries (mostly for diagnostics/tests). */
  readonly size: number;
  /** True iff a fully qualified module qn exists in the index. */
  hasModuleQn(qn: string): boolean;
}

/**
 * Build a suffix index from a set of source-file paths.
 *
 * @param repoPath  Repository root.
 * @param projectName  Project name used as the root of every module qn.
 * @param filePaths  Absolute (or relative) paths of all source files.
 */
export function buildSuffixIndex(
  repoPath: string,
  projectName: string,
  filePaths: Iterable<string>,
): SuffixIndex {
  const exact = new Map<string, string>();
  const lower = new Map<string, string>();
  const known = new Set<string>();

  const addSuffixes = (parts: string[], moduleQn: string) => {
    for (let j = parts.length - 1; j >= 0; j--) {
      const suffix = parts.slice(j).join(SEPARATOR_DOT);
      if (!suffix) continue;
      if (!exact.has(suffix)) exact.set(suffix, moduleQn);
      const lc = suffix.toLowerCase();
      if (!lower.has(lc)) lower.set(lc, moduleQn);
    }
  };

  for (const fp of filePaths) {
    let rel = relative(repoPath, fp).replace(/\\/g, '/');
    if (!rel || rel.startsWith('..')) continue;

    // Strip known source extensions
    rel = rel.replace(STRIP_EXT_RE, '');
    rel = normalizeModulePart(rel);

    const pathParts = rel.split('/').filter(Boolean);
    if (pathParts.length === 0) continue;

    const moduleQn = [projectName, ...pathParts].join(SEPARATOR_DOT);
    known.add(moduleQn);

    // Index suffixes that include the project name as well as those that don't
    addSuffixes([projectName, ...pathParts], moduleQn);
    addSuffixes(pathParts, moduleQn);
  }

  return {
    get: (s) => exact.get(s),
    getInsensitive: (s) => lower.get(s.toLowerCase()),
    get size() {
      return exact.size;
    },
    hasModuleQn: (qn) => known.has(qn),
  };
}

/** Empty sentinel index — used until a real one is installed. */
export const EMPTY_SUFFIX_INDEX: SuffixIndex = {
  get: () => undefined,
  getInsensitive: () => undefined,
  size: 0,
  hasModuleQn: () => false,
};

/**
 * Try to resolve an import to a known module qn by progressively dropping
 * leading path segments. Mirrors GitNexus's `suffixResolve` but operates on
 * dotted module qns.
 *
 * @param importPath  The original import literal (e.g. "@pkg/oauth"
 *                    or "./parsers/workspace-resolver").
 * @param primaryGuess  The dotted module path produced by primary resolution
 *                      (used as an additional candidate to suffix-match).
 * @param index  The suffix index built from all known source files.
 */
export function suffixResolveImport(
  importPath: string,
  primaryGuess: string | null,
  index: SuffixIndex,
): string | null {
  if (index.size === 0) return null;

  const candidates: string[][] = [];

  // Candidate 1: parts of the primary guess (already dotted)
  if (primaryGuess) {
    candidates.push(primaryGuess.split(SEPARATOR_DOT).filter(Boolean));
  }

  // Candidate 2: parts of the raw import path
  const cleaned = importPath
    .replace(STRIP_EXT_RE, '')
    .replace(/^\.\/+/, '')
    .replace(/\\/g, '/');
  const importParts = cleaned
    .split('/')
    .filter((p) => p && p !== '.' && p !== '..');
  if (importParts.length > 0) candidates.push(importParts);

  for (const parts of candidates) {
    for (let i = 0; i < parts.length; i++) {
      const suffix = parts.slice(i).join(SEPARATOR_DOT);
      if (!suffix) continue;
      const hit = index.get(suffix) ?? index.getInsensitive(suffix);
      if (hit) return hit;
    }
  }

  return null;
}
