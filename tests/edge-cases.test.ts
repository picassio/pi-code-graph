import { describe, it, expect } from 'vitest';
import { cleanCypherResponse } from '../src/lib/llm-service.js';
import { shouldSkipPath } from '../src/lib/parsers/structure-processor.js';
import { safeDecodeText, safeDecodeWithFallback } from '../src/lib/parsers/base.js';

describe('Edge case tests', () => {
  describe('cleanCypherResponse edge cases', () => {
    it('handles null-like inputs gracefully', () => {
      expect(cleanCypherResponse('')).toBe('');
      expect(cleanCypherResponse('   \n\t  ')).toBe('');
    });
    
    it('handles unbalanced markdown', () => {
      // Unbalanced backticks - should still extract
      expect(cleanCypherResponse('```cypher\nMATCH (n)')).toContain('MATCH');
    });
    
    it('handles very long queries', () => {
      const longQuery = 'MATCH (n) ' + 'WHERE n.id > 1 '.repeat(1000) + 'RETURN n';
      const result = cleanCypherResponse(longQuery);
      expect(result.length).toBeGreaterThan(1000);
    });
    
    it('handles special characters', () => {
      const query = "MATCH (n) WHERE n.name = 'test\\'s \"value\"' RETURN n";
      expect(cleanCypherResponse(query)).toContain('test');
    });
  });

  describe('shouldSkipPath edge cases', () => {
    const repoPath = '/project';
    
    it('skips .egg-info directories', () => {
      expect(shouldSkipPath('/project/package.egg-info/PKG-INFO', repoPath)).toBe(true);
      expect(shouldSkipPath('/project/my_package.egg-info/SOURCES.txt', repoPath)).toBe(true);
    });
    
    it('skips common build directories', () => {
      expect(shouldSkipPath('/project/node_modules/foo/bar.js', repoPath)).toBe(true);
      expect(shouldSkipPath('/project/__pycache__/module.pyc', repoPath)).toBe(true);
      expect(shouldSkipPath('/project/.git/objects/pack', repoPath)).toBe(true);
      expect(shouldSkipPath('/project/dist/bundle.js', repoPath)).toBe(true);
    });
    
    it('does not skip valid source files', () => {
      expect(shouldSkipPath('/project/src/main.ts', repoPath)).toBe(false);
      expect(shouldSkipPath('/project/lib/utils.py', repoPath)).toBe(false);
    });
  });

  describe('safeDecodeText edge cases', () => {
    it('handles null input', () => {
      expect(safeDecodeText(null)).toBe(null);
    });
    
    it('handles empty buffer', () => {
      expect(safeDecodeText(Buffer.from(''))).toBe('');
    });
    
    it('handles binary data without crashing', () => {
      // Random binary data
      const binary = Buffer.from([0x00, 0x01, 0x02, 0xFF, 0xFE, 0x80]);
      const result = safeDecodeText(binary);
      expect(typeof result).toBe('string');
    });
  });

  describe('safeDecodeWithFallback edge cases', () => {
    it('handles valid UTF-8', () => {
      expect(safeDecodeWithFallback(Buffer.from('hello'))).toBe('hello');
    });
    
    it('handles unicode', () => {
      expect(safeDecodeWithFallback(Buffer.from('你好世界'))).toBe('你好世界');
      expect(safeDecodeWithFallback(Buffer.from('🎉🎊🎁'))).toBe('🎉🎊🎁');
    });
    
    it('handles mixed encoding gracefully', () => {
      // Latin-1 encoded text
      const latin1 = Buffer.from([0xe9, 0xe8, 0xe0]); // é è à in latin-1
      const result = safeDecodeWithFallback(latin1);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });
  });
});
