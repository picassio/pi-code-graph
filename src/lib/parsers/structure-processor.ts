import { logger } from '../logger.js';
/**
 * Structure processor for identifying code structure (packages, folders, files)
 * Ported from codebase_rag/parsers/structure_processor.py
 */

import { SupportedLanguage } from '../constants.js';
import type { LanguageQueries, NodeIdentifier } from '../types.js';
import type { IngestorProtocol, StructureProcessorProtocol } from './base.js';
import * as cs from '../constants.js';
import { readdir, stat } from 'node:fs/promises';
import { join, relative, dirname, basename, extname, resolve } from 'node:path';

// =============================================================================
// Path Utility Functions
// =============================================================================

/**
 * Check if a path should be skipped based on ignore patterns
 */
export function shouldSkipPath(
  path: string,
  repoPath: string,
  excludePaths: Set<string> | null = null,
  unignorePaths: Set<string> | null = null
): boolean {
  const relativePath = relative(repoPath, path);
  const pathParts = relativePath.split('/');

  // Check if explicitly unignored (check first - prefix match)
  if (unignorePaths) {
    for (const unignore of unignorePaths) {
      if (relativePath.startsWith(unignore + '/') || relativePath === unignore) {
        return false;
      }
    }
  }

  // Check each path segment against ignore patterns
  for (const part of pathParts) {
    // Check built-in ignore patterns
    if (cs.IGNORE_PATTERNS.has(part)) {
      return true;
    }

    // Check for .egg-info suffix (Python egg packages)
    if (part.endsWith('.egg-info')) {
      return true;
    }
  }

  // Check against explicit exclude paths (prefix match)
  if (excludePaths) {
    for (const exclude of excludePaths) {
      if (relativePath.startsWith(exclude + '/') || relativePath === exclude) {
        return true;
      }
      // Also check if any path part exactly matches an exclude pattern
      for (const part of pathParts) {
        if (part === exclude) {
          return true;
        }
      }
    }
  }

  return false;
}

// =============================================================================
// Structure Processor Implementation
// =============================================================================

export class StructureProcessor implements StructureProcessorProtocol {
  readonly repoPath: string;
  readonly projectName: string;
  readonly ingestor: IngestorProtocol;
  readonly queries: Map<SupportedLanguage, LanguageQueries>;
  readonly structuralElements: Map<string, string | null> = new Map();
  readonly unignorePaths: Set<string> | null;
  readonly excludePaths: Set<string> | null;

  constructor(
    ingestor: IngestorProtocol,
    repoPath: string,
    projectName: string,
    queries: Map<SupportedLanguage, LanguageQueries>,
    unignorePaths: Set<string> | null = null,
    excludePaths: Set<string> | null = null
  ) {
    this.ingestor = ingestor;
    this.repoPath = repoPath;
    this.projectName = projectName;
    this.queries = queries;
    this.unignorePaths = unignorePaths;
    this.excludePaths = excludePaths;
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  async identifyStructure(): Promise<void> {
    const directories = new Set<string>([this.repoPath]);

    // Recursively collect all directories
    await this.collectDirectories(this.repoPath, directories);

    // Process directories in sorted order (parent before children)
    const sortedDirs = Array.from(directories).sort();

    for (const root of sortedDirs) {
      const relativeRoot = relative(this.repoPath, root);
      const parentRelPath = dirname(relativeRoot);
      const parentContainerQn = this.structuralElements.get(parentRelPath) ?? null;

      // Collect package indicators from all language specs
      const packageIndicators = new Set<string>();
      for (const langQueries of this.queries.values()) {
        const config = langQueries.config;
        for (const indicator of config.packageIndicators) {
          packageIndicators.add(indicator);
        }
      }

      // Check if this directory is a package
      let isPackage = false;
      for (const indicator of packageIndicators) {
        try {
          await stat(join(root, indicator));
          isPackage = true;
          break;
        } catch {
          // File doesn't exist
        }
      }

      if (isPackage) {
        const packageQn = this.buildQualifiedName(relativeRoot);
        this.structuralElements.set(relativeRoot, packageQn);

        logger.info(`Identified package: ${packageQn}`);

        this.ingestor.ensureNodeBatch(cs.NodeLabel.PACKAGE, {
          [cs.KEY_QUALIFIED_NAME]: packageQn,
          [cs.KEY_NAME]: basename(root),
          [cs.KEY_PATH]: relativeRoot || '.',
          [cs.KEY_ABSOLUTE_PATH]: resolve(root),
        });

        const parentIdentifier = this.getParentIdentifier(parentRelPath, parentContainerQn);
        this.ingestor.ensureRelationshipBatch(
          parentIdentifier,
          cs.RelationshipType.CONTAINS_PACKAGE,
          [cs.NodeLabel.PACKAGE, cs.KEY_QUALIFIED_NAME, packageQn]
        );
      } else if (root !== this.repoPath) {
        // Regular folder
        this.structuralElements.set(relativeRoot, null);

        logger.info(`Identified folder: ${relativeRoot}`);

        this.ingestor.ensureNodeBatch(cs.NodeLabel.FOLDER, {
          [cs.KEY_PATH]: relativeRoot,
          [cs.KEY_NAME]: basename(root),
          [cs.KEY_ABSOLUTE_PATH]: resolve(root),
        });

        const parentIdentifier = this.getParentIdentifier(parentRelPath, parentContainerQn);
        this.ingestor.ensureRelationshipBatch(
          parentIdentifier,
          cs.RelationshipType.CONTAINS_FOLDER,
          [cs.NodeLabel.FOLDER, cs.KEY_PATH, relativeRoot]
        );
      }
    }
  }

  processGenericFile(filePath: string, fileName: string): void {
    const relativeFilepath = relative(this.repoPath, filePath);
    const relativeRoot = dirname(relativeFilepath);

    const parentContainerQn = this.structuralElements.get(relativeRoot) ?? null;
    const parentIdentifier = this.getParentIdentifier(relativeRoot, parentContainerQn);

    this.ingestor.ensureNodeBatch(cs.NodeLabel.FILE, {
      [cs.KEY_PATH]: relativeFilepath,
      [cs.KEY_NAME]: fileName,
      [cs.KEY_EXTENSION]: extname(filePath),
      [cs.KEY_ABSOLUTE_PATH]: resolve(filePath),
    });

    this.ingestor.ensureRelationshipBatch(
      parentIdentifier,
      cs.RelationshipType.CONTAINS_FILE,
      [cs.NodeLabel.FILE, cs.KEY_PATH, relativeFilepath]
    );
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  private async collectDirectories(root: string, directories: Set<string>): Promise<void> {
    try {
      const entries = await readdir(root, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const fullPath = join(root, entry.name);

        // Skip ignored paths
        if (shouldSkipPath(fullPath, this.repoPath, this.excludePaths, this.unignorePaths)) {
          continue;
        }

        directories.add(fullPath);
        await this.collectDirectories(fullPath, directories);
      }
    } catch (error) {
      logger.warn(`Failed to read directory ${root}:`, error);
    }
  }

  private buildQualifiedName(relativePath: string): string {
    if (!relativePath || relativePath === cs.PATH_CURRENT_DIR) {
      return this.projectName;
    }

    const parts = relativePath.split('/').filter(Boolean);
    return [this.projectName, ...parts].join(cs.SEPARATOR_DOT);
  }

  private getParentIdentifier(
    parentRelPath: string,
    parentContainerQn: string | null
  ): NodeIdentifier {
    // Root level - parent is the project
    if (!parentRelPath || parentRelPath === cs.PATH_CURRENT_DIR) {
      return [cs.NodeLabel.PROJECT, cs.KEY_NAME, this.projectName];
    }

    // Parent is a package
    if (parentContainerQn) {
      return [cs.NodeLabel.PACKAGE, cs.KEY_QUALIFIED_NAME, parentContainerQn];
    }

    // Parent is a folder
    return [cs.NodeLabel.FOLDER, cs.KEY_PATH, parentRelPath];
  }
}

// =============================================================================
// Factory Function
// =============================================================================

export function createStructureProcessor(
  ingestor: IngestorProtocol,
  repoPath: string,
  projectName: string,
  queries: Map<SupportedLanguage, LanguageQueries>,
  unignorePaths: Set<string> | null = null,
  excludePaths: Set<string> | null = null
): StructureProcessor {
  return new StructureProcessor(
    ingestor,
    repoPath,
    projectName,
    queries,
    unignorePaths,
    excludePaths
  );
}
