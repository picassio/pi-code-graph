/**
 * Shared logger for pi-code-graph library
 * 
 * Defaults to 'error' level so only errors are shown.
 * This prevents flooding the pi TUI with log output during indexing.
 */

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

const LOG_LEVELS: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

let currentLevel: LogLevel = 'error';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] <= LOG_LEVELS[currentLevel];
}

export const logger = {
  debug(msg: string, ...args: unknown[]): void {
    if (shouldLog('debug')) console.debug(msg, ...args);
  },
  info(msg: string, ...args: unknown[]): void {
    if (shouldLog('info')) console.info(msg, ...args);
  },
  warn(msg: string, ...args: unknown[]): void {
    if (shouldLog('warn')) console.warn(msg, ...args);
  },
  error(msg: string, ...args: unknown[]): void {
    if (shouldLog('error')) console.error(msg, ...args);
  },
};
