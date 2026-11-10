import type { Database } from './database.types.ts';
import type { ChairsideClient, Enums, SalonSettings, Tables, TablesInsert } from './index.ts';

type PublicSchema = Database['public'];

export type Product = Tables<'products'>;
export type StockMovement = Tables<'stock_movements'>;
export type StockMovementReason = Enums<'stock_movement_reason'>;
export type ReorderItem = PublicSchema['Views']['reorder_list']['Row'];

/** The columns members edit directly; on_hand only changes through a stock movement. */
export type ProductFields = Omit<
  TablesInsert<'products'>,
  'id' | 'salon_id' | 'on_hand' | 'created_at' | 'updated_at'
>;

/** Reasons the app can record by hand (sales come from checkout, counts from `countStock`). */
export type ManualStockReason = Exclude<StockMovementReason, 'sale' | 'count'>;

export async function listProducts(client: ChairsideClient, salonId: string): Promise<Product[]> {
  const { data, error } = await client
    .from('products')
    .select('*')
    .eq('salon_id', salonId)
    .order('name');
  if (error) throw error;
  return data;
}

export async function getProduct(client: ChairsideClient, productId: string): Promise<Product> {
  const { data, error } = await client.from('products').select('*').eq('id', productId).single();
  if (error) throw error;
  return data;
}

/** The product with this barcode in the salon, or null (the scanner then offers to add it). */
export async function findProductByBarcode(
  client: ChairsideClient,
  salonId: string,
  barcode: string,
): Promise<Product | null> {
  const { data, error } = await client
    .from('products')
    .select('*')
    .eq('salon_id', salonId)
    .eq('barcode', barcode.trim())
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function createProduct(
  client: ChairsideClient,
  salonId: string,
  fields: ProductFields,
): Promise<Product> {
  const { data, error } = await client
    .from('products')
    .insert({ ...fields, salon_id: salonId })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function updateProduct(
  client: ChairsideClient,
  productId: string,
  fields: Partial<ProductFields>,
): Promise<Product> {
  const { data, error } = await client
    .from('products')
    .update(fields)
    .eq('id', productId)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function deleteProduct(client: ChairsideClient, productId: string): Promise<void> {
  const { error } = await client.from('products').delete().eq('id', productId);
  if (error) throw error;
}

/** Adds (positive) or removes (negative) stock; returns the ledger row with the new on_hand. */
export async function adjustStock(
  client: ChairsideClient,
  productId: string,
  delta: number,
  reason: ManualStockReason = 'adjust',
  note?: string | null,
): Promise<StockMovement> {
  const { data, error } = await client.rpc('adjust_stock', {
    p_product_id: productId,
    p_delta: delta,
    p_reason: reason,
    p_note: note ?? undefined,
  });
  if (error) throw error;
  return data;
}

/** A stock count: sets on_hand to what's on the shelf. */
export async function countStock(
  client: ChairsideClient,
  productId: string,
  onHand: number,
  note?: string | null,
): Promise<StockMovement> {
  const { data, error } = await client.rpc('count_stock', {
    p_product_id: productId,
    p_on_hand: onHand,
    p_note: note ?? undefined,
  });
  if (error) throw error;
  return data;
}

export async function listStockMovements(
  client: ChairsideClient,
  productId: string,
  limit = 50,
): Promise<StockMovement[]> {
  const { data, error } = await client
    .from('stock_movements')
    .select('*')
    .eq('product_id', productId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
}

/** Active products at or below their reorder point, with a suggested order quantity. */
export async function getReorderList(
  client: ChairsideClient,
  salonId: string,
): Promise<ReorderItem[]> {
  const { data, error } = await client
    .from('reorder_list')
    .select('*')
    .eq('salon_id', salonId)
    .order('supplier', { nullsFirst: false })
    .order('name');
  if (error) throw error;
  return data;
}

export type InventorySettings = Pick<SalonSettings, 'low_stock_alerts_enabled'>;

export async function getInventorySettings(
  client: ChairsideClient,
  salonId: string,
): Promise<InventorySettings> {
  const { data, error } = await client
    .from('settings')
    .select('low_stock_alerts_enabled')
    .eq('salon_id', salonId)
    .single();
  if (error) throw error;
  return data;
}

/** Owners only (settings RLS). */
export async function updateInventorySettings(
  client: ChairsideClient,
  salonId: string,
  changes: InventorySettings,
): Promise<InventorySettings> {
  const { data, error } = await client
    .from('settings')
    .update(changes)
    .eq('salon_id', salonId)
    .select('low_stock_alerts_enabled')
    .single();
  if (error) throw error;
  return data;
}
