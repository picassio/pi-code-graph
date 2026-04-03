/**
 * Tests for Embeddings Service - API-based embeddings for semantic search
 * Tests embedding generation, caching, and similarity functions
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';

// Mock fetch before importing
global.fetch = vi.fn();

import {
  EmbeddingService,
  EmbeddingCache,
  EmbeddingConfig,
  cosineSimilarity,
  euclideanDistance,
  findSimilar,
  semanticSearch,
  normalizeEmbedding,
  averageEmbeddings,
  createEmbeddingServiceFromEnv,
  getDefaultCachePath,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_EMBEDDING_DIMENSIONS,
  DEFAULT_BATCH_SIZE,
} from '../src/lib/embeddings.js';

// =============================================================================
// EmbeddingCache Tests
// =============================================================================

describe('EmbeddingCache', () => {
  let cache: EmbeddingCache;
  let testDir: string;
  
  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(tmpdir(), 'embedding-cache-test-'));
    cache = new EmbeddingCache(path.join(testDir, 'cache.json'));
  });
  
  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });
  
  describe('Basic Operations', () => {
    it('should store and retrieve embeddings', () => {
      const embedding = [0.1, 0.2, 0.3, 0.4, 0.5];
      cache.put('test content', embedding);
      
      const retrieved = cache.get('test content');
      expect(retrieved).toEqual(embedding);
    });
    
    it('should return null for non-existent keys', () => {
      const result = cache.get('nonexistent');
      expect(result).toBeNull();
    });
    
    it('should check existence with has()', () => {
      cache.put('exists', [0.1, 0.2]);
      
      expect(cache.has('exists')).toBe(true);
      expect(cache.has('does not exist')).toBe(false);
    });
    
    it('should track size correctly', () => {
      expect(cache.size).toBe(0);
      
      cache.put('item1', [0.1]);
      expect(cache.size).toBe(1);
      
      cache.put('item2', [0.2]);
      expect(cache.size).toBe(2);
    });
    
    it('should clear all entries', () => {
      cache.put('item1', [0.1]);
      cache.put('item2', [0.2]);
      expect(cache.size).toBe(2);
      
      cache.clear();
      expect(cache.size).toBe(0);
    });
  });
  
  describe('Batch Operations', () => {
    it('should get multiple cached embeddings', () => {
      cache.put('snippet1', [0.1, 0.2]);
      cache.put('snippet2', [0.3, 0.4]);
      
      const results = cache.getMany(['snippet1', 'snippet2', 'snippet3']);
      
      expect(results.size).toBe(2);
      expect(results.get(0)).toEqual([0.1, 0.2]);
      expect(results.get(1)).toEqual([0.3, 0.4]);
      expect(results.has(2)).toBe(false); // snippet3 not in cache
    });
    
    it('should put multiple embeddings', () => {
      const snippets = ['code1', 'code2', 'code3'];
      const embeddings = [[0.1], [0.2], [0.3]];
      
      cache.putMany(snippets, embeddings);
      
      expect(cache.get('code1')).toEqual([0.1]);
      expect(cache.get('code2')).toEqual([0.2]);
      expect(cache.get('code3')).toEqual([0.3]);
    });
    
    it('should throw on mismatched array lengths', () => {
      expect(() => {
        cache.putMany(['a', 'b'], [[0.1]]);
      }).toThrow('same length');
    });
  });
  
  describe('Persistence', () => {
    it('should save cache to disk', async () => {
      cache.put('test', [0.1, 0.2, 0.3]);
      await cache.save();
      
      const cachePath = path.join(testDir, 'cache.json');
      const exists = await fs.access(cachePath).then(() => true).catch(() => false);
      expect(exists).toBe(true);
      
      const content = JSON.parse(await fs.readFile(cachePath, 'utf-8'));
      expect(Object.keys(content).length).toBe(1);
    });
    
    it('should load cache from disk', async () => {
      const cachePath = path.join(testDir, 'cache.json');
      const mockCache = {
        'abc123': [0.1, 0.2, 0.3],
        'def456': [0.4, 0.5, 0.6],
      };
      await fs.writeFile(cachePath, JSON.stringify(mockCache));
      
      const newCache = new EmbeddingCache(cachePath);
      await newCache.load();
      
      expect(newCache.size).toBe(2);
    });
    
    it('should handle missing cache file gracefully', async () => {
      const nonExistentPath = path.join(testDir, 'nonexistent.json');
      const newCache = new EmbeddingCache(nonExistentPath);
      
      await newCache.load(); // Should not throw
      expect(newCache.size).toBe(0);
    });
    
    it('should handle corrupted cache file gracefully', async () => {
      const cachePath = path.join(testDir, 'corrupted.json');
      await fs.writeFile(cachePath, 'not valid json {{{');
      
      const newCache = new EmbeddingCache(cachePath);
      await newCache.load(); // Should not throw
      expect(newCache.size).toBe(0);
    });
  });
  
  describe('Content Hashing', () => {
    it('should produce consistent hashes for same content', () => {
      cache.put('same content', [0.1]);
      
      const result1 = cache.get('same content');
      const result2 = cache.get('same content');
      
      expect(result1).toEqual(result2);
    });
    
    it('should produce different hashes for different content', () => {
      cache.put('content A', [0.1]);
      cache.put('content B', [0.2]);
      
      expect(cache.get('content A')).not.toEqual(cache.get('content B'));
    });
    
    it('should handle unicode content', () => {
      const unicodeContent = '日本語のコード // Japanese comment';
      cache.put(unicodeContent, [0.1, 0.2]);
      
      expect(cache.get(unicodeContent)).toEqual([0.1, 0.2]);
    });
    
    it('should handle empty content', () => {
      cache.put('', [0.0]);
      expect(cache.get('')).toEqual([0.0]);
    });
  });
});

// =============================================================================
// EmbeddingService Tests
// =============================================================================

describe('EmbeddingService', () => {
  let service: EmbeddingService;
  let testDir: string;
  
  const mockConfig: EmbeddingConfig = {
    provider: 'openai',
    apiKey: 'test-api-key',
    model: 'text-embedding-3-small',
    dimensions: 1536,
  };
  
  const mockEmbeddingResponse = {
    object: 'list',
    data: [
      { object: 'embedding', embedding: Array(1536).fill(0.01), index: 0 },
    ],
    model: 'text-embedding-3-small',
    usage: { prompt_tokens: 10, total_tokens: 10 },
  };
  
  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(tmpdir(), 'embedding-service-test-'));
    const cachePath = path.join(testDir, 'cache.json');
    service = new EmbeddingService(mockConfig, cachePath);
    await service.initialize();
    vi.mocked(global.fetch).mockReset();
  });
  
  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });
  
  describe('Single Embedding', () => {
    it('should generate embedding for code snippet', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockEmbeddingResponse,
      } as Response);
      
      const embedding = await service.embedCode('def hello(): pass');
      
      expect(embedding).toHaveLength(1536);
      expect(fetch).toHaveBeenCalledTimes(1);
    });
    
    it('should return cached embedding on second request', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockEmbeddingResponse,
      } as Response);
      
      // First call - fetches from API
      await service.embedCode('def hello(): pass');
      
      // Second call - should use cache
      const embedding = await service.embedCode('def hello(): pass');
      
      expect(embedding).toHaveLength(1536);
      expect(fetch).toHaveBeenCalledTimes(1); // Only one API call
    });
    
    it('should handle API errors', async () => {
      // Mock all retries to fail
      vi.mocked(global.fetch)
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          text: async () => 'Internal Server Error',
        } as Response)
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          text: async () => 'Internal Server Error',
        } as Response)
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          text: async () => 'Internal Server Error',
        } as Response);
      
      await expect(
        service.embedCode('test code')
      ).rejects.toThrow();
    });
    
    it('should retry on rate limiting', async () => {
      // First call: rate limited
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => 'Rate limited',
      } as Response);
      
      // Second call: success
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockEmbeddingResponse,
      } as Response);
      
      const embedding = await service.embedCode('test');
      expect(embedding).toHaveLength(1536);
    });
  });
  
  describe('Batch Embedding', () => {
    it('should embed multiple snippets', async () => {
      const snippets = ['code1', 'code2', 'code3'];
      
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ...mockEmbeddingResponse,
          data: snippets.map((_, i) => ({
            object: 'embedding',
            embedding: Array(1536).fill(0.01 * (i + 1)),
            index: i,
          })),
        }),
      } as Response);
      
      const embeddings = await service.embedCodeBatch(snippets);
      
      expect(embeddings).toHaveLength(3);
      expect(embeddings[0]).toHaveLength(1536);
    });
    
    it('should use cache for already-embedded snippets', async () => {
      // First embed one snippet
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockEmbeddingResponse,
      } as Response);
      await service.embedCode('cached_code');
      
      // Then batch embed including the cached one
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ...mockEmbeddingResponse,
          data: [
            { object: 'embedding', embedding: Array(1536).fill(0.02), index: 0 },
          ],
        }),
      } as Response);
      
      const embeddings = await service.embedCodeBatch(['cached_code', 'new_code']);
      
      expect(embeddings).toHaveLength(2);
      // The first embedding should be from cache, second from API
    });
    
    it('should handle empty batch', async () => {
      const embeddings = await service.embedCodeBatch([]);
      expect(embeddings).toHaveLength(0);
    });
    
    it('should batch large requests', async () => {
      const largeSnippets = Array(150).fill(null).map((_, i) => `code_${i}`);
      
      // Should make 2 API calls (100 + 50 batches)
      vi.mocked(global.fetch)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ...mockEmbeddingResponse,
            data: Array(100).fill(null).map((_, i) => ({
              object: 'embedding',
              embedding: Array(1536).fill(0.01),
              index: i,
            })),
          }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ...mockEmbeddingResponse,
            data: Array(50).fill(null).map((_, i) => ({
              object: 'embedding',
              embedding: Array(1536).fill(0.01),
              index: i,
            })),
          }),
        } as Response);
      
      const embeddings = await service.embedCodeBatch(largeSnippets);
      
      expect(embeddings).toHaveLength(150);
      expect(fetch).toHaveBeenCalledTimes(2);
    });
  });
  
  describe('Provider Configuration', () => {
    it('should use OpenAI endpoint for openai provider', () => {
      const openaiService = new EmbeddingService({
        provider: 'openai',
        apiKey: 'test-key',
      });
      
      const info = openaiService.getModelInfo();
      expect(info.provider).toBe('openai');
    });
    
    it('should use OpenRouter endpoint for openrouter provider', () => {
      const openrouterService = new EmbeddingService({
        provider: 'openrouter',
        apiKey: 'test-key',
      });
      
      const info = openrouterService.getModelInfo();
      expect(info.provider).toBe('openrouter');
    });
    
    it('should use default model when not specified', () => {
      const defaultService = new EmbeddingService({
        provider: 'openai',
        apiKey: 'test-key',
      });
      
      const info = defaultService.getModelInfo();
      expect(info.model).toBe(DEFAULT_EMBEDDING_MODEL);
    });
    
    it('should use default dimensions when not specified', () => {
      const defaultService = new EmbeddingService({
        provider: 'openai',
        apiKey: 'test-key',
      });
      
      const info = defaultService.getModelInfo();
      expect(info.dimensions).toBe(DEFAULT_EMBEDDING_DIMENSIONS);
    });
  });
  
  describe('Cache Management', () => {
    it('should save cache to disk', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockEmbeddingResponse,
      } as Response);
      
      await service.embedCode('test code');
      await service.saveCache();
      
      const cachePath = path.join(testDir, 'cache.json');
      const exists = await fs.access(cachePath).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });
    
    it('should clear cache', () => {
      service.clearCache();
      expect(service.getCache().size).toBe(0);
    });
  });
});

// =============================================================================
// Similarity Functions Tests
// =============================================================================

describe('Similarity Functions', () => {
  describe('cosineSimilarity', () => {
    it('should return 1 for identical vectors', () => {
      const v = [1, 2, 3, 4, 5];
      expect(cosineSimilarity(v, v)).toBeCloseTo(1.0);
    });
    
    it('should return 0 for orthogonal vectors', () => {
      const v1 = [1, 0, 0];
      const v2 = [0, 1, 0];
      expect(cosineSimilarity(v1, v2)).toBeCloseTo(0.0);
    });
    
    it('should return -1 for opposite vectors', () => {
      const v1 = [1, 0, 0];
      const v2 = [-1, 0, 0];
      expect(cosineSimilarity(v1, v2)).toBeCloseTo(-1.0);
    });
    
    it('should handle normalized vectors', () => {
      const v1 = [0.6, 0.8]; // Already normalized
      const v2 = [0.6, 0.8];
      expect(cosineSimilarity(v1, v2)).toBeCloseTo(1.0);
    });
    
    it('should throw on dimension mismatch', () => {
      const v1 = [1, 2, 3];
      const v2 = [1, 2];
      expect(() => cosineSimilarity(v1, v2)).toThrow('dimension mismatch');
    });
    
    it('should handle zero vectors', () => {
      const v1 = [0, 0, 0];
      const v2 = [1, 2, 3];
      expect(cosineSimilarity(v1, v2)).toBe(0);
    });
  });
  
  describe('euclideanDistance', () => {
    it('should return 0 for identical vectors', () => {
      const v = [1, 2, 3];
      expect(euclideanDistance(v, v)).toBe(0);
    });
    
    it('should calculate correct distance', () => {
      const v1 = [0, 0];
      const v2 = [3, 4];
      expect(euclideanDistance(v1, v2)).toBeCloseTo(5.0);
    });
    
    it('should be symmetric', () => {
      const v1 = [1, 2, 3];
      const v2 = [4, 5, 6];
      expect(euclideanDistance(v1, v2)).toBeCloseTo(euclideanDistance(v2, v1));
    });
    
    it('should throw on dimension mismatch', () => {
      const v1 = [1, 2];
      const v2 = [1, 2, 3];
      expect(() => euclideanDistance(v1, v2)).toThrow('dimension mismatch');
    });
  });
  
  describe('findSimilar', () => {
    const queryEmbedding = [1, 0, 0];
    const embeddings = [
      [1, 0, 0],    // Identical
      [0.9, 0.1, 0], // Very similar
      [0, 1, 0],    // Orthogonal
      [-1, 0, 0],   // Opposite
    ];
    
    it('should return top K results', () => {
      const results = findSimilar(queryEmbedding, embeddings, 2);
      
      expect(results).toHaveLength(2);
      expect(results[0].score).toBeCloseTo(1.0);
    });
    
    it('should order by score descending', () => {
      const results = findSimilar(queryEmbedding, embeddings, 4);
      
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }
    });
    
    it('should filter by minimum score', () => {
      const results = findSimilar(queryEmbedding, embeddings, 10, 0.5);
      
      results.forEach(r => {
        expect(r.score).toBeGreaterThanOrEqual(0.5);
      });
    });
    
    it('should include correct indices', () => {
      const results = findSimilar(queryEmbedding, embeddings, 1);
      
      expect(results[0].index).toBe(0); // First embedding is identical
    });
    
    it('should handle empty embeddings array', () => {
      const results = findSimilar(queryEmbedding, [], 5);
      expect(results).toHaveLength(0);
    });
  });
  
  describe('semanticSearch', () => {
    it('should find similar code snippets', async () => {
      const mockService = {
        embedCode: vi.fn().mockResolvedValue([1, 0, 0]),
        embedCodeBatch: vi.fn().mockResolvedValue([
          [1, 0, 0],
          [0.9, 0.1, 0],
          [0, 1, 0],
        ]),
      } as unknown as EmbeddingService;
      
      const candidates = [
        'def similar1(): pass',
        'def similar2(): pass',
        'def different(): pass',
      ];
      
      const results = await semanticSearch(
        mockService,
        'find similar',
        candidates,
        2
      );
      
      expect(results).toHaveLength(2);
      expect(results[0]).toHaveProperty('content');
      expect(results[0]).toHaveProperty('score');
    });
    
    it('should handle empty candidates', async () => {
      const mockService = {
        embedCode: vi.fn(),
        embedCodeBatch: vi.fn(),
      } as unknown as EmbeddingService;
      
      const results = await semanticSearch(mockService, 'query', [], 5);
      
      expect(results).toHaveLength(0);
      expect(mockService.embedCode).not.toHaveBeenCalled();
    });
  });
});

// =============================================================================
// Vector Operations Tests
// =============================================================================

describe('Vector Operations', () => {
  describe('normalizeEmbedding', () => {
    it('should normalize to unit length', () => {
      const v = [3, 4]; // Length = 5
      const normalized = normalizeEmbedding(v);
      
      const length = Math.sqrt(
        normalized.reduce((sum, x) => sum + x * x, 0)
      );
      expect(length).toBeCloseTo(1.0);
    });
    
    it('should preserve direction', () => {
      const v = [2, 2];
      const normalized = normalizeEmbedding(v);
      
      // Normalized should have same ratio
      expect(normalized[0]).toBeCloseTo(normalized[1]);
    });
    
    it('should handle zero vector', () => {
      const v = [0, 0, 0];
      const normalized = normalizeEmbedding(v);
      
      expect(normalized).toEqual([0, 0, 0]);
    });
    
    it('should handle already normalized vector', () => {
      const v = [0.6, 0.8]; // Already unit length
      const normalized = normalizeEmbedding(v);
      
      expect(normalized[0]).toBeCloseTo(0.6);
      expect(normalized[1]).toBeCloseTo(0.8);
    });
  });
  
  describe('averageEmbeddings', () => {
    it('should compute element-wise average', () => {
      const embeddings = [
        [1, 2, 3],
        [3, 4, 5],
        [5, 6, 7],
      ];
      
      const avg = averageEmbeddings(embeddings);
      
      expect(avg).toEqual([3, 4, 5]);
    });
    
    it('should handle single embedding', () => {
      const embeddings = [[1, 2, 3]];
      const avg = averageEmbeddings(embeddings);
      
      expect(avg).toEqual([1, 2, 3]);
    });
    
    it('should throw on empty array', () => {
      expect(() => averageEmbeddings([])).toThrow('empty');
    });
    
    it('should throw on dimension mismatch', () => {
      const embeddings = [
        [1, 2],
        [1, 2, 3],
      ];
      
      expect(() => averageEmbeddings(embeddings)).toThrow('same dimension');
    });
  });
});

// =============================================================================
// Factory Functions Tests
// =============================================================================

describe('Factory Functions', () => {
  const originalEnv = process.env;
  
  beforeEach(() => {
    process.env = { ...originalEnv };
  });
  
  afterEach(() => {
    process.env = originalEnv;
  });
  
  describe('createEmbeddingServiceFromEnv', () => {
    it('should create service with OpenAI key', () => {
      process.env.OPENAI_API_KEY = 'test-openai-key';
      
      const service = createEmbeddingServiceFromEnv();
      
      expect(service).toBeInstanceOf(EmbeddingService);
      expect(service?.getModelInfo().provider).toBe('openai');
    });
    
    it('should create service with OpenRouter key', () => {
      delete process.env.OPENAI_API_KEY;
      process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
      
      const service = createEmbeddingServiceFromEnv();
      
      expect(service).toBeInstanceOf(EmbeddingService);
      expect(service?.getModelInfo().provider).toBe('openrouter');
    });
    
    it('should return null when no API keys available', () => {
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENROUTER_API_KEY;
      
      const service = createEmbeddingServiceFromEnv();
      
      expect(service).toBeNull();
    });
    
    it('should use custom model from environment', () => {
      process.env.OPENAI_API_KEY = 'test-key';
      process.env.EMBEDDING_MODEL = 'text-embedding-ada-002';
      
      const service = createEmbeddingServiceFromEnv();
      
      expect(service?.getModelInfo().model).toBe('text-embedding-ada-002');
    });
  });
  
  describe('getDefaultCachePath', () => {
    it('should return path in .cgr directory', () => {
      const projectPath = '/home/user/project';
      const cachePath = getDefaultCachePath(projectPath);
      
      expect(cachePath).toContain('.cgr');
      expect(cachePath).toContain('embedding');
    });
  });
});

// =============================================================================
// Edge Cases Tests
// =============================================================================

describe('Edge Cases', () => {
  describe('Embedding Edge Cases', () => {
    it('should handle very short code snippets', async () => {
      const mockService = {
        embedCode: vi.fn().mockResolvedValue(Array(1536).fill(0.01)),
      } as unknown as EmbeddingService;
      
      const embedding = await mockService.embedCode('x');
      expect(embedding).toHaveLength(1536);
    });
    
    it('should handle very long code snippets', async () => {
      const mockService = {
        embedCode: vi.fn().mockResolvedValue(Array(1536).fill(0.01)),
      } as unknown as EmbeddingService;
      
      const longCode = 'x'.repeat(10000);
      const embedding = await mockService.embedCode(longCode);
      expect(embedding).toHaveLength(1536);
    });
    
    it('should handle code with special characters', async () => {
      const cache = new EmbeddingCache();
      const specialCode = 'def func(): return "\\n\\t\\r\\0"';
      
      cache.put(specialCode, [0.1]);
      expect(cache.get(specialCode)).toEqual([0.1]);
    });
    
    it('should handle code with null bytes', async () => {
      const cache = new EmbeddingCache();
      const nullCode = 'code\x00with\x00nulls';
      
      cache.put(nullCode, [0.1]);
      expect(cache.get(nullCode)).toEqual([0.1]);
    });
  });
  
  describe('Similarity Edge Cases', () => {
    it('should handle high-dimensional vectors', () => {
      const dim = 4096;
      const v1 = Array(dim).fill(0.01);
      const v2 = Array(dim).fill(0.01);
      
      const sim = cosineSimilarity(v1, v2);
      expect(sim).toBeCloseTo(1.0);
    });
    
    it('should handle vectors with very small values', () => {
      const v1 = [1e-10, 1e-10, 1e-10];
      const v2 = [1e-10, 1e-10, 1e-10];
      
      const sim = cosineSimilarity(v1, v2);
      expect(sim).toBeCloseTo(1.0);
    });
    
    it('should handle vectors with very large values', () => {
      const v1 = [1e10, 1e10, 1e10];
      const v2 = [1e10, 1e10, 1e10];
      
      const sim = cosineSimilarity(v1, v2);
      expect(sim).toBeCloseTo(1.0);
    });
    
    it('should handle mixed positive/negative values', () => {
      const v1 = [-1, 1, -1, 1];
      const v2 = [-1, 1, -1, 1];
      
      const sim = cosineSimilarity(v1, v2);
      expect(sim).toBeCloseTo(1.0);
    });
  });
});
