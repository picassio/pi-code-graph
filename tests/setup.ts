/**
 * Test setup file for vitest
 * Sets up global mocks and test utilities
 */

/// <reference types="vitest/globals" />

import { vi, beforeEach } from 'vitest';

// Mock console methods to reduce test noise
global.console = {
  ...console,
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  // Keep error for actual test failures
  error: console.error,
};

// Mock fetch for API tests
global.fetch = vi.fn();

// Reset all mocks before each test
beforeEach(() => {
  vi.clearAllMocks();
});
