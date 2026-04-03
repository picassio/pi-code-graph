import { logger } from '../logger.js';
/**
 * Workspace resolver for monorepo cross-package import resolution
 *
 * Reads package.json workspaces to build a mapping of npm package names
 * to their local filesystem paths, enabling cross-package CALLS resolution.
 *
 * Supports: npm/yarn/pnpm workspaces, tsconfig paths
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';
import { SEPARATOR_DOT } from '../constants.js';

// =============================================================================
// Types
// =============================================================================

export interface WorkspacePackage {
  /** npm package name (e.g., "@mariozechner/pi-ai") */
  name: string;
  /** Relative path from repo root (e.g., "packages/ai") */
  relativePath: string;
  /** Qualified name prefix (e.g., "pi-mono.packages.ai") */
  qualifiedPrefix: string;
  /** Resolved subpath exports: "." → "src.index", "./oauth" → "src.oauth" */
  subpathMap: Map<string, string>;
}

export interface WorkspaceMap {
  /** Map of npm package name → workspace info */
  packages: Map<string, WorkspacePackage>;
  /** Resolve a non-relative import to a local qualified name, or null if external */
  resolve(importPath: string): string | null;
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Build a workspace map from the repo root
 * Scans package.json workspaces to find all local packages
 */
export function buildWorkspaceMap(repoPath: string, projectName: string): WorkspaceMap {
  const packages = new Map<string, WorkspacePackage>();

  try {
    const rootPkgPath = join(repoPath, 'package.json');
    if (!existsSync(rootPkgPath)) {
      return createWorkspaceMap(packages);
    }

    const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf-8'));

    // Get workspace patterns from package.json
    let workspacePatterns: string[] = [];

    if (Array.isArray(rootPkg.workspaces)) {
      // npm/yarn format: "workspaces": ["packages/*"]
      workspacePatterns = rootPkg.workspaces;
    } else if (rootPkg.workspaces?.packages) {
      // yarn v1 format: "workspaces": { "packages": ["packages/*"] }
      workspacePatterns = rootPkg.workspaces.packages;
    }

    // Also check pnpm-workspace.yaml
    if (workspacePatterns.length === 0) {
      const pnpmPath = join(repoPath, 'pnpm-workspace.yaml');
      if (existsSync(pnpmPath)) {
        const content = readFileSync(pnpmPath, 'utf-8');
        // Simple YAML parsing for packages list
        const match = content.match(/packages:\s*\n((?:\s*-\s*.+\n?)*)/);
        if (match) {
          workspacePatterns = match[1]
            .split('\n')
            .map(line => line.replace(/^\s*-\s*/, '').trim())
            .filter(Boolean);
        }
      }
    }

    if (workspacePatterns.length === 0) {
      return createWorkspaceMap(packages);
    }

    // Expand glob patterns and find all package directories
    for (const pattern of workspacePatterns) {
      const expandedDirs = expandWorkspacePattern(repoPath, pattern);
      for (const dir of expandedDirs) {
        const pkgJsonPath = join(dir, 'package.json');
        if (!existsSync(pkgJsonPath)) continue;

        try {
          const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
          if (!pkg.name) continue;

          const relativePath = relative(repoPath, dir).replace(/\\/g, '/');
          const qualifiedPrefix = `${projectName}${SEPARATOR_DOT}${relativePath.replace(/\//g, SEPARATOR_DOT)}`;

          // Build subpath map from package.json exports
          const subpathMap = buildSubpathMap(pkg, dir);

          packages.set(pkg.name, {
            name: pkg.name,
            relativePath,
            qualifiedPrefix,
            subpathMap,
          });

          logger.info(`[workspace] Found package: ${pkg.name} → ${relativePath} (${qualifiedPrefix})`);
        } catch {
          // Skip packages with invalid package.json
        }
      }
    }

    if (packages.size > 0) {
      logger.info(`[workspace] Resolved ${packages.size} workspace packages`);
    }
  } catch (err) {
    logger.warn(`[workspace] Failed to read workspace config: ${err}`);
  }

  return createWorkspaceMap(packages);
}

/**
 * Expand a workspace glob pattern to actual directories
 * Supports: "packages/*", "apps/*", "libs/foo"
 */
function expandWorkspacePattern(repoPath: string, pattern: string): string[] {
  // Remove trailing slashes
  pattern = pattern.replace(/\/+$/, '');

  if (pattern.includes('*')) {
    // Glob pattern: "packages/*" → list subdirectories
    const base = pattern.replace(/\/?\*.*$/, '');
    const basePath = join(repoPath, base);

    if (!existsSync(basePath) || !statSync(basePath).isDirectory()) {
      return [];
    }

    try {
      return readdirSync(basePath)
        .map(entry => join(basePath, entry))
        .filter(fullPath => {
          try {
            return statSync(fullPath).isDirectory();
          } catch {
            return false;
          }
        });
    } catch {
      return [];
    }
  }

  // Exact path: "libs/foo"
  const fullPath = join(repoPath, pattern);
  if (existsSync(fullPath) && statSync(fullPath).isDirectory()) {
    return [fullPath];
  }

  return [];
}

/**
 * Create a WorkspaceMap from a packages map
 */
function createWorkspaceMap(packages: Map<string, WorkspacePackage>): WorkspaceMap {
  return {
    packages,
    resolve(importPath: string): string | null {
      if (packages.size === 0) return null;

      // Try exact match first: "@scope/pkg" → resolve main entry
      if (packages.has(importPath)) {
        const pkg = packages.get(importPath)!;
        const mainEntry = pkg.subpathMap.get('.');
        if (mainEntry) {
          return `${pkg.qualifiedPrefix}${SEPARATOR_DOT}${mainEntry}`;
        }
        return pkg.qualifiedPrefix;
      }

      // Try subpath match: "@scope/pkg/subpath"
      for (const [pkgName, pkg] of packages) {
        if (importPath.startsWith(pkgName + '/')) {
          const subpath = './' + importPath.slice(pkgName.length + 1);

          // Check exports map first (e.g., "./oauth" → "src.oauth")
          const exportResolved = pkg.subpathMap.get(subpath);
          if (exportResolved) {
            return `${pkg.qualifiedPrefix}${SEPARATOR_DOT}${exportResolved}`;
          }

          // Fallback: direct subpath mapping
          const rawSubpath = importPath.slice(pkgName.length + 1);
          return `${pkg.qualifiedPrefix}${SEPARATOR_DOT}${rawSubpath.replace(/\//g, SEPARATOR_DOT)}`;
        }
      }

      return null;
    },
  };
}

/**
 * Build a map of package.json exports subpaths → source module qualified names
 * e.g., "./oauth" → "src.oauth" (from exports: { "./oauth": "./dist/oauth.js" })
 */
function buildSubpathMap(pkg: any, pkgDir: string): Map<string, string> {
  const map = new Map<string, string>();

  // Read main/module entry point
  const mainEntry = pkg.main || pkg.module;
  if (mainEntry) {
    const srcPath = distToSrc(mainEntry, pkgDir);
    if (srcPath) {
      map.set('.', srcPath);
    }
  }

  // Read exports field
  const exports = pkg.exports;
  if (!exports || typeof exports !== 'object') {
    return map;
  }

  for (const [subpath, target] of Object.entries(exports)) {
    // Get the import/default target
    let targetPath: string | null = null;
    if (typeof target === 'string') {
      targetPath = target;
    } else if (target && typeof target === 'object') {
      const t = target as Record<string, string>;
      targetPath = t.import || t.default || t.require || null;
    }

    if (!targetPath) continue;

    // Convert dist path → src path → qualified name
    const srcPath = distToSrc(targetPath, pkgDir);
    if (srcPath) {
      map.set(subpath, srcPath);
      logger.info(`[workspace] Export: ${subpath} → ${srcPath}`);
    }
  }

  return map;
}

/**
 * Convert a dist/build output path to its source equivalent
 * e.g., "./dist/oauth.js" → "src.oauth" (if src/oauth.ts exists)
 *       "./dist/providers/google.js" → "src.providers.google"
 */
function distToSrc(distPath: string, pkgDir: string): string | null {
  // Remove leading ./ and extension
  let p = distPath.replace(/^\.?\//, '').replace(/\.[^.]+$/, '');

  // Try replacing dist/build/out with src
  const distPrefixes = ['dist/', 'build/', 'out/', 'lib/'];
  for (const prefix of distPrefixes) {
    if (p.startsWith(prefix)) {
      const srcEquiv = 'src/' + p.slice(prefix.length);
      // Check if src file exists
      const srcTs = join(pkgDir, srcEquiv + '.ts');
      const srcTsx = join(pkgDir, srcEquiv + '.tsx');
      const srcIndex = join(pkgDir, srcEquiv, 'index.ts');
      if (existsSync(srcTs) || existsSync(srcTsx)) {
        return srcEquiv.replace(/\//g, SEPARATOR_DOT);
      }
      if (existsSync(srcIndex)) {
        return (srcEquiv + '.index').replace(/\//g, SEPARATOR_DOT);
      }
      // Fallback: use src path even if file not found (might be generated)
      return srcEquiv.replace(/\//g, SEPARATOR_DOT);
    }
  }

  // No dist prefix — use as-is
  return p.replace(/\//g, SEPARATOR_DOT);
}
