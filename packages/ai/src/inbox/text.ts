/** Text helpers for forwarded client messages: keyword stripping, phone numbers, dedupe keys. */

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Removes the trigger keyword ("Chairside", plus autocorrect variants like "Chair side",
 * "Chair-side", "Chairsides", and the salon's custom keyword), case-insensitively. The keyword is
 * never required: a message without it is kept as is.
 */
export function stripKeyword(text: string, keyword?: string | null): string {
  const patterns = [String.raw`chair[\s-]*sides?`];
  const custom = keyword?.trim();
  if (custom && !/^chair[\s-]*sides?$/i.test(custom)) {
    patterns.push(escapeRegExp(custom).replace(/\s+/g, String.raw`\s+`));
  }
  const re = new RegExp(
    String.raw`(^|[^\p{L}\p{N}])(?:${patterns.join('|')})[,:;]?(?=$|[^\p{L}\p{N}])`,
    'giu',
  );
  return text
    .replace(re, '$1')
    .replace(/^[\s,:;.!\-–—]+/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const digitsOf = (s: string) => s.replace(/\D/g, '');

/** True when `s` looks like a phone number rather than a name or email. */
export function isPhoneLike(s: string | null | undefined): boolean {
  return !!s && /^[+\d\s().\-]+$/.test(s.trim()) && digitsOf(s).length >= 7;
}

/**
 * Best-effort E.164: 10 digits are treated as North American (+1). Other numbers keep their
 * digits (with `+` if one was given). Null when there aren't enough digits to be a phone number.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw || !isPhoneLike(raw)) return null;
  const digits = digitsOf(raw);
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return raw.trim().startsWith('+') ? `+${digits}` : digits;
}

/**
 * Whether two phone numbers are the same line, ignoring formatting and country code: the last 10
 * digits must match (or all of them when one number is shorter, at least 7).
 */
export function phonesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const da = digitsOf(a ?? '');
  const db = digitsOf(b ?? '');
  const n = Math.min(10, da.length, db.length);
  return n >= 7 && da.slice(-n) === db.slice(-n);
}

/** "(555) 010-0199" for North American numbers, otherwise the number as given. */
export function formatPhone(raw: string): string {
  const digits = digitsOf(raw);
  const local = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  return local.length === 10
    ? `(${local.slice(0, 3)}) ${local.slice(3, 6)}-${local.slice(6)}`
    : raw.trim();
}

/** Hex SHA-256 (Web Crypto, available in Node and Deno). */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Idempotency key for a forwarded message. The Shortcut may retry or fire twice for the same text,
 * so sender + text + receive time identify it.
 */
export function inboxDedupeKey(input: {
  sender: string;
  senderPhone?: string | null;
  text: string;
  receivedAt: string;
}): Promise<string> {
  const who = digitsOf(input.senderPhone ?? '') || input.sender.trim().toLowerCase();
  return sha256Hex(JSON.stringify([who, input.text.trim(), input.receivedAt]));
}
