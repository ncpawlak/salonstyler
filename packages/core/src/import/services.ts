/**
 * Service menu import (#16). An LLM (or the line parser below) only *extracts* a menu: names,
 * durations, prices, categories and processing gaps. Everything here is deterministic: it cleans
 * whatever came back, dedupes it against the salon's menu, and turns the reviewed rows into
 * `save_service` payloads.
 */
import type { ServiceSegment } from '../availability/types.ts';
import type { ServiceColorTag, ServiceDefinition } from '../services/types.ts';
import { parseDuration, parseMoneyCents } from './normalize.ts';

/** One service as read from a Vagaro booking page, menu screenshot or pasted text. */
export interface ExtractedService {
  name: string;
  category: string | null;
  /** Total client time in minutes. */
  durationMinutes: number | null;
  priceCents: number | null;
  /** Processing ("gap") minutes inside the duration, only when the menu shows them. */
  processingMinutes: number | null;
  description: string | null;
}

/** Where an extracted menu came from: the salon's AI, the local demo stand-in, or the line parser. */
export type ServiceMenuSource = 'ai' | 'demo' | 'parser';

/** Request body for the `import-services` Edge Function. */
export type ExtractServicesRequest =
  | { source: 'url'; salonId: string; url: string }
  | { source: 'text'; salonId: string; text: string }
  | { source: 'image'; salonId: string; mimeType: string; data: string };

/** Response body of the `import-services` Edge Function. */
export interface ExtractServicesResponse {
  services: ExtractedService[];
  source: ServiceMenuSource;
  /** Why the result may need extra checking (e.g. read line by line because AI isn't set up). */
  notice?: string;
}

export const MAX_EXTRACTED_SERVICES = 150;
/** `service_segments.minutes` caps a single segment at 12 hours. */
export const MAX_IMPORTED_SERVICE_MINUTES = 720;
const MAX_NAME = 80;
const MAX_CATEGORY = 40;
const MAX_DESCRIPTION = 500;

const clean = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const s = v
    .replace(/[\u0000-\u001f\u007f\ue000-\uf8ff]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s•·*\-–—>]+/, '')
    .trim();
  return s ? s.slice(0, max).trim() : null;
};

const DURATION_RE =
  /(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b\.?(?:\s*(?:and\s*)?(\d+)\s*(?:m|min|mins|minute|minutes)\b\.?)?|(\d+)\s*(?:m|min|mins|minute|minutes)\b\.?/i;
const PRICE_RE = /\$\s*(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/;

/** `45 min`, `1 hr 30 min`, `1h30m`, `1.5 hours`, `90` → minutes, or null. Finds it inside text. */
export function parseDurationText(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw >= 1 ? Math.round(raw) : null;
  }
  if (typeof raw !== 'string') return null;
  const direct = parseDuration(raw);
  if (direct !== null) return direct;
  const m = DURATION_RE.exec(raw);
  if (!m) return null;
  const minutes = m[3] ? Number(m[3]) : Math.round(Number(m[1]) * 60) + Number(m[2] ?? 0);
  return minutes >= 1 && minutes <= 1440 ? minutes : null;
}

/** `$65`, `$85.00+`, `from $120`, `$60 - $80` (lowest), `65` → cents, or null. */
export function parsePriceText(raw: unknown): number | null {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0) return null;
    const cents = Math.round(raw * 100);
    return cents <= 10_000_000 ? cents : null;
  }
  if (typeof raw !== 'string') return null;
  const direct = parseMoneyCents(raw);
  if (direct !== null) return direct;
  const m = PRICE_RE.exec(raw);
  return m ? parseMoneyCents(m[1]) : null;
}

/** Case/punctuation-insensitive service name key ("Women’s Haircut" = "womens haircut"). */
export function serviceNameKey(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const pick = (o: Record<string, unknown>, ...keys: string[]) => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
  return null;
};

/**
 * Cleans an untrusted extraction (a model's tool arguments or the line parser's output): drops
 * nameless rows, parses durations/prices given as text, bounds every field and dedupes by name.
 * Accepts `{ services: [...] }` or a bare array.
 */
export function sanitizeExtractedServices(raw: unknown): ExtractedService[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { services?: unknown }).services)
      ? (raw as { services: unknown[] }).services
      : [];
  const out: ExtractedService[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (out.length >= MAX_EXTRACTED_SERVICES) break;
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const name = clean(o.name, MAX_NAME);
    if (!name || !/\p{L}/u.test(name)) continue;
    const key = serviceNameKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    let duration = parseDurationText(pick(o, 'durationMinutes', 'duration', 'minutes'));
    if (duration !== null && duration > MAX_IMPORTED_SERVICE_MINUTES) duration = null;
    let processing = parseDurationText(pick(o, 'processingMinutes', 'processing', 'gapMinutes'));
    if (processing !== null && (duration === null || processing > duration - 2)) processing = null;

    // `priceCents` is already in cents; `price` is dollars or text like "$85+".
    const cents = o.priceCents;
    const priceCents =
      typeof cents === 'number'
        ? Number.isInteger(cents) && cents >= 0 && cents <= 10_000_000
          ? cents
          : null
        : parsePriceText(pick(o, 'price'));

    out.push({
      name,
      category: clean(o.category, MAX_CATEGORY),
      durationMinutes: duration,
      priceCents,
      processingMinutes: processing,
      description: clean(o.description, MAX_DESCRIPTION),
    });
  }
  return out;
}

const IGNORED_LINE =
  /^(book( now)?|select|add|show (more|less)|read more|view all|see all|services?|menu|price|duration|reviews?|\d+ services?)$/i;
const PROCESSING_RE = /\b(process(ing)?|gap|develop(ing)?)\b/i;

interface ParsedLine {
  text: string;
  name: string | null;
  minutes: number | null;
  priceCents: number | null;
  processing: number | null;
}

function parseLine(line: string): ParsedLine {
  const text = line.replace(/\s+/g, ' ').trim();
  const priceCents = parsePriceText(PRICE_RE.exec(text)?.[0] ?? null);
  const processing =
    priceCents === null && PROCESSING_RE.test(text) ? parseDurationText(text) : null;
  const minutes =
    processing === null ? parseDurationText(DURATION_RE.exec(text)?.[0] ?? null) : null;
  let name = text
    .replace(new RegExp(PRICE_RE.source, 'g'), ' ')
    .replace(new RegExp(DURATION_RE.source, 'gi'), ' ')
    .replace(/\b(from|starting at|and up|price varies|varies)\b/gi, ' ')
    .replace(/[+|·•…]|\.{2,}|\s[-–—:]\s|[-–—:]\s*$/g, ' ')
    .replace(/\(\s*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (processing !== null || !/\p{L}/u.test(name)) name = '';
  return { text, name: name || null, minutes, priceCents, processing };
}

const looksLikeHeading = (s: string) =>
  s.length <= MAX_CATEGORY && s.split(' ').length <= 5 && !/[.!?]$/.test(s);

/**
 * Deterministic menu reader for pasted text (or a booking page's text) when no AI is available.
 * Understands one service per line ("Women's Haircut · 45 min · $65") and the stacked layout of
 * a copied Vagaro menu (name, then duration and price on their own lines). A plain line followed
 * by another plain line is treated as a category heading.
 */
export function parseMenuText(text: string): ExtractedService[] {
  const lines = text
    .split(/\r?\n/)
    .map(parseLine)
    .filter((l) => l.text && !IGNORED_LINE.test(l.text));
  const raw: Record<string, unknown>[] = [];
  let category: string | null = null;
  let current: Record<string, unknown> | null = null;

  const hasDetails = (l: ParsedLine | undefined) =>
    !!l && (l.minutes !== null || l.priceCents !== null || l.processing !== null);

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.processing !== null) {
      if (current) current.processingMinutes = l.processing;
      continue;
    }
    if (hasDetails(l) && l.name) {
      current = { name: l.name, category, durationMinutes: l.minutes, priceCents: l.priceCents };
      raw.push(current);
      continue;
    }
    if (hasDetails(l)) {
      if (current) {
        current.durationMinutes ??= l.minutes;
        current.priceCents ??= l.priceCents;
      }
      continue;
    }
    // A plain line: a service name when details follow, else a heading or a description.
    if (hasDetails(lines[i + 1]) && !lines[i + 1]!.name) {
      current = { name: l.text, category, durationMinutes: null, priceCents: null };
      raw.push(current);
    } else if (looksLikeHeading(l.text)) {
      category = l.text;
      current = null;
    } else if (current && !current.description) {
      current.description = l.text;
    }
  }
  return sanitizeExtractedServices(
    raw.filter((r) => r.durationMinutes !== null || r.priceCents !== null),
  );
}

/** A price or a duration somewhere in the text, at least `min` times (a menu, not a blurb). */
export function looksLikeMenuText(text: string, min = 2): boolean {
  const prices = text.match(new RegExp(PRICE_RE.source, 'g'))?.length ?? 0;
  const durations = text.match(new RegExp(DURATION_RE.source, 'gi'))?.length ?? 0;
  return prices >= min || durations >= min;
}

// ---------------------------------------------------------------------------------------------
// Review rows and saving

export type ServiceImportAction = 'add' | 'update' | 'skip';

/** The menu services an import is checked against. */
export interface ExistingService {
  id: string;
  name: string;
  archivedAt?: string | null;
}

export interface ServiceImportRow extends ExtractedService {
  /** Stable key for the review list. */
  key: string;
  /** The active menu service with the same name, if any. */
  match: { id: string; name: string } | null;
  action: ServiceImportAction;
}

/**
 * Review rows for an extracted menu. A service already on the menu (same name, ignoring case and
 * punctuation) defaults to `skip`, so importing the same menu twice changes nothing.
 */
export function planServiceImport(
  extracted: readonly ExtractedService[],
  existing: readonly ExistingService[],
): ServiceImportRow[] {
  const byKey = new Map<string, ExistingService>();
  for (const s of existing) {
    if (s.archivedAt) continue;
    const k = serviceNameKey(s.name);
    if (!byKey.has(k)) byKey.set(k, s);
  }
  return extracted.map((s, i) => {
    const m = byKey.get(serviceNameKey(s.name));
    return {
      ...s,
      key: `row-${i}`,
      match: m ? { id: m.id, name: m.name } : null,
      action: m ? 'skip' : 'add',
    };
  });
}

/** Problems that block saving a row (empty when it can be imported). */
export function serviceImportIssues(row: ExtractedService): string[] {
  const issues: string[] = [];
  const name = row.name.trim();
  if (!name) issues.push('Add a name');
  else if (name.length > MAX_NAME) issues.push(`Shorten the name to ${MAX_NAME} characters`);
  if (row.category && row.category.trim().length > MAX_CATEGORY) {
    issues.push(`Shorten the category to ${MAX_CATEGORY} characters`);
  }
  const d = row.durationMinutes;
  if (d === null) issues.push('Add a duration');
  else if (!Number.isInteger(d) || d < 1 || d > MAX_IMPORTED_SERVICE_MINUTES) {
    issues.push('Duration must be 1 minute to 12 hours');
  }
  const p = row.processingMinutes;
  if (p !== null && p !== 0) {
    if (!Number.isInteger(p) || p < 1) issues.push('Processing must be whole minutes');
    else if (d !== null && p > d - 2) {
      issues.push('Processing must leave hands-on time before and after it');
    }
  }
  if (row.priceCents !== null && (row.priceCents < 0 || row.priceCents > 10_000_000)) {
    issues.push('Price must be $0 to $100,000');
  }
  return issues;
}

/**
 * Segments for an imported service: one hands-on block, or apply → processing → rinse & style
 * when a processing gap is given (hands-on time split evenly around it).
 */
export function importedServiceSegments(
  durationMinutes: number,
  processingMinutes?: number | null,
): ServiceSegment[] {
  const p = processingMinutes ?? 0;
  if (p <= 0) return [{ kind: 'busy', minutes: durationMinutes }];
  const handsOn = durationMinutes - p;
  const apply = Math.ceil(handsOn / 2);
  return [
    { kind: 'busy', minutes: apply, label: 'Apply' },
    { kind: 'processing', minutes: p, label: 'Process' },
    { kind: 'style', minutes: handsOn - apply, label: 'Rinse & style' },
  ];
}

const COLOR_RULES: [RegExp, ServiceColorTag][] = [
  [/colou?r|highlight|lowlight|balayage|ombr|foil|toner|gloss|bleach|root|blond/i, 'purple'],
  [/cut|trim|barber|fade|shave|beard|bang|fringe/i, 'blue'],
  [/blow|style|styling|updo|braid|bridal|wedding|curl|event/i, 'pink'],
  [/treat|keratin|condition|mask|scalp|smooth|olaplex|perm|relax/i, 'teal'],
  [/wax|brow|lash|nail|mani|pedi|facial|makeup/i, 'amber'],
  [/extension|weave|install/i, 'indigo'],
];

/** Calendar color for an imported service, from its category or name. */
export function importedServiceColor(category: string | null, name: string): ServiceColorTag {
  for (const text of [category ?? '', name]) {
    for (const [re, tag] of COLOR_RULES) if (re.test(text)) return tag;
  }
  return 'gray';
}

const totalOf = (segments: readonly ServiceSegment[]) =>
  segments.reduce((sum, s) => sum + s.minutes, 0);

/**
 * The `save_service` payload for a reviewed row. `add` builds a new service; `update` keeps the
 * existing service's settings and replaces its price and timing (its own segments are kept when
 * the length is unchanged and no processing gap was given). Throws if the row has issues.
 */
export function serviceImportPayload(
  row: ServiceImportRow,
  existing?: ServiceDefinition & { id: string },
): ServiceDefinition & { id?: string } {
  const issues = serviceImportIssues(row);
  if (issues.length) throw new Error(`${row.name || 'Service'}: ${issues[0]}`);
  const duration = row.durationMinutes!;
  const processing = row.processingMinutes || null;
  if (row.action === 'update') {
    if (!existing) throw new Error(`${row.name}: the service to update is missing`);
    const keep = !processing && totalOf(existing.segments) === duration;
    return {
      id: existing.id,
      name: existing.name,
      category: existing.category,
      description: existing.description ?? null,
      priceCents: row.priceCents ?? existing.priceCents,
      colorTag: existing.colorTag,
      segments: keep ? existing.segments : importedServiceSegments(duration, processing),
      bufferBeforeMinutes: existing.bufferBeforeMinutes,
      bufferAfterMinutes: existing.bufferAfterMinutes,
      consultationRequired: existing.consultationRequired,
      bookableOnline: existing.bookableOnline,
      newClientsOnly: existing.newClientsOnly,
      variants: existing.variants,
    };
  }
  const name = row.name.trim();
  return {
    name,
    category: row.category?.trim() || 'Other',
    description: row.description?.trim() || null,
    priceCents: row.priceCents,
    colorTag: importedServiceColor(row.category, name),
    segments: importedServiceSegments(duration, processing),
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    consultationRequired: false,
    bookableOnline: true,
    newClientsOnly: false,
    variants: [],
  };
}

/**
 * "Replace my menu": the active services and combos to hide after the import. Every service the
 * import matched (updated or skipped) stays; combos stay only if all of their services do.
 */
export function servicesToArchive(
  rows: readonly ServiceImportRow[],
  menu: {
    services: readonly ExistingService[];
    combos: readonly (ExistingService & { items: readonly { serviceId: string }[] })[];
  },
): string[] {
  const kept = new Set(rows.filter((r) => r.match && r.action !== 'add').map((r) => r.match!.id));
  const archived = menu.services.filter((s) => !s.archivedAt && !kept.has(s.id)).map((s) => s.id);
  const gone = new Set(archived);
  const combos = menu.combos
    .filter((c) => !c.archivedAt && c.items.some((i) => gone.has(i.serviceId)))
    .map((c) => c.id);
  return [...archived, ...combos];
}
