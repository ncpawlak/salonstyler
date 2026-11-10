import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { FAKE_KEYS, FIXTURE_MODELS, TINY_PNG_BASE64 } from '../contract/scenarios.ts';
import { AI_PROVIDERS, type AiProvider } from '../providers.ts';
import { createProvider } from '../registry.ts';
import { type AiServiceDeps, handleAiRequest, type UsageEntry } from '../server/handler.ts';
import type { FetchLike } from '../types.ts';
import { normalizeReceipt } from './receipt.ts';

const SALON = '6f1c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f';
const TODAY = '2026-11-10';
const IMAGE = { type: 'image', mimeType: 'image/png', data: TINY_PNG_BASE64 } as const;

describe('normalizeReceipt', () => {
  it('turns the total into cents', () => {
    expect(
      normalizeReceipt(
        {
          isReceipt: true,
          total: 48.62,
          currency: 'USD',
          vendor: ' SalonCentric ',
          date: '2026-11-02',
          category: 'products',
        },
        TODAY,
      ),
    ).toEqual({
      amountCents: 4862,
      currency: 'usd',
      vendor: 'SalonCentric',
      date: '2026-11-02',
      category: 'products',
    });
    expect(normalizeReceipt({ isReceipt: true, total: '$1,250.00' }, TODAY)).toMatchObject({
      amountCents: 125000,
      category: 'other',
    });
  });

  it('drops future dates, bad currencies and unknown categories', () => {
    expect(
      normalizeReceipt(
        { isReceipt: true, total: 10, date: '2026-12-01', currency: 'dollars', category: 'food' },
        TODAY,
      ),
    ).toEqual({ amountCents: 1000, currency: null, vendor: null, date: null, category: 'other' });
  });

  it('rejects non-receipts and unreadable totals', () => {
    expect(normalizeReceipt({ isReceipt: false, total: 10 }, TODAY)).toBeNull();
    expect(normalizeReceipt({ isReceipt: true, total: null }, TODAY)).toBeNull();
    expect(normalizeReceipt({ isReceipt: true, total: 0 }, TODAY)).toBeNull();
    expect(normalizeReceipt('nope', TODAY)).toBeNull();
  });
});

// Recorded-format provider responses (packages/ai/fixtures/<provider>/finances_receipt_read.json),
// replayed through the real adapters via the `ai` handler.
const fixturesDir = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'fixtures');
interface Fixture {
  request: { method: string; url: string; body: unknown };
  response: { status: number; body: unknown };
}
const loadFixture = (provider: AiProvider): Fixture =>
  JSON.parse(readFileSync(join(fixturesDir, provider, 'finances_receipt_read.json'), 'utf8'));

function setup(provider: AiProvider, overrides: Partial<AiServiceDeps> = {}) {
  const usage: UsageEntry[] = [];
  const bodies: unknown[] = [];
  const fixture = loadFixture(provider);
  const fetch: FetchLike = async (url, init) => {
    expect(String(url).split('?')[0]).toBe(fixture.request.url);
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(fixture.response.body), {
      status: fixture.response.status,
    });
  };
  const deps: AiServiceDeps = {
    getMemberRole: async () => 'owner',
    loadConfig: async () => ({
      provider,
      model: FIXTURE_MODELS[provider],
      apiKey: FAKE_KEYS[provider],
      monthlyTokenBudget: 100_000,
    }),
    tokensUsedThisMonth: async () => 0,
    recordUsage: async (entry) => {
      usage.push(entry);
    },
    createProvider: (id, options) => createProvider(id, { ...options, fetch }),
    ...overrides,
  };
  return { deps, usage, bodies, fixture };
}

const request = { action: 'read_receipt', salonId: SALON, image: IMAGE, today: TODAY };

describe('read_receipt', () => {
  for (const provider of AI_PROVIDERS) {
    it(`reads a receipt photo with ${provider}`, async () => {
      const { deps, usage, bodies, fixture } = setup(provider);
      const res = await handleAiRequest(request, deps);
      expect(res).toEqual({
        status: 200,
        body: {
          receipt: {
            amountCents: 4862,
            currency: 'usd',
            vendor: 'SalonCentric',
            date: '2026-11-02',
            category: 'products',
          },
          source: 'ai',
        },
      });
      expect(bodies).toEqual([fixture.request.body]);
      expect(usage).toEqual([
        expect.objectContaining({ purpose: 'receipt', inputTokens: 1288, outputTokens: 52 }),
      ]);
    });
  }

  it('is for owners only', async () => {
    const { deps, bodies } = setup('openai', { getMemberRole: async () => 'stylist' });
    expect(await handleAiRequest(request, deps)).toMatchObject({
      status: 403,
      body: { error: { code: 'forbidden' } },
    });
    expect(bodies).toHaveLength(0);
  });

  it('answers with a fixed receipt in local demo mode', async () => {
    const { deps, bodies } = setup('openai', { loadConfig: async () => null, demoMapping: true });
    expect(await handleAiRequest(request, deps)).toMatchObject({
      status: 200,
      body: { source: 'demo', receipt: { amountCents: 4862, date: TODAY } },
    });
    expect(bodies).toHaveLength(0);
  });

  it('needs an AI key otherwise', async () => {
    const { deps } = setup('openai', { loadConfig: async () => null });
    expect(await handleAiRequest(request, deps)).toMatchObject({
      status: 409,
      body: { error: { code: 'not_configured' } },
    });
  });

  it('rejects unsupported images', async () => {
    const { deps } = setup('openai');
    const res = await handleAiRequest(
      { ...request, image: { ...IMAGE, mimeType: 'image/heic' } },
      deps,
    );
    expect(res.status).toBe(400);
  });
});
