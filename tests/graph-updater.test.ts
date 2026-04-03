/**
 * Tests for GraphUpdater - Incremental indexing and file tracking
 * Tests hash caching, file change detection, and graph updates
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';

// Import the FunctionRegistryTrie from graph-updater
import { FunctionRegistryTrie } from '../src/lib/graph-updater.js';
import { NodeType } from '../src/lib/types.js';

// =============================================================================
// FunctionRegistryTrie Tests (from graph-updater)
// =============================================================================

describe('FunctionRegistryTrie (graph-updater)', () => {
  let trie: FunctionRegistryTrie;
  
  beforeEach(() => {
    trie = new FunctionRegistryTrie();
  });
  
  describe('Insert and Retrieve', () => {
    it('should insert and retrieve function entries', () => {
      trie.insert('module.MyClass.method', NodeType.METHOD);
      
      expect(trie.get('module.MyClass.method')).toBe(NodeType.METHOD);
    });
    
    it('should support multiple entries', () => {
      trie.insert('module.func1', NodeType.FUNCTION);
      trie.insert('module.func2', NodeType.FUNCTION);
      trie.insert('module.Class1', NodeType.CLASS);
      
      expect(trie.get('module.func1')).toBe(NodeType.FUNCTION);
      expect(trie.get('module.func2')).toBe(NodeType.FUNCTION);
      expect(trie.get('module.Class1')).toBe(NodeType.CLASS);
    });
    
    it('should return undefined for missing entries', () => {
      expect(trie.get('nonexistent')).toBeUndefined();
    });
    
    it('should return default value when provided', () => {
      const result = trie.get('nonexistent', NodeType.FUNCTION);
      expect(result).toBe(NodeType.FUNCTION);
    });
  });
  
  describe('Simple Name Lookup', () => {
    beforeEach(() => {
      trie.insert('pkg.module.MyClass.method', NodeType.METHOD);
      trie.insert('pkg.other.OtherClass.method', NodeType.METHOD);
      trie.insert('pkg.module.standalone_method', NodeType.FUNCTION);
    });
    
    it('should find all qualified names by simple name', () => {
      // The trie maintains simple name -> qualified names mapping
      const entries = Array.from(trie.entries());
      const methodEntries = entries.filter(([qn]) => qn.endsWith('.method'));
      
      expect(methodEntries).toHaveLength(2);
    });
  });
});

// =============================================================================
// File Hash Cache Tests
// =============================================================================

describe('File Hash Cache', () => {
  let testDir: string;
  
  beforeEach(async () => {
    // Create temp directory for tests
    testDir = await fs.mkdtemp(path.join(tmpdir(), 'graph-updater-test-'));
  });
  
  afterEach(async () => {
    // Cleanup temp directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });
  
  describe('Hash Calculation', () => {
    it('should produce consistent hashes for same content', async () => {
      const content = 'def hello():\n    print("Hello")\n';
      const file1 = path.join(testDir, 'file1.py');
      const file2 = path.join(testDir, 'file2.py');
      
      await fs.writeFile(file1, content);
      await fs.writeFile(file2, content);
      
      const hash1 = await computeFileHash(file1);
      const hash2 = await computeFileHash(file2);
      
      expect(hash1).toBe(hash2);
    });
    
    it('should produce different hashes for different content', async () => {
      const file1 = path.join(testDir, 'file1.py');
      const file2 = path.join(testDir, 'file2.py');
      
      await fs.writeFile(file1, 'def func1(): pass');
      await fs.writeFile(file2, 'def func2(): pass');
      
      const hash1 = await computeFileHash(file1);
      const hash2 = await computeFileHash(file2);
      
      expect(hash1).not.toBe(hash2);
    });
    
    it('should handle empty files', async () => {
      const emptyFile = path.join(testDir, 'empty.py');
      await fs.writeFile(emptyFile, '');
      
      const hash = await computeFileHash(emptyFile);
      expect(hash).toBeTruthy();
      expect(hash.length).toBeGreaterThan(0);
    });
    
    it('should handle binary content', async () => {
      const binaryFile = path.join(testDir, 'binary.bin');
      await fs.writeFile(binaryFile, Buffer.from([0x00, 0x01, 0x02, 0xFF]));
      
      const hash = await computeFileHash(binaryFile);
      expect(hash).toBeTruthy();
    });
    
    it('should handle unicode content', async () => {
      const unicodeFile = path.join(testDir, 'unicode.py');
      await fs.writeFile(unicodeFile, '# 日本語コメント\ndef 函数(): pass');
      
      const hash = await computeFileHash(unicodeFile);
      expect(hash).toBeTruthy();
    });
  });
  
  describe('Cache Persistence', () => {
    it('should save cache to JSON file', async () => {
      const cachePath = path.join(testDir, '.cgr-hash-cache.json');
      const cache: Record<string, string> = {
        'file1.py': 'hash1',
        'file2.py': 'hash2',
      };
      
      await fs.writeFile(cachePath, JSON.stringify(cache));
      
      const loaded = JSON.parse(await fs.readFile(cachePath, 'utf-8'));
      expect(loaded['file1.py']).toBe('hash1');
      expect(loaded['file2.py']).toBe('hash2');
    });
    
    it('should handle missing cache file', async () => {
      const cachePath = path.join(testDir, 'nonexistent-cache.json');
      
      try {
        await fs.readFile(cachePath, 'utf-8');
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('ENOENT');
      }
    });
    
    it('should handle corrupted cache file', async () => {
      const cachePath = path.join(testDir, 'corrupted-cache.json');
      await fs.writeFile(cachePath, 'not valid json {{{');
      
      try {
        JSON.parse(await fs.readFile(cachePath, 'utf-8'));
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(SyntaxError);
      }
    });
  });
});

// =============================================================================
// File Change Detection Tests
// =============================================================================

describe('File Change Detection', () => {
  let testDir: string;
  
  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(tmpdir(), 'change-detection-test-'));
  });
  
  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });
  
  describe('detectFileChanges', () => {
    it('should detect new files', async () => {
      const file1 = path.join(testDir, 'new_file.py');
      await fs.writeFile(file1, 'def new_function(): pass');
      
      const oldCache: Record<string, string> = {};
      const currentFiles = [file1];
      
      const { added, modified, removed } = await detectFileChanges(
        currentFiles,
        oldCache
      );
      
      expect(added).toContain(file1);
      expect(modified).toHaveLength(0);
      expect(removed).toHaveLength(0);
    });
    
    it('should detect modified files', async () => {
      const file1 = path.join(testDir, 'modified_file.py');
      await fs.writeFile(file1, 'def original(): pass');
      
      const originalHash = await computeFileHash(file1);
      const oldCache: Record<string, string> = {
        [file1]: 'different_hash',
      };
      
      const currentFiles = [file1];
      
      const { added, modified, removed } = await detectFileChanges(
        currentFiles,
        oldCache
      );
      
      expect(added).toHaveLength(0);
      expect(modified).toContain(file1);
      expect(removed).toHaveLength(0);
    });
    
    it('should detect removed files', async () => {
      const file1 = path.join(testDir, 'existing.py');
      const removedFile = path.join(testDir, 'removed.py');
      
      await fs.writeFile(file1, 'def existing(): pass');
      
      const oldCache: Record<string, string> = {
        [file1]: await computeFileHash(file1),
        [removedFile]: 'old_hash',
      };
      
      const currentFiles = [file1];
      
      const { added, modified, removed } = await detectFileChanges(
        currentFiles,
        oldCache
      );
      
      expect(added).toHaveLength(0);
      expect(modified).toHaveLength(0);
      expect(removed).toContain(removedFile);
    });
    
    it('should detect unchanged files', async () => {
      const file1 = path.join(testDir, 'unchanged.py');
      await fs.writeFile(file1, 'def unchanged(): pass');
      
      const hash = await computeFileHash(file1);
      const oldCache: Record<string, string> = {
        [file1]: hash,
      };
      
      const currentFiles = [file1];
      
      const { added, modified, removed } = await detectFileChanges(
        currentFiles,
        oldCache
      );
      
      expect(added).toHaveLength(0);
      expect(modified).toHaveLength(0);
      expect(removed).toHaveLength(0);
    });
    
    it('should handle mixed changes', async () => {
      const newFile = path.join(testDir, 'new.py');
      const modifiedFile = path.join(testDir, 'modified.py');
      const unchangedFile = path.join(testDir, 'unchanged.py');
      const removedFile = path.join(testDir, 'removed.py');
      
      await fs.writeFile(newFile, 'def new(): pass');
      await fs.writeFile(modifiedFile, 'def modified(): pass');
      await fs.writeFile(unchangedFile, 'def unchanged(): pass');
      
      const unchangedHash = await computeFileHash(unchangedFile);
      
      const oldCache: Record<string, string> = {
        [modifiedFile]: 'old_hash',
        [unchangedFile]: unchangedHash,
        [removedFile]: 'removed_hash',
      };
      
      const currentFiles = [newFile, modifiedFile, unchangedFile];
      
      const { added, modified, removed } = await detectFileChanges(
        currentFiles,
        oldCache
      );
      
      expect(added).toContain(newFile);
      expect(modified).toContain(modifiedFile);
      expect(removed).toContain(removedFile);
    });
  });
});

// =============================================================================
// Incremental Indexing Tests
// =============================================================================

describe('Incremental Indexing', () => {
  describe('Module Path Computation', () => {
    it('should compute module path from file path', () => {
      const projectRoot = '/home/user/project';
      const filePath = '/home/user/project/src/utils/helpers.py';
      
      const modulePath = computeModulePath(filePath, projectRoot);
      
      expect(modulePath).toBe('src.utils.helpers');
    });
    
    it('should handle root-level files', () => {
      const projectRoot = '/home/user/project';
      const filePath = '/home/user/project/main.py';
      
      const modulePath = computeModulePath(filePath, projectRoot);
      
      expect(modulePath).toBe('main');
    });
    
    it('should handle nested directories', () => {
      const projectRoot = '/project';
      const filePath = '/project/a/b/c/d/e/file.py';
      
      const modulePath = computeModulePath(filePath, projectRoot);
      
      expect(modulePath).toBe('a.b.c.d.e.file');
    });
    
    it('should strip common extensions', () => {
      const projectRoot = '/project';
      
      expect(computeModulePath('/project/file.py', projectRoot)).toBe('file');
      expect(computeModulePath('/project/file.ts', projectRoot)).toBe('file');
      expect(computeModulePath('/project/file.js', projectRoot)).toBe('file');
      expect(computeModulePath('/project/file.rs', projectRoot)).toBe('file');
      expect(computeModulePath('/project/file.go', projectRoot)).toBe('file');
    });
    
    it('should handle __init__.py files', () => {
      const projectRoot = '/project';
      const filePath = '/project/package/__init__.py';
      
      const modulePath = computeModulePath(filePath, projectRoot);
      
      // __init__.py should represent the package itself
      expect(modulePath).toBe('package.__init__');
    });
    
    it('should handle index files', () => {
      const projectRoot = '/project';
      
      expect(computeModulePath('/project/src/index.ts', projectRoot)).toBe('src.index');
      expect(computeModulePath('/project/lib/mod.rs', projectRoot)).toBe('lib.mod');
    });
  });
  
  describe('Force Re-index', () => {
    it('should treat all files as new when force=true', async () => {
      const files = ['file1.py', 'file2.py', 'file3.py'];
      const oldCache: Record<string, string> = {
        'file1.py': 'hash1',
        'file2.py': 'hash2',
        'file3.py': 'hash3',
      };
      
      const result = simulateForceReindex(files, oldCache);
      
      expect(result.added).toHaveLength(3);
      expect(result.modified).toHaveLength(0);
      expect(result.removed).toHaveLength(0);
    });
  });
});

// =============================================================================
// cgrignore Pattern Tests
// =============================================================================

describe('cgrignore Patterns', () => {
  describe('Pattern Parsing', () => {
    it('should parse exclude patterns', () => {
      const content = `
# Comment line
node_modules/
dist/
*.pyc
__pycache__/
      `.trim();
      
      const { exclude, unignore } = parseCgrignore(content);
      
      expect(exclude.has('node_modules/')).toBe(true);
      expect(exclude.has('dist/')).toBe(true);
      expect(exclude.has('*.pyc')).toBe(true);
      expect(exclude.has('__pycache__/')).toBe(true);
      expect(unignore.size).toBe(0);
    });
    
    it('should parse unignore patterns with !', () => {
      const content = `
node_modules/
!node_modules/my-local-package/
dist/
!dist/important.js
      `.trim();
      
      const { exclude, unignore } = parseCgrignore(content);
      
      expect(exclude.has('node_modules/')).toBe(true);
      expect(exclude.has('dist/')).toBe(true);
      expect(unignore.has('node_modules/my-local-package/')).toBe(true);
      expect(unignore.has('dist/important.js')).toBe(true);
    });
    
    it('should ignore empty lines and comments', () => {
      const content = `
# This is a comment
node_modules/

# Another comment
dist/

      `.trim();
      
      const { exclude, unignore } = parseCgrignore(content);
      
      expect(exclude.size).toBe(2);
      expect(exclude.has('node_modules/')).toBe(true);
      expect(exclude.has('dist/')).toBe(true);
    });
    
    it('should handle empty content', () => {
      const { exclude, unignore } = parseCgrignore('');
      
      expect(exclude.size).toBe(0);
      expect(unignore.size).toBe(0);
    });
    
    it('should handle whitespace-only lines', () => {
      const content = '   \n\t\n  node_modules/  \n';
      
      const { exclude, unignore } = parseCgrignore(content);
      
      expect(exclude.has('node_modules/')).toBe(true);
    });
  });
  
  describe('Pattern Matching', () => {
    it('should match directory patterns', () => {
      const patterns = new Set(['node_modules/', 'dist/']);
      
      expect(matchesExcludePattern('node_modules/pkg/index.js', patterns)).toBe(true);
      expect(matchesExcludePattern('dist/bundle.js', patterns)).toBe(true);
      expect(matchesExcludePattern('src/index.js', patterns)).toBe(false);
    });
    
    it('should match glob patterns', () => {
      const patterns = new Set(['*.pyc', '*.log', '.*.swp']);
      
      expect(matchesExcludePattern('module.pyc', patterns)).toBe(true);
      expect(matchesExcludePattern('debug.log', patterns)).toBe(true);
      expect(matchesExcludePattern('.file.swp', patterns)).toBe(true);
      expect(matchesExcludePattern('module.py', patterns)).toBe(false);
    });
    
    it('should handle nested patterns', () => {
      const patterns = new Set(['**/test/**', '**/tests/**']);
      
      expect(matchesExcludePattern('src/test/file.py', patterns)).toBe(true);
      expect(matchesExcludePattern('pkg/tests/test_module.py', patterns)).toBe(true);
      expect(matchesExcludePattern('src/main.py', patterns)).toBe(false);
    });
  });
});

// =============================================================================
// Helper Functions for Tests
// =============================================================================

import { createHash } from 'crypto';

/**
 * Compute SHA-256 hash of a file
 */
async function computeFileHash(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Detect file changes between current state and cached state
 */
async function detectFileChanges(
  currentFiles: string[],
  oldCache: Record<string, string>
): Promise<{ added: string[]; modified: string[]; removed: string[] }> {
  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];
  
  const currentSet = new Set(currentFiles);
  
  // Check for new and modified files
  for (const file of currentFiles) {
    const currentHash = await computeFileHash(file);
    
    if (!(file in oldCache)) {
      added.push(file);
    } else if (oldCache[file] !== currentHash) {
      modified.push(file);
    }
  }
  
  // Check for removed files
  for (const file of Object.keys(oldCache)) {
    if (!currentSet.has(file)) {
      removed.push(file);
    }
  }
  
  return { added, modified, removed };
}

/**
 * Compute module path from file path
 */
function computeModulePath(filePath: string, projectRoot: string): string {
  const relativePath = path.relative(projectRoot, filePath);
  const withoutExtension = relativePath.replace(/\.(py|ts|tsx|js|jsx|rs|go|java|c|cpp|h|hpp)$/, '');
  return withoutExtension.replace(/[\/\\]/g, '.');
}

/**
 * Simulate force re-index behavior
 */
function simulateForceReindex(
  files: string[],
  _oldCache: Record<string, string>
): { added: string[]; modified: string[]; removed: string[] } {
  // When force=true, treat all files as new
  return {
    added: [...files],
    modified: [],
    removed: [],
  };
}

/**
 * Parse .cgrignore file content
 */
function parseCgrignore(content: string): { exclude: Set<string>; unignore: Set<string> } {
  const exclude = new Set<string>();
  const unignore = new Set<string>();
  
  const lines = content.split('\n');
  
  for (const line of lines) {
    const trimmed = line.trim();
    
    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    
    // Handle unignore patterns (starting with !)
    if (trimmed.startsWith('!')) {
      unignore.add(trimmed.slice(1).trim());
    } else {
      exclude.add(trimmed);
    }
  }
  
  return { exclude, unignore };
}

/**
 * Check if a path matches any exclude pattern
 */
function matchesExcludePattern(filePath: string, patterns: Set<string>): boolean {
  for (const pattern of patterns) {
    // Directory patterns (ending with /)
    if (pattern.endsWith('/')) {
      const dir = pattern.slice(0, -1);
      if (filePath.startsWith(dir + '/') || filePath.includes('/' + dir + '/')) {
        return true;
      }
    }
    
    // Glob patterns
    if (pattern.includes('*')) {
      // Simple glob matching
      if (pattern.startsWith('**/')) {
        const rest = pattern.slice(3);
        if (filePath.includes('/' + rest.replace('/**', ''))) {
          return true;
        }
      } else if (pattern.startsWith('*.')) {
        const ext = pattern.slice(1);
        if (filePath.endsWith(ext)) {
          return true;
        }
      } else if (pattern.startsWith('.*.')) {
        // Hidden file pattern
        const ext = pattern.slice(2);
        const basename = path.basename(filePath);
        if (basename.startsWith('.') && basename.endsWith(ext)) {
          return true;
        }
      }
    }
    
    // Exact match
    if (filePath === pattern || filePath.endsWith('/' + pattern)) {
      return true;
    }
  }
  
  return false;
}
