import { describe, expect, it } from 'vitest';
import { applyProjectScopeToCypher } from '../src/lib/tools/codebase-query.js';

describe('applyProjectScopeToCypher', () => {
  it('adds project scope to simple code-node queries without WHERE', () => {
    const query = 'MATCH (m:Method) RETURN m.name AS name LIMIT 50;';
    expect(applyProjectScopeToCypher(query, 'pi-mono')).toBe(
      'MATCH (m:Method) WHERE m.project = $project\nRETURN m.name AS name LIMIT 50;',
    );
  });

  it('adds project scope before existing WHERE conditions', () => {
    const query = "MATCH (f:Function|Method) WHERE toLower(f.name) CONTAINS 'handle' RETURN f.name AS name LIMIT 50;";
    expect(applyProjectScopeToCypher(query, 'pi-mono')).toBe(
      "MATCH (f:Function|Method) WHERE f.project = $project AND (toLower(f.name) CONTAINS 'handle')\nRETURN f.name AS name LIMIT 50;",
    );
  });

  it('scopes multiple code-node variables', () => {
    const query = 'MATCH (c:Class)-[:DEFINES_METHOD]->(m:Method) RETURN c.name AS className, m.name AS methodName LIMIT 50;';
    expect(applyProjectScopeToCypher(query, 'pi-mono')).toContain('c.project = $project AND m.project = $project');
  });

  it('does not change queries that already mention project scoping', () => {
    const query = 'MATCH (m:Method) WHERE m.project = $project RETURN m.name AS name LIMIT 50;';
    expect(applyProjectScopeToCypher(query, 'pi-mono')).toBe(query);
  });

  it('does not change non-code-node queries', () => {
    const query = 'MATCH (p:Project) RETURN p.name AS name LIMIT 50;';
    expect(applyProjectScopeToCypher(query, 'pi-mono')).toBe(query);
  });
});
