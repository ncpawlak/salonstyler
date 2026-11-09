import { describe, expect, it } from 'vitest';

import { toAnthropicMessages } from './adapters/anthropic.ts';
import { toGeminiContents, toGeminiSchema } from './adapters/gemini.ts';
import { toOpenAiMessages } from './adapters/openai.ts';
import { AiProviderError, redactSecrets } from './http.ts';
import { createProvider } from './registry.ts';
import type { ChatMessage, FetchLike } from './types.ts';

const conversation: ChatMessage[] = [
  { role: 'system', content: 'sys A' },
  { role: 'system', content: 'sys B' },
  { role: 'user', content: 'hi' },
  {
    role: 'assistant',
    content: 'checking',
    toolCalls: [
      { id: 't1', name: 'get_services', arguments: {} },
      { id: 't2', name: 'find_client', arguments: { name: 'Karina' } },
    ],
  },
  { role: 'tool', toolCallId: 't1', name: 'get_services', content: '[{"name":"Trim"}]' },
  { role: 'tool', toolCallId: 't2', name: 'find_client', content: 'not json' },
];

describe('message mapping', () => {
  it('openai keeps system messages inline and stringifies tool arguments', () => {
    const out = toOpenAiMessages(conversation);
    expect(out.map((m) => m.role)).toEqual([
      'system',
      'system',
      'user',
      'assistant',
      'tool',
      'tool',
    ]);
    expect(out[3]).toMatchObject({
      tool_calls: [{ id: 't1', function: { name: 'get_services', arguments: '{}' } }, {}],
    });
    expect(out[5]).toEqual({ role: 'tool', tool_call_id: 't2', content: 'not json' });
  });

  it('anthropic hoists system and merges consecutive tool results into one user turn', () => {
    const { system, messages } = toAnthropicMessages(conversation);
    expect(system).toBe('sys A\n\nsys B');
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(messages[2]!.content).toEqual([
      { type: 'tool_result', tool_use_id: 't1', content: '[{"name":"Trim"}]' },
      { type: 'tool_result', tool_use_id: 't2', content: 'not json' },
    ]);
  });

  it('gemini uses model role, wraps non-object tool output, and strips unsupported schema keys', () => {
    const { systemInstruction, contents } = toGeminiContents(conversation);
    expect(systemInstruction).toEqual({ parts: [{ text: 'sys A\n\nsys B' }] });
    expect(contents.map((c) => c.role)).toEqual(['user', 'model', 'user']);
    expect(contents[2]!.parts).toEqual([
      { functionResponse: { name: 'get_services', response: { result: [{ name: 'Trim' }] } } },
      { functionResponse: { name: 'find_client', response: { result: 'not json' } } },
    ]);
    expect(
      toGeminiSchema({
        $schema: 'x',
        type: 'object',
        additionalProperties: false,
        properties: { a: { type: 'object', additionalProperties: false } },
      }),
    ).toEqual({ type: 'object', properties: { a: { type: 'object' } } });
  });
});

describe('errors', () => {
  const respond =
    (status: number, body: unknown): FetchLike =>
    async () =>
      new Response(JSON.stringify(body), { status });

  it.each([
    [429, 'rate_limit'],
    [500, 'unavailable'],
    [529, 'unavailable'],
    [400, 'bad_request'],
    [403, 'auth'],
  ] as const)('maps HTTP %i to %s', async (status, code) => {
    const llm = createProvider('anthropic', {
      apiKey: 'sk-ant-secret-0123456789',
      model: 'm',
      fetch: respond(status, { error: { message: 'nope' } }),
    });
    await expect(llm.chat([{ role: 'user', content: 'x' }])).rejects.toMatchObject({
      code,
      status,
    });
  });

  it('maps network failures without leaking the key', async () => {
    const apiKey = 'sk-proj-supersecret-abcdefgh';
    const llm = createProvider('openai', {
      apiKey,
      model: 'm',
      fetch: async () => {
        throw new TypeError(`fetch failed for key ${apiKey}`);
      },
    });
    const error = await llm.chat([{ role: 'user', content: 'x' }]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as AiProviderError).code).toBe('network');
    expect((error as AiProviderError).message).not.toContain('supersecret');
  });

  it('rejects malformed tool-call arguments', async () => {
    const llm = createProvider('openai', {
      apiKey: 'sk-test-0123456789abc',
      model: 'm',
      fetch: respond(200, {
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              tool_calls: [
                { id: 'c', type: 'function', function: { name: 'f', arguments: '{oops' } },
              ],
            },
          },
        ],
      }),
    });
    await expect(llm.chat([{ role: 'user', content: 'x' }])).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('redacts exact keys and key-shaped strings', () => {
    expect(redactSecrets('bad key sk-abcd1234efgh used', 'zzz')).toBe('bad key [redacted] used');
    expect(redactSecrets('key AIzaSyA1234567890 bad')).toBe('key [redacted] bad');
    expect(redactSecrets('my-custom-key-123456 leaked', 'my-custom-key-123456')).toBe(
      '[redacted] leaked',
    );
  });

  it('requires a key and a model', () => {
    expect(() => createProvider('gemini', { apiKey: '', model: 'm' })).toThrow(/apiKey/);
    expect(() => createProvider('gemini', { apiKey: 'k', model: '' })).toThrow(/model/);
  });
});
