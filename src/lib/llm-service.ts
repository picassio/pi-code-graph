/**
 * LLM Service for Cypher generation
 * Ported from codebase_rag/services/llm.py and codebase_rag/prompts.py
 */

import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  Provider,
  CYPHER_DANGEROUS_KEYWORDS,
  CYPHER_MATCH_KEYWORD,
  CYPHER_SEMICOLON,
  CYPHER_BACKTICK,
  CYPHER_PREFIX,
  CYPHER_DEFAULT_LIMIT,
  NodeLabel,
  RelationshipType,
} from './constants.js';
import {
  CYPHER_EXAMPLE_DECORATED_FUNCTIONS,
  CYPHER_EXAMPLE_CONTENT_BY_PATH,
  CYPHER_EXAMPLE_KEYWORD_SEARCH,
  CYPHER_EXAMPLE_FIND_FILE,
  CYPHER_EXAMPLE_CLASS_METHODS,
  CYPHER_EXAMPLE_README,
  CYPHER_EXAMPLE_PYTHON_FILES,
  CYPHER_EXAMPLE_TASKS,
  CYPHER_EXAMPLE_FILES_IN_FOLDER,
  CYPHER_EXAMPLE_LIMIT_ONE,
} from './cypher-queries.js';
import type { ToolNames, NodeSchema, RelationshipSchema } from './types.js';

// =============================================================================
// Error Types
// =============================================================================

export class LLMGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LLMGenerationError';
  }
}

export class LLMConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LLMConfigurationError';
  }
}

// =============================================================================
// Types
// =============================================================================

export type LLMProvider = 'openai' | 'anthropic' | 'google' | 'openrouter' | 'ollama';

export interface LLMConfig {
  provider: LLMProvider;
  model: string;
  apiKey?: string;
  endpoint?: string;
  headers?: Record<string, string>;  // Custom headers (for OAuth, etc.)
  temperature?: number;
  maxTokens?: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMResponse {
  content: string;
  model: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface PiAuthEntry {
  type: 'oauth' | 'api_key';
  key?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  openrouter_key?: string;
}

export interface PiAuthConfig {
  anthropic?: PiAuthEntry;
  openrouter?: PiAuthEntry;
  'google-antigravity'?: PiAuthEntry;
  google?: PiAuthEntry;
  openai?: PiAuthEntry;
  [key: string]: PiAuthEntry | undefined;
}

// =============================================================================
// Schema Builder
// =============================================================================

/**
 * Node schema definitions for documentation
 */
const NODE_SCHEMAS: NodeSchema[] = [
  { label: NodeLabel.PROJECT, properties: 'name (unique)' },
  { label: NodeLabel.PACKAGE, properties: 'qualified_name (unique), name, path' },
  { label: NodeLabel.FOLDER, properties: 'path (unique), name, absolute_path' },
  { label: NodeLabel.FILE, properties: 'path (unique), name, absolute_path, extension' },
  { label: NodeLabel.MODULE, properties: 'qualified_name (unique), path, name, is_external' },
  { label: NodeLabel.CLASS, properties: 'qualified_name (unique), name, docstring, start_line, end_line' },
  { label: NodeLabel.FUNCTION, properties: 'qualified_name (unique), name, docstring, parameters, decorators, start_line, end_line' },
  { label: NodeLabel.METHOD, properties: 'qualified_name (unique), name, docstring, parameters, decorators, start_line, end_line' },
  { label: NodeLabel.INTERFACE, properties: 'qualified_name (unique), name, start_line, end_line' },
  { label: NodeLabel.ENUM, properties: 'qualified_name (unique), name, start_line, end_line' },
  { label: NodeLabel.TYPE, properties: 'qualified_name (unique), name, start_line, end_line' },
  { label: NodeLabel.EXTERNAL_PACKAGE, properties: 'name (unique), version_spec' },
];

/**
 * Relationship schema definitions for documentation
 */
const RELATIONSHIP_SCHEMAS: RelationshipSchema[] = [
  { sources: [NodeLabel.PROJECT], relType: RelationshipType.CONTAINS_PACKAGE, targets: [NodeLabel.PACKAGE] },
  { sources: [NodeLabel.PROJECT, NodeLabel.FOLDER], relType: RelationshipType.CONTAINS_FOLDER, targets: [NodeLabel.FOLDER] },
  { sources: [NodeLabel.FOLDER], relType: RelationshipType.CONTAINS_FILE, targets: [NodeLabel.FILE] },
  { sources: [NodeLabel.FILE], relType: RelationshipType.CONTAINS_MODULE, targets: [NodeLabel.MODULE] },
  { sources: [NodeLabel.MODULE], relType: RelationshipType.DEFINES, targets: [NodeLabel.CLASS, NodeLabel.FUNCTION, NodeLabel.INTERFACE, NodeLabel.ENUM, NodeLabel.TYPE] },
  { sources: [NodeLabel.CLASS], relType: RelationshipType.DEFINES_METHOD, targets: [NodeLabel.METHOD] },
  { sources: [NodeLabel.MODULE], relType: RelationshipType.IMPORTS, targets: [NodeLabel.MODULE, NodeLabel.CLASS, NodeLabel.FUNCTION] },
  { sources: [NodeLabel.MODULE], relType: RelationshipType.EXPORTS, targets: [NodeLabel.CLASS, NodeLabel.FUNCTION, NodeLabel.INTERFACE, NodeLabel.ENUM, NodeLabel.TYPE] },
  { sources: [NodeLabel.CLASS], relType: RelationshipType.INHERITS, targets: [NodeLabel.CLASS] },
  { sources: [NodeLabel.CLASS], relType: RelationshipType.IMPLEMENTS, targets: [NodeLabel.INTERFACE] },
  { sources: [NodeLabel.METHOD], relType: RelationshipType.OVERRIDES, targets: [NodeLabel.METHOD] },
  { sources: [NodeLabel.FUNCTION, NodeLabel.METHOD], relType: RelationshipType.CALLS, targets: [NodeLabel.FUNCTION, NodeLabel.METHOD] },
  { sources: [NodeLabel.MODULE], relType: RelationshipType.DEPENDS_ON_EXTERNAL, targets: [NodeLabel.EXTERNAL_PACKAGE] },
];

function formatNodeSchema(schema: NodeSchema): string {
  return `- ${schema.label}: ${schema.properties}`;
}

function formatRelationshipSchema(schema: RelationshipSchema): string {
  const sources = schema.sources.length > 1 ? `(${schema.sources.join('|')})` : schema.sources[0];
  const targets = schema.targets.length > 1 ? `(${schema.targets.join('|')})` : schema.targets[0];
  return `- ${sources} -[:${schema.relType}]-> ${targets}`;
}

function buildNodeLabelsSection(): string {
  const lines = ['Node Labels and Their Key Properties:'];
  lines.push(...NODE_SCHEMAS.map(formatNodeSchema));
  return lines.join('\n');
}

function buildRelationshipsSection(): string {
  const lines = ['Relationships (source)-[REL_TYPE]->(target):'];
  lines.push(...RELATIONSHIP_SCHEMAS.map(formatRelationshipSchema));
  return lines.join('\n');
}

export function buildGraphSchemaText(): string {
  return `${buildNodeLabelsSection()}\n\n${buildRelationshipsSection()}`;
}

export const GRAPH_SCHEMA_DEFINITION = buildGraphSchemaText();

// =============================================================================
// Prompt Templates
// =============================================================================

const CYPHER_QUERY_RULES = `**2. Critical Cypher Query Rules**

- **ALWAYS Return Specific Properties with Aliases**: Do NOT return whole nodes (e.g., \`RETURN n\`). You MUST return specific properties with clear aliases (e.g., \`RETURN n.name AS name\`).
- **Use \`STARTS WITH\` for Paths**: When matching paths, always use \`STARTS WITH\` for robustness (e.g., \`WHERE n.path STARTS WITH 'workflows/src'\`). Do not use \`=\`.
- **Use \`ENDS WITH\` for qualified_name**: The \`qualified_name\` property contains full paths like \`'Project.folder.subfolder.ClassName'\`. When users mention a class, function, or method by its short name (e.g., "VatManager"), use \`ENDS WITH\` to match: \`WHERE c.qualified_name ENDS WITH '.VatManager'\`. Do NOT use \`{name: 'VatManager'}\` equality matching.
- **Use \`toLower()\` for Searches**: For case-insensitive searching on string properties, use \`toLower()\`.
- **Querying Lists**: To check if a list property (like \`decorators\`) contains an item, use the \`ANY\` or \`IN\` clause (e.g., \`WHERE 'flow' IN n.decorators\`).`;

export function buildGraphSchemaAndRules(): string {
  return `You are an expert AI assistant for analyzing codebases using a **hybrid retrieval system**: a **Memgraph knowledge graph** for structural queries and a **semantic code search engine** for intent-based discovery.

**1. Graph Schema Definition**
The database contains information about a codebase, structured with the following nodes and relationships.

${GRAPH_SCHEMA_DEFINITION}

${CYPHER_QUERY_RULES}
`;
}

export const GRAPH_SCHEMA_AND_RULES = buildGraphSchemaAndRules();

/**
 * System prompt for capable models (OpenAI, Anthropic, Google)
 */
export const CYPHER_SYSTEM_PROMPT = `
You are an expert translator that converts natural language questions about code structure into precise Neo4j Cypher queries.

${GRAPH_SCHEMA_AND_RULES}

**3. Query Optimization Rules**

- **LIMIT Results**: ALWAYS add \`LIMIT ${CYPHER_DEFAULT_LIMIT}\` to queries that list items. This prevents overwhelming responses.
- **Aggregation Queries**: When asked "how many", "count", or "total", return ONLY the count, not all items:
  - CORRECT: \`MATCH (c:Class) RETURN count(c) AS total\`
  - WRONG: \`MATCH (c:Class) RETURN c.name, c.path, count(c) AS total\` (returns all items!)
- **List vs Count**: If asked to "list" or "show", return items with LIMIT. If asked to "count" or "how many", return only the count.

**4. Query Patterns & Examples**
When listing items, return the \`name\`, \`path\`, and \`qualified_name\` with a LIMIT.

**Pattern: Counting Items**
cypher// "How many classes are there?" or "Count all functions"
MATCH (c:Class) RETURN count(c) AS total

**Pattern: Finding Decorated Functions/Methods (e.g., Workflows, Tasks)**
cypher// "Find all prefect flows" or "what are the workflows?" or "show me the tasks"
// Use the 'IN' operator to check the 'decorators' list property.
${CYPHER_EXAMPLE_DECORATED_FUNCTIONS}

**Pattern: Finding Content by Path (Robustly)**
cypher// "what is in the 'workflows/src' directory?" or "list files in workflows"
// Use \`STARTS WITH\` for path matching.
${CYPHER_EXAMPLE_CONTENT_BY_PATH}

**Pattern: Keyword & Concept Search (Fallback for general terms)**
cypher// "find things related to 'database'"
${CYPHER_EXAMPLE_KEYWORD_SEARCH}

**Pattern: Finding a Specific File**
cypher// "Find the main README.md"
${CYPHER_EXAMPLE_FIND_FILE}

**Pattern: Finding Methods of a Class by Short Name**
cypher// "What methods does UserService have?" or "Show me methods in UserService" or "List UserService methods"
// Use \`ENDS WITH\` to match the class by short name since qualified_name contains full path.
${CYPHER_EXAMPLE_CLASS_METHODS}

**4. Output Format**
Provide only the Cypher query.
`;

/**
 * Stricter prompt for less capable or local models (e.g., Ollama)
 */
export const LOCAL_CYPHER_SYSTEM_PROMPT = `
You are a Neo4j Cypher query generator. You ONLY respond with a valid Cypher query. Do not add explanations or markdown.

${GRAPH_SCHEMA_AND_RULES}

**CRITICAL RULES FOR QUERY GENERATION:**
1.  **NO \`UNION\`**: Never use the \`UNION\` clause. Generate a single, simple \`MATCH\` query.
2.  **BIND and ALIAS**: You must bind every node you use to a variable (e.g., \`MATCH (f:File)\`). You must use that variable to access properties and alias every returned property (e.g., \`RETURN f.path AS path\`).
3.  **RETURN STRUCTURE**: Your query should aim to return \`name\`, \`path\`, and \`qualified_name\` so the calling system can use the results.
    - For \`File\` nodes, return \`f.path AS path\`.
    - For code nodes (\`Class\`, \`Function\`, etc.), return \`n.qualified_name AS qualified_name\`.
4.  **KEEP IT SIMPLE**: Do not try to be clever. A simple query that returns a few relevant nodes is better than a complex one that fails.
5.  **CLAUSE ORDER**: You MUST follow the standard Cypher clause order: \`MATCH\`, \`WHERE\`, \`RETURN\`, \`LIMIT\`.
6.  **ALWAYS ADD LIMIT**: For queries that list items, ALWAYS add \`LIMIT ${CYPHER_DEFAULT_LIMIT}\` to prevent overwhelming responses.
7.  **AGGREGATION QUERIES**: When asked "how many" or "count", return ONLY the count:
    - CORRECT: \`MATCH (c:Class) RETURN count(c) AS total\`
    - WRONG: \`MATCH (c:Class) RETURN c.name, count(c) AS total\` (returns all items!)

**VALUE PATTERN RULES (CRITICAL FOR NAME MATCHING):**
- The \`qualified_name\` property contains FULL paths like: \`'Project.folder.subfolder.ClassName'\`
- When users mention a class or function by SHORT NAME (e.g., "VatManager", "UserService"), you MUST match using the \`name\` property, NOT \`qualified_name\`.
- CORRECT: \`WHERE c.name = 'VatManager'\`
- WRONG: \`WHERE c.qualified_name = 'VatManager'\` (will never match!)
- Use \`DEFINES_METHOD\` relationship to find methods of a class.
- Use \`DEFINES\` relationship to find functions/classes defined in a module.

**Examples:**

*   **Natural Language:** "How many classes are there?"
*   **Cypher Query:**
    \`\`\`cypher
    MATCH (c:Class) RETURN count(c) AS total
    \`\`\`

*   **Natural Language:** "Find the main README file"
*   **Cypher Query:**
    \`\`\`cypher
    ${CYPHER_EXAMPLE_README}
    \`\`\`

*   **Natural Language:** "Find all python files"
*   **Cypher Query (Note the '.' in extension):**
    \`\`\`cypher
    ${CYPHER_EXAMPLE_PYTHON_FILES}
    \`\`\`

*   **Natural Language:** "show me the tasks"
*   **Cypher Query:**
    \`\`\`cypher
    ${CYPHER_EXAMPLE_TASKS}
    \`\`\`

*   **Natural Language:** "list files in the services folder"
*   **Cypher Query:**
    \`\`\`cypher
    ${CYPHER_EXAMPLE_FILES_IN_FOLDER}
    \`\`\`

*   **Natural Language:** "Find just one file to test"
*   **Cypher Query:**
    \`\`\`cypher
    ${CYPHER_EXAMPLE_LIMIT_ONE}
    \`\`\`

*   **Natural Language:** "What methods does UserService have?" or "Show me methods in UserService" or "List UserService methods"
*   **Cypher Query (Note: match by \`name\` property, use \`DEFINES_METHOD\` relationship):**
    \`\`\`cypher
    ${CYPHER_EXAMPLE_CLASS_METHODS}
    \`\`\`
`;

/**
 * Build RAG orchestrator prompt with tool names
 */
export function buildRAGOrchestratorPrompt(toolNames: ToolNames): string {
  const t = toolNames;
  return `You are an expert AI assistant for analyzing codebases. Your answers are based **EXCLUSIVELY** on information retrieved using your tools.

**CRITICAL RULES:**
1.  **TOOL-ONLY ANSWERS**: You must ONLY use information from the tools provided. Do not use external knowledge.
2.  **NATURAL LANGUAGE QUERIES**: When using the \`${t.queryGraph}\` tool, ALWAYS use natural language questions. NEVER write Cypher queries directly - the tool will translate your natural language into the appropriate database query.
3.  **HONESTY**: If a tool fails or returns no results, you MUST state that clearly and report any error messages. Do not invent answers.
4.  **CHOOSE THE RIGHT TOOL FOR THE FILE TYPE**:
    - For source code files (.py, .ts, etc.), use \`${t.readFile}\`.
    - For documents like PDFs, use the \`${t.analyzeDocument}\` tool. This is more effective than trying to read them as plain text.

**Your General Approach:**
1.  **Analyze Documents**: If the user asks a question about a document (like a PDF), you **MUST** use the \`${t.analyzeDocument}\` tool. Provide both the \`file_path\` and the user's \`question\` to the tool.
2.  **Deep Dive into Code**: When you identify a relevant component (e.g., a folder), you must go beyond documentation.
    a. First, check if documentation files like \`README.md\` exist and read them for context.
    b. **Then, you MUST dive into the source code.** Explore the \`src\` directory (or equivalent). Identify and read key files.
    c. Synthesize all this information to provide a comprehensive, factual answer.
    d. Only ask for clarification if, after a thorough investigation, the user's intent is still unclear.
3.  **Choose the Right Search Strategy - SEMANTIC FIRST for Intent**:
    a. **WHEN TO USE SEMANTIC SEARCH FIRST**: Always start with \`${t.semanticSearch}\` for intent-based queries.
    b. **WHEN TO USE GRAPH DIRECTLY**: Only use \`${t.queryGraph}\` directly for pure structural queries.
    c. **HYBRID APPROACH (RECOMMENDED)**: For most queries, use this sequence:
       1. Use \`${t.semanticSearch}\` to find relevant code elements by intent/meaning
       2. Then use \`${t.queryGraph}\` to explore structural relationships
       3. **CRITICAL**: Always read the actual files using \`${t.readFile}\` to examine source code
4.  **Plan Before Writing or Modifying**:
    a. Before using \`${t.createFile}\`, \`${t.editFile}\`, or modifying files, you MUST explore the codebase first.
    b. For shell commands: If \`${t.shellCommand}\` returns a confirmation message, relay it to the user.
5.  **Token Management**: Be efficient with context usage.
6.  **Synthesize Answer**: Analyze and explain the retrieved content. Cite your sources (file paths or qualified names).
`;
}

// =============================================================================
// Auth System Integration
// =============================================================================

/**
 * Read pi's auth.json file for API keys
 */
function readPiAuthConfig(): PiAuthConfig | null {
  const authPath = join(homedir(), '.pi', 'agent', 'auth.json');
  if (!existsSync(authPath)) {
    return null;
  }
  try {
    const content = readFileSync(authPath, 'utf-8');
    return JSON.parse(content) as PiAuthConfig;
  } catch {
    return null;
  }
}

/**
 * Get API key for a provider from pi's auth system
 */
export function getApiKeyFromPiAuth(provider: LLMProvider): string | null {
  const auth = readPiAuthConfig();
  if (!auth) return null;

  switch (provider) {
    case 'anthropic': {
      const entry = auth.anthropic;
      if (entry?.type === 'oauth' && entry.access) {
        return entry.access;
      }
      if (entry?.type === 'api_key' && entry.key) {
        return entry.key;
      }
      return null;
    }
    case 'openai': {
      const entry = auth.openai;
      if (entry?.type === 'api_key' && entry.key) {
        return entry.key;
      }
      return null;
    }
    case 'openrouter': {
      const entry = auth.openrouter;
      if (entry?.type === 'api_key') {
        return entry.openrouter_key || entry.key || null;
      }
      return null;
    }
    case 'google': {
      // Try google-antigravity first, then google
      const entry = auth['google-antigravity'] || auth.google;
      if (entry?.type === 'oauth' && entry.access) {
        return entry.access;
      }
      if (entry?.type === 'api_key' && entry.key) {
        return entry.key;
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Get API key from environment variable
 */
function getApiKeyFromEnv(provider: LLMProvider): string | null {
  switch (provider) {
    case 'anthropic':
      return process.env.ANTHROPIC_API_KEY || null;
    case 'openai':
      return process.env.OPENAI_API_KEY || null;
    case 'openrouter':
      return process.env.OPENROUTER_API_KEY || null;
    case 'google':
      return process.env.GOOGLE_API_KEY || null;
    case 'ollama':
      return 'ollama'; // No API key needed
    default:
      return null;
  }
}

/**
 * Resolve API key from multiple sources
 */
export function resolveApiKey(provider: LLMProvider, explicitKey?: string): string | null {
  // Explicit key takes precedence
  if (explicitKey && explicitKey !== 'ollama') {
    return explicitKey;
  }

  // Then try environment variables
  const envKey = getApiKeyFromEnv(provider);
  if (envKey) {
    return envKey;
  }

  // Finally try pi's auth system
  return getApiKeyFromPiAuth(provider);
}

// =============================================================================
// LLM Client
// =============================================================================

/**
 * Base class for LLM clients
 */
abstract class LLMClient {
  protected config: LLMConfig;

  constructor(config: LLMConfig) {
    this.config = config;
  }

  abstract chat(messages: ChatMessage[]): Promise<LLMResponse>;
}

/**
 * OpenAI-compatible client (works with OpenAI, OpenRouter, Ollama)
 */
class OpenAICompatibleClient extends LLMClient {
  private endpoint: string;
  private apiKey: string;
  private headers: Record<string, string>;

  constructor(config: LLMConfig) {
    super(config);

    // Set endpoint based on provider
    switch (config.provider) {
      case 'openai':
        this.endpoint = config.endpoint || 'https://api.openai.com/v1';
        break;
      case 'openrouter':
        this.endpoint = config.endpoint || 'https://openrouter.ai/api/v1';
        break;
      case 'ollama':
        this.endpoint = config.endpoint || 'http://localhost:11434/v1';
        break;
      default:
        this.endpoint = config.endpoint || 'https://api.openai.com/v1';
    }

    const apiKey = resolveApiKey(config.provider, config.apiKey);
    if (!apiKey && config.provider !== 'ollama') {
      throw new LLMConfigurationError(`No API key found for provider: ${config.provider}`);
    }
    this.apiKey = apiKey || 'ollama';

    this.headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
      // Merge any custom headers (e.g., from OAuth)
      ...(config.headers || {}),
    };

    // OpenRouter requires additional headers
    if (config.provider === 'openrouter') {
      this.headers['HTTP-Referer'] = 'https://github.com/anthropics/pi-code-graph';
      this.headers['X-Title'] = 'pi-code-graph';
    }
  }

  async chat(messages: ChatMessage[]): Promise<LLMResponse> {
    const url = `${this.endpoint}/chat/completions`;

    const body = {
      model: this.config.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: this.config.temperature ?? 0.1,
      max_tokens: this.config.maxTokens ?? 2048,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new LLMGenerationError(`API request failed: ${response.status} - ${error}`);
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
      model: string;
      usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      };
    };

    return {
      content: data.choices[0]?.message?.content || '',
      model: data.model,
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
            totalTokens: data.usage.total_tokens,
          }
        : undefined,
    };
  }
}

/**
 * Anthropic client
 */
class AnthropicClient extends LLMClient {
  private apiKey: string;
  private endpoint: string;
  private headers: Record<string, string>;

  constructor(config: LLMConfig) {
    super(config);

    const apiKey = resolveApiKey(config.provider, config.apiKey);
    if (!apiKey) {
      throw new LLMConfigurationError('No API key found for Anthropic');
    }
    this.apiKey = apiKey;
    this.endpoint = config.endpoint || 'https://api.anthropic.com/v1';

    // Build headers, merging any custom headers (e.g., from OAuth)
    this.headers = {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
      ...(config.headers || {}),
    };
  }

  async chat(messages: ChatMessage[]): Promise<LLMResponse> {
    const url = `${this.endpoint}/messages`;

    // Anthropic uses a different format - extract system message
    const systemMessage = messages.find((m) => m.role === 'system');
    const chatMessages = messages.filter((m) => m.role !== 'system');

    const body: Record<string, unknown> = {
      model: this.config.model,
      max_tokens: this.config.maxTokens ?? 2048,
      messages: chatMessages.map((m) => ({ role: m.role, content: m.content })),
    };

    if (systemMessage) {
      body.system = systemMessage.content;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new LLMGenerationError(`Anthropic API request failed: ${response.status} - ${error}`);
    }

    const data = (await response.json()) as {
      content: Array<{ text: string }>;
      model: string;
      usage?: {
        input_tokens: number;
        output_tokens: number;
      };
    };

    return {
      content: data.content[0]?.text || '',
      model: data.model,
      usage: data.usage
        ? {
            promptTokens: data.usage.input_tokens,
            completionTokens: data.usage.output_tokens,
            totalTokens: data.usage.input_tokens + data.usage.output_tokens,
          }
        : undefined,
    };
  }
}

/**
 * Google Gemini client
 */
class GoogleClient extends LLMClient {
  private apiKey: string;
  private endpoint: string;

  constructor(config: LLMConfig) {
    super(config);

    const apiKey = resolveApiKey(config.provider, config.apiKey);
    if (!apiKey) {
      throw new LLMConfigurationError('No API key found for Google');
    }
    this.apiKey = apiKey;
    this.endpoint = config.endpoint || 'https://generativelanguage.googleapis.com/v1beta';
  }

  async chat(messages: ChatMessage[]): Promise<LLMResponse> {
    // Gemini uses a different format
    const model = this.config.model;
    const url = `${this.endpoint}/models/${model}:generateContent?key=${this.apiKey}`;

    // Convert messages to Gemini format
    const systemMessage = messages.find((m) => m.role === 'system');
    const chatMessages = messages.filter((m) => m.role !== 'system');

    const contents = chatMessages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature: this.config.temperature ?? 0.1,
        maxOutputTokens: this.config.maxTokens ?? 2048,
      },
    };

    if (systemMessage) {
      body.systemInstruction = { parts: [{ text: systemMessage.content }] };
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new LLMGenerationError(`Google API request failed: ${response.status} - ${error}`);
    }

    const data = (await response.json()) as {
      candidates: Array<{
        content: {
          parts: Array<{ text: string }>;
        };
      }>;
      modelVersion?: string;
      usageMetadata?: {
        promptTokenCount: number;
        candidatesTokenCount: number;
        totalTokenCount: number;
      };
    };

    return {
      content: data.candidates[0]?.content?.parts[0]?.text || '',
      model: data.modelVersion || model,
      usage: data.usageMetadata
        ? {
            promptTokens: data.usageMetadata.promptTokenCount,
            completionTokens: data.usageMetadata.candidatesTokenCount,
            totalTokens: data.usageMetadata.totalTokenCount,
          }
        : undefined,
    };
  }
}

/**
 * Create LLM client based on provider
 */
function createLLMClient(config: LLMConfig): LLMClient {
  switch (config.provider) {
    case 'openai':
    case 'openrouter':
    case 'ollama':
      return new OpenAICompatibleClient(config);
    case 'anthropic':
      return new AnthropicClient(config);
    case 'google':
      return new GoogleClient(config);
    default:
      throw new LLMConfigurationError(`Unknown provider: ${config.provider}`);
  }
}

// =============================================================================
// Cypher Response Cleaning & Validation
// =============================================================================

/**
 * Clean LLM response to extract pure Cypher query.
 * Handles markdown formatting that models sometimes output.
 */
export function cleanCypherResponse(responseText: string): string {
  let query = responseText.trim();

  // Handle empty input
  if (!query) {
    return '';
  }

  // Extract content from code blocks (```cypher ... ``` or ``` ... ```)
  if (query.includes('```')) {
    const parts = query.split('```');
    if (parts.length >= 3) {
      let block = parts[1];
      if (block.toLowerCase().startsWith('cypher')) {
        block = block.slice('cypher'.length);
      }
      query = block.trim();
    }
  } else {
    // Remove markdown bold/headers (e.g., **Cypher Query:**)
    while (query.includes('**')) {
      const start = query.indexOf('**');
      const end = query.indexOf('**', start + 2);
      if (end === -1) break;

      let after = end + 2;
      if (after < query.length && query[after] === ':') {
        after += 1;
      }
      query = query.slice(0, start) + query.slice(after).trimStart();
    }

    // Remove single backticks
    query = query.replaceAll(CYPHER_BACKTICK, '');

    // Remove "cypher" prefix if present
    if (query.toLowerCase().startsWith(CYPHER_PREFIX)) {
      query = query.slice(CYPHER_PREFIX.length).trim();
    }
  }

  // Ensure query ends with semicolon
  if (!query.endsWith(CYPHER_SEMICOLON)) {
    query += CYPHER_SEMICOLON;
  }

  return query;
}

/**
 * Build regex pattern for keyword matching (handles comments/whitespace)
 */
function buildKeywordPattern(keyword: string): RegExp {
  const parts = keyword.split(/\s+/);
  if (parts.length === 1) {
    return new RegExp(`\\b${escapeRegex(parts[0])}\\b`, 'i');
  }
  const commentOrWs = '(?:\\s|//[^\\n]*|/\\*.*?\\*/)+';
  const joined = parts.map(escapeRegex).join(commentOrWs);
  return new RegExp(`\\b${joined}\\b`, 'is');
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Pre-build dangerous patterns
const CYPHER_DANGEROUS_PATTERNS = Array.from(CYPHER_DANGEROUS_KEYWORDS).map((kw) => ({
  keyword: kw,
  pattern: buildKeywordPattern(kw),
}));

/**
 * Validate that a Cypher query is read-only (no mutations)
 */
export function validateCypherReadOnly(query: string): void {
  const upperQuery = query.toUpperCase();

  for (const { keyword, pattern } of CYPHER_DANGEROUS_PATTERNS) {
    if (pattern.test(upperQuery)) {
      throw new LLMGenerationError(
        `Dangerous Cypher operation detected: "${keyword}" in query: ${query}`
      );
    }
  }
}

// =============================================================================
// CypherGenerator Class
// =============================================================================

export interface CypherGeneratorConfig {
  provider?: LLMProvider;
  model?: string;
  apiKey?: string;
  endpoint?: string;
  headers?: Record<string, string>;  // Custom headers (for OAuth, etc.)
  temperature?: number;
  maxTokens?: number;
  maxRetries?: number;
  useLocalPrompt?: boolean;
}

/**
 * CypherGenerator class - converts natural language to Cypher queries
 */
export class CypherGenerator {
  private client: LLMClient;
  private systemPrompt: string;
  private maxRetries: number;

  constructor(config: CypherGeneratorConfig = {}) {
    const provider = config.provider || 'openrouter';
    const model = config.model || this.getDefaultModel(provider);

    // Use local prompt for Ollama or when explicitly requested
    const useLocalPrompt = config.useLocalPrompt ?? provider === 'ollama';
    this.systemPrompt = useLocalPrompt ? LOCAL_CYPHER_SYSTEM_PROMPT : CYPHER_SYSTEM_PROMPT;
    this.maxRetries = config.maxRetries ?? 3;

    try {
      this.client = createLLMClient({
        provider,
        model,
        apiKey: config.apiKey,
        endpoint: config.endpoint,
        headers: config.headers,
        temperature: config.temperature ?? 0.1,
        maxTokens: config.maxTokens ?? 2048,
      });
    } catch (error) {
      throw new LLMConfigurationError(
        `Failed to initialize CypherGenerator: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private getDefaultModel(provider: LLMProvider): string {
    switch (provider) {
      case 'openai':
        return 'gpt-4o-mini';
      case 'anthropic':
        return 'claude-3-5-sonnet-20241022';
      case 'google':
        return 'gemini-1.5-flash';
      case 'openrouter':
        return 'anthropic/claude-3.5-sonnet';
      case 'ollama':
        return 'llama3.2';
      default:
        return 'gpt-4o-mini';
    }
  }

  /**
   * Generate a Cypher query from natural language
   * @param naturalLanguageQuery The natural language question
   * @param projectName Optional project name to include in context
   */
  async generate(naturalLanguageQuery: string, projectName?: string): Promise<string> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const userContent = projectName
          ? `Project: ${projectName}\n\nQuery: ${naturalLanguageQuery}`
          : naturalLanguageQuery;

        const messages: ChatMessage[] = [
          { role: 'system', content: this.systemPrompt },
          { role: 'user', content: userContent },
        ];

        const response = await this.client.chat(messages);

        if (!response.content || !response.content.toUpperCase().includes(CYPHER_MATCH_KEYWORD)) {
          throw new LLMGenerationError(
            `Invalid Cypher response - does not contain MATCH: ${response.content}`
          );
        }

        const query = cleanCypherResponse(response.content);
        validateCypherReadOnly(query);

        return query;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < this.maxRetries - 1) {
          // Wait before retry with exponential backoff
          await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 500));
        }
      }
    }

    throw new LLMGenerationError(
      `Failed to generate Cypher query after ${this.maxRetries} attempts: ${lastError?.message}`
    );
  }

  /**
   * Generate with context (e.g., previous results, schema info)
   */
  async generateWithContext(
    naturalLanguageQuery: string,
    context: string
  ): Promise<string> {
    const contextMessage = `Context from previous operations:\n${context}\n\nUser query: ${naturalLanguageQuery}`;
    return this.generate(contextMessage);
  }
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create a CypherGenerator with auto-detected configuration
 */
export function createCypherGenerator(config?: CypherGeneratorConfig): CypherGenerator {
  return new CypherGenerator(config);
}

/**
 * Detect available providers based on API keys
 */
export function detectAvailableProviders(): LLMProvider[] {
  const providers: LLMProvider[] = [];

  if (resolveApiKey('anthropic')) providers.push('anthropic');
  if (resolveApiKey('openai')) providers.push('openai');
  if (resolveApiKey('openrouter')) providers.push('openrouter');
  if (resolveApiKey('google')) providers.push('google');

  // Ollama is always potentially available (no auth needed)
  providers.push('ollama');

  return providers;
}

/**
 * Get the best available provider (preference order)
 */
export function getBestAvailableProvider(): LLMProvider | null {
  const preferenceOrder: LLMProvider[] = ['openrouter', 'google', 'openai', 'anthropic', 'ollama'];

  for (const provider of preferenceOrder) {
    if (provider === 'ollama') {
      return provider; // Always available as fallback
    }
    if (resolveApiKey(provider)) {
      return provider;
    }
  }

  return 'ollama';
}

// =============================================================================
// Re-exports
// =============================================================================

export {
  GRAPH_SCHEMA_DEFINITION as graphSchemaDefinition,
  CYPHER_SYSTEM_PROMPT as cypherSystemPrompt,
  LOCAL_CYPHER_SYSTEM_PROMPT as localCypherSystemPrompt,
};
