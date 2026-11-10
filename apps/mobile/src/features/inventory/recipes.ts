/** Pure helpers for service recipes (no React / Supabase), unit-tested in recipes.test.ts. */
import { formatQuantity, parseQuantity } from './stock';

export interface RecipeProduct {
  id: string;
  name: string;
  brand: string | null;
  unit: string;
}

export interface RecipeLineDraft {
  productId: string;
  /** As typed. */
  quantity: string;
}

export const productName = (p: Pick<RecipeProduct, 'name' | 'brand'>) =>
  p.brand ? `${p.brand} ${p.name}` : p.name;

/** "1 tube 6N · 60 ml Processing Solution", or null for no recipe. */
export function recipeSummary(
  lines: { productId: string; quantity: number }[] | undefined,
  products: RecipeProduct[],
): string | null {
  if (!lines?.length) return null;
  const byId = new Map(products.map((p) => [p.id, p]));
  return lines
    .map((l) => {
      const p = byId.get(l.productId);
      return p ? `${formatQuantity(l.quantity, p.unit)} ${productName(p)}` : null;
    })
    .filter(Boolean)
    .join(' · ');
}

/** The lines to save, or the first problem to show. */
export function parseRecipe(
  drafts: RecipeLineDraft[],
): { lines: { productId: string; quantity: number }[] } | { error: string } {
  const lines: { productId: string; quantity: number }[] = [];
  for (const d of drafts) {
    const quantity = parseQuantity(d.quantity);
    if (quantity === null || quantity <= 0) {
      return { error: 'Enter an amount above 0 for each product (up to 2 decimals).' };
    }
    lines.push({ productId: d.productId, quantity });
  }
  return { lines };
}
