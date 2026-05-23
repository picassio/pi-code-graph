export type ExpectedRoute = 'graph' | 'dependency' | 'semantic' | 'exact_text' | 'grep_recommended' | 'unsupported';

export interface CypherEvalExample {
  id: string;
  question: string;
  projectName: string;
  expectedRoute: ExpectedRoute;
  mustContain?: string[];
  mustNotContain?: string[];
  expectedRows?: Array<Record<string, unknown>>;
  notes?: string;
}

export const CYPHER_EVAL_DATASET: CypherEvalExample[] = [
  {
    id: 'direct-callers-authstorage-login',
    question: 'Who calls AuthStorage.login?',
    projectName: 'pi-mono',
    expectedRoute: 'dependency',
    mustContain: ['MATCH', 'CALLS', 'AuthStorage.login'],
    mustNotContain: ['DELETE', 'CREATE', 'SET '],
  },
  {
    id: 'oauth-provider-interface-impls',
    question: 'List implementations of OAuthProviderInterface',
    projectName: 'pi-mono',
    expectedRoute: 'graph',
    mustContain: ['IMPLEMENTS', 'OAuthProviderInterface'],
  },
  {
    id: 'transitive-callers-get-api-key',
    question: 'Show transitive callers of AuthStorage.getApiKey up to depth 3',
    projectName: 'pi-mono',
    expectedRoute: 'dependency',
    mustContain: ['CALLS', '*1..3', 'AuthStorage.getApiKey'],
  },
  {
    id: 'console-log-builtins',
    question: 'Where do we call console.log?',
    projectName: 'pi-mono',
    expectedRoute: 'exact_text',
    mustContain: ['Builtin', 'console.log'],
  },
  {
    id: 'openrouter-api-key-literal',
    question: 'Find string literals containing OPENROUTER_API_KEY',
    projectName: 'pi-mono',
    expectedRoute: 'exact_text',
    mustContain: ['Literal', 'OPENROUTER_API_KEY'],
  },
  {
    id: 'raw-docs-text-search',
    question: 'Search every README and package-lock for @mariozechner/pi-coding-agent',
    projectName: 'pi-mono',
    expectedRoute: 'grep_recommended',
    notes: 'Exhaustive docs/package-lock raw text search should recommend ripgrep.',
  },
  {
    id: 'oauth-refresh-concept',
    question: 'Find code that refreshes OAuth tokens',
    projectName: 'pi-mono',
    expectedRoute: 'semantic',
    notes: 'Fuzzy concept query should route to semantic search.',
  },
  {
    id: 'scalar-in-trap',
    question: 'Find methods whose name contains create',
    projectName: 'pi-mono',
    expectedRoute: 'graph',
    mustContain: ['Method', 'name'],
    mustNotContain: [' IN ', 'ANY('],
  },
];
