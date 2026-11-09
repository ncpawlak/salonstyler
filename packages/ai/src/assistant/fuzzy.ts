/** Fuzzy client-name matching for "schedule karina…" style requests. */

export const normalizeName = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length]!;
}

const similarity = (a: string, b: string) =>
  1 - levenshtein(a, b) / Math.max(a.length, b.length, 1);

/**
 * How well `query` matches `name`, 0…1. Exact name 1, exact first/last name 0.95, prefix 0.85,
 * substring 0.7, otherwise a typo-tolerant edit-distance score (Karina ≈ Carina ≈ Karena).
 */
export function nameMatchScore(query: string, name: string): number {
  const q = normalizeName(query);
  const n = normalizeName(name);
  if (!q || !n) return 0;
  if (q === n) return 1;
  const tokens = n.split(' ');
  const qTokens = q.split(' ');
  if (qTokens.length === 1 && tokens.includes(q)) return 0.95;
  if (qTokens.length > 1 && qTokens.every((t) => tokens.includes(t))) return 0.95;
  if (n.startsWith(q) || tokens.some((t) => t.startsWith(q))) return q.length >= 2 ? 0.85 : 0.5;
  if (n.includes(q)) return 0.7;
  // Typo tolerance: compare each query token with its best name token.
  const perToken = qTokens.map((qt) => Math.max(...tokens.map((t) => similarity(qt, t))));
  const tokenScore = perToken.reduce((a, b) => a + b, 0) / perToken.length;
  return Math.max(tokenScore, similarity(q, n)) * 0.8;
}

export const MATCH_THRESHOLD = 0.55;
/** At or above this a single match is unambiguous enough to act on. */
export const CONFIDENT_MATCH = 0.85;

export function rankByName<T extends { name: string }>(
  query: string,
  items: readonly T[],
  limit = 5,
): { item: T; score: number }[] {
  return items
    .map((item) => ({ item, score: nameMatchScore(query, item.name) }))
    .filter((m) => m.score >= MATCH_THRESHOLD)
    .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name))
    .slice(0, limit);
}
