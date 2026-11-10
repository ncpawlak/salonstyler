import type { Product } from '@chairside/db/inventory';
import type { RecipeLine } from '@chairside/db/recipes';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { DetailScreen } from '@/components/shell/screen';
import {
  Button,
  Card,
  Chip,
  EmptyState,
  Input,
  SectionHeader,
  SkeletonRow,
  Text,
} from '@/components/ui';
import { errorMessage } from '@/features/appointments/api';
import { useProducts } from '@/features/inventory/api';
import { parseRecipe, productName, type RecipeLineDraft } from '@/features/inventory/recipes';
import { useServiceRecipe, useSetServiceRecipe } from '@/features/inventory/recipes-api';
import { formatQuantity, matchesProduct } from '@/features/inventory/stock';
import { useServiceMenu } from '@/features/services/data';
import { haptics } from '@/lib/haptics';

/** One service's recipe: the products (and amounts) one appointment of it uses. */
export default function ServiceRecipeScreen() {
  const { serviceId } = useLocalSearchParams<{ serviceId: string }>();
  const menu = useServiceMenu();
  const recipe = useServiceRecipe(serviceId);
  const products = useProducts();

  const service = menu.data?.services.find((s) => s.id === serviceId);
  const loading = menu.isPending || recipe.isPending || products.isPending;
  const error = menu.error ?? recipe.error ?? products.error;

  return (
    <DetailScreen title={service?.name ?? 'Recipe'}>
      {loading ? (
        <View className="gap-3">
          <SkeletonRow />
          <SkeletonRow />
        </View>
      ) : error || !service || !recipe.data ? (
        <EmptyState
          icon="cloud-offline-outline"
          title="Couldn't load this recipe"
          message={error ? errorMessage(error) : undefined}
          actionLabel="Try again"
          onAction={() => {
            void menu.refetch();
            void recipe.refetch();
            void products.refetch();
          }}
        />
      ) : (
        <RecipeForm
          serviceId={serviceId}
          initial={recipe.data}
          products={products.data ?? []}
          canEdit={menu.canEdit}
        />
      )}
    </DetailScreen>
  );
}

function RecipeForm({
  serviceId,
  initial,
  products,
  canEdit,
}: {
  serviceId: string;
  initial: RecipeLine[];
  products: Product[];
  canEdit: boolean;
}) {
  const save = useSetServiceRecipe(serviceId);
  const [lines, setLines] = useState<RecipeLineDraft[]>(() =>
    initial.map((l) => ({ productId: l.productId, quantity: String(l.quantity) })),
  );
  const [query, setQuery] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const byId = new Map(products.map((p) => [p.id, p]));
  const used = new Set(lines.map((l) => l.productId));
  const choices = products
    .filter((p) => p.active && !used.has(p.id) && matchesProduct(p, query))
    .slice(0, 12);

  const update = (next: RecipeLineDraft[]) => {
    setLines(next);
    setProblem(null);
  };

  const onSave = () => {
    const parsed = parseRecipe(lines);
    if ('error' in parsed) {
      setProblem(parsed.error);
      haptics.error();
      return;
    }
    save.mutate(parsed.lines, {
      onSuccess: () => {
        haptics.success();
        router.back();
      },
      onError: () => haptics.error(),
    });
  };

  if (!canEdit) {
    return (
      <View className="gap-3">
        {initial.length === 0 ? (
          <Text tone="muted">No recipe — completing this service doesn&apos;t use any stock.</Text>
        ) : (
          <Card className="gap-2">
            {initial.map((l) => {
              const p = byId.get(l.productId);
              return (
                <Text key={l.productId} variant="body">
                  {p
                    ? `${formatQuantity(l.quantity, p.unit)} ${productName(p)}`
                    : 'Unknown product'}
                </Text>
              );
            })}
          </Card>
        )}
        <Text variant="footnote" tone="muted" className="px-1">
          Only the salon owner can change recipes.
        </Text>
      </View>
    );
  }

  return (
    <View>
      <Text variant="footnote" tone="muted" className="px-1">
        Amounts are per appointment, in each product&apos;s unit. Stock comes out when the
        appointment is completed or checked out.
      </Text>

      <SectionHeader title="Uses" />
      {lines.length === 0 ? (
        <Text tone="muted" className="px-1">
          No products yet — add what this service uses below.
        </Text>
      ) : (
        <View className="gap-2">
          {lines.map((line, i) => {
            const p = byId.get(line.productId);
            return (
              <Card key={line.productId} className="flex-row items-center gap-3">
                <View className="flex-1">
                  <Text variant="body" numberOfLines={2}>
                    {p ? productName(p) : 'Unknown product'}
                  </Text>
                </View>
                <View className="w-24">
                  <Input
                    accessibilityLabel={`Amount of ${p ? productName(p) : 'product'}`}
                    value={line.quantity}
                    onChangeText={(quantity) =>
                      update(lines.map((l, j) => (j === i ? { ...l, quantity } : l)))
                    }
                    keyboardType="decimal-pad"
                    placeholder="0"
                  />
                </View>
                <Text variant="subhead" tone="muted" className="w-10">
                  {p?.unit ?? ''}
                </Text>
                <Button
                  size="icon"
                  variant="ghost"
                  icon="close"
                  accessibilityLabel={`Remove ${p ? productName(p) : 'product'}`}
                  onPress={() => update(lines.filter((_, j) => j !== i))}
                />
              </Card>
            );
          })}
        </View>
      )}

      <SectionHeader title="Add a product" />
      {products.some((p) => p.active) ? (
        <View className="gap-3">
          <Input
            accessibilityLabel="Search products"
            placeholder="Search name, brand or SKU"
            icon="search"
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <View className="flex-row flex-wrap gap-2">
            {choices.map((p) => (
              <Chip
                key={p.id}
                icon="add"
                label={productName(p)}
                onPress={() => {
                  update([...lines, { productId: p.id, quantity: '1' }]);
                  setQuery('');
                }}
              />
            ))}
          </View>
          {choices.length === 0 ? (
            <Text variant="footnote" tone="muted" className="px-1">
              {query.trim()
                ? `No products match “${query.trim()}”.`
                : 'Every active product is already in this recipe.'}
            </Text>
          ) : null}
        </View>
      ) : (
        <Text tone="muted" className="px-1">
          Add products in Inventory first.
        </Text>
      )}

      {problem || save.error ? (
        <Text variant="footnote" tone="destructive" className="px-1 pt-4">
          {problem ?? errorMessage(save.error)}
        </Text>
      ) : null}
      <View className="pt-6">
        <Button label="Save recipe" fullWidth loading={save.isPending} onPress={onSave} />
      </View>
    </View>
  );
}
