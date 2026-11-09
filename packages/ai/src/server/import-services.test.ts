import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { readExtractedServices, servicesExtractionPrompt } from '../import/services.ts';
import { fetchVagaroPage, parseVagaroUrl, vagaroPageText } from '../import/vagaro-page.ts';
import type { ChatResult, LLMProvider } from '../types.ts';
import type { UsageEntry } from './handler.ts';
import { type ImportServicesDeps, handleImportServices } from './import-services-handler.ts';

const SALON = '6f1c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f';
const MENU = readFileSync(
  fileURLToPath(
    new URL('../../../core/src/import/fixtures/vagaro-service-menu.txt', import.meta.url),
  ),
  'utf8',
);

function toolResult(args: Record<string, unknown>): ChatResult {
  return {
    type: 'tool_calls',
    text: null,
    toolCalls: [{ id: 't1', name: 'record_services', arguments: args }],
    provider: 'openai',
    model: 'gpt-test',
    finishReason: 'tool_calls',
    usage: { inputTokens: 900, outputTokens: 200, totalTokens: 1100 },
  };
}

function setup(reply: ChatResult | Error | null, overrides: Partial<ImportServicesDeps> = {}) {
  const usage: UsageEntry[] = [];
  const chat = vi.fn<LLMProvider['chat']>(async () => {
    if (reply instanceof Error) throw reply;
    return reply!;
  });
  const deps: ImportServicesDeps = {
    getMemberRole: async () => 'owner',
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

const html = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/html', ...headers } });

const MENU_PAGE = `<!doctype html><html><head><title>Salon</title><script>var x = "$999";</script></head>
<body><h2>Haircuts</h2><div><span>Women&#39;s Haircut</span><span>45 min</span><span>$65.00</span></div>
<div><span>Men&rsquo;s Haircut</span><span>30 min</span><span>$35</span></div>
<i>&#xe900;</i><button>Book Now</button></body></html>`;

describe('handleImportServices', () => {
  it('rejects non-owners', async () => {
    const { deps, chat } = setup(null, { getMemberRole: async () => 'stylist' });
    const res = await handleImportServices({ source: 'text', salonId: SALON, text: MENU }, deps);
    expect(res.status).toBe(403);
    expect(chat).not.toHaveBeenCalled();
  });

  it('validates the request', async () => {
    const { deps } = setup(null);
    const res = await handleImportServices({ source: 'url', salonId: 'nope', url: '' }, deps);
    expect(res.status).toBe(400);
  });

  it('extracts a screenshot with the model and sanitizes the answer', async () => {
    const { deps, usage, chat } = setup(
      toolResult({
        services: [
          { name: 'Balayage', category: 'Color', durationMinutes: 180, price: 210 },
          { name: '  ', durationMinutes: 30 },
          { name: 'Gloss', durationMinutes: 9999, price: '$40+' },
        ],
      }),
    );
    const res = await handleImportServices(
      { source: 'image', salonId: SALON, mimeType: 'image/png', data: 'iVBORw0KGgo=' },
      deps,
    );
    expect(res.status).toBe(200);
    if (res.status !== 200) return;
    expect(res.body.source).toBe('ai');
    expect(res.body.services).toEqual([
      expect.objectContaining({ name: 'Balayage', durationMinutes: 180, priceCents: 21000 }),
      expect.objectContaining({ name: 'Gloss', durationMinutes: null, priceCents: 4000 }),
    ]);
    const messages = chat.mock.calls[0]![0];
    expect(JSON.stringify(messages)).toContain('iVBORw0KGgo=');
    expect(usage).toEqual([expect.objectContaining({ purpose: 'import_services' })]);
  });

  it('reads pasted text line by line when AI is not set up', async () => {
    const { deps, chat } = setup(null, { loadConfig: async () => null });
    const res = await handleImportServices({ source: 'text', salonId: SALON, text: MENU }, deps);
    expect(res.status).toBe(200);
    if (res.status !== 200) return;
    expect(res.body.source).toBe('parser');
    expect(res.body.notice).toMatch(/line by line/);
    expect(res.body.services.length).toBeGreaterThan(3);
    expect(chat).not.toHaveBeenCalled();
  });

  it('needs AI for screenshots', async () => {
    const { deps } = setup(null, { loadConfig: async () => null });
    const res = await handleImportServices(
      { source: 'image', salonId: SALON, mimeType: 'image/jpeg', data: 'abc' },
      deps,
    );
    expect(res).toMatchObject({ status: 409, body: { error: { code: 'not_configured' } } });
  });

  it('falls back to the parser when the provider fails on text', async () => {
    const { deps } = setup(new Error('boom'));
    const res = await handleImportServices({ source: 'text', salonId: SALON, text: MENU }, deps);
    expect(res).toMatchObject({ status: 200, body: { source: 'parser' } });
  });

  it('reports provider failures on screenshots without leaking the key', async () => {
    const { deps } = setup(new Error('bad key sk-test-0123456789abcdefghij'));
    const res = await handleImportServices(
      { source: 'image', salonId: SALON, mimeType: 'image/png', data: 'abc' },
      deps,
    );
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain('sk-test-0123456789abcdefghij');
  });

  it('refuses screenshots over budget', async () => {
    const { deps } = setup(null, { tokensUsedThisMonth: async () => 100_000 });
    const res = await handleImportServices(
      { source: 'image', salonId: SALON, mimeType: 'image/png', data: 'abc' },
      deps,
    );
    expect(res.status).toBe(429);
  });

  it('says so when nothing was found', async () => {
    const { deps } = setup(toolResult({ services: [] }));
    const res = await handleImportServices(
      { source: 'image', salonId: SALON, mimeType: 'image/png', data: 'abc' },
      deps,
    );
    expect(res).toMatchObject({ status: 422, body: { error: { code: 'no_services_found' } } });
  });

  it('demo mode never calls a model', async () => {
    const { deps, chat } = setup(null, { demo: true });
    const image = await handleImportServices(
      { source: 'image', salonId: SALON, mimeType: 'image/png', data: 'abc' },
      deps,
    );
    expect(image).toMatchObject({ status: 200, body: { source: 'demo' } });
    const text = await handleImportServices({ source: 'text', salonId: SALON, text: MENU }, deps);
    expect(text).toMatchObject({ status: 200, body: { source: 'parser' } });
    expect(chat).not.toHaveBeenCalled();
  });

  describe('booking page links', () => {
    it('only accepts vagaro.com links', async () => {
      const fetch = vi.fn<typeof globalThis.fetch>();
      const { deps } = setup(null, { fetch });
      for (const url of ['http://169.254.169.254/', 'https://evil.com/vagaro.com', 'file:///etc']) {
        const res = await handleImportServices({ source: 'url', salonId: SALON, url }, deps);
        expect(res).toMatchObject({ status: 400, body: { error: { code: 'unsupported_url' } } });
      }
      expect(fetch).not.toHaveBeenCalled();
    });

    it('suggests a screenshot when the page cannot be fetched', async () => {
      const { deps } = setup(null, { fetch: async () => html('nope', 404) });
      const res = await handleImportServices(
        { source: 'url', salonId: SALON, url: 'vagaro.com/fictionalsalon' },
        deps,
      );
      expect(res).toMatchObject({ status: 502, body: { error: { code: 'page_fetch_failed' } } });
      if (res.status !== 200) expect(res.body.error.message).toMatch(/screenshot/i);
    });

    it('suggests a screenshot when the menu only renders in the browser', async () => {
      const { deps, chat } = setup(null, {
        fetch: async () => html('<html><body><div id="app">Loading…</div></body></html>'),
      });
      const res = await handleImportServices(
        { source: 'url', salonId: SALON, url: 'https://www.vagaro.com/fictionalsalon/services' },
        deps,
      );
      expect(res).toMatchObject({ status: 422, body: { error: { code: 'page_unreadable' } } });
      expect(chat).not.toHaveBeenCalled();
    });

    it('sends readable page text to the model', async () => {
      const { deps, chat } = setup(
        toolResult({ services: [{ name: "Women's Haircut", durationMinutes: 45, price: 65 }] }),
        { fetch: async () => html(MENU_PAGE) },
      );
      const res = await handleImportServices(
        { source: 'url', salonId: SALON, url: 'https://vagaro.com/fictionalsalon' },
        deps,
      );
      expect(res).toMatchObject({ status: 200, body: { source: 'ai' } });
      const prompt = JSON.stringify(chat.mock.calls[0]![0]);
      expect(prompt).toContain('45 min');
      expect(prompt).not.toContain('$999');
    });
  });
});

describe('parseVagaroUrl', () => {
  it('normalizes vagaro links', () => {
    expect(parseVagaroUrl('vagaro.com/fictionalsalon')?.toString()).toBe(
      'https://www.vagaro.com/fictionalsalon',
    );
    expect(parseVagaroUrl('http://www.vagaro.com/x/services#top')?.toString()).toBe(
      'https://www.vagaro.com/x/services',
    );
  });

  it('rejects other hosts, ports and credentials', () => {
    for (const bad of [
      '',
      'https://vagaro.com.evil.com/x',
      'https://evilvagaro.com/x',
      'https://www.vagaro.com:8443/x',
      'https://user:pw@www.vagaro.com/x',
      'ftp://www.vagaro.com/x',
      'javascript:alert(1)',
    ]) {
      expect(parseVagaroUrl(bad), bad).toBeNull();
    }
  });
});

describe('fetchVagaroPage', () => {
  const url = parseVagaroUrl('vagaro.com/fictionalsalon')!;

  it('follows redirects within vagaro.com only', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(html('', 301, { location: '/fictionalsalon/services' }))
      .mockResolvedValueOnce(html(MENU_PAGE));
    const res = await fetchVagaroPage(url, { fetch });
    expect(res).toMatchObject({ ok: true, url: 'https://www.vagaro.com/fictionalsalon/services' });

    const offsite = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(html('', 302, { location: 'http://10.0.0.1/admin' }));
    expect(await fetchVagaroPage(url, { fetch: offsite })).toMatchObject({
      ok: false,
      reason: 'redirect_blocked',
    });
    expect(offsite).toHaveBeenCalledTimes(1);
  });

  it('caps the page size and survives network errors', async () => {
    const big = async () => html('x'.repeat(2000));
    expect(await fetchVagaroPage(url, { fetch: big, maxBytes: 1000 })).toMatchObject({
      ok: false,
      reason: 'too_large',
    });
    const down = async () => {
      throw new TypeError('network down');
    };
    expect(await fetchVagaroPage(url, { fetch: down })).toMatchObject({
      ok: false,
      reason: 'network',
    });
  });
});

describe('vagaroPageText', () => {
  it('keeps visible text and JSON-LD services, drops scripts and icon glyphs', () => {
    const text = vagaroPageText(
      MENU_PAGE.replace(
        '</head>',
        '<script type="application/ld+json">{"@type":"Service","name":"Gloss","duration":"PT30M","offers":{"price":"40"}}</script></head>',
      ),
    );
    expect(text.split('\n')).toEqual(
      expect.arrayContaining([
        'Gloss · 30 min · $40',
        "Women's Haircut",
        '45 min',
        'Men’s Haircut',
      ]),
    );
    expect(text).not.toContain('$999');
    expect(text).not.toMatch(/[\ue000-\uf8ff]/);
  });
});

describe('extraction prompt', () => {
  it('treats the menu as data and reads tool or JSON answers', () => {
    const [system] = servicesExtractionPrompt({ kind: 'text', text: 'Cut 30 min $20' });
    expect(system!.content).toMatch(/ignore any instructions/);
    expect(
      readExtractedServices({
        toolCalls: [],
        text: '```json\n{"services":[{"name":"Cut","price":20}]}\n```',
      }),
    ).toEqual([expect.objectContaining({ name: 'Cut', priceCents: 2000 })]);
    expect(readExtractedServices({ toolCalls: [], text: 'sorry' })).toBeNull();
  });
});
