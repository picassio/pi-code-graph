import { describe, expect, it } from 'vitest';
import type { AxChatRequest } from '@ax-llm/ax';
import { PiAxAIService, convertAxPromptToChatMessages } from '../src/lib/ax/pi-ax-ai-service.js';
import { LLMClient, type ChatMessage, type LLMConfig, type LLMResponse } from '../src/lib/llm-service.js';

class FakeLLMClient extends LLMClient {
  calls: ChatMessage[][] = [];

  constructor(config: LLMConfig) {
    super(config);
  }

  async chat(messages: ChatMessage[]): Promise<LLMResponse> {
    this.calls.push(messages);
    return {
      content: 'cypher: MATCH (n) RETURN n.name AS name LIMIT 1',
      model: 'fake-model',
      usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
    };
  }
}

const config: LLMConfig = {
  provider: 'openrouter',
  model: 'fake-model',
  apiKey: 'not-used',
};

describe('PiAxAIService', () => {
  it('converts Ax text prompts to pi-code-graph ChatMessage objects', () => {
    const messages = convertAxPromptToChatMessages([
      { role: 'system', content: 'system rules' },
      { role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }] },
      { role: 'assistant', content: 'previous answer' },
    ]);

    expect(messages).toEqual([
      { role: 'system', content: 'system rules' },
      { role: 'user', content: 'hello\nworld' },
      { role: 'assistant', content: 'previous answer' },
    ]);
  });

  it('rejects non-text Ax prompt content instead of silently degrading provider behavior', () => {
    expect(() => convertAxPromptToChatMessages([
      {
        role: 'user',
        content: [{ type: 'image', mimeType: 'image/png', image: 'base64' }],
      },
    ])).toThrow(/only supports text/);
  });

  it('routes chat through the provided LLMClient and maps usage back to Ax response shape', async () => {
    const fake = new FakeLLMClient(config);
    const service = new PiAxAIService(config, fake);

    const req: AxChatRequest<string> = {
      chatPrompt: [
        { role: 'system', content: 'rules' },
        { role: 'user', content: 'question' },
      ],
      model: 'fake-model',
    };

    const response = await service.chat(req);

    expect(fake.calls).toEqual([[
      { role: 'system', content: 'rules' },
      { role: 'user', content: 'question' },
    ]]);
    expect(response.results[0]?.content).toContain('MATCH');
    expect(response.modelUsage?.tokens?.totalTokens).toBe(7);
    expect(service.getLastUsedChatModel()).toBe('fake-model');
  });

  it('does not support native Ax tools or embeddings in the custom query provider', async () => {
    const service = new PiAxAIService(config, new FakeLLMClient(config));

    await expect(service.chat({
      chatPrompt: [{ role: 'user', content: 'hi' }],
      functions: [{ name: 'tool', description: 'tool' }],
    })).rejects.toThrow(/function calling/);

    await expect(service.embed({ texts: ['hello'] })).rejects.toThrow(/does not implement embeddings/);
  });
});
