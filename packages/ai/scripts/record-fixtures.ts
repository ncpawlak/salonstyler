/**
 * Records adapter contract fixtures from the real provider APIs.
 *
 *   OPENAI_API_KEY=... ANTHROPIC_API_KEY=... GEMINI_API_KEY=... npm run record:fixtures --workspace @chairside/ai
 *
 * Only providers with a key in the environment are recorded. Keys are never written to disk
 * (auth headers are not stored and response bodies are scrubbed).
 *
 *   npm run record:fixtures --workspace @chairside/ai -- --update-requests
 *
 * Offline mode: rewrites only the `request` half of existing fixtures after an intentional
 * adapter change, keeping the recorded responses.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { format, resolveConfig } from 'prettier';

import {
  contractScenarios,
  FAKE_KEYS,
  FIXTURE_MODELS,
  type RecordedFixture,
} from '../src/contract/scenarios.ts';
import { redactSecrets } from '../src/http.ts';
import { AI_PROVIDERS, type AiProvider } from '../src/providers.ts';
import { createProvider } from '../src/registry.ts';
import type { FetchLike } from '../src/types.ts';

// Node-only script: copy the environment so lookups by provider name are explicit.
const env: Record<string, string | undefined> = { ...process.env };

const ENV_KEYS: Record<AiProvider, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const updateRequestsOnly = process.argv.includes('--update-requests');
const scenarios = contractScenarios(() => undefined);

function fixturePath(provider: AiProvider, scenario: string) {
  return join(fixturesDir, provider, `${scenario}.json`);
}

async function write(fixture: RecordedFixture) {
  const path = fixturePath(fixture.provider, fixture.scenario);
  mkdirSync(dirname(path), { recursive: true });
  const options = (await resolveConfig(path)) ?? {};
  writeFileSync(path, await format(JSON.stringify(fixture), { ...options, parser: 'json' }));
  console.log(`  wrote ${path}`);
}

for (const provider of AI_PROVIDERS) {
  const realKey = env[ENV_KEYS[provider]];
  if (!updateRequestsOnly && !realKey) {
    console.log(`${provider}: skipped (set ${ENV_KEYS[provider]} to record)`);
    continue;
  }
  console.log(`${provider}:`);
  const model = env[`${ENV_KEYS[provider]}_MODEL`] ?? FIXTURE_MODELS[provider];

  for (const scenario of scenarios) {
    const apiKey = updateRequestsOnly || scenario.invalidKey ? FAKE_KEYS[provider] : realKey!;
    let captured: RecordedFixture['request'] | undefined;
    let response: RecordedFixture['response'] | undefined;
    let existing: RecordedFixture | undefined;
    if (updateRequestsOnly) {
      existing = JSON.parse(readFileSync(fixturePath(provider, scenario.name), 'utf8'));
    }

    const recordingFetch: FetchLike = async (url, init) => {
      captured = { method: init.method ?? 'GET', url, body: JSON.parse(String(init.body)) };
      if (existing) {
        response = existing.response;
        return new Response(JSON.stringify(existing.response.body), {
          status: existing.response.status,
        });
      }
      const res = await fetch(url, init);
      const text = redactSecrets(await res.text(), apiKey);
      response = { status: res.status, body: JSON.parse(text) };
      return new Response(text, { status: res.status });
    };

    try {
      await createProvider(provider, {
        apiKey,
        model: existing?.model ?? model,
        fetch: recordingFetch,
      }).chat(scenario.messages, scenario.tools, scenario.options);
    } catch (error) {
      if (!scenario.invalidKey) console.warn(`  ${scenario.name}: ${String(error)}`);
    }
    if (!captured || !response) continue;
    await write({
      provider,
      scenario: scenario.name,
      model: existing?.model ?? model,
      source:
        existing?.source ??
        `recorded from the live API on ${new Date().toISOString().slice(0, 10)}`,
      request: captured,
      response,
    });
  }
}
