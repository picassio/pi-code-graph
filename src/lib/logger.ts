/**
 * Shared logger for pi-code-graph library
 * 
 * All output goes to ~/.cgs/cgs.log to avoid interfering with the pi TUI.
 * Default level is 'info' — everything is captured in the log file.
 * Use /cgs docker logs or check ~/.cgs/cgs.log for debugging.
 */

import { appendFileSync, mkdirSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

const LOG_LEVELS: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

const LOG_DIR = join(homedir(), '.cgs');
const LOG_FILE = join(LOG_DIR, 'cgs.log');
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB

let currentLevel: LogLevel = 'info';
let logFileReady = false;

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

/**
 * Get the log file path
 */
export function getLogFilePath(): string {
  return LOG_FILE;
}

function ensureLogFile(): void {
  if (logFileReady) return;
  try {
    if (!existsSync(LOG_DIR)) {
      mkdirSync(LOG_DIR, { recursive: true });
    }
    // Rotate if too large
    if (existsSync(LOG_FILE)) {
      const stats = statSync(LOG_FILE);
      if (stats.size > MAX_LOG_SIZE) {
        const rotated = LOG_FILE + '.old';
        try {
          writeFileSync(rotated, '');
          // Swap: copy current to .old, truncate current
          const { copyFileSync } = require('node:fs');
          copyFileSync(LOG_FILE, rotated);
        } catch { /* ignore rotation errors */ }
        writeFileSync(LOG_FILE, '');
      }
    }
    logFileReady = true;
  } catch {
    // Can't write logs — silently ignore
    logFileReady = false;
  }
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] <= LOG_LEVELS[currentLevel];
}

function formatArgs(args: unknown[]): string {
  if (args.length === 0) return '';
  return ' ' + args.map(a => {
    if (a instanceof Error) return a.message;
    if (typeof a === 'object') {
      try { return JSON.stringify(a); } catch { return String(a); }
    }
    return String(a);
  }).join(' ');
}

function writeLog(level: string, msg: string, args: unknown[]): void {
  ensureLogFile();
  if (!logFileReady) return;
  try {
    const ts = new Date().toISOString();
    const line = `${ts} [${level.toUpperCase()}] ${msg}${formatArgs(args)}\n`;
    appendFileSync(LOG_FILE, line);
  } catch {
    // Silently ignore write errors
  }
}

export const logger = {
  debug(msg: string, ...args: unknown[]): void {
    if (shouldLog('debug')) writeLog('debug', msg, args);
  },
  info(msg: string, ...args: unknown[]): void {
    if (shouldLog('info')) writeLog('info', msg, args);
  },
  warn(msg: string, ...args: unknown[]): void {
    if (shouldLog('warn')) writeLog('warn', msg, args);
  },
  error(msg: string, ...args: unknown[]): void {
    if (shouldLog('error')) writeLog('error', msg, args);
  },
};
