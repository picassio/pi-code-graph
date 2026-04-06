import { describe, it, expect } from 'vitest';
import {
  buildSuffixIndex,
  suffixResolveImport,
  EMPTY_SUFFIX_INDEX,
} from '../src/lib/parsers/suffix-resolver.js';

describe('suffix-resolver', () => {
  const repoPath = '/repo';
  const projectName = 'pkg';
  const files = [
    '/repo/src/oauth.ts',
    '/repo/src/utils/oauth/index.ts',
    '/repo/src/components/Button.tsx',
    '/repo/src/lib/parsers/workspace-resolver.ts',
  ];
  const index = buildSuffixIndex(repoPath, projectName, files);

  it('indexes module qns from file paths', () => {
    expect(index.hasModuleQn('src/oauth.ts')).toBe(true);
    expect(index.hasModuleQn('src/utils/oauth/index.ts')).toBe(true);
    expect(index.hasModuleQn('src/lib/parsers/workspace-resolver.ts')).toBe(true);
  });

  it('exact suffix lookup wins (longest path first stored)', () => {
    // "oauth" is ambiguous; whichever indexed first wins (stable, non-null)
    const hit = index.get('oauth.ts');
    expect(hit === 'src/oauth.ts' || hit === 'src/utils/oauth/index.ts').toBe(true);
  });

  it('case-insensitive lookup works', () => {
    expect(index.getInsensitive('button.tsx')).toBe('src/components/Button.tsx');
  });

  it('suffixResolveImport falls back via primary guess', () => {
    const hit = suffixResolveImport(
      './foo/workspace-resolver',
      'src/lib/parsers/workspace-resolver',
      index
    );
    expect(hit).toBe('src/lib/parsers/workspace-resolver.ts');
  });

  it('suffixResolveImport handles non-relative bare specifiers', () => {
    const hit = suffixResolveImport('@scope/oauth', null, index);
    expect(hit).not.toBeNull();
    expect(hit!.endsWith('oauth.ts') || hit!.endsWith('oauth/index.ts')).toBe(true);
  });

  it('returns null on empty index', () => {
    expect(suffixResolveImport('./anything', 'a/b/c', EMPTY_SUFFIX_INDEX)).toBeNull();
  });

  it('returns null when no suffix matches', () => {
    expect(suffixResolveImport('totally-unknown-pkg', null, index)).toBeNull();
  });
});
