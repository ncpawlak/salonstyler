import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AUTH_HEADER,
  contractScenarios,
  FAKE_KEYS,
  type RecordedFixture,
} from './contract/scenarios.ts';
import { AiProviderError } from './http.ts';
import { AI_PROVIDERS, type AiProvider } from './providers.ts';
import { createProvider } from './registry.ts';
import type { FetchLike } from './types.ts';

const fixturesDir = join(import.meta.dirname, '..', 'fixtures');

function loadFixture(provider: AiProvider, scenario: string): RecordedFixture {
  return JSON.parse(readFileSync(join(fixturesDir, provider, `${scenario}.json`), 'utf8'));
}

/** Replays a recorded response, failing if the adapter's request drifted from the recording. */
function replay(fixture: RecordedFixture, provider: AiProvider): FetchLike {
  return async (url, init) => {
    expect(init.method).toBe(fixture.request.method);
    expect(url).toBe(fixture.request.url);
    expect(JSON.parse(String(init.body))).toEqual(fixture.request.body);
    const headers = new Headers(init.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get(AUTH_HEADER[provider])).toContain(FAKE_KEYS[provider]);
    return new Response(JSON.stringify(fixture.response.body), { status: fixture.response.status });
  };
}

const assert = (condition: boolean, message: string) => expect(condition, message).toBe(true);

describe.each(AI_PROVIDERS)('%s adapter contract (recorded fixtures)', (provider) => {
  for (const scenario of contractScenarios(assert)) {
    it(`${scenario.name}`, async () => {
      const fixture = loadFixture(provider, scenario.name);
      expect(JSON.stringify(fixture)).not.toMatch(/"(authorization|x-api-key|x-goog-api-key)"/i);

      const llm = createProvider(provider, {
        apiKey: FAKE_KEYS[provider],
        model: fixture.model,
        fetch: replay(fixture, provider),
      });
      expect(llm.id).toBe(provider);

      const call = llm.chat(scenario.messages, scenario.tools, scenario.options);
      if (scenario.invalidKey) {
        const error = await call.then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(AiProviderError);
        expect((error as AiProviderError).code).toBe('auth');
        expect((error as AiProviderError).provider).toBe(provider);
        expect((error as AiProviderError).message).not.toContain(FAKE_KEYS[provider]);
        expect((error as AiProviderError).message).not.toMatch(/sk-chair/);
        return;
      }

      const result = await call;
      scenario.expect(result);
      expect(result.provider).toBe(provider);
      expect(result.model).toMatch(new RegExp(`^${fixture.model}`));
      expect(result.usage.inputTokens).toBeGreaterThan(0);
      expect(result.usage.outputTokens).toBeGreaterThan(0);
      expect(result.usage.totalTokens).toBe(result.usage.inputTokens + result.usage.outputTokens);
    });
  }
});

describe('cross-provider normalization', () => {
  it('every adapter extracts the same parse_request arguments', async () => {
    const scenario = contractScenarios(assert).find((s) => s.name === 'tool_call')!;
    const args = await Promise.all(
      AI_PROVIDERS.map(async (provider) => {
        const fixture = loadFixture(provider, 'tool_call');
        const result = await createProvider(provider, {
          apiKey: FAKE_KEYS[provider],
          model: fixture.model,
          fetch: replay(fixture, provider),
        }).chat(scenario.messages, scenario.tools, scenario.options);
        return result.toolCalls[0]?.arguments;
      }),
    );
    expect(args[1]).toEqual(args[0]);
    expect(args[2]).toEqual(args[0]);
  });
});
