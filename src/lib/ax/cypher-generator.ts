import { ax } from '@ax-llm/ax';
import {
  cleanCypherResponse,
  LLMGenerationError,
  LLMConfigurationError,
  validateCypherReadOnly,
  buildGraphSchemaAndRules,
  createLLMClient,
  type CypherGenerationMetadata,
  type CypherGeneratorConfig,
  type CypherGeneratorLike,
  type LLMConfig,
} from '../llm-service.js';
import { CYPHER_DEFAULT_LIMIT, CYPHER_MATCH_KEYWORD } from '../constants.js';
import { PiAxAIService } from './pi-ax-ai-service.js';

interface AxCypherOut {
  cypher: string;
  confidence?: number;
  resultShape?: string;
  caveats?: string;
}

interface AxRepairOut {
  repairedCypher: string;
  explanation?: string;
}

export interface AxCypherGeneratorConfig extends CypherGeneratorConfig {
  maxRepairAttempts?: number;
  ai?: PiAxAIService;
}

const generateCypherProgram = ax(`
  question:string,
  projectName:string,
  graphSchemaAndRules:string,
  defaultLimit:number ->
  cypher:string "A single read-only Cypher MATCH query. Return only Cypher text in this field.",
  confidence:number "0 to 1 confidence in the query",
  resultShape:string "Brief description of returned columns",
  caveats:string "Important caveats, empty string if none"
`);

const repairCypherProgram = ax(`
  question:string,
  invalidCypher:string,
  error:string,
  graphSchemaAndRules:string,
  projectName:string,
  defaultLimit:number ->
  repairedCypher:string "A single corrected read-only Cypher MATCH query. Return only Cypher text in this field.",
  explanation:string "What was fixed"
`);

function toLLMConfig(config: CypherGeneratorConfig): LLMConfig {
  const provider = config.provider || 'openrouter';
  const model = config.model || defaultModel(provider);
  return {
    provider,
    model,
    apiKey: config.apiKey,
    endpoint: config.endpoint,
    headers: config.headers,
    temperature: config.temperature ?? 0.1,
    maxTokens: config.maxTokens ?? 2048,
  };
}

function defaultModel(provider: LLMConfig['provider']): string {
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

function normalizeAxCypher(raw: string): string {
  const query = cleanCypherResponse(raw);
  if (!query.toUpperCase().includes(CYPHER_MATCH_KEYWORD)) {
    throw new LLMGenerationError(`Invalid Ax Cypher response - does not contain MATCH: ${raw}`);
  }
  validateCypherReadOnly(query);
  return query;
}

/**
 * Ax-backed Cypher generator. It always uses PiAxAIService, which wraps the
 * existing pi-code-graph LLMClient stack. There is intentionally no fallback to
 * Ax built-in providers.
 */
export class AxCypherGenerator implements CypherGeneratorLike {
  private readonly ai: PiAxAIService;
  private readonly maxRetries: number;
  private readonly maxRepairAttempts: number;
  private readonly graphSchemaAndRules: string;
  private lastMetadata: CypherGenerationMetadata = { engine: 'ax', repairAttempted: false, repairAttempts: 0 };

  constructor(config: AxCypherGeneratorConfig = {}) {
    this.maxRetries = config.maxRetries ?? 3;
    this.maxRepairAttempts = config.maxRepairAttempts ?? 1;
    this.graphSchemaAndRules = buildGraphSchemaAndRules();

    if (config.ai) {
      this.ai = config.ai;
      return;
    }

    try {
      const llmConfig = toLLMConfig(config);
      this.ai = new PiAxAIService(llmConfig, createLLMClient(llmConfig));
    } catch (error) {
      throw new LLMConfigurationError(
        `Failed to initialize AxCypherGenerator with PiAxAIService: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async generate(naturalLanguageQuery: string, projectName?: string): Promise<string> {
    let lastError: Error | null = null;
    const resolvedProjectName = projectName || 'current-project';

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      let generatedCypher = '';
      try {
        const result = await generateCypherProgram.forward(this.ai, {
          question: naturalLanguageQuery,
          projectName: resolvedProjectName,
          graphSchemaAndRules: this.graphSchemaAndRules,
          defaultLimit: CYPHER_DEFAULT_LIMIT,
        }) as AxCypherOut;

        generatedCypher = result.cypher;
        const query = normalizeAxCypher(generatedCypher);
        this.lastMetadata = {
          engine: 'ax',
          confidence: result.confidence,
          resultShape: result.resultShape,
          caveats: result.caveats,
          repairAttempted: false,
          repairAttempts: 0,
        };
        return query;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const repaired = await this.tryRepair(naturalLanguageQuery, resolvedProjectName, generatedCypher, lastError);
        if (repaired) return repaired;
        if (attempt < this.maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 500));
        }
      }
    }

    throw new LLMGenerationError(
      `Failed to generate Cypher query with Ax after ${this.maxRetries} attempts: ${lastError?.message}`,
    );
  }

  getLastGenerationMetadata(): CypherGenerationMetadata {
    return this.lastMetadata;
  }

  private async tryRepair(
    naturalLanguageQuery: string,
    projectName: string,
    invalidCypher: string,
    error: Error,
  ): Promise<string | null> {
    if (this.maxRepairAttempts <= 0) return null;

    let lastRepairError: Error | null = null;
    for (let attempt = 0; attempt < this.maxRepairAttempts; attempt++) {
      try {
        const result = await repairCypherProgram.forward(this.ai, {
          question: naturalLanguageQuery,
          invalidCypher,
          error: error.message,
          graphSchemaAndRules: this.graphSchemaAndRules,
          projectName,
          defaultLimit: CYPHER_DEFAULT_LIMIT,
        }) as AxRepairOut;
        const query = normalizeAxCypher(result.repairedCypher);
        this.lastMetadata = {
          engine: 'ax',
          repairAttempted: true,
          repairAttempts: attempt + 1,
          caveats: result.explanation,
        };
        return query;
      } catch (repairError) {
        lastRepairError = repairError instanceof Error ? repairError : new Error(String(repairError));
      }
    }

    if (lastRepairError) {
      return null;
    }
    return null;
  }
}

export function createAxCypherGenerator(config?: AxCypherGeneratorConfig): AxCypherGenerator {
  return new AxCypherGenerator(config);
}
