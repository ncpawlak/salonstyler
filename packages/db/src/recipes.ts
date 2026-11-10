import type { ChairsideClient, Tables } from './index.ts';

export type ServiceRecipeRow = Tables<'service_recipes'>;

/** One line of a recipe: how much of a product (in the product's unit) a service uses. */
export interface RecipeLine {
  productId: string;
  quantity: number;
}

/** Every recipe in the salon, grouped by service id (services without a recipe are absent). */
export async function listServiceRecipes(
  client: ChairsideClient,
  salonId: string,
): Promise<Map<string, RecipeLine[]>> {
  const { data, error } = await client
    .from('service_recipes')
    .select('service_id, product_id, quantity')
    .eq('salon_id', salonId)
    .order('created_at')
    .order('id');
  if (error) throw error;
  const byService = new Map<string, RecipeLine[]>();
  for (const row of data) {
    const lines = byService.get(row.service_id) ?? [];
    lines.push({ productId: row.product_id, quantity: Number(row.quantity) });
    byService.set(row.service_id, lines);
  }
  return byService;
}

export async function getServiceRecipe(
  client: ChairsideClient,
  serviceId: string,
): Promise<RecipeLine[]> {
  const { data, error } = await client
    .from('service_recipes')
    .select('product_id, quantity')
    .eq('service_id', serviceId)
    .order('created_at')
    .order('id');
  if (error) throw error;
  return data.map((r) => ({ productId: r.product_id, quantity: Number(r.quantity) }));
}

/**
 * Replaces a service's recipe (owners only; `[]` clears it). Completing an appointment, or paying
 * its checkout, then deducts these quantities from stock once.
 */
export async function setServiceRecipe(
  client: ChairsideClient,
  serviceId: string,
  lines: RecipeLine[],
): Promise<RecipeLine[]> {
  const { data, error } = await client.rpc('set_service_recipe', {
    p_service_id: serviceId,
    p_lines: lines.map((l) => ({ productId: l.productId, quantity: l.quantity })),
  });
  if (error) throw error;
  return data.map((r) => ({ productId: r.product_id, quantity: Number(r.quantity) }));
}
