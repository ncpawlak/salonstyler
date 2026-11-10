import { orderCategories } from '@chairside/db/service-categories';
import type { ServiceMenu } from '@chairside/db/services';

type MenuLike = Pick<ServiceMenu, 'services' | 'combos' | 'categories'>;

/** Category names in display order, including any only used by services. */
export function menuCategories(menu: MenuLike): string[] {
  return orderCategories(
    menu.categories ?? [],
    [...menu.services, ...menu.combos].map((s) => s.category),
  );
}

/** Number of services and combos (archived included) filed under each category. */
export function categoryCounts(menu: Pick<ServiceMenu, 'services' | 'combos'>) {
  const counts = new Map<string, number>();
  for (const s of [...menu.services, ...menu.combos]) {
    counts.set(s.category, (counts.get(s.category) ?? 0) + 1);
  }
  return counts;
}

/** The existing category matching `name` ignoring case and spacing, else the cleaned-up name. */
export function canonicalCategory(categories: readonly string[], name: string): string {
  const cleaned = name.trim().replace(/\s+/g, ' ');
  return categories.find((c) => c.toLowerCase() === cleaned.toLowerCase()) ?? cleaned;
}

/** `names` with the item at `index` moved by `delta` (clamped). */
export function moveCategory(names: readonly string[], index: number, delta: number): string[] {
  const to = Math.max(0, Math.min(names.length - 1, index + delta));
  const out = [...names];
  const [item] = out.splice(index, 1);
  if (item !== undefined) out.splice(to, 0, item);
  return out;
}
