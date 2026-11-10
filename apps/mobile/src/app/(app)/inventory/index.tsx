import { router } from 'expo-router';
import { useState } from 'react';
import { Switch, View } from 'react-native';

import { DetailScreen } from '@/components/shell/screen';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  ListGroup,
  ListRow,
  SectionHeader,
  SkeletonRow,
  Text,
} from '@/components/ui';
import { errorMessage } from '@/features/appointments/api';
import {
  useInventorySettings,
  useProducts,
  useUpdateInventorySettings,
} from '@/features/inventory/api';
import { formatQuantity, isLowStock, matchesProduct, stockState } from '@/features/inventory/stock';
import { useCurrentSalon } from '@/providers/session-provider';

/** Settings → Inventory: retail and back-bar products with what's on the shelf. */
export default function InventoryScreen() {
  const salon = useCurrentSalon();
  const isOwner = salon.role === 'owner';
  const products = useProducts();
  const settings = useInventorySettings();
  const updateSettings = useUpdateInventorySettings();
  const [query, setQuery] = useState('');

  const all = products.data ?? [];
  const low = all.filter(isLowStock);
  const shown = all.filter((p) => matchesProduct(p, query));
  const active = shown.filter((p) => p.active);
  const archived = shown.filter((p) => !p.active);

  return (
    <DetailScreen
      title="Inventory"
      right={
        <Button
          size="sm"
          icon="add"
          label="New"
          accessibilityLabel="New product"
          onPress={() => router.push({ pathname: '/inventory/[id]', params: { id: 'new' } })}
        />
      }
    >
      <View className="flex-row gap-3">
        <Button
          label="Scan"
          icon="barcode-outline"
          grow
          onPress={() => router.push('/inventory/scan')}
        />
        <Button
          variant="secondary"
          label={low.length ? `Reorder (${low.length})` : 'Reorder'}
          icon="cart-outline"
          grow
          onPress={() => router.push('/inventory/reorder')}
        />
      </View>

      {products.isPending ? (
        <View className="gap-3 pt-4">
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </View>
      ) : products.error ? (
        <EmptyState
          icon="cloud-offline-outline"
          title="Couldn't load products"
          message={errorMessage(products.error)}
          actionLabel="Try again"
          onAction={() => void products.refetch()}
        />
      ) : all.length === 0 ? (
        <EmptyState
          icon="cube-outline"
          title="No products yet"
          message="Scan a barcode or add products by hand to track what's on the shelf."
          actionLabel="Scan a product"
          onAction={() => router.push('/inventory/scan')}
        />
      ) : (
        <View>
          <View className="pt-4">
            <Input
              accessibilityLabel="Search products"
              placeholder="Search name, brand, SKU or barcode"
              icon="search"
              value={query}
              onChangeText={setQuery}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
          <ProductGroup title={`Products (${active.length})`} products={active} />
          {archived.length > 0 ? <ProductGroup title="Archived" products={archived} /> : null}
          {shown.length === 0 ? (
            <Text variant="footnote" tone="muted" className="px-1 pt-4">
              No products match “{query.trim()}”.
            </Text>
          ) : null}
        </View>
      )}

      {settings.data ? (
        <View>
          <SectionHeader title="Alerts" />
          <Card className="flex-row items-center gap-3">
            <View className="flex-1 gap-0.5">
              <Text variant="body">Low-stock alerts</Text>
              <Text variant="footnote" tone="muted">
                Push the owner when a product drops to its reorder point.
              </Text>
            </View>
            <Switch
              accessibilityLabel="Low-stock alerts"
              value={settings.data.low_stock_alerts_enabled}
              disabled={!isOwner || updateSettings.isPending}
              onValueChange={(v) => updateSettings.mutate({ low_stock_alerts_enabled: v })}
            />
          </Card>
          {!isOwner ? (
            <Text variant="footnote" tone="muted" className="px-1 pt-2">
              Only the salon owner can change this.
            </Text>
          ) : null}
          {updateSettings.error ? (
            <Text variant="footnote" tone="destructive" className="px-1 pt-2">
              {errorMessage(updateSettings.error)}
            </Text>
          ) : null}
        </View>
      ) : null}
    </DetailScreen>
  );
}

function ProductGroup({
  title,
  products,
}: {
  title: string;
  products: NonNullable<ReturnType<typeof useProducts>['data']>;
}) {
  if (products.length === 0) return null;
  return (
    <View>
      <SectionHeader title={title} />
      <ListGroup>
        {products.map((p, i) => {
          const state = stockState(p);
          return (
            <ListRow
              key={p.id}
              title={p.brand ? `${p.brand} ${p.name}` : p.name}
              subtitle={[p.category, p.retail_price_cents === null ? 'Back bar' : null]
                .filter(Boolean)
                .join(' · ')}
              trailing={
                <View className="flex-row items-center gap-2">
                  {p.active && state !== 'ok' ? (
                    <Badge
                      label={state === 'out' ? 'Out' : 'Low'}
                      tone={state === 'out' ? 'destructive' : 'warning'}
                    />
                  ) : null}
                  <Text variant="subhead" tone="muted" numeric>
                    {formatQuantity(p.on_hand, p.unit)}
                  </Text>
                </View>
              }
              chevron
              onPress={() => router.push({ pathname: '/inventory/[id]', params: { id: p.id } })}
              last={i === products.length - 1}
            />
          );
        })}
      </ListGroup>
    </View>
  );
}
