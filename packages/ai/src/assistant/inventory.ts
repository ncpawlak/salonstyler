/** Product matching and formatting shared by the inventory tools (issue #18). */
import { CONFIDENT_MATCH, MATCH_THRESHOLD, nameMatchScore, normalizeName } from './fuzzy.ts';
import type { AssistantProduct } from './types.ts';

/** "2", "2.5 tubes", "60 ml" (no unit for "each"). */
export function formatStock(quantity: number, unit: string): string {
  const n = Number(quantity.toFixed(2)).toString();
  const u = unit.trim();
  return !u || u.toLowerCase() === 'each' ? n : `${n} ${u}`;
}

/** Best product matches for "6N", "shades eq 6n", a SKU or a barcode, best first. */
export function matchProducts(
  query: string,
  products: readonly AssistantProduct[],
  limit = 5,
): { product: AssistantProduct; score: number }[] {
  const q = normalizeName(query);
  return products
    .map((product) => {
      const exactCode = [product.sku, product.barcode].some(
        (code) => code && normalizeName(code) === q,
      );
      const score = exactCode
        ? 1
        : Math.max(
            nameMatchScore(query, product.name),
            product.brand ? nameMatchScore(query, `${product.brand} ${product.name}`) : 0,
          );
      return { product, score };
    })
    .filter((m) => m.score >= MATCH_THRESHOLD)
    .sort((a, b) => b.score - a.score || a.product.name.localeCompare(b.product.name))
    .slice(0, limit);
}

/** The one product a query clearly means, or the candidates to ask about. */
export function resolveProduct(
  query: string,
  products: readonly AssistantProduct[],
): { product: AssistantProduct } | { candidates: AssistantProduct[] } {
  const ranked = matchProducts(query, products);
  const confident = ranked.filter((m) => m.score >= CONFIDENT_MATCH);
  const top = confident[0];
  // A clearly better match wins ("6N" vs "6NB" when one is exact).
  if (top && (confident.length === 1 || top.score > confident[1]!.score)) {
    return { product: top.product };
  }
  return { candidates: (confident.length ? confident : ranked).map((m) => m.product) };
}

export const productLabel = (p: AssistantProduct) => (p.brand ? `${p.brand} ${p.name}` : p.name);

export const productSummary = (p: AssistantProduct) => ({
  id: p.id,
  name: productLabel(p),
  onHand: formatStock(p.onHand, p.unit),
  reorderPoint: formatStock(p.reorderPoint, p.unit),
  low: p.onHand <= p.reorderPoint,
});
