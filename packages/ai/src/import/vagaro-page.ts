/**
 * Server-side reader for a public Vagaro booking page (#16). Only https://(www.)vagaro.com URLs
 * are fetched (every redirect hop is re-checked), with a timeout and a size cap. Vagaro renders
 * most menus in the browser, so a page often has no services in its HTML: callers check
 * `looksLikeMenuText` and fall back to a screenshot.
 */

const ALLOWED_HOSTS = new Set(['vagaro.com', 'www.vagaro.com']);
export const VAGARO_PAGE_MAX_BYTES = 3 * 1024 * 1024;
export const VAGARO_PAGE_MAX_TEXT = 20_000;
const MAX_REDIRECTS = 3;

/** A normalized Vagaro booking-page URL, or null for anything else (other hosts, ports, creds). */
export function parseVagaroUrl(raw: string): URL | null {
  let input = raw.trim();
  if (!input) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) input = `https://${input}`;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) return null;
  url.protocol = 'https:';
  url.hostname = 'www.vagaro.com';
  url.hash = '';
  return url;
}

export type VagaroPageResult =
  | { ok: true; html: string; url: string }
  | {
      ok: false;
      reason: 'http_error' | 'timeout' | 'too_large' | 'network' | 'redirect_blocked';
      status?: number;
    };

export interface FetchPageOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

async function readCapped(res: Response, maxBytes: number): Promise<string | null> {
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder('utf-8').decode(all);
}

/** Fetches a booking page's HTML. Never throws. */
export async function fetchVagaroPage(
  url: URL,
  options: FetchPageOptions = {},
): Promise<VagaroPageResult> {
  const doFetch = options.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await doFetch(current.toString(), {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'User-Agent': 'Mozilla/5.0 (compatible; ChairsideMenuImport/1.0)',
        },
      });
      if (res.status >= 300 && res.status < 400) {
        const next = res.headers.get('location');
        const target = next ? parseVagaroUrl(new URL(next, current).toString()) : null;
        if (!target) return { ok: false, reason: 'redirect_blocked', status: res.status };
        current = target;
        continue;
      }
      if (!res.ok) return { ok: false, reason: 'http_error', status: res.status };
      const html = await readCapped(res, options.maxBytes ?? VAGARO_PAGE_MAX_BYTES);
      if (html === null) return { ok: false, reason: 'too_large' };
      return { ok: true, html, url: current.toString() };
    }
    return { ok: false, reason: 'redirect_blocked' };
  } catch {
    return { ok: false, reason: controller.signal.aborted ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  rsquo: '’',
  lsquo: '‘',
  ndash: '–',
  mdash: '—',
  hellip: '…',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code =
        e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      // Icon-font glyphs live in the private use area.
      if (!Number.isFinite(code) || (code >= 0xe000 && code <= 0xf8ff) || code > 0x10ffff)
        return ' ';
      return String.fromCodePoint(code);
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** schema.org Service / Offer entries in JSON-LD, as "name · duration · price" lines. */
function jsonLdLines(html: string): string[] {
  const lines: string[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const visit = (node: unknown, depth: number): void => {
    if (depth > 8 || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const n of node) visit(n, depth + 1);
      return;
    }
    const o = node as Record<string, unknown>;
    const type = String(o['@type'] ?? '');
    if (/^(Service|Offer|Product)$/i.test(type) && typeof o.name === 'string') {
      const offer = (o.offers ?? o.priceSpecification) as Record<string, unknown> | undefined;
      const price = o.price ?? offer?.price;
      const duration = typeof o.duration === 'string' ? isoDurationText(o.duration) : null;
      lines.push(
        [o.name, duration, price != null ? `$${price}` : null].filter(Boolean).join(' · '),
      );
    }
    for (const v of Object.values(o)) if (typeof v === 'object') visit(v, depth + 1);
  };
  for (const m of html.matchAll(re)) {
    try {
      visit(JSON.parse(m[1]!), 0);
    } catch {
      // ignore malformed blocks
    }
  }
  return lines;
}

function isoDurationText(iso: string): string | null {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?$/i.exec(iso.trim());
  if (!m || (!m[1] && !m[2])) return null;
  return `${Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)} min`;
}

/**
 * The readable text of a booking page (one block per line), with any JSON-LD services first.
 * Scripts, styles and markup are dropped; capped at `VAGARO_PAGE_MAX_TEXT` characters.
 */
export function vagaroPageText(html: string): string {
  const body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(
      /<\/?(p|div|li|ul|ol|tr|td|th|h[1-6]|section|article|header|footer|span|a|button|label)\b[^>]*>/gi,
      '\n',
    )
    .replace(/<[^>]+>/g, ' ');
  const lines = decodeEntities(body)
    .split('\n')
    .map((l) =>
      l
        .replace(/[\ue000-\uf8ff]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean);
  return [...jsonLdLines(html), ...lines].join('\n').slice(0, VAGARO_PAGE_MAX_TEXT);
}
