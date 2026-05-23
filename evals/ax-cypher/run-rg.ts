import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

interface RgCase {
  id: string;
  question: string;
  args: string[];
  notes: string;
}

const repo = process.env.CGR_EVAL_REPO || '/home/ubuntu/projects/pi-mono';

const cases: RgCase[] = [
  {
    id: 'direct-callers-authstorage-login',
    question: 'Who calls AuthStorage.login?',
    args: ['-n', 'authStorage\\.login\\(', 'packages'],
    notes: 'Fast if the receiver variable name is known; gives line hits, not enclosing functions or aliases.',
  },
  {
    id: 'oauth-provider-interface-impls',
    question: 'List implementations of OAuthProviderInterface',
    args: ['-n', ': OAuthProviderInterface = \\{', 'packages'],
    notes: 'Excellent exact-pattern result once the TypeScript object-literal shape is known.',
  },
  {
    id: 'transitive-callers-get-api-key',
    question: 'Show transitive callers of AuthStorage.getApiKey up to depth 3',
    args: ['-n', 'getApiKey\\(', 'packages'],
    notes: 'Finds many direct text occurrences but does not compute transitive call chains.',
  },
  {
    id: 'console-log-builtins',
    question: 'Where do we call console.log?',
    args: ['-n', 'console\\.log', 'packages'],
    notes: 'Best tool for exhaustive exact text hits.',
  },
  {
    id: 'openrouter-api-key-literal',
    question: 'Find string literals containing OPENROUTER_API_KEY',
    args: ['-n', 'OPENROUTER_API_KEY', '.'],
    notes: 'Finds all text occurrences, including docs/scripts/tests; not restricted to code literal nodes.',
  },
  {
    id: 'raw-docs-text-search',
    question: 'Search every README and package-lock for @mariozechner/pi-coding-agent',
    args: ['-n', '@mariozechner/pi-coding-agent', 'README.md', 'package-lock.json', 'package.json', 'packages'],
    notes: 'Exactly the workload ripgrep is designed for.',
  },
  {
    id: 'oauth-refresh-concept',
    question: 'Find code that refreshes OAuth tokens',
    args: ['-n', 'refreshToken|refresh_token|refreshAccessToken|refreshOAuthToken', 'packages'],
    notes: 'Good only after a human guesses the vocabulary; returns lines/files, not ranked semantic functions.',
  },
  {
    id: 'scalar-in-trap',
    question: 'Find methods whose name contains create',
    args: ['-n', 'function create|create[A-Za-z0-9_]*\\(', 'packages'],
    notes: 'Very broad pattern; fast but noisy and not AST-aware.',
  },
];

function runRg(args: string[]): Promise<{ exitCode: number; durationMs: number; count: number; sample: string[]; stderr: string }> {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const child = spawn('rg', args, { cwd: repo });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      const lines = stdout.split('\n').filter(Boolean);
      resolve({
        exitCode: code ?? 0,
        durationMs: performance.now() - start,
        count: lines.length,
        sample: lines.slice(0, 10),
        stderr,
      });
    });
  });
}

const allStart = performance.now();
const results = [];
for (const c of cases) {
  const result = await runRg(c.args);
  const record = { ...c, command: `rg ${c.args.map((a) => JSON.stringify(a)).join(' ')}`, ...result };
  results.push(record);
  console.log(JSON.stringify(record, null, 2));
}

const totalMs = performance.now() - allStart;
console.log(JSON.stringify({
  summary: {
    repo,
    cases: results.length,
    totalMs,
    totalMatches: results.reduce((sum, r) => sum + r.count, 0),
    avgMs: totalMs / Math.max(1, results.length),
  },
}, null, 2));
