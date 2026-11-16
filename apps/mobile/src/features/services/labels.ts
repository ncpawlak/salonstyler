import type { ServiceMenu } from '@chairside/db/services';

/**
 * Distinct segment labels used across the salon's services and add-ons, most used first (ties
 * alphabetical). Labels differing only in case or spacing count as one, shown as most often typed.
 */
export function segmentLabels(menu: Pick<ServiceMenu, 'services' | 'addons'>): string[] {
  const byKey = new Map<string, { count: number; spellings: Map<string, number> }>();
  const segments = [...menu.services, ...menu.addons].flatMap((s) => s.segments);
  for (const { label } of segments) {
    const text = label?.trim().replace(/\s+/g, ' ');
    if (!text) continue;
    const key = text.toLowerCase();
    const entry = byKey.get(key) ?? { count: 0, spellings: new Map() };
    entry.count += 1;
    entry.spellings.set(text, (entry.spellings.get(text) ?? 0) + 1);
    byKey.set(key, entry);
  }
  return [...byKey.values()]
    .map(({ count, spellings }) => ({
      count,
      label: [...spellings].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0],
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .map((l) => l.label);
}

/**
 * Suggestions for what's typed so far: labels containing it (prefix matches first), excluding
 * an exact match of what's already there.
 */
export function filterLabels(labels: readonly string[], typed: string, limit = 8): string[] {
  const q = typed.trim().toLowerCase();
  const matches = labels.filter((l) => {
    const lower = l.toLowerCase();
    return lower !== q && lower.includes(q);
  });
  if (q) matches.sort((a, b) => +!a.toLowerCase().startsWith(q) - +!b.toLowerCase().startsWith(q));
  return matches.slice(0, limit);
}
