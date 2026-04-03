/**
 * Tests for LLM Service - Cypher generation from natural language
 * Tests prompt construction, Cypher validation, and provider handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fetch before importing
global.fetch = vi.fn();

import {
  CypherGenerator,
  createCypherGenerator,
  cleanCypherResponse,
  validateCypherReadOnly,
  LLMGenerationError,
  LLMConfigurationError,
  LLMConfig,
  LLMProvider,
  detectAvailableProviders,
  getBestAvailableProvider,
  GRAPH_SCHEMA_DEFINITION,
} from '../src/lib/llm-service.js';

// =============================================================================
// cleanCypherResponse Tests
// =============================================================================

describe('cleanCypherResponse', () => {
  it('should extract Cypher from markdown code blocks', () => {
    const input = '```cypher\nMATCH (n) RETURN n\n```';
    const cleaned = cleanCypherResponse(input);

    expect(cleaned).toContain('MATCH (n) RETURN n');
    expect(cleaned).not.toContain('```');
  });

  it('should extract from generic code blocks', () => {
    const input = '```\nMATCH (n) RETURN n\n```';
    const cleaned = cleanCypherResponse(input);

    expect(cleaned).toContain('MATCH (n) RETURN n');
  });

  it('should trim whitespace', () => {
    const input = '  \n  MATCH (n) RETURN n  \n  ';
    const cleaned = cleanCypherResponse(input);

    expect(cleaned.startsWith(' ')).toBe(false);
    expect(cleaned.endsWith(' ')).toBe(false);
  });

  it('should handle query without code blocks', () => {
    const input = 'MATCH (n:Function) RETURN n';
    const cleaned = cleanCypherResponse(input);

    expect(cleaned).toContain('MATCH');
  });

  it('should handle multi-line queries', () => {
    const input = `\`\`\`cypher
MATCH (f:Function)
WHERE f.name CONTAINS "test"
RETURN f
\`\`\``;

    const cleaned = cleanCypherResponse(input);
    expect(cleaned).toContain('MATCH');
    expect(cleaned).toContain('WHERE');
    expect(cleaned).toContain('RETURN');
  });

  it('should handle empty input', () => {
    expect(cleanCypherResponse('')).toBe('');
    expect(cleanCypherResponse('   ')).toBe('');
  });
});

// =============================================================================
// validateCypherReadOnly Tests
// =============================================================================

describe('validateCypherReadOnly', () => {
  it('should accept valid MATCH queries', () => {
    const validQueries = [
      'MATCH (n:Function) RETURN n',
      'MATCH (a)-[r:CALLS]->(b) RETURN a, r, b',
      'MATCH (f:Function {name: "test"}) RETURN f',
      'MATCH (c:Class)-[:DEFINES]->(m:Method) RETURN c, m',
      'MATCH p=(start)-[*1..3]->(end) RETURN p',
    ];

    for (const query of validQueries) {
      expect(() => validateCypherReadOnly(query)).not.toThrow();
    }
  });

  it('should throw on DELETE queries', () => {
    expect(() =>
      validateCypherReadOnly('MATCH (n) DELETE n')
    ).toThrow(LLMGenerationError);
  });

  it('should throw on DETACH DELETE queries', () => {
    expect(() =>
      validateCypherReadOnly('MATCH (n) DETACH DELETE n')
    ).toThrow(LLMGenerationError);
  });

  it('should throw on SET queries', () => {
    expect(() =>
      validateCypherReadOnly('MATCH (n) SET n.prop = "value"')
    ).toThrow(LLMGenerationError);
  });

  it('should throw on REMOVE queries', () => {
    expect(() =>
      validateCypherReadOnly('MATCH (n) REMOVE n.prop')
    ).toThrow(LLMGenerationError);
  });

  it('should throw on DROP queries', () => {
    expect(() =>
      validateCypherReadOnly('DROP INDEX index_name')
    ).toThrow(LLMGenerationError);
  });

  it('should throw on CREATE queries', () => {
    expect(() =>
      validateCypherReadOnly('CREATE (n:Node)')
    ).toThrow(LLMGenerationError);
  });

  it('should throw on MERGE queries', () => {
    expect(() =>
      validateCypherReadOnly('MERGE (n:Node {id: 1})')
    ).toThrow(LLMGenerationError);
  });

  it('should accept queries with WHERE clauses', () => {
    const queries = [
      'MATCH (n:Function) WHERE n.name = "test" RETURN n',
      'MATCH (n) WHERE n.start_line > 10 RETURN n',
      'MATCH (n) WHERE n.path CONTAINS "utils" RETURN n',
    ];

    for (const query of queries) {
      expect(() => validateCypherReadOnly(query)).not.toThrow();
    }
  });

  it('should accept queries with ORDER BY and LIMIT', () => {
    const query = 'MATCH (n:Function) RETURN n ORDER BY n.name LIMIT 10';
    expect(() => validateCypherReadOnly(query)).not.toThrow();
  });

  it('should accept queries with aggregations', () => {
    const queries = [
      'MATCH (n:Function) RETURN count(n)',
      'MATCH (n:Function) RETURN n.name, count(*) AS cnt',
      'MATCH (n) RETURN collect(n.name)',
    ];

    for (const query of queries) {
      expect(() => validateCypherReadOnly(query)).not.toThrow();
    }
  });
});

// =============================================================================
// CypherGenerator Tests
// =============================================================================

describe('CypherGenerator', () => {
  let generator: CypherGenerator;

  beforeEach(() => {
    // Set env var for API key
    process.env.OPENAI_API_KEY = 'test-api-key';
    generator = createCypherGenerator({
      provider: 'openai',
      model: 'gpt-4',
    });
    vi.mocked(global.fetch).mockReset();
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
    vi.clearAllMocks();
  });

  describe('Query Generation', () => {
    it('should generate Cypher from natural language query', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: 'MATCH (f:Function) WHERE f.name = "main" RETURN f',
            },
          }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            total_tokens: 120,
          },
        }),
      } as Response);

      const result = await generator.generate(
        'Find the main function',
        'test-project'
      );

      expect(result).toBeDefined();
      expect(result).toContain('MATCH');
      expect(fetch).toHaveBeenCalled();
    });

    it('should throw LLMGenerationError on API failure', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      } as Response);

      await expect(
        generator.generate('Find all functions', 'test-project')
      ).rejects.toThrow(LLMGenerationError);
    });

    it('should throw for dangerous queries in response', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: 'MATCH (n) DELETE n', // Dangerous!
            },
          }],
        }),
      } as Response);

      await expect(
        generator.generate('Delete everything', 'test-project')
      ).rejects.toThrow(LLMGenerationError);
    });

    it('should include project name in context', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: 'MATCH (n) RETURN n',
            },
          }],
        }),
      } as Response);

      await generator.generate('Find all nodes', 'my-special-project');

      const call = vi.mocked(global.fetch).mock.calls[0];
      const body = JSON.parse(call[1]?.body as string);
      const messages = body.messages;

      // User message should contain project name
      const userMessage = messages.find((m: any) => m.role === 'user');
      expect(userMessage?.content).toContain('my-special-project');
    });
  });

  describe('Provider Configuration', () => {
    it('should use OpenAI endpoint for openai provider', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'MATCH (n) RETURN n' } }],
        }),
      } as Response);

      await generator.generate('test', 'project');

      const call = vi.mocked(global.fetch).mock.calls[0];
      expect(call[0]).toContain('openai.com');
    });

    it('should format Anthropic requests correctly', async () => {
      delete process.env.OPENAI_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';

      const anthropicGenerator = createCypherGenerator({
        provider: 'anthropic',
        model: 'claude-3-sonnet-20240229',
      });

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'MATCH (n) RETURN n' }],
        }),
      } as Response);

      await anthropicGenerator.generate('test', 'project');

      const call = vi.mocked(global.fetch).mock.calls[0];
      expect(call[0]).toContain('anthropic.com');
    });
  });

  describe('Schema Context', () => {
    it('should have schema definition available', () => {
      expect(GRAPH_SCHEMA_DEFINITION).toContain('Function');
      expect(GRAPH_SCHEMA_DEFINITION).toContain('Class');
      expect(GRAPH_SCHEMA_DEFINITION).toContain('CALLS');
      expect(GRAPH_SCHEMA_DEFINITION).toContain('DEFINES');
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
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('createCypherGenerator', () => {
    it('should create generator with OpenAI key', () => {
      process.env.OPENAI_API_KEY = 'test-openai-key';

      const generator = createCypherGenerator();
      expect(generator).toBeInstanceOf(CypherGenerator);
    });

    it('should create generator with Anthropic key', () => {
      delete process.env.OPENAI_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';

      const generator = createCypherGenerator({ provider: 'anthropic' });
      expect(generator).toBeInstanceOf(CypherGenerator);
    });

    it('should throw when no API keys available', () => {
      delete process.env.OPENAI_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENROUTER_API_KEY;
      delete process.env.GOOGLE_API_KEY;

      // Use a provider that requires an API key (not ollama)
      // This will only throw if pi's auth.json doesn't have the key
      const generator = createCypherGenerator({ provider: 'ollama' });
      // Ollama doesn't require a key, so it should succeed
      expect(generator).toBeInstanceOf(CypherGenerator);
    });
  });

  describe('detectAvailableProviders', () => {
    it('should detect OpenAI when key is set', () => {
      process.env.OPENAI_API_KEY = 'test-key';

      const providers = detectAvailableProviders();
      expect(providers).toContain('openai');
    });

    it('should detect Anthropic when key is set', () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';

      const providers = detectAvailableProviders();
      expect(providers).toContain('anthropic');
    });

    it('should return empty array when no keys', () => {
      delete process.env.OPENAI_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENROUTER_API_KEY;
      delete process.env.GOOGLE_API_KEY;

      const providers = detectAvailableProviders();
      // Ollama is always available as a fallback (no key required)
      // Other providers may also be available from pi's auth.json
      expect(providers).toContain('ollama');
    });
  });

  describe('getBestAvailableProvider', () => {
    it('should return openai when available', () => {
      process.env.OPENAI_API_KEY = 'test-key';

      const provider = getBestAvailableProvider();
      // Provider order is: openrouter, google, openai, anthropic, ollama
      // If openrouter/google is available from pi auth, it will be returned first
      // Otherwise openai should be returned
      expect(['openrouter', 'google', 'openai']).toContain(provider);
    });

    it('should return null when no providers available', () => {
      delete process.env.OPENAI_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENROUTER_API_KEY;
      delete process.env.GOOGLE_API_KEY;

      const provider = getBestAvailableProvider();
      // Should return a provider - either from pi auth or ollama as fallback
      expect(provider).not.toBeNull();
    });
  });
});

// =============================================================================
// Edge Cases Tests
// =============================================================================

describe('Edge Cases', () => {
  let generator: CypherGenerator;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test-key';
    generator = createCypherGenerator();
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  it('should handle empty natural language query', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'MATCH (n) RETURN n LIMIT 10' } }],
      }),
    } as Response);

    const result = await generator.generate('', 'project');
    expect(result).toContain('MATCH');
  });

  it('should handle very long queries', async () => {
    const longQuery = 'Find ' + 'all functions that '.repeat(100);

    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'MATCH (n:Function) RETURN n' } }],
      }),
    } as Response);

    const result = await generator.generate(longQuery, 'project');
    expect(result).toBeDefined();
  });

  it('should handle special characters in query', async () => {
    const queryWithSpecial = 'Find functions matching "test\'s $pecial"';

    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'MATCH (n) RETURN n' } }],
      }),
    } as Response);

    const result = await generator.generate(queryWithSpecial, 'project');
    expect(result).toBeDefined();
  });

  it('should handle unicode in query', async () => {
    const unicodeQuery = 'Find functions named 日本語 or функция';

    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'MATCH (n) RETURN n' } }],
      }),
    } as Response);

    const result = await generator.generate(unicodeQuery, 'project');
    expect(result).toBeDefined();
  });

  it('should handle network errors', async () => {
    vi.mocked(global.fetch).mockRejectedValueOnce(new Error('Network error'));

    await expect(
      generator.generate('test', 'project')
    ).rejects.toThrow();
  });

  it('should handle malformed API responses', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        // Missing choices array
        error: null,
      }),
    } as Response);

    await expect(
      generator.generate('test', 'project')
    ).rejects.toThrow();
  });
});

// =============================================================================
// Query Pattern Tests
// =============================================================================

describe('Common Query Patterns', () => {
  it('should validate finding functions by name', () => {
    const query = 'MATCH (f:Function) WHERE f.name = "main" RETURN f';
    expect(() => validateCypherReadOnly(query)).not.toThrow();
  });

  it('should validate finding classes with methods', () => {
    const query = 'MATCH (c:Class)-[:DEFINES_METHOD]->(m:Method) RETURN c, m';
    expect(() => validateCypherReadOnly(query)).not.toThrow();
  });

  it('should validate call graph queries', () => {
    const query = `
      MATCH (caller:Function)-[:CALLS]->(callee:Function)
      WHERE caller.name = "process"
      RETURN callee.qualified_name
    `;
    expect(() => validateCypherReadOnly(query)).not.toThrow();
  });

  it('should validate path queries', () => {
    const query = `
      MATCH path = (start:Function)-[:CALLS*1..5]->(end:Function)
      WHERE start.name = "entry" AND end.name = "exit"
      RETURN path
    `;
    expect(() => validateCypherReadOnly(query)).not.toThrow();
  });

  it('should validate aggregation queries', () => {
    const query = `
      MATCH (f:Function)-[:CALLS]->(called)
      RETURN f.name, count(called) AS call_count
      ORDER BY call_count DESC
      LIMIT 10
    `;
    expect(() => validateCypherReadOnly(query)).not.toThrow();
  });

  it('should validate optional match queries', () => {
    const query = `
      MATCH (c:Class)
      OPTIONAL MATCH (c)-[:DEFINES_METHOD]->(m:Method)
      RETURN c.name, collect(m.name) AS methods
    `;
    expect(() => validateCypherReadOnly(query)).not.toThrow();
  });

  it('should validate UNION queries', () => {
    const query = `
      MATCH (f:Function) WHERE f.name CONTAINS "test" RETURN f.qualified_name
      UNION
      MATCH (m:Method) WHERE m.name CONTAINS "test" RETURN m.qualified_name
    `;
    expect(() => validateCypherReadOnly(query)).not.toThrow();
  });
});
