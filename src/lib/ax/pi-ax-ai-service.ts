import type {
  AxAIFeatures,
  AxAIModelList,
  AxAIService,
  AxAIServiceMetrics,
  AxAIServiceOptions,
  AxChatRequest,
  AxChatResponse,
  AxEmbedRequest,
  AxEmbedResponse,
  AxLoggerFunction,
  AxModelConfig,
} from '@ax-llm/ax';
import {
  createLLMClient,
  LLMConfigurationError,
  type ChatMessage,
  type LLMClient,
  type LLMConfig,
} from '../llm-service.js';

const UNSUPPORTED_CONTENT_MESSAGE =
  'PiAxAIService only supports text chat prompts for pi-code-graph query generation';

const TEXT_ONLY_FEATURES: AxAIFeatures = {
  functions: false,
  streaming: false,
  structuredOutputs: false,
  media: {
    images: { supported: false, formats: [] },
    audio: { supported: false, formats: [] },
    files: { supported: false, formats: [], uploadMethod: 'none' },
    urls: { supported: false, webSearch: false, contextFetching: false },
  },
  caching: { supported: false, types: [] },
  thinking: false,
  multiTurn: true,
};

function emptyMetrics(): AxAIServiceMetrics {
  return {
    latency: {
      chat: { mean: 0, p95: 0, p99: 0, samples: [] },
      embed: { mean: 0, p95: 0, p99: 0, samples: [] },
    },
    errors: {
      chat: { count: 0, rate: 0, total: 0 },
      embed: { count: 0, rate: 0, total: 0 },
    },
  };
}

function mergeTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      parts.push(part.text);
      continue;
    }
    if ('extractedText' in part && typeof part.extractedText === 'string') {
      parts.push(part.extractedText);
      continue;
    }
    if ('cachedContent' in part && typeof part.cachedContent === 'string') {
      parts.push(part.cachedContent);
      continue;
    }
    throw new LLMConfigurationError(UNSUPPORTED_CONTENT_MESSAGE);
  }
  return parts.join('\n');
}

export function convertAxPromptToChatMessages(
  chatPrompt: AxChatRequest['chatPrompt'],
): ChatMessage[] {
  const messages: ChatMessage[] = [];

  for (const item of chatPrompt) {
    if (item.role === 'system') {
      messages.push({ role: 'system', content: item.content });
      continue;
    }
    if (item.role === 'user') {
      messages.push({ role: 'user', content: mergeTextContent(item.content) });
      continue;
    }
    if (item.role === 'assistant') {
      const content = item.content ?? item.functionCalls?.map((call) => JSON.stringify(call)).join('\n') ?? '';
      messages.push({ role: 'assistant', content });
      continue;
    }

    throw new LLMConfigurationError('PiAxAIService does not support Ax function-result messages');
  }

  return messages;
}

export interface PiAxAIServiceOptions {
  client?: LLMClient;
  logger?: AxLoggerFunction;
}

/**
 * Custom Ax AI service that routes all Ax runtime calls through pi-code-graph's
 * existing LLMClient stack. Do not use Ax built-in provider wrappers as a
 * fallback; this adapter preserves Pi/modelRegistry auth, OAuth headers, token
 * refresh behavior, logging rules, and provider semantics.
 */
export class PiAxAIService implements AxAIService<string, string, string> {
  private options: Readonly<AxAIServiceOptions> = {};
  private readonly metrics = emptyMetrics();
  private lastChatModel: string | undefined;
  private lastModelConfig: AxModelConfig | undefined;
  private readonly logger: AxLoggerFunction;

  constructor(
    private readonly config: LLMConfig,
    private readonly client: LLMClient = createLLMClient(config),
    options: PiAxAIServiceOptions = {},
  ) {
    this.logger = options.logger ?? (() => undefined);
  }

  getId(): string {
    return `pi-code-graph:${this.config.provider}:${this.config.model}`;
  }

  getName(): string {
    return 'Pi Code Graph LLM';
  }

  getFeatures(): AxAIFeatures {
    return TEXT_ONLY_FEATURES;
  }

  getModelList(): AxAIModelList<string> {
    return [{ key: this.config.model, description: `${this.config.provider} ${this.config.model}`, model: this.config.model }];
  }

  getMetrics(): AxAIServiceMetrics {
    return this.metrics;
  }

  getLogger(): AxLoggerFunction {
    return this.logger;
  }

  getLastUsedChatModel(): string | undefined {
    return this.lastChatModel;
  }

  getLastUsedEmbedModel(): string | undefined {
    return undefined;
  }

  getLastUsedModelConfig(): AxModelConfig | undefined {
    return this.lastModelConfig;
  }

  async chat(
    req: Readonly<AxChatRequest<string>>,
    _options?: Readonly<AxAIServiceOptions>,
  ): Promise<AxChatResponse> {
    if (req.functions && req.functions.length > 0) {
      throw new LLMConfigurationError('PiAxAIService does not enable Ax function calling for query generation');
    }
    if (req.responseFormat?.type === 'json_schema') {
      // Ax can parse structured text itself; pi-code-graph clients intentionally
      // stay provider-neutral and do not promise native JSON-schema support.
      throw new LLMConfigurationError('PiAxAIService does not support native Ax json_schema responseFormat');
    }

    const start = Date.now();
    const messages = convertAxPromptToChatMessages(req.chatPrompt);
    try {
      const response = await this.client.chat(messages);
      const elapsed = Date.now() - start;
      this.metrics.latency.chat.samples.push(elapsed);
      this.metrics.latency.chat.mean = this.metrics.latency.chat.samples.reduce((a, b) => a + b, 0) / this.metrics.latency.chat.samples.length;
      this.metrics.latency.chat.p95 = elapsed;
      this.metrics.latency.chat.p99 = elapsed;
      this.lastChatModel = response.model || req.model || this.config.model;
      this.lastModelConfig = req.modelConfig ?? {
        temperature: this.config.temperature,
        maxTokens: this.config.maxTokens,
      };

      return {
        results: [{ index: 0, content: response.content, finishReason: 'stop' }],
        modelUsage: response.usage
          ? {
              ai: 'pi-code-graph',
              model: response.model,
              tokens: {
                promptTokens: response.usage.promptTokens,
                completionTokens: response.usage.completionTokens,
                totalTokens: response.usage.totalTokens,
              },
            }
          : undefined,
      };
    } catch (error) {
      this.metrics.errors.chat.count += 1;
      this.metrics.errors.chat.total += 1;
      this.metrics.errors.chat.rate = this.metrics.errors.chat.count / Math.max(1, this.metrics.latency.chat.samples.length + this.metrics.errors.chat.count);
      throw error;
    }
  }

  async embed(_req: Readonly<AxEmbedRequest<string>>, _options?: Readonly<AxAIServiceOptions>): Promise<AxEmbedResponse> {
    this.metrics.errors.embed.count += 1;
    this.metrics.errors.embed.total += 1;
    this.metrics.errors.embed.rate = 1;
    throw new LLMConfigurationError('PiAxAIService does not implement embeddings; use SemanticSearchService instead');
  }

  getEstimatedCost(): number {
    return 0;
  }

  setOptions(options: Readonly<AxAIServiceOptions>): void {
    this.options = options;
  }

  getOptions(): Readonly<AxAIServiceOptions> {
    return this.options;
  }
}

export function createPiAxAIService(config: LLMConfig): PiAxAIService {
  return new PiAxAIService(config);
}
