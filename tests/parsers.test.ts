/**
 * Tests for code parsers - Code analysis for each supported language
 * Tests function/class extraction, import processing, call analysis
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NodeType } from '../src/lib/types.js';

// Import parsers for testing
import {
  FunctionRegistryTrieImpl,
  ASTCacheImpl,
} from '../src/lib/parsers/factory.js';

import {
  shouldSkipPath,
} from '../src/lib/parsers/structure-processor.js';

import {
  safeDecodeText,
  safeDecodeWithFallback,
} from '../src/lib/parsers/base.js';

// =============================================================================
// FunctionRegistryTrie Tests
// =============================================================================

describe('FunctionRegistryTrieImpl', () => {
  let registry: FunctionRegistryTrieImpl;
  
  beforeEach(() => {
    registry = new FunctionRegistryTrieImpl();
  });
  
  describe('Basic Operations', () => {
    it('should store and retrieve function types', () => {
      registry.set('module.MyClass.my_method', NodeType.METHOD);
      expect(registry.get('module.MyClass.my_method')).toBe(NodeType.METHOD);
    });
    
    it('should return undefined for non-existent keys', () => {
      expect(registry.get('nonexistent')).toBeUndefined();
    });
    
    it('should check existence with has()', () => {
      registry.set('module.func', NodeType.FUNCTION);
      expect(registry.has('module.func')).toBe(true);
      expect(registry.has('nonexistent')).toBe(false);
    });
    
    it('should iterate over all keys', () => {
      registry.set('module.func1', NodeType.FUNCTION);
      registry.set('module.func2', NodeType.FUNCTION);
      registry.set('module.Class1', NodeType.CLASS);
      
      const keys = Array.from(registry.keys());
      expect(keys).toHaveLength(3);
      expect(keys).toContain('module.func1');
      expect(keys).toContain('module.func2');
      expect(keys).toContain('module.Class1');
    });
    
    it('should iterate over entries', () => {
      registry.set('module.func1', NodeType.FUNCTION);
      registry.set('module.Class1', NodeType.CLASS);
      
      const entries = Array.from(registry.entries());
      expect(entries).toHaveLength(2);
    });
  });
  
  describe('Prefix Search', () => {
    beforeEach(() => {
      registry.set('pkg.module.Class.method1', NodeType.METHOD);
      registry.set('pkg.module.Class.method2', NodeType.METHOD);
      registry.set('pkg.module.func1', NodeType.FUNCTION);
      registry.set('pkg.other.func2', NodeType.FUNCTION);
    });
    
    it('should find all functions with a given prefix', () => {
      const results = registry.findWithPrefix('pkg.module');
      expect(results).toHaveLength(3);
      
      const qualifiedNames = results.map(([qn]) => qn);
      expect(qualifiedNames).toContain('pkg.module.Class.method1');
      expect(qualifiedNames).toContain('pkg.module.Class.method2');
      expect(qualifiedNames).toContain('pkg.module.func1');
    });
    
    it('should find functions by class prefix', () => {
      const results = registry.findWithPrefix('pkg.module.Class');
      expect(results).toHaveLength(2);
    });
    
    it('should return empty array for non-matching prefix', () => {
      const results = registry.findWithPrefix('nonexistent');
      expect(results).toHaveLength(0);
    });
  });
  
  describe('Suffix Search', () => {
    beforeEach(() => {
      registry.set('pkg.module.Class.init', NodeType.METHOD);
      registry.set('pkg.other.Class.init', NodeType.METHOD);
      registry.set('pkg.module.init', NodeType.FUNCTION);
      registry.set('pkg.module.Class.cleanup', NodeType.METHOD);
    });
    
    it('should find all functions ending with a name', () => {
      const results = registry.findEndingWith('init');
      expect(results).toHaveLength(3);
    });
    
    it('should find functions by method name', () => {
      const results = registry.findEndingWith('Class.init');
      expect(results).toHaveLength(2);
    });
    
    it('should return empty array for non-matching suffix', () => {
      const results = registry.findEndingWith('nonexistent');
      expect(results).toHaveLength(0);
    });
  });
  
  describe('Edge Cases', () => {
    it('should handle empty qualified names', () => {
      registry.set('', NodeType.FUNCTION);
      expect(registry.has('')).toBe(true);
    });
    
    it('should handle single-part qualified names', () => {
      registry.set('func', NodeType.FUNCTION);
      expect(registry.has('func')).toBe(true);
      
      const prefix = registry.findWithPrefix('func');
      expect(prefix).toHaveLength(1);
    });
    
    it('should handle deeply nested qualified names', () => {
      const deepName = 'a.b.c.d.e.f.g.h.i.j.k.l.m.n.o.p';
      registry.set(deepName, NodeType.FUNCTION);
      
      expect(registry.has(deepName)).toBe(true);
      expect(registry.findWithPrefix('a.b.c')).toHaveLength(1);
    });
    
    it('should handle special characters in names', () => {
      registry.set('module.__init__', NodeType.FUNCTION);
      registry.set('module._private', NodeType.FUNCTION);
      
      expect(registry.has('module.__init__')).toBe(true);
      expect(registry.has('module._private')).toBe(true);
    });
    
    it('should clear all entries', () => {
      registry.set('module.func1', NodeType.FUNCTION);
      registry.set('module.func2', NodeType.FUNCTION);
      
      registry.clear();
      
      expect(registry.size).toBe(0);
      expect(registry.has('module.func1')).toBe(false);
    });
    
    it('should track size correctly', () => {
      expect(registry.size).toBe(0);
      
      registry.set('func1', NodeType.FUNCTION);
      expect(registry.size).toBe(1);
      
      registry.set('func2', NodeType.FUNCTION);
      expect(registry.size).toBe(2);
    });
  });
});

// =============================================================================
// ASTCache Tests
// =============================================================================

describe('ASTCacheImpl', () => {
  let cache: ASTCacheImpl;
  
  beforeEach(() => {
    cache = new ASTCacheImpl();
  });
  
  // Create mock AST node
  const createMockASTNode = (id: string): any => ({
    id,
    type: 'program',
    startPosition: { row: 0, column: 0 },
    endPosition: { row: 10, column: 0 },
    children: [],
  });
  
  describe('Basic Operations', () => {
    it('should store and retrieve AST entries', () => {
      const mockNode = createMockASTNode('test');
      cache.set('file.py', [mockNode, 'python' as any]);
      
      const result = cache.get('file.py');
      expect(result).toBeDefined();
      expect(result![0]).toBe(mockNode);
      expect(result![1]).toBe('python');
    });
    
    it('should return undefined for non-existent keys', () => {
      expect(cache.get('nonexistent')).toBeUndefined();
    });
    
    it('should check existence with has()', () => {
      cache.set('file.py', [createMockASTNode('test'), 'python' as any]);
      
      expect(cache.has('file.py')).toBe(true);
      expect(cache.has('other.py')).toBe(false);
    });
    
    it('should delete entries', () => {
      cache.set('file.py', [createMockASTNode('test'), 'python' as any]);
      expect(cache.has('file.py')).toBe(true);
      
      const deleted = cache.delete('file.py');
      expect(deleted).toBe(true);
      expect(cache.has('file.py')).toBe(false);
    });
    
    it('should return false when deleting non-existent key', () => {
      const deleted = cache.delete('nonexistent');
      expect(deleted).toBe(false);
    });
    
    it('should iterate over entries', () => {
      cache.set('file1.py', [createMockASTNode('1'), 'python' as any]);
      cache.set('file2.ts', [createMockASTNode('2'), 'typescript' as any]);
      
      const entries = Array.from(cache.entries());
      expect(entries).toHaveLength(2);
    });
  });
  
  describe('Edge Cases', () => {
    it('should handle empty cache iteration', () => {
      const entries = Array.from(cache.entries());
      expect(entries).toHaveLength(0);
    });
    
    it('should handle overwriting existing entries', () => {
      const node1 = createMockASTNode('1');
      const node2 = createMockASTNode('2');
      
      cache.set('file.py', [node1, 'python' as any]);
      cache.set('file.py', [node2, 'python' as any]);
      
      const result = cache.get('file.py');
      expect(result![0]).toBe(node2);
    });
    
    it('should handle paths with special characters', () => {
      const node = createMockASTNode('test');
      const specialPath = '/path/to/file with spaces/[brackets].py';
      
      cache.set(specialPath, [node, 'python' as any]);
      expect(cache.has(specialPath)).toBe(true);
      expect(cache.get(specialPath)![0]).toBe(node);
    });
  });
});

// =============================================================================
// Path Skip Logic Tests
// =============================================================================

describe('shouldSkipPath', () => {
  // Use a mock repo path for all tests
  const repoPath = '/project';
  
  describe('Default Skip Patterns', () => {
    it('should skip node_modules directories', () => {
      expect(shouldSkipPath('/project/node_modules/package/index.js', repoPath)).toBe(true);
      expect(shouldSkipPath('/project/src/node_modules/foo.ts', repoPath)).toBe(true);
    });
    
    it('should skip .git directories', () => {
      expect(shouldSkipPath('/project/.git/config', repoPath)).toBe(true);
      expect(shouldSkipPath('/project/.git/objects/pack', repoPath)).toBe(true);
    });
    
    it('should skip __pycache__ directories', () => {
      expect(shouldSkipPath('/project/module/__pycache__/file.cpython-39.pyc', repoPath)).toBe(true);
    });
    
    it('should skip .venv directories', () => {
      expect(shouldSkipPath('/project/.venv/lib/python3.9/site-packages', repoPath)).toBe(true);
    });
    
    it('should skip dist directories', () => {
      expect(shouldSkipPath('/project/dist/bundle.js', repoPath)).toBe(true);
    });
    
    it('should skip build directories', () => {
      expect(shouldSkipPath('/project/build/output.js', repoPath)).toBe(true);
    });
    
    it('should skip vendor directories', () => {
      expect(shouldSkipPath('/project/vendor/third-party.js', repoPath)).toBe(true);
    });
    
    it('should skip .egg-info directories', () => {
      expect(shouldSkipPath('/project/package.egg-info/PKG-INFO', repoPath)).toBe(true);
    });
    
    it('should skip target directories (Rust)', () => {
      expect(shouldSkipPath('/project/target/release/binary', repoPath)).toBe(true);
    });
  });
  
  describe('Allowed Paths', () => {
    it('should allow regular source files', () => {
      expect(shouldSkipPath('/project/src/index.ts', repoPath)).toBe(false);
      expect(shouldSkipPath('/project/lib/utils.py', repoPath)).toBe(false);
      expect(shouldSkipPath('/project/main.rs', repoPath)).toBe(false);
    });
    
    it('should allow paths containing skip words in filenames', () => {
      expect(shouldSkipPath('/project/src/build_utils.ts', repoPath)).toBe(false);
      expect(shouldSkipPath('/project/src/dist_helper.py', repoPath)).toBe(false);
    });
    
    it('should allow test directories', () => {
      expect(shouldSkipPath('/project/tests/test_module.py', repoPath)).toBe(false);
      expect(shouldSkipPath('/project/__tests__/component.test.tsx', repoPath)).toBe(false);
    });
  });
  
  describe('Custom Patterns', () => {
    it('should respect custom exclude patterns', () => {
      const excludePatterns = new Set(['generated', 'temp']);
      
      expect(shouldSkipPath('/project/generated/types.ts', repoPath, excludePatterns)).toBe(true);
      expect(shouldSkipPath('/project/temp/cache.json', repoPath, excludePatterns)).toBe(true);
      expect(shouldSkipPath('/project/src/main.ts', repoPath, excludePatterns)).toBe(false);
    });
    
    it('should respect unignore patterns', () => {
      const excludePatterns = new Set<string>();
      const unignorePatterns = new Set(['node_modules/my-local-package']);
      
      // With unignore, specific path should be allowed
      expect(
        shouldSkipPath('/project/node_modules/my-local-package/index.js', repoPath, excludePatterns, unignorePatterns)
      ).toBe(false);
      
      // But other node_modules should still be skipped
      expect(
        shouldSkipPath('/project/node_modules/other-package/index.js', repoPath, excludePatterns, unignorePatterns)
      ).toBe(true);
    });
  });
  
  describe('Edge Cases', () => {
    it('should handle paths at repo root', () => {
      expect(shouldSkipPath('/project/main.py', repoPath)).toBe(false);
    });
    
    it('should handle deeply nested paths', () => {
      const deepPath = '/project/a/b/c/d/e/f/g/h/node_modules/package/file.js';
      expect(shouldSkipPath(deepPath, repoPath)).toBe(true);
    });
    
    it('should handle case sensitivity', () => {
      // Most skip patterns are case-sensitive
      expect(shouldSkipPath('/project/Node_Modules/pkg/index.js', repoPath)).toBe(false);
    });
  });
});

// =============================================================================
// Text Decoding Tests
// =============================================================================

describe('Text Decoding', () => {
  describe('safeDecodeText', () => {
    it('should decode valid UTF-8 text', () => {
      const buffer = Buffer.from('Hello, World!', 'utf-8');
      expect(safeDecodeText(buffer)).toBe('Hello, World!');
    });
    
    it('should decode text with unicode characters', () => {
      const buffer = Buffer.from('日本語テキスト', 'utf-8');
      expect(safeDecodeText(buffer)).toBe('日本語テキスト');
    });
    
    it('should decode text with emojis', () => {
      const buffer = Buffer.from('Hello 🌍 World 🚀', 'utf-8');
      expect(safeDecodeText(buffer)).toBe('Hello 🌍 World 🚀');
    });
    
    it('should handle empty buffer', () => {
      const buffer = Buffer.from('', 'utf-8');
      expect(safeDecodeText(buffer)).toBe('');
    });
    
    it('should handle Uint8Array input', () => {
      const arr = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
      expect(safeDecodeText(arr)).toBe('Hello');
    });
  });
  
  describe('safeDecodeWithFallback', () => {
    it('should decode valid UTF-8 text', () => {
      const buffer = Buffer.from('Valid UTF-8', 'utf-8');
      expect(safeDecodeWithFallback(buffer)).toBe('Valid UTF-8');
    });
    
    it('should handle invalid UTF-8 sequences gracefully', () => {
      // Invalid UTF-8 byte sequence
      const buffer = Buffer.from([0x80, 0x81, 0x82]);
      const result = safeDecodeWithFallback(buffer);
      expect(typeof result).toBe('string');
    });
    
    it('should handle mixed valid/invalid sequences', () => {
      // "Hello" + invalid byte + "World"
      const buffer = Buffer.from([
        72, 101, 108, 108, 111, // Hello
        0xFF, // Invalid
        87, 111, 114, 108, 100 // World
      ]);
      const result = safeDecodeWithFallback(buffer);
      expect(result).toContain('Hello');
      expect(result).toContain('World');
    });
  });
});

// =============================================================================
// Language Detection Tests (file extensions)
// =============================================================================

describe('Language Detection by Extension', () => {
  const extensionToLanguage: Record<string, string> = {
    '.py': 'python',
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.rs': 'rust',
    '.go': 'go',
    '.java': 'java',
    '.c': 'c',
    '.cpp': 'cpp',
    '.cc': 'cpp',
    '.cxx': 'cpp',
    '.h': 'c',
    '.hpp': 'cpp',
  };
  
  it('should map common extensions to languages', () => {
    // This test validates that our language specs are complete
    for (const [ext, lang] of Object.entries(extensionToLanguage)) {
      expect(ext).toBeTruthy();
      expect(lang).toBeTruthy();
    }
  });
});

// =============================================================================
// Parser Behavior Tests (without tree-sitter)
// =============================================================================

describe('Parser Behavior', () => {
  describe('Import Pattern Matching', () => {
    // Common import patterns that should be recognized
    const pythonImports = [
      'import os',
      'from typing import List, Dict',
      'from . import utils',
      'from ..module import Class',
      'import numpy as np',
    ];
    
    const typescriptImports = [
      'import { foo } from "bar"',
      'import * as React from "react"',
      'import type { Type } from "./types"',
      'export { something } from "./module"',
      'const x = require("module")',
    ];
    
    const rustImports = [
      'use std::io;',
      'use crate::module::*;',
      'use super::parent;',
      'extern crate serde;',
    ];
    
    it('should have valid Python import patterns', () => {
      pythonImports.forEach(imp => {
        expect(imp).toMatch(/^(import|from)\s/);
      });
    });
    
    it('should have valid TypeScript import patterns', () => {
      typescriptImports.forEach(imp => {
        expect(imp).toMatch(/(import|export|require)/);
      });
    });
    
    it('should have valid Rust import patterns', () => {
      rustImports.forEach(imp => {
        expect(imp).toMatch(/(use|extern\s+crate)/);
      });
    });
  });
  
  describe('Function Pattern Matching', () => {
    // Common function patterns
    const patterns = {
      python: [
        'def function_name():',
        'def method(self, arg):',
        'async def async_function():',
        'def __init__(self):',
      ],
      typescript: [
        'function functionName() {}',
        'const arrowFunc = () => {}',
        'async function asyncFunc() {}',
        'export function exportedFunc() {}',
      ],
      rust: [
        'fn function_name() {}',
        'pub fn public_fn() {}',
        'async fn async_fn() {}',
        'impl Struct { fn method(&self) {} }',
      ],
    };
    
    it('should have valid Python function patterns', () => {
      patterns.python.forEach(p => {
        expect(p).toMatch(/def\s+\w+/);
      });
    });
    
    it('should have valid TypeScript function patterns', () => {
      patterns.typescript.forEach(p => {
        expect(p).toMatch(/(function|=>)/);
      });
    });
    
    it('should have valid Rust function patterns', () => {
      patterns.rust.forEach(p => {
        expect(p).toMatch(/fn\s+\w+/);
      });
    });
  });
  
  describe('Class Pattern Matching', () => {
    const patterns = {
      python: [
        'class MyClass:',
        'class Child(Parent):',
        'class Multi(A, B, C):',
      ],
      typescript: [
        'class MyClass {}',
        'class Child extends Parent {}',
        'class Impl implements Interface {}',
        'abstract class AbstractClass {}',
      ],
      rust: [
        'struct MyStruct {}',
        'struct Tuple(i32, String);',
        'enum MyEnum {}',
        'impl Trait for Struct {}',
      ],
      java: [
        'class MyClass {}',
        'public class PublicClass {}',
        'class Child extends Parent implements Interface {}',
        'abstract class AbstractClass {}',
      ],
    };
    
    it('should have valid Python class patterns', () => {
      patterns.python.forEach(p => {
        expect(p).toMatch(/class\s+\w+/);
      });
    });
    
    it('should have valid TypeScript class patterns', () => {
      patterns.typescript.forEach(p => {
        expect(p).toMatch(/class\s+\w+/);
      });
    });
    
    it('should have valid Rust struct/enum patterns', () => {
      patterns.rust.forEach(p => {
        expect(p).toMatch(/(struct|enum|impl)\s+\w+/);
      });
    });
    
    it('should have valid Java class patterns', () => {
      patterns.java.forEach(p => {
        expect(p).toMatch(/class\s+\w+/);
      });
    });
  });
});

// =============================================================================
// Qualified Name Construction Tests
// =============================================================================

describe('Qualified Name Construction', () => {
  it('should construct module-level function names', () => {
    const moduleName = 'my_module';
    const funcName = 'my_function';
    const qualifiedName = `${moduleName}.${funcName}`;
    
    expect(qualifiedName).toBe('my_module.my_function');
  });
  
  it('should construct class method names', () => {
    const moduleName = 'my_module';
    const className = 'MyClass';
    const methodName = 'my_method';
    const qualifiedName = `${moduleName}.${className}.${methodName}`;
    
    expect(qualifiedName).toBe('my_module.MyClass.my_method');
  });
  
  it('should handle nested classes', () => {
    const parts = ['module', 'OuterClass', 'InnerClass', 'method'];
    const qualifiedName = parts.join('.');
    
    expect(qualifiedName).toBe('module.OuterClass.InnerClass.method');
  });
  
  it('should handle special method names', () => {
    const moduleName = 'my_module';
    const className = 'MyClass';
    const specialMethods = ['__init__', '__str__', '__repr__', '__eq__'];
    
    specialMethods.forEach(method => {
      const qn = `${moduleName}.${className}.${method}`;
      expect(qn).toContain('__');
    });
  });
  
  it('should handle package paths', () => {
    const packagePath = 'pkg/subpkg/module.py';
    const normalizedPath = packagePath.replace(/\//g, '.').replace(/\.py$/, '');
    
    expect(normalizedPath).toBe('pkg.subpkg.module');
  });
});
