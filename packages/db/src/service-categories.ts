import type { ChairsideClient } from './index.ts';

/** The salon's category names in display order (members read; see service_categories). */
export async function listServiceCategories(
  client: ChairsideClient,
  salonId: string,
): Promise<string[]> {
  const { data, error } = await client
    .from('service_categories')
    .select('name, position')
    .eq('salon_id', salonId)
    .order('position')
    .order('name');
  if (error) throw error;
  return data.map((c) => c.name);
}

/**
 * Display order for categories: the saved list first, then any category a service uses that the
 * list doesn't have yet (e.g. after restoring an older export), in first-seen order.
 */
export function orderCategories(listed: readonly string[], used: readonly string[]): string[] {
  const out = [...new Set(listed)];
  for (const name of used) if (!out.includes(name)) out.push(name);
  return out;
}

async function rpc(call: PromiseLike<{ error: { message: string } | null }>): Promise<void> {
  const { error } = await call;
  if (error) throw error;
}

/** Adds a category at the end (no-op if it exists). Owners only. */
export function addServiceCategory(client: ChairsideClient, salonId: string, name: string) {
  return rpc(client.rpc('add_service_category', { p_salon_id: salonId, p_name: name }));
}

/** Renames a category and every service in it; onto an existing name it merges. Owners only. */
export function renameServiceCategory(
  client: ChairsideClient,
  salonId: string,
  from: string,
  to: string,
) {
  return rpc(
    client.rpc('rename_service_category', { p_salon_id: salonId, p_from: from, p_to: to }),
  );
}

/** Removes a category; one with services needs `moveTo` (they move there). Owners only. */
export function deleteServiceCategory(
  client: ChairsideClient,
  salonId: string,
  name: string,
  moveTo?: string,
) {
  return rpc(
    client.rpc('delete_service_category', {
      p_salon_id: salonId,
      p_name: name,
      ...(moveTo ? { p_move_to: moveTo } : {}),
    }),
  );
}

/** Saves the display order. Owners only. */
export function reorderServiceCategories(
  client: ChairsideClient,
  salonId: string,
  names: readonly string[],
) {
  return rpc(
    client.rpc('reorder_service_categories', { p_salon_id: salonId, p_names: [...names] }),
  );
}
