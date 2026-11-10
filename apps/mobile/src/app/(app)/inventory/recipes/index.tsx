import { router } from 'expo-router';
import { View } from 'react-native';

import { DetailScreen } from '@/components/shell/screen';
import { EmptyState, ListGroup, ListRow, SectionHeader, SkeletonRow, Text } from '@/components/ui';
import { errorMessage } from '@/features/appointments/api';
import { useProducts } from '@/features/inventory/api';
import { recipeSummary } from '@/features/inventory/recipes';
import { useServiceRecipes } from '@/features/inventory/recipes-api';
import { useServiceMenu } from '@/features/services/data';

/** Settings → Service recipes: what each service uses from the back bar. */
export default function ServiceRecipesScreen() {
  const menu = useServiceMenu();
  const recipes = useServiceRecipes();
  const products = useProducts();

  const loading = menu.isPending || recipes.isPending || products.isPending;
  const error = menu.error ?? recipes.error ?? products.error;
  const services = (menu.data?.services ?? []).filter((s) => !s.archivedAt);

  return (
    <DetailScreen title="Service recipes">
      <Text variant="footnote" tone="muted" className="px-1">
        When an appointment is completed or checked out, Chairside takes each service&apos;s recipe
        out of inventory — once per appointment. Combos use the recipes of their services.
      </Text>
      {loading ? (
        <View className="gap-3 pt-4">
          <SkeletonRow />
          <SkeletonRow />
        </View>
      ) : error ? (
        <EmptyState
          icon="cloud-offline-outline"
          title="Couldn't load recipes"
          message={errorMessage(error)}
          actionLabel="Try again"
          onAction={() => {
            void menu.refetch();
            void recipes.refetch();
            void products.refetch();
          }}
        />
      ) : services.length === 0 ? (
        <EmptyState
          icon="color-palette-outline"
          title="No services yet"
          message="Add services to your menu, then set what product each one uses."
        />
      ) : (
        <View>
          <SectionHeader title="Services" />
          <ListGroup>
            {services.map((s, i) => (
              <ListRow
                key={s.id}
                title={s.name}
                subtitle={
                  recipeSummary(recipes.data?.get(s.id), products.data ?? []) || 'No recipe'
                }
                chevron
                onPress={() =>
                  router.push({
                    pathname: '/inventory/recipes/[serviceId]',
                    params: { serviceId: s.id },
                  })
                }
                last={i === services.length - 1}
              />
            ))}
          </ListGroup>
        </View>
      )}
    </DetailScreen>
  );
}
