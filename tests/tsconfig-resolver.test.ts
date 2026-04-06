import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTsconfigAliases } from '../src/lib/parsers/tsconfig-resolver.js';

describe('tsconfig-resolver', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tsconfig-test-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty when no tsconfig exists', () => {
    const m = loadTsconfigAliases(dir);
    expect(m.hasAliases).toBe(false);
    expect(m.rewrite('@/foo')).toBeNull();
  });

  it('rewrites glob aliases', () => {
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { '@/*': ['src/*'], '@lib/*': ['src/lib/*'] },
        },
      })
    );
    const m = loadTsconfigAliases(dir);
    expect(m.hasAliases).toBe(true);
    expect(m.rewrite('@/components/Button')).toBe('src/components/Button');
    expect(m.rewrite('@lib/foo/bar')).toBe('src/lib/foo/bar');
    expect(m.rewrite('react')).toBeNull();
  });

  it('handles exact (non-glob) aliases', () => {
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '~root': ['src/index.ts'] } },
      })
    );
    const m = loadTsconfigAliases(dir);
    expect(m.rewrite('~root')).toBe('src/index.ts');
  });

  it('follows extends chains', () => {
    writeFileSync(
      join(dir, 'tsconfig.base.json'),
      JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } },
      })
    );
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({ extends: './tsconfig.base.json' })
    );
    const m = loadTsconfigAliases(dir);
    expect(m.hasAliases).toBe(true);
    expect(m.rewrite('@/x/y')).toBe('src/x/y');
  });

  it('respects baseUrl subdirectory', () => {
    mkdirSync(join(dir, 'app'));
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { baseUrl: 'app', paths: { '@/*': ['src/*'] } },
      })
    );
    const m = loadTsconfigAliases(dir);
    expect(m.rewrite('@/foo')).toBe('app/src/foo');
  });

  it('strips JSONC comments', () => {
    writeFileSync(
      join(dir, 'tsconfig.json'),
      `{
        // a comment
        "compilerOptions": {
          /* block */
          "baseUrl": ".",
          "paths": { "@/*": ["src/*"] }
        }
      }`
    );
    const m = loadTsconfigAliases(dir);
    expect(m.rewrite('@/a')).toBe('src/a');
  });
});
