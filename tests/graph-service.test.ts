/**
 * Tests for MemgraphService - Graph database operations
 * Tests CRUD operations, batch operations, and connection management
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MockDriver, MockRecord, createMockDriver } from './mocks/neo4j-driver.js';

// Mock neo4j-driver before importing graph-service
vi.mock('neo4j-driver', async () => {
  const mock = await import('./mocks/neo4j-driver.js');
  return {
    default: {
      driver: vi.fn((_uri: string, _auth?: unknown, _config?: unknown) => createMockDriver()),
      auth: mock.mockAuth,
      session: mock.mockSessionMode,
      int: mock.default.int,
      isInt: mock.isInt,
    },
    isInt: mock.isInt,
    Integer: mock.MockInteger,
  };
});

import {
  MemgraphService,
  createMemgraphService,
  createMemgraphServiceFromEnv,
  MemgraphConfig,
  MemgraphServiceOptions,
} from '../src/lib/graph-service.js';

describe('MemgraphService', () => {
  let service: MemgraphService;
  let mockDriver: MockDriver;
  
  const defaultConfig: MemgraphConfig = {
    host: 'localhost',
    port: 7687,
  };
  
  const defaultOptions: MemgraphServiceOptions = {
    batchSize: 100,
    logLevel: 'silent', // Suppress logs in tests
  };
  
  beforeEach(async () => {
    mockDriver = createMockDriver();
    service = createMemgraphService(defaultConfig, defaultOptions);
    
    // Mock the driver creation
    const neo4j = await import('neo4j-driver');
    vi.mocked(neo4j.default.driver).mockReturnValue(mockDriver as any);
  });
  
  afterEach(async () => {
    if (service.isConnected()) {
      await service.close();
    }
    vi.clearAllMocks();
  });
  
  // ===========================================================================
  // Connection Management Tests
  // ===========================================================================
  
  describe('Connection Management', () => {
    it('should connect to Memgraph successfully', async () => {
      await service.connect();
      expect(service.isConnected()).toBe(true);
    });
    
    it('should fail connection when database is unreachable', async () => {
      mockDriver.setConnected(false);
      await expect(service.connect()).rejects.toThrow('Connection refused');
    });
    
    it('should disconnect properly', async () => {
      await service.connect();
      expect(service.isConnected()).toBe(true);
      
      await service.close();
      expect(service.isConnected()).toBe(false);
    });
    
    it('should throw error when executing without connection', async () => {
      await expect(service.query('MATCH (n) RETURN n')).rejects.toThrow('Not connected');
    });
  });
  
  // ===========================================================================
  // Query Execution Tests
  // ===========================================================================
  
  describe('Query Execution', () => {
    beforeEach(async () => {
      await service.connect();
    });
    
    it('should execute read queries and return results', async () => {
      mockDriver.setMockData({
        records: [
          new MockRecord({ name: 'Function1', qualified_name: 'module.Function1' }),
          new MockRecord({ name: 'Function2', qualified_name: 'module.Function2' }),
        ],
        summary: {
          counters: {
            nodesCreated: () => 0,
            relationshipsCreated: () => 0,
          },
        },
      });
      
      const results = await service.query('MATCH (n:Function) RETURN n.name AS name');
      
      expect(results).toHaveLength(2);
      expect(results[0].name).toBe('Function1');
      expect(results[1].name).toBe('Function2');
    });
    
    it('should execute write queries', async () => {
      mockDriver.setMockData({
        records: [new MockRecord({ created: 1 })],
        summary: {
          counters: {
            nodesCreated: () => 1,
            relationshipsCreated: () => 0,
          },
        },
      });
      
      const results = await service.executeWrite(
        'CREATE (n:Function {name: $name}) RETURN n',
        { name: 'testFunc' }
      );
      
      expect(results).toHaveLength(1);
    });
    
    it('should handle empty results', async () => {
      mockDriver.setMockData({
        records: [],
        summary: {
          counters: {
            nodesCreated: () => 0,
            relationshipsCreated: () => 0,
          },
        },
      });
      
      const results = await service.query('MATCH (n:NonExistent) RETURN n');
      expect(results).toHaveLength(0);
    });
  });
  
  // ===========================================================================
  // CRUD Operations Tests
  // ===========================================================================
  
  describe('CRUD Operations', () => {
    beforeEach(async () => {
      await service.connect();
    });
    
    describe('Node Operations', () => {
      it('should create a node with required properties', async () => {
        mockDriver.setMockData({
          records: [new MockRecord({ n: { qualified_name: 'module.testFunc' } })],
          summary: {
            counters: {
              nodesCreated: () => 1,
              relationshipsCreated: () => 0,
            },
          },
        });
        
        const result = await service.createNode('Function', {
          qualified_name: 'module.testFunc',
          name: 'testFunc',
          start_line: 10,
          end_line: 20,
        });
        
        expect(result).toHaveLength(1);
      });
      
      it('should throw error when creating node without required key', async () => {
        await expect(
          service.createNode('Function', {
            name: 'testFunc', // Missing qualified_name
          })
        ).rejects.toThrow(/Missing required property/);
      });
      
      it('should create multiple nodes in batch', async () => {
        mockDriver.setMockData({
          records: [],
          summary: {
            counters: {
              nodesCreated: () => 3,
              relationshipsCreated: () => 0,
            },
          },
        });
        
        await service.createNodes('Function', [
          { qualified_name: 'module.func1', name: 'func1' },
          { qualified_name: 'module.func2', name: 'func2' },
          { qualified_name: 'module.func3', name: 'func3' },
        ]);
        
        // No throw means success
        expect(true).toBe(true);
      });
      
      it('should find nodes by filter', async () => {
        mockDriver.setMockData({
          records: [
            new MockRecord({ n: { qualified_name: 'module.func1', name: 'func1' } }),
          ],
          summary: {
            counters: {
              nodesCreated: () => 0,
              relationshipsCreated: () => 0,
            },
          },
        });
        
        const results = await service.findNodes('Function', { name: 'func1' });
        expect(results).toHaveLength(1);
      });
      
      it('should find a single node by key', async () => {
        mockDriver.setMockData({
          records: [
            new MockRecord({ n: { qualified_name: 'module.func1', name: 'func1' } }),
          ],
          summary: {
            counters: {
              nodesCreated: () => 0,
              relationshipsCreated: () => 0,
            },
          },
        });
        
        const result = await service.findNode('Function', 'module.func1');
        expect(result).not.toBeNull();
      });
      
      it('should return null when node not found', async () => {
        mockDriver.setMockData({
          records: [],
          summary: {
            counters: {
              nodesCreated: () => 0,
              relationshipsCreated: () => 0,
            },
          },
        });
        
        const result = await service.findNode('Function', 'nonexistent');
        expect(result).toBeNull();
      });
      
      it('should update node properties', async () => {
        mockDriver.setMockData({
          records: [
            new MockRecord({ n: { qualified_name: 'module.func1', name: 'updatedFunc' } }),
          ],
          summary: {
            counters: {
              nodesCreated: () => 0,
              relationshipsCreated: () => 0,
            },
          },
        });
        
        const result = await service.updateNode('Function', 'module.func1', {
          name: 'updatedFunc',
        });
        
        expect(result).toHaveLength(1);
      });
      
      it('should delete a node', async () => {
        mockDriver.setMockData({
          records: [],
          summary: {
            counters: {
              nodesCreated: () => 0,
              relationshipsCreated: () => 0,
            },
          },
        });
        
        await service.deleteNode('Function', 'module.func1');
        // No throw means success
        expect(true).toBe(true);
      });
    });
    
    describe('Relationship Operations', () => {
      it('should create a relationship between nodes', async () => {
        mockDriver.setMockData({
          records: [new MockRecord({ r: {} })],
          summary: {
            counters: {
              nodesCreated: () => 0,
              relationshipsCreated: () => 1,
            },
          },
        });
        
        const result = await service.createRelationship(
          ['Function', 'qualified_name', 'module.caller'],
          'CALLS',
          ['Function', 'qualified_name', 'module.callee'],
          { call_count: 5 }
        );
        
        expect(result).toHaveLength(1);
      });
      
      it('should create multiple relationships in batch', async () => {
        mockDriver.setMockData({
          records: [],
          summary: {
            counters: {
              nodesCreated: () => 0,
              relationshipsCreated: () => 2,
            },
          },
        });
        
        await service.createRelationships(
          'Function', 'qualified_name',
          'CALLS',
          'Function', 'qualified_name',
          [
            { fromVal: 'module.func1', toVal: 'module.func2' },
            { fromVal: 'module.func1', toVal: 'module.func3' },
          ]
        );
        
        // No throw means success
        expect(true).toBe(true);
      });
    });
  });
  
  // ===========================================================================
  // Batch Buffer Operations Tests
  // ===========================================================================
  
  describe('Batch Buffer Operations', () => {
    beforeEach(async () => {
      await service.connect();
    });
    
    it('should buffer nodes for batch processing', async () => {
      service.ensureNodeBatch('Function', {
        qualified_name: 'module.func1',
        name: 'func1',
      });
      
      // Node is buffered, not yet flushed
      // Verify by flushing and checking no errors
      mockDriver.setMockData({
        records: [],
        summary: {
          counters: {
            nodesCreated: () => 1,
            relationshipsCreated: () => 0,
          },
        },
      });
      
      await service.flushNodes();
      expect(true).toBe(true);
    });
    
    it('should buffer relationships for batch processing', async () => {
      service.ensureRelationshipBatch(
        ['Function', 'qualified_name', 'module.func1'],
        'CALLS',
        ['Function', 'qualified_name', 'module.func2']
      );
      
      mockDriver.setMockData({
        records: [],
        summary: {
          counters: {
            nodesCreated: () => 0,
            relationshipsCreated: () => 1,
          },
        },
      });
      
      await service.flushRelationships();
      expect(true).toBe(true);
    });
    
    it('should flush all buffered data', async () => {
      service.ensureNodeBatch('Function', {
        qualified_name: 'module.func1',
        name: 'func1',
      });
      
      service.ensureRelationshipBatch(
        ['Function', 'qualified_name', 'module.func1'],
        'CALLS',
        ['Function', 'qualified_name', 'module.func2']
      );
      
      mockDriver.setMockData({
        records: [],
        summary: {
          counters: {
            nodesCreated: () => 1,
            relationshipsCreated: () => 1,
          },
        },
      });
      
      await service.flushAll();
      expect(true).toBe(true);
    });
    
    it('should implement flush() for IngestorProtocol', async () => {
      mockDriver.setMockData({
        records: [],
        summary: {
          counters: {
            nodesCreated: () => 0,
            relationshipsCreated: () => 0,
          },
        },
      });
      
      await service.flush();
      expect(true).toBe(true);
    });
  });
  
  // ===========================================================================
  // Database Management Tests
  // ===========================================================================
  
  describe('Database Management', () => {
    beforeEach(async () => {
      await service.connect();
    });
    
    it('should clean database', async () => {
      mockDriver.setMockData({
        records: [],
        summary: {
          counters: {
            nodesCreated: () => 0,
            relationshipsCreated: () => 0,
          },
        },
      });
      
      await service.cleanDatabase();
      expect(true).toBe(true);
    });
    
    it('should list projects', async () => {
      mockDriver.setMockData({
        records: [
          new MockRecord({ name: 'project1' }),
          new MockRecord({ name: 'project2' }),
        ],
        summary: {
          counters: {
            nodesCreated: () => 0,
            relationshipsCreated: () => 0,
          },
        },
      });
      
      const projects = await service.listProjects();
      expect(projects).toContain('project1');
      expect(projects).toContain('project2');
    });
    
    it('should delete a specific project', async () => {
      mockDriver.setMockData({
        records: [],
        summary: {
          counters: {
            nodesCreated: () => 0,
            relationshipsCreated: () => 0,
          },
        },
      });
      
      await service.deleteProject('testProject');
      expect(true).toBe(true);
    });
    
    it('should ensure constraints exist', async () => {
      mockDriver.setMockData({
        records: [],
        summary: {
          counters: {
            nodesCreated: () => 0,
            relationshipsCreated: () => 0,
          },
        },
      });
      
      await service.ensureConstraints();
      expect(true).toBe(true);
    });
  });
  
  // ===========================================================================
  // Statistics Tests
  // ===========================================================================
  
  describe('Statistics', () => {
    beforeEach(async () => {
      await service.connect();
    });
    
    it('should get node counts by label', async () => {
      mockDriver.setMockData({
        records: [
          new MockRecord({ labels: ['Function'], count: 100 }),
          new MockRecord({ labels: ['Class'], count: 25 }),
        ],
        summary: {
          counters: {
            nodesCreated: () => 0,
            relationshipsCreated: () => 0,
          },
        },
      });
      
      const counts = await service.getNodeCounts();
      expect(counts['Function']).toBe(100);
      expect(counts['Class']).toBe(25);
    });
    
    it('should get relationship counts by type', async () => {
      mockDriver.setMockData({
        records: [
          new MockRecord({ type: 'CALLS', count: 500 }),
          new MockRecord({ type: 'DEFINES', count: 200 }),
        ],
        summary: {
          counters: {
            nodesCreated: () => 0,
            relationshipsCreated: () => 0,
          },
        },
      });
      
      const counts = await service.getRelationshipCounts();
      expect(counts['CALLS']).toBe(500);
      expect(counts['DEFINES']).toBe(200);
    });
    
    it('should get total stats', async () => {
      let callCount = 0;
      const originalSetMockData = mockDriver.setMockData.bind(mockDriver);
      
      // First call returns node count, second returns relationship count
      vi.spyOn(mockDriver, 'setMockData').mockImplementation((data) => {
        originalSetMockData(data);
      });
      
      mockDriver.setMockData({
        records: [new MockRecord({ count: 150 })],
        summary: {
          counters: {
            nodesCreated: () => 0,
            relationshipsCreated: () => 0,
          },
        },
      });
      
      const stats = await service.getStats();
      expect(typeof stats.nodes).toBe('number');
      expect(typeof stats.relationships).toBe('number');
    });
  });
  
  // ===========================================================================
  // Export Operations Tests
  // ===========================================================================
  
  describe('Export Operations', () => {
    beforeEach(async () => {
      await service.connect();
    });
    
    it('should export graph to dictionary', async () => {
      mockDriver.setMockData({
        records: [
          new MockRecord({ node_id: 1, labels: ['Function'], properties: { name: 'func1' } }),
        ],
        summary: {
          counters: {
            nodesCreated: () => 0,
            relationshipsCreated: () => 0,
          },
        },
      });
      
      const exported = await service.exportGraphToDict();
      
      expect(exported).toHaveProperty('nodes');
      expect(exported).toHaveProperty('relationships');
      expect(exported).toHaveProperty('metadata');
      expect(exported.metadata).toHaveProperty('exported_at');
    });
  });
  
  // ===========================================================================
  // Factory Functions Tests
  // ===========================================================================
  
  describe('Factory Functions', () => {
    it('should create service with createMemgraphService', () => {
      const svc = createMemgraphService(defaultConfig);
      expect(svc).toBeInstanceOf(MemgraphService);
    });
    
    it('should create service from environment variables', () => {
      // Set env vars
      process.env.MEMGRAPH_HOST = 'testhost';
      process.env.MEMGRAPH_PORT = '7688';
      
      const svc = createMemgraphServiceFromEnv();
      expect(svc).toBeInstanceOf(MemgraphService);
      
      // Clean up
      delete process.env.MEMGRAPH_HOST;
      delete process.env.MEMGRAPH_PORT;
    });
  });
  
  // ===========================================================================
  // Edge Cases Tests
  // ===========================================================================
  
  describe('Edge Cases', () => {
    beforeEach(async () => {
      await service.connect();
    });
    
    it('should handle empty batch creates', async () => {
      await service.createNodes('Function', []);
      expect(true).toBe(true);
    });
    
    it('should handle special characters in property values', async () => {
      mockDriver.setMockData({
        records: [new MockRecord({ n: {} })],
        summary: {
          counters: {
            nodesCreated: () => 1,
            relationshipsCreated: () => 0,
          },
        },
      });
      
      await service.createNode('Function', {
        qualified_name: 'module.func_with_special_$chars',
        docstring: 'This has "quotes" and \'apostrophes\'',
      });
      
      expect(true).toBe(true);
    });
    
    it('should handle null property values', async () => {
      mockDriver.setMockData({
        records: [new MockRecord({ n: {} })],
        summary: {
          counters: {
            nodesCreated: () => 1,
            relationshipsCreated: () => 0,
          },
        },
      });
      
      await service.createNode('Function', {
        qualified_name: 'module.func',
        docstring: null,
        start_line: null,
      });
      
      expect(true).toBe(true);
    });
    
    it('should handle very long qualified names', async () => {
      const longName = 'a'.repeat(1000) + '.func';
      
      mockDriver.setMockData({
        records: [new MockRecord({ n: {} })],
        summary: {
          counters: {
            nodesCreated: () => 1,
            relationshipsCreated: () => 0,
          },
        },
      });
      
      await service.createNode('Function', {
        qualified_name: longName,
        name: 'func',
      });
      
      expect(true).toBe(true);
    });
    
    it('should handle unicode in property values', async () => {
      mockDriver.setMockData({
        records: [new MockRecord({ n: {} })],
        summary: {
          counters: {
            nodesCreated: () => 1,
            relationshipsCreated: () => 0,
          },
        },
      });
      
      await service.createNode('Function', {
        qualified_name: 'module.函数',
        name: 'функция',
        docstring: 'This function does 日本語',
      });
      
      expect(true).toBe(true);
    });
  });
});
