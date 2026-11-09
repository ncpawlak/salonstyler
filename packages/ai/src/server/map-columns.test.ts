import { describe, expect, it, vi } from 'vitest';

import { columnMappingPrompt, columnMappingTool, readColumnMapping } from '../import/mapping.ts';
import type { ChatResult, LLMProvider } from '../types.ts';
import { type AiServiceDeps, type UsageEntry, handleAiRequest } from './handler.ts';

const SALON = '6f1c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f';
const HEADERS = ['First Name', 'Last Name', 'Cell Phone', 'Email', 'Customer Since'];
const SAMPLES = [['Axxxx'], ['Bxxxxx'], ['(###) ###-####'], ['x***@example.com'], ['##/##/####']];

function toolResult(args: Record<string, unknown>): ChatResult {
  return {
    type: 'tool_calls',
    text: null,
    toolCalls: [{ id: 't1', name: 'set_column_mapping', arguments: args }],
    provider: 'openai',
    model: 'gpt-test',
    finishReason: 'tool_calls',
    usage: { inputTokens: 300, outputTokens: 40, totalTokens: 340 },
  };
}

function setup(reply: ChatResult | null, overrides: Partial<AiServiceDeps> = {}) {
  const usage: UsageEntry[] = [];
  const chat = vi.fn<LLMProvider['chat']>(async () => reply!);
  const deps: AiServiceDeps = {
    getMemberRole: async () => 'stylist',
    loadConfig: async () => ({
      provider: 'openai',
      model: 'gpt-test',
      apiKey: 'sk-test-0123456789abcdefghij',
      monthlyTokenBudget: 100_000,
    }),
    tokensUsedThisMonth: async () => 0,
    recordUsage: async (e) => {
      usage.push(e);
    },
    createProvider: (id, o) => ({ id, model: o.model, chat }),
    ...overrides,
  };
  return { deps, usage, chat };
}

const request = {
  action: 'map_columns',
  salonId: SALON,
  kind: 'clients',
  headers: HEADERS,
  samples: SAMPLES,
};

describe('map_columns', () => {
  it('asks the model with redacted samples and sanitizes its mapping', async () => {
    const { deps, usage, chat } = setup(
      toolResult({
        firstName: 0,
        lastName: 1,
        phone: 2,
        email: 3,
        fullName: -1,
        birthday: 9,
        tags: 2,
      }),
    );
    const res = await handleAiRequest(request, deps);
    expect(res).toEqual({
      status: 200,
      body: { mapping: { firstName: 0, lastName: 1, phone: 2, email: 3 }, source: 'ai' },
    });
    const [messages, tools] = chat.mock.calls[0]!;
    expect(JSON.stringify(messages)).toContain('(###) ###-####');
    expect(tools!.map((t) => t.name)).toEqual(['set_column_mapping']);
    expect(usage).toEqual([
      expect.objectContaining({ purpose: 'import_mapping', inputTokens: 300 }),
    ]);
  });

  it('reports a reply without a mapping', async () => {
    const { deps } = setup({ ...toolResult({}), type: 'text', text: 'Sorry', toolCalls: [] });
    const res = await handleAiRequest(request, deps);
    expect(res).toMatchObject({ status: 502, body: { error: { code: 'provider_bad_response' } } });
  });

  it('needs a key unless demo mode is on', async () => {
    const off = setup(null, { loadConfig: async () => null });
    expect(await handleAiRequest(request, off.deps)).toMatchObject({
      status: 409,
      body: { error: { code: 'not_configured' } },
    });
    const demo = setup(null, { loadConfig: async () => null, demoMapping: true });
    expect(await handleAiRequest(request, demo.deps)).toEqual({
      status: 200,
      body: {
        mapping: { firstName: 0, lastName: 1, phone: 2, email: 3 },
        source: 'demo',
      },
    });
    expect(demo.chat).not.toHaveBeenCalled();
  });

  it('rejects non-members and bad kinds', async () => {
    const { deps } = setup(null, { getMemberRole: async () => null });
    expect((await handleAiRequest(request, deps)).status).toBe(403);
    expect((await handleAiRequest({ ...request, kind: 'invoices' }, deps)).status).toBe(400);
  });
});

describe('mapping prompt', () => {
  it('lists every field as an optional integer', () => {
    const tool = columnMappingTool('appointments');
    expect(Object.keys((tool.parameters as { properties: object }).properties)).toContain(
      'appointmentId',
    );
    const text = JSON.stringify(columnMappingPrompt('clients', HEADERS, SAMPLES));
    expect(text).toContain('4: \\"Customer Since\\"');
  });

  it('accepts JSON in a plain-text reply', () => {
    expect(
      readColumnMapping('clients', HEADERS, {
        toolCalls: [],
        text: 'Here: {"fullName": 4, "email": 3}',
      }),
    ).toEqual({ fullName: 4, email: 3 });
    expect(readColumnMapping('clients', HEADERS, { toolCalls: [], text: 'no idea' })).toBeNull();
  });
});
