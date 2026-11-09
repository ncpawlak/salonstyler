import { describe, expect, it, vi } from 'vitest';

import { AiProviderError } from '../http.ts';
import type { ChatResult, LLMProvider } from '../types.ts';
import {
  type AiServiceDeps,
  handleAiRequest,
  type StoredAiConfig,
  type UsageEntry,
} from './handler.ts';

const SALON = '6f1c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f';
const SAVED_KEY = 'sk-saved-key-0123456789abcdef';

function textResult(provider: ChatResult['provider'], model: string): ChatResult {
  return {
    type: 'text',
    text: 'OK',
    toolCalls: [],
    provider,
    model,
    finishReason: 'stop',
    usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
  };
}

function setup(overrides: Partial<AiServiceDeps> & { role?: 'owner' | 'stylist' | null } = {}) {
  const usage: UsageEntry[] = [];
  const created: { provider: string; apiKey: string; model: string }[] = [];
  const config: StoredAiConfig = {
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    apiKey: SAVED_KEY,
    monthlyTokenBudget: 1000,
  };
  const chat = vi.fn<LLMProvider['chat']>();
  const deps: AiServiceDeps = {
    getMemberRole: async () => (overrides.role === undefined ? 'owner' : overrides.role),
    loadConfig: async () => config,
    tokensUsedThisMonth: async () => 0,
    recordUsage: async (entry) => {
      usage.push(entry);
    },
    createProvider: (provider, options) => {
      created.push({ provider, apiKey: options.apiKey, model: options.model });
      chat.mockImplementation(async () => textResult(provider, options.model));
      return { id: provider, model: options.model, chat };
    },
    now: (() => {
      let t = 1000;
      return () => (t += 25);
    })(),
    ...overrides,
  };
  return { deps, usage, created, chat, config };
}

describe('handleAiRequest', () => {
  it('rejects malformed requests', async () => {
    const { deps } = setup();
    const res = await handleAiRequest({ action: 'chat', salonId: 'nope', messages: [] }, deps);
    expect(res.status).toBe(400);
  });

  it('rejects non-members', async () => {
    const { deps } = setup({ role: null });
    const res = await handleAiRequest({ action: 'test', salonId: SALON }, deps);
    expect(res).toMatchObject({ status: 403, body: { error: { code: 'forbidden' } } });
  });

  describe('test action', () => {
    it('is owner-only', async () => {
      const { deps } = setup({ role: 'stylist' });
      const res = await handleAiRequest({ action: 'test', salonId: SALON }, deps);
      expect(res.status).toBe(403);
    });

    it('tests the saved config without returning the key', async () => {
      const { deps, created, usage } = setup();
      const res = await handleAiRequest({ action: 'test', salonId: SALON }, deps);
      expect(res).toEqual({
        status: 200,
        body: { ok: true, provider: 'anthropic', model: 'claude-haiku-4-5', latencyMs: 25 },
      });
      expect(created).toEqual([
        { provider: 'anthropic', apiKey: SAVED_KEY, model: 'claude-haiku-4-5' },
      ]);
      expect(usage[0]).toMatchObject({
        purpose: 'connection_test',
        inputTokens: 10,
        outputTokens: 2,
      });
      expect(JSON.stringify(res)).not.toContain(SAVED_KEY);
    });

    it('tests an unsaved key for a new provider', async () => {
      const { deps, created } = setup();
      const res = await handleAiRequest(
        {
          action: 'test',
          salonId: SALON,
          provider: 'openai',
          model: 'gpt-4.1-mini',
          apiKey: 'sk-new-key-abcdefghijklmnop',
        },
        deps,
      );
      expect(res.status).toBe(200);
      expect(created[0]).toEqual({
        provider: 'openai',
        apiKey: 'sk-new-key-abcdefghijklmnop',
        model: 'gpt-4.1-mini',
      });
    });

    it('never sends the saved key to a different provider', async () => {
      const { deps, created } = setup();
      const res = await handleAiRequest(
        { action: 'test', salonId: SALON, provider: 'gemini', model: 'gemini-2.5-flash' },
        deps,
      );
      expect(res).toMatchObject({ status: 409, body: { error: { code: 'not_configured' } } });
      expect(created).toHaveLength(0);
    });

    it('returns redacted provider errors', async () => {
      const { deps } = setup({
        createProvider: () => ({
          id: 'anthropic',
          model: 'm',
          chat: async () => {
            throw new AiProviderError('anthropic', 'auth', `invalid x-api-key ${SAVED_KEY}`, 401);
          },
        }),
      });
      const res = await handleAiRequest({ action: 'test', salonId: SALON }, deps);
      expect(res).toMatchObject({ status: 502, body: { error: { code: 'provider_auth' } } });
      expect(JSON.stringify(res)).not.toContain(SAVED_KEY);
    });
  });

  describe('chat action', () => {
    const chatBody = {
      action: 'chat',
      salonId: SALON,
      messages: [{ role: 'user', content: 'cut next fri?' }],
      tools: [{ name: 'parse_request', description: 'd', parameters: { type: 'object' } }],
    };

    it('lets stylists chat, meters usage, and reports the running total', async () => {
      const { deps, usage, chat } = setup({
        role: 'stylist',
        tokensUsedThisMonth: async () => 100,
      });
      const res = await handleAiRequest(chatBody, deps);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ usage: { usedThisMonth: 112, monthlyTokenBudget: 1000 } });
      expect(chat).toHaveBeenCalledWith(
        chatBody.messages,
        chatBody.tools,
        expect.objectContaining({ maxOutputTokens: undefined }),
      );
      expect(usage).toEqual([
        {
          salonId: SALON,
          provider: 'anthropic',
          model: 'claude-haiku-4-5',
          purpose: 'chat',
          inputTokens: 10,
          outputTokens: 2,
        },
      ]);
    });

    it('stops at the monthly budget without calling the provider', async () => {
      const { deps, created } = setup({ tokensUsedThisMonth: async () => 1000 });
      const res = await handleAiRequest(chatBody, deps);
      expect(res).toMatchObject({ status: 429, body: { error: { code: 'budget_exceeded' } } });
      expect(created).toHaveLength(0);
    });

    it('requires a saved configuration', async () => {
      const { deps } = setup({ loadConfig: async () => null });
      const res = await handleAiRequest(chatBody, deps);
      expect(res).toMatchObject({ status: 409, body: { error: { code: 'not_configured' } } });
    });

    it('switching providers is just a config change', async () => {
      for (const provider of ['openai', 'anthropic', 'gemini'] as const) {
        const { deps, created } = setup({
          loadConfig: async () => ({
            provider,
            model: `${provider}-model`,
            apiKey: SAVED_KEY,
            monthlyTokenBudget: 10,
          }),
        });
        const res = await handleAiRequest(chatBody, deps);
        expect(res.status).toBe(200);
        expect(created[0]?.provider).toBe(provider);
      }
    });
  });
});
