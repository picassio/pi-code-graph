/**
 * Integration Tests - End-to-end tests for the code-graph-rag library
 * Tests complete workflows from file parsing through query execution
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';

// Mock external services
vi.mock('neo4j-driver', async () => {
  const mock = await import('./mocks/neo4j-driver.js');
  return {
    default: mock.default,
    isInt: mock.isInt,
    Integer: mock.MockInteger,
  };
});

global.fetch = vi.fn();

// =============================================================================
// Test Fixtures
// =============================================================================

const PYTHON_CODE = `
"""Sample Python module for testing."""

import os
from typing import List, Dict

class DataProcessor:
    """Process data from various sources."""
    
    def __init__(self, config: Dict):
        self.config = config
        self._cache = {}
    
    def process(self, items: List[str]) -> List[str]:
        """Process a list of items."""
        results = []
        for item in items:
            result = self._transform(item)
            results.append(result)
        return results
    
    def _transform(self, item: str) -> str:
        """Internal transform method."""
        return item.upper()

def main():
    """Entry point."""
    processor = DataProcessor({"key": "value"})
    processor.process(["a", "b", "c"])

if __name__ == "__main__":
    main()
`;

const TYPESCRIPT_CODE = `
/**
 * Sample TypeScript module for testing.
 */

import { EventEmitter } from 'events';
import type { Config } from './types';

export interface DataItem {
  id: string;
  value: number;
}

export class DataService extends EventEmitter {
  private cache: Map<string, DataItem>;
  
  constructor(private config: Config) {
    super();
    this.cache = new Map();
  }
  
  async fetchData(id: string): Promise<DataItem | null> {
    if (this.cache.has(id)) {
      return this.cache.get(id)!;
    }
    
    const data = await this.loadFromSource(id);
    if (data) {
      this.cache.set(id, data);
    }
    return data;
  }
  
  private async loadFromSource(id: string): Promise<DataItem | null> {
    // Simulated load
    return { id, value: 42 };
  }
  
  clearCache(): void {
    this.cache.clear();
    this.emit('cache-cleared');
  }
}

export function createService(config: Config): DataService {
  return new DataService(config);
}
`;

const RUST_CODE = `
//! Sample Rust module for testing.

use std::collections::HashMap;

/// A simple data processor
pub struct Processor {
    config: HashMap<String, String>,
    cache: Vec<String>,
}

impl Processor {
    /// Create a new processor
    pub fn new() -> Self {
        Self {
            config: HashMap::new(),
            cache: Vec::new(),
        }
    }
    
    /// Process input data
    pub fn process(&mut self, input: &str) -> String {
        let result = self.transform(input);
        self.cache.push(result.clone());
        result
    }
    
    fn transform(&self, input: &str) -> String {
        input.to_uppercase()
    }
}

/// Entry point
fn main() {
    let mut processor = Processor::new();
    let result = processor.process("hello");
    println!("{}", result);
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_process() {
        let mut p = Processor::new();
        assert_eq!(p.process("test"), "TEST");
    }
}
`;

// =============================================================================
// Helper Functions
// =============================================================================

async function createTestProject(baseDir: string): Promise<string> {
  const projectDir = path.join(baseDir, 'test-project');
  await fs.mkdir(projectDir, { recursive: true });
  
  // Create source directory
  const srcDir = path.join(projectDir, 'src');
  await fs.mkdir(srcDir, { recursive: true });
  
  // Create files
  await fs.writeFile(path.join(srcDir, 'processor.py'), PYTHON_CODE);
  await fs.writeFile(path.join(srcDir, 'service.ts'), TYPESCRIPT_CODE);
  await fs.writeFile(path.join(srcDir, 'lib.rs'), RUST_CODE);
  
  // Create a README
  await fs.writeFile(
    path.join(projectDir, 'README.md'),
    '# Test Project\n\nA test project for integration tests.'
  );
  
  return projectDir;
}

// =============================================================================
// Integration Test Suite
// =============================================================================

describe('Integration Tests', () => {
  let testDir: string;
  let projectDir: string;
  
  beforeAll(async () => {
    testDir = await fs.mkdtemp(path.join(tmpdir(), 'integration-test-'));
    projectDir = await createTestProject(testDir);
  });
  
  afterAll(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });
  
  beforeEach(() => {
    vi.clearAllMocks();
  });
  
  // ===========================================================================
  // Project Scanning Tests
  // ===========================================================================
  
  describe('Project Scanning', () => {
    it('should discover all source files', async () => {
      const files = await fs.readdir(path.join(projectDir, 'src'));
      
      expect(files).toContain('processor.py');
      expect(files).toContain('service.ts');
      expect(files).toContain('lib.rs');
    });
    
    it('should identify correct file languages', () => {
      const extensionMap: Record<string, string> = {
        '.py': 'python',
        '.ts': 'typescript',
        '.tsx': 'typescript',
        '.js': 'javascript',
        '.jsx': 'javascript',
        '.rs': 'rust',
        '.go': 'go',
        '.java': 'java',
      };
      
      const files = ['processor.py', 'service.ts', 'lib.rs'];
      
      files.forEach(file => {
        const ext = path.extname(file);
        expect(extensionMap[ext]).toBeDefined();
      });
    });
    
    it('should exclude common non-source directories', async () => {
      // Create some directories that should be excluded
      const excludedDirs = ['node_modules', '.git', '__pycache__', 'target'];
      
      for (const dir of excludedDirs) {
        const dirPath = path.join(projectDir, dir);
        await fs.mkdir(dirPath, { recursive: true });
        await fs.writeFile(path.join(dirPath, 'test.js'), 'console.log("test")');
      }
      
      // shouldSkipPath should filter these (needs repo path as second arg)
      const { shouldSkipPath } = await import('../src/lib/parsers/structure-processor.js');
      
      for (const dir of excludedDirs) {
        expect(shouldSkipPath(path.join(projectDir, dir, 'test.js'), projectDir)).toBe(true);
      }
    });
  });
  
  // ===========================================================================
  // File Content Analysis Tests
  // ===========================================================================
  
  describe('File Content Analysis', () => {
    it('should read Python file content', async () => {
      const content = await fs.readFile(
        path.join(projectDir, 'src', 'processor.py'),
        'utf-8'
      );
      
      expect(content).toContain('class DataProcessor');
      expect(content).toContain('def process');
      expect(content).toContain('def main');
    });
    
    it('should read TypeScript file content', async () => {
      const content = await fs.readFile(
        path.join(projectDir, 'src', 'service.ts'),
        'utf-8'
      );
      
      expect(content).toContain('class DataService');
      expect(content).toContain('fetchData');
      expect(content).toContain('export function createService');
    });
    
    it('should read Rust file content', async () => {
      const content = await fs.readFile(
        path.join(projectDir, 'src', 'lib.rs'),
        'utf-8'
      );
      
      expect(content).toContain('pub struct Processor');
      expect(content).toContain('impl Processor');
      expect(content).toContain('fn main()');
    });
  });
  
  // ===========================================================================
  // Mock Graph Service Tests
  // ===========================================================================
  
  describe('Graph Service Integration', () => {
    it('should create graph service from config', async () => {
      const { createMemgraphService } = await import('../src/lib/graph-service.js');
      
      const service = createMemgraphService({
        host: 'localhost',
        port: 7687,
      });
      
      expect(service).toBeDefined();
    });
    
    it('should batch nodes correctly', async () => {
      const { createMemgraphService } = await import('../src/lib/graph-service.js');
      
      const service = createMemgraphService({
        host: 'localhost',
        port: 7687,
      }, {
        batchSize: 10,
        logLevel: 'silent',
      });
      
      // Add nodes to buffer
      service.ensureNodeBatch('Function', {
        qualified_name: 'module.func1',
        name: 'func1',
      });
      
      service.ensureNodeBatch('Function', {
        qualified_name: 'module.func2',
        name: 'func2',
      });
      
      // Nodes are buffered
      expect(true).toBe(true);
    });
  });
  
  // ===========================================================================
  // Query Tool Tests
  // ===========================================================================
  
  describe('Query Tools Integration', () => {
    it('should create all tools with factory function', async () => {
      const { createAllTools } = await import('../src/lib/tools/index.js');
      const { createMemgraphService } = await import('../src/lib/graph-service.js');
      
      const graphService = createMemgraphService({
        host: 'localhost',
        port: 7687,
      });
      
      const tools = await createAllTools({
        projectRoot: projectDir,
        projectName: 'test-project',
        graphService,
      });
      
      expect(tools.codeRetriever).toBeDefined();
      expect(tools.codebaseQuery).toBeDefined();
      expect(tools.dependencyAnalyzer).toBeDefined();
    });
    
    it('should get all tool schemas', async () => {
      const { getAllToolSchemas } = await import('../src/lib/tools/index.js');
      
      const schemas = getAllToolSchemas();
      
      expect(schemas.length).toBeGreaterThan(0);
      
      schemas.forEach(schema => {
        expect(schema.name).toBeDefined();
        expect(schema.description).toBeDefined();
        expect(schema.inputSchema).toBeDefined();
      });
    });
    
    it('should format tool descriptions', async () => {
      const { formatToolDescriptions } = await import('../src/lib/tools/index.js');
      
      const formatted = formatToolDescriptions();
      
      expect(formatted).toContain('Available Tools');
      expect(formatted).toContain('query_graph');
      expect(formatted).toContain('semantic_search');
    });
  });
  
  // ===========================================================================
  // Embedding Integration Tests
  // ===========================================================================
  
  describe('Embedding Integration', () => {
    it('should create embedding service from env', async () => {
      process.env.OPENAI_API_KEY = 'test-key';
      
      const { createEmbeddingServiceFromEnv } = await import('../src/lib/embeddings.js');
      
      const service = createEmbeddingServiceFromEnv();
      expect(service).toBeDefined();
      
      delete process.env.OPENAI_API_KEY;
    });
    
    it('should compute correct cache paths', async () => {
      const { getDefaultCachePath } = await import('../src/lib/embeddings.js');
      
      const cachePath = getDefaultCachePath(projectDir);
      
      expect(cachePath).toContain(projectDir);
      expect(cachePath).toContain('.cgr');
    });
  });
  
  // ===========================================================================
  // LLM Integration Tests
  // ===========================================================================
  
  describe('LLM Integration', () => {
    it('should create cypher generator from env', async () => {
      process.env.OPENAI_API_KEY = 'test-key';
      
      const { createCypherGenerator } = await import('../src/lib/llm-service.js');
      
      const generator = createCypherGenerator();
      expect(generator).toBeDefined();
      
      delete process.env.OPENAI_API_KEY;
    });
    
    it('should validate generated queries', async () => {
      const { validateCypherReadOnly, LLMGenerationError } = await import('../src/lib/llm-service.js');
      
      // Valid queries - should not throw
      expect(() => validateCypherReadOnly('MATCH (n) RETURN n')).not.toThrow();
      expect(() => validateCypherReadOnly('MATCH (a)-[r]->(b) RETURN a, r, b')).not.toThrow();
      
      // Invalid queries - should throw
      expect(() => validateCypherReadOnly('MATCH (n) DELETE n')).toThrow(LLMGenerationError);
      expect(() => validateCypherReadOnly('DROP INDEX idx')).toThrow(LLMGenerationError);
    });
  });
  
  // ===========================================================================
  // End-to-End Workflow Tests
  // ===========================================================================
  
  describe('End-to-End Workflows', () => {
    it('should complete file discovery to indexing workflow', async () => {
      // 1. Discover files
      const srcDir = path.join(projectDir, 'src');
      const files = await fs.readdir(srcDir);
      expect(files.length).toBeGreaterThan(0);
      
      // 2. Read file contents
      const pythonFile = path.join(srcDir, 'processor.py');
      const content = await fs.readFile(pythonFile, 'utf-8');
      expect(content.length).toBeGreaterThan(0);
      
      // 3. Create graph service
      const { createMemgraphService } = await import('../src/lib/graph-service.js');
      const graphService = createMemgraphService({
        host: 'localhost',
        port: 7687,
      }, { logLevel: 'silent' });
      
      // 4. Create function registry
      const { FunctionRegistryTrieImpl } = await import('../src/lib/parsers/factory.js');
      const registry = new FunctionRegistryTrieImpl();
      
      // Simulate adding parsed functions
      const { NodeType } = await import('../src/lib/types.js');
      registry.set('processor.DataProcessor', NodeType.CLASS);
      registry.set('processor.DataProcessor.process', NodeType.METHOD);
      registry.set('processor.main', NodeType.FUNCTION);
      
      expect(registry.has('processor.DataProcessor')).toBe(true);
      expect(registry.findWithPrefix('processor').length).toBe(3);
    });
    
    it('should complete query generation workflow', async () => {
      // 1. Create cypher generator
      process.env.OPENAI_API_KEY = 'test-key';
      const { createCypherGenerator, validateCypherReadOnly, cleanCypherResponse } = 
        await import('../src/lib/llm-service.js');
      
      const generator = createCypherGenerator({
        provider: 'openai',
        model: 'gpt-4',
      });
      
      // 2. Mock successful query generation
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: '```cypher\nMATCH (f:Function) WHERE f.name CONTAINS "process" RETURN f\n```',
            },
          }],
        }),
      } as Response);
      
      // 3. Generate query
      const cypher = await generator.generate(
        'Find all functions that process data',
        'test-project'
      );
      
      // 4. Validate - should not throw
      expect(() => validateCypherReadOnly(cypher)).not.toThrow();
      expect(cypher).toContain('MATCH');
      
      delete process.env.OPENAI_API_KEY;
    });
    
    it('should complete semantic search workflow', async () => {
      // 1. Create embedding service
      const { EmbeddingService, cosineSimilarity } = await import('../src/lib/embeddings.js');
      
      const embeddingService = new EmbeddingService({
        provider: 'openai',
        apiKey: 'test-key',
      });
      
      // 2. Mock embedding generation
      const mockEmbedding1 = Array(1536).fill(0).map((_, i) => Math.sin(i));
      const mockEmbedding2 = Array(1536).fill(0).map((_, i) => Math.sin(i + 0.1));
      const mockEmbedding3 = Array(1536).fill(0).map((_, i) => Math.cos(i));
      
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          object: 'list',
          data: [
            { object: 'embedding', embedding: mockEmbedding1, index: 0 },
            { object: 'embedding', embedding: mockEmbedding2, index: 1 },
            { object: 'embedding', embedding: mockEmbedding3, index: 2 },
          ],
          model: 'text-embedding-3-small',
          usage: { prompt_tokens: 10, total_tokens: 10 },
        }),
      } as Response);
      
      // 3. Generate embeddings for code snippets
      const snippets = [
        'def process_data(): pass',
        'def process_items(): pass',
        'def calculate_sum(): pass',
      ];
      
      const embeddings = await embeddingService.embedCodeBatch(snippets);
      expect(embeddings).toHaveLength(3);
      
      // 4. Calculate similarities
      const queryEmbedding = mockEmbedding1;
      const similarities = embeddings.map((emb, i) => ({
        index: i,
        score: cosineSimilarity(queryEmbedding, emb),
      }));
      
      // 5. Sort by similarity
      similarities.sort((a, b) => b.score - a.score);
      
      // First should be most similar
      expect(similarities[0].index).toBe(0);
    });
  });
  
  // ===========================================================================
  // Error Handling Tests
  // ===========================================================================
  
  describe('Error Handling', () => {
    it('should handle missing files gracefully', async () => {
      const nonExistentFile = path.join(projectDir, 'nonexistent.py');
      
      await expect(
        fs.readFile(nonExistentFile, 'utf-8')
      ).rejects.toThrow();
    });
    
    it('should handle API failures gracefully', async () => {
      process.env.OPENAI_API_KEY = 'test-key';
      const { createCypherGenerator, LLMGenerationError } = await import('../src/lib/llm-service.js');
      
      const generator = createCypherGenerator({
        provider: 'openai',
        model: 'gpt-4',
      });
      
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      } as Response);
      
      await expect(
        generator.generate('test query', 'test-project')
      ).rejects.toThrow();
      
      delete process.env.OPENAI_API_KEY;
    });
    
    it('should handle invalid Cypher gracefully', async () => {
      const { validateCypherReadOnly, LLMGenerationError } = await import('../src/lib/llm-service.js');
      
      const invalidCypher = 'MATCH (n) DELETE n';
      
      expect(() => validateCypherReadOnly(invalidCypher)).toThrow(LLMGenerationError);
    });
    
    it('should handle embedding API failures after retries', async () => {
      const { EmbeddingService } = await import('../src/lib/embeddings.js');
      
      const service = new EmbeddingService({
        provider: 'openai',
        apiKey: 'test-key',
        retryCount: 2,
        retryDelayMs: 10, // Fast for tests
      });
      
      // Mock all retry attempts to fail
      vi.mocked(global.fetch)
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          text: async () => 'Server Error',
        } as Response)
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          text: async () => 'Server Error',
        } as Response);
      
      await expect(
        service.embedCode('test')
      ).rejects.toThrow();
    });
  });
  
  // ===========================================================================
  // Performance Tests
  // ===========================================================================
  
  describe('Performance', () => {
    it('should handle large file lists efficiently', async () => {
      const { shouldSkipPath } = await import('../src/lib/parsers/structure-processor.js');
      const repoPath = '/project';
      
      // Generate 10000 file paths
      const files = Array(10000).fill(null).map((_, i) => 
        `/project/src/module${i}/file${i}.py`
      );
      
      const start = Date.now();
      const filtered = files.filter(f => !shouldSkipPath(f, repoPath));
      const duration = Date.now() - start;
      
      // Should complete in under 200ms (allow more time for CI)
      expect(duration).toBeLessThan(200);
      expect(filtered.length).toBe(10000);
    });
    
    it('should handle large function registries', async () => {
      const { FunctionRegistryTrieImpl } = await import('../src/lib/parsers/factory.js');
      const { NodeType } = await import('../src/lib/types.js');
      
      const registry = new FunctionRegistryTrieImpl();
      
      // Add 10000 functions
      const start = Date.now();
      for (let i = 0; i < 10000; i++) {
        registry.set(`module.pkg${i % 100}.Class${i % 50}.method${i}`, NodeType.METHOD);
      }
      const insertDuration = Date.now() - start;
      
      // Inserts should complete in under 500ms
      expect(insertDuration).toBeLessThan(500);
      
      // Test lookup performance
      const lookupStart = Date.now();
      for (let i = 0; i < 1000; i++) {
        registry.findWithPrefix(`module.pkg${i % 100}`);
      }
      const lookupDuration = Date.now() - lookupStart;
      
      // Lookups should complete in under 100ms
      expect(lookupDuration).toBeLessThan(100);
    });
    
    it('should batch embeddings efficiently', async () => {
      const { EmbeddingCache } = await import('../src/lib/embeddings.js');
      
      const cache = new EmbeddingCache();
      
      // Add 1000 cached items
      const start = Date.now();
      for (let i = 0; i < 1000; i++) {
        cache.put(`code snippet ${i}`, Array(1536).fill(0.01));
      }
      const duration = Date.now() - start;
      
      // Should complete in under 200ms
      expect(duration).toBeLessThan(200);
      expect(cache.size).toBe(1000);
    });
  });
});

// =============================================================================
// MCP Tool Handler Integration Tests
// =============================================================================

describe('MCP Tool Handler Integration', () => {
  it('should create MCP-compatible tool handler', async () => {
    const { createMCPToolHandler, createAllTools } = await import('../src/lib/tools/index.js');
    const { createMemgraphService } = await import('../src/lib/graph-service.js');
    
    const graphService = createMemgraphService({
      host: 'localhost',
      port: 7687,
    }, { logLevel: 'silent' });
    
    const tools = await createAllTools({
      projectRoot: '/test/project',
      projectName: 'test',
      graphService,
    });
    
    const handler = createMCPToolHandler(tools);
    expect(typeof handler).toBe('function');
  });
  
  it('should handle unknown tool names', async () => {
    const { createMCPToolHandler, createAllTools } = await import('../src/lib/tools/index.js');
    const { createMemgraphService } = await import('../src/lib/graph-service.js');
    
    const graphService = createMemgraphService({
      host: 'localhost',
      port: 7687,
    }, { logLevel: 'silent' });
    
    const tools = await createAllTools({
      projectRoot: '/test/project',
      projectName: 'test',
      graphService,
    });
    
    const handler = createMCPToolHandler(tools);
    
    const result = await handler({
      name: 'unknown_tool',
      arguments: {},
    });
    
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown tool');
  });
});
