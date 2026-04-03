/**
 * Mock neo4j-driver for testing graph-service
 * Simulates Memgraph/Neo4j driver behavior
 */

import { vi } from 'vitest';

// Mock Integer type
export class MockInteger {
  private value: number;
  
  constructor(value: number) {
    this.value = value;
  }
  
  toNumber(): number {
    return this.value;
  }
}

export function isInt(val: unknown): boolean {
  return val instanceof MockInteger;
}

// Mock Record class
export class MockRecord {
  private data: Map<string, unknown>;
  keys: string[];
  
  constructor(data: Record<string, unknown>) {
    this.data = new Map(Object.entries(data));
    this.keys = Object.keys(data);
  }
  
  get(key: string): unknown {
    return this.data.get(key);
  }
}

// Mock QueryResult
export interface MockQueryResult {
  records: MockRecord[];
  summary: {
    counters: {
      nodesCreated: () => number;
      relationshipsCreated: () => number;
    };
  };
}

// Mock Session
export class MockSession {
  private closed = false;
  private mockData: MockQueryResult;
  
  constructor(mockData?: MockQueryResult) {
    this.mockData = mockData || {
      records: [],
      summary: {
        counters: {
          nodesCreated: () => 0,
          relationshipsCreated: () => 0,
        },
      },
    };
  }
  
  setMockData(data: MockQueryResult): void {
    this.mockData = data;
  }
  
  async run(_query: string, _params?: Record<string, unknown>): Promise<MockQueryResult> {
    if (this.closed) {
      throw new Error('Session is closed');
    }
    return this.mockData;
  }
  
  async executeWrite<T>(fn: (tx: MockTransaction) => Promise<T>): Promise<T> {
    const tx = new MockTransaction(this.mockData);
    return fn(tx);
  }
  
  async close(): Promise<void> {
    this.closed = true;
  }
}

// Mock Transaction
export class MockTransaction {
  private mockData: MockQueryResult;
  
  constructor(mockData: MockQueryResult) {
    this.mockData = mockData;
  }
  
  async run(_query: string, _params?: Record<string, unknown>): Promise<MockQueryResult> {
    return this.mockData;
  }
}

// Mock Driver
export class MockDriver {
  private sessions: MockSession[] = [];
  private mockData: MockQueryResult;
  private connected = true;
  
  constructor(mockData?: MockQueryResult) {
    this.mockData = mockData || {
      records: [],
      summary: {
        counters: {
          nodesCreated: () => 0,
          relationshipsCreated: () => 0,
        },
      },
    };
  }
  
  setMockData(data: MockQueryResult): void {
    this.mockData = data;
    this.sessions.forEach(s => s.setMockData(data));
  }
  
  async verifyConnectivity(): Promise<void> {
    if (!this.connected) {
      throw new Error('Connection refused');
    }
  }
  
  setConnected(connected: boolean): void {
    this.connected = connected;
  }
  
  session(_options?: Record<string, unknown>): MockSession {
    const session = new MockSession(this.mockData);
    this.sessions.push(session);
    return session;
  }
  
  async close(): Promise<void> {
    await Promise.all(this.sessions.map(s => s.close()));
    this.sessions = [];
  }
}

// Mock auth functions
export const mockAuth = {
  basic: vi.fn((username: string, password: string) => ({
    scheme: 'basic',
    principal: username,
    credentials: password,
  })),
};

// Mock session access modes
export const mockSessionMode = {
  READ: 'READ',
  WRITE: 'WRITE',
};

// Factory for creating mock driver
export function createMockDriver(mockData?: MockQueryResult): MockDriver {
  return new MockDriver(mockData);
}

// Default mock module
const mockNeo4j = {
  driver: vi.fn((_uri: string, _auth?: unknown, _config?: unknown) => new MockDriver()),
  auth: mockAuth,
  session: mockSessionMode,
  int: (value: number) => new MockInteger(value),
  isInt,
};

export default mockNeo4j;
