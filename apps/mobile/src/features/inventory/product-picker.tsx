import { View } from 'react-native';

import { Button, ListGroup, ListRow, Text } from '@/components/ui';

import { useProducts } from './api';
import { formatQuantity, matchesProduct } from './stock';

export type PickedProduct = { id: string; name: string; unitAmountCents: number };

/**
 * Under a checkout retail line: suggests in-stock retail products matching what's typed, and shows
 * which product the line is linked to. A linked line takes stock off the shelf when paid.
 */
export function ProductPicker({
  query,
  linkedId,
  onPick,
  onUnlink,
}: {
  query: string;
  linkedId: string | null;
  onPick: (product: PickedProduct) => void;
  onUnlink: () => void;
}) {
  const products = useProducts();
  const retail = (products.data ?? []).filter((p) => p.active && p.retail_price_cents !== null);
  const linked = linkedId ? products.data?.find((p) => p.id === linkedId) : undefined;

  if (linkedId) {
    return (
      <View className="flex-row items-center gap-2">
        <Text variant="footnote" tone="muted" className="flex-1">
          {linked
            ? `From inventory · ${formatQuantity(linked.on_hand, linked.unit)} on hand`
            : 'From inventory'}
        </Text>
        <Button variant="ghost" size="sm" label="Unlink" onPress={onUnlink} />
      </View>
    );
  }
  if (retail.length === 0) return null;

  const matches = retail.filter((p) => matchesProduct(p, query)).slice(0, 4);
  if (matches.length === 0) return null;
  return (
    <View className="gap-1">
      <Text variant="footnote" tone="muted" className="px-1">
        From inventory
      </Text>
      <ListGroup>
        {matches.map((p, i) => {
          const name = p.brand ? `${p.brand} ${p.name}` : p.name;
          return (
            <ListRow
              key={p.id}
              title={name}
              subtitle={`${formatQuantity(p.on_hand, p.unit)} on hand`}
              trailing={
                <Text variant="subhead" tone="muted" numeric>
                  {((p.retail_price_cents ?? 0) / 100).toFixed(2)}
                </Text>
              }
              onPress={() => onPick({ id: p.id, name, unitAmountCents: p.retail_price_cents ?? 0 })}
              last={i === matches.length - 1}
            />
          );
        })}
      </ListGroup>
    </View>
  );
}
