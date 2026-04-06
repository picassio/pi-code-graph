/**
 * Suffix-based import resolution (file-path edition).
 *
 * New-format module QNs are normalized file paths with extensions
 * (e.g., 'src/lib/foo.ts'). This resolver walks progressively shorter
 * path suffixes to match a known file path.
 */

import { relative } from 'node:path';

/** Source extensions we match when resolving imports without extension. */
const CANDIDATE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const STRIP_EXT_RE = /\.(tsx?|jsx?|mjs|cjs|vue|py|java|kt|kts|c|h|cpp|hpp|cc|cxx|hxx|hh|cs|go|rs|php|phtml|swift|rb|lua)$/i;

export interface SuffixIndex {
  get(suffix: string): string | undefined;
  getInsensitive(suffix: string): string | undefined;
  readonly size: number;
  /** True iff the given file-path module QN is known. */
  hasModuleQn(qn: string): boolean;
}

function normalizeRel(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Build a suffix index from source-file paths.
 * Keys are path suffixes (with and without extension, and with '/index'
 * stripped); values are the canonical file-path module QN.
 */
export function buildSuffixIndex(
  repoPath: string,
  _projectName: string,
  filePaths: Iterable<string>,
): SuffixIndex {
  const exact = new Map<string, string>();
  const lower = new Map<string, string>();
  const known = new Set<string>();

  const addKey = (key: string, moduleQn: string) => {
    if (!key) return;
    if (!exact.has(key)) exact.set(key, moduleQn);
    const lc = key.toLowerCase();
    if (!lower.has(lc)) lower.set(lc, moduleQn);
  };

  for (const fp of filePaths) {
    const rel = normalizeRel(relative(repoPath, fp));
    if (!rel || rel.startsWith('..')) continue;

    const moduleQn = rel; // file path with extension
    known.add(moduleQn);

    const noExt = rel.replace(STRIP_EXT_RE, '');
    const noIndex = noExt.replace(/\/index$/i, '');

    const parts = rel.split('/').filter(Boolean);
    const partsNoExt = noExt.split('/').filter(Boolean);
    const partsNoIndex = noIndex.split('/').filter(Boolean);

    for (let j = 0; j < parts.length; j++) addKey(parts.slice(j).join('/'), moduleQn);
    for (let j = 0; j < partsNoExt.length; j++) addKey(partsNoExt.slice(j).join('/'), moduleQn);
    for (let j = 0; j < partsNoIndex.length; j++) addKey(partsNoIndex.slice(j).join('/'), moduleQn);
  }

  return {
    get: (s) => exact.get(s),
    getInsensitive: (s) => lower.get(s.toLowerCase()),
    get size() { return exact.size; },
    hasModuleQn: (qn) => known.has(qn),
  };
}

export const EMPTY_SUFFIX_INDEX: SuffixIndex = {
  get: () => undefined,
  getInsensitive: () => undefined,
  size: 0,
  hasModuleQn: () => false,
};

/**
 * Resolve an import to a known file-path module QN by progressively
 * dropping leading path segments.
 */
export function suffixResolveImport(
  importPath: string,
  primaryGuess: string | null,
  index: SuffixIndex,
): string | null {
  if (index.size === 0) return null;

  const candidates: string[][] = [];

  if (primaryGuess) {
    const cleaned = normalizeRel(primaryGuess).replace(STRIP_EXT_RE, '');
    candidates.push(cleaned.split('/').filter(Boolean));
  }

  const cleanedImport = normalizeRel(importPath)
    .replace(STRIP_EXT_RE, '')
    .replace(/^\.\/+/, '');
  const importParts = cleanedImport
    .split('/')
    .filter((p) => p && p !== '.' && p !== '..');
  if (importParts.length > 0) candidates.push(importParts);

  for (const parts of candidates) {
    for (let i = 0; i < parts.length; i++) {
      const suffix = parts.slice(i).join('/');
      if (!suffix) continue;
      // Try with each candidate extension appended, plus '/index.ext'
      for (const ext of CANDIDATE_EXTS) {
        const hit = index.get(suffix + ext) ?? index.getInsensitive(suffix + ext);
        if (hit) return hit;
        const idxHit = index.get(suffix + '/index' + ext) ?? index.getInsensitive(suffix + '/index' + ext);
        if (idxHit) return idxHit;
      }
      // Also try exact (no extension, e.g. user asked for a path with ext already)
      const direct = index.get(suffix) ?? index.getInsensitive(suffix);
      if (direct) return direct;
    }
  }

  return null;
}
