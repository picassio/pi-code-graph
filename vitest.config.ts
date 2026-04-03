import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Enable globals for describe/it/expect
    globals: true,
    // Test environment
    environment: 'node',
    // Test file patterns
    include: ['tests/**/*.test.ts'],
    // Coverage settings
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/lib/**/*.ts'],
      exclude: [
        'src/lib/**/index.ts',
        'src/lib/tree-sitter/**',
      ],
    },
    // Timeout for async tests (ms)
    testTimeout: 30000,
    // Allow importing TypeScript files
    typecheck: {
      enabled: false, // Don't block on type errors during testing
    },
    // Setup files
    setupFiles: ['./tests/setup.ts'],
    // Isolate tests
    isolate: true,
    // Mock modules
    deps: {
      interopDefault: true,
    },
  },
});
