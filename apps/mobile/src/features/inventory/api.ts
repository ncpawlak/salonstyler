import {
  adjustStock,
  countStock,
  createProduct,
  deleteProduct,
  findProductByBarcode,
  getInventorySettings,
  getProduct,
  getReorderList,
  listProducts,
  listStockMovements,
  updateInventorySettings,
  updateProduct,
  type InventorySettings,
  type ManualStockReason,
  type Product,
  type ProductFields,
} from '@chairside/db/inventory';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';
import { useCurrentSalon } from '@/providers/session-provider';

export const productsKey = (salonId: string) => ['products', salonId] as const;
const productKey = (productId: string) => ['product', productId] as const;
const movementsKey = (productId: string) => ['stock-movements', productId] as const;
const reorderKey = (salonId: string) => ['reorder-list', salonId] as const;
const settingsKey = (salonId: string) => ['inventory-settings', salonId] as const;

export function useProducts() {
  const salon = useCurrentSalon();
  return useQuery({
    queryKey: productsKey(salon.id),
    queryFn: () => listProducts(supabase, salon.id),
  });
}

export function useProduct(productId: string | undefined) {
  return useQuery({
    queryKey: productKey(productId ?? ''),
    enabled: !!productId,
    queryFn: () => getProduct(supabase, productId!),
  });
}

export function useStockMovements(productId: string | undefined) {
  return useQuery({
    queryKey: movementsKey(productId ?? ''),
    enabled: !!productId,
    queryFn: () => listStockMovements(supabase, productId!),
  });
}

export function useReorderList() {
  const salon = useCurrentSalon();
  return useQuery({
    queryKey: reorderKey(salon.id),
    queryFn: () => getReorderList(supabase, salon.id),
  });
}

/** Refreshes every inventory view after a product or its stock changes. */
function useInvalidateInventory() {
  const salon = useCurrentSalon();
  const queryClient = useQueryClient();
  return (productId?: string) =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: productsKey(salon.id) }),
      queryClient.invalidateQueries({ queryKey: reorderKey(salon.id) }),
      productId ? queryClient.invalidateQueries({ queryKey: productKey(productId) }) : null,
      productId ? queryClient.invalidateQueries({ queryKey: movementsKey(productId) }) : null,
    ]);
}

export function useSaveProduct() {
  const salon = useCurrentSalon();
  const invalidate = useInvalidateInventory();
  return useMutation({
    mutationFn: ({ id, fields }: { id?: string; fields: ProductFields }) =>
      id ? updateProduct(supabase, id, fields) : createProduct(supabase, salon.id, fields),
    onSuccess: (product: Product) => invalidate(product.id),
  });
}

export function useDeleteProduct() {
  const invalidate = useInvalidateInventory();
  return useMutation({
    mutationFn: (productId: string) => deleteProduct(supabase, productId),
    onSuccess: () => invalidate(),
  });
}

export type StockChange =
  | { productId: string; kind: 'adjust'; delta: number; reason: ManualStockReason; note?: string }
  | { productId: string; kind: 'count'; onHand: number; note?: string };

export function useChangeStock() {
  const invalidate = useInvalidateInventory();
  return useMutation({
    mutationFn: (change: StockChange) =>
      change.kind === 'count'
        ? countStock(supabase, change.productId, change.onHand, change.note)
        : adjustStock(supabase, change.productId, change.delta, change.reason, change.note),
    onSuccess: (_movement, change) => invalidate(change.productId),
  });
}

/** Looks a scanned barcode up in this salon's products. */
export function useFindByBarcode() {
  const salon = useCurrentSalon();
  return useMutation({
    mutationFn: (barcode: string) => findProductByBarcode(supabase, salon.id, barcode),
  });
}

export function useInventorySettings() {
  const salon = useCurrentSalon();
  return useQuery({
    queryKey: settingsKey(salon.id),
    queryFn: () => getInventorySettings(supabase, salon.id),
  });
}

export function useUpdateInventorySettings() {
  const salon = useCurrentSalon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (changes: InventorySettings) =>
      updateInventorySettings(supabase, salon.id, changes),
    onSuccess: (data) => queryClient.setQueryData(settingsKey(salon.id), data),
  });
}
