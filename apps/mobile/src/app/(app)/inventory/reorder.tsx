import { getStripeAccount } from '@chairside/db/payments';
import { formatAmount } from '@chairside/payments';
import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { Platform, Share, View } from 'react-native';

import { DetailScreen } from '@/components/shell/screen';
import {
  Button,
  Card,
  EmptyState,
  ListGroup,
  ListRow,
  SectionHeader,
  SkeletonRow,
  Text,
} from '@/components/ui';
import { errorMessage } from '@/features/appointments/api';
import { useReorderList } from '@/features/inventory/api';
import {
  formatQuantity,
  groupBySupplier,
  reorderCsv,
  reorderTotalCents,
} from '@/features/inventory/stock';
import { supabase } from '@/lib/supabase';
import { useCurrentSalon } from '@/providers/session-provider';

/** Everything at or below its reorder point, grouped by supplier, exportable as CSV. */
export default function ReorderScreen() {
  const salon = useCurrentSalon();
  const list = useReorderList();
  const [exportError, setExportError] = useState<string | null>(null);
  const rows = list.data ?? [];
  const totalCents = reorderTotalCents(rows);
  // Checkouts are priced in the Stripe account's currency (USD until one is connected).
  const account = useQuery({
    queryKey: ['stripe-account', salon.id],
    queryFn: () => getStripeAccount(supabase, salon.id),
  });
  const currency = account.data?.default_currency?.toLowerCase() ?? 'usd';

  const exportCsv = async () => {
    setExportError(null);
    const csv = reorderCsv(rows);
    const filename = `reorder-${new Date().toISOString().slice(0, 10)}.csv`;
    try {
      if (Platform.OS === 'web') {
        const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
      } else {
        await Share.share({ title: filename, message: csv });
      }
    } catch (e) {
      setExportError(errorMessage(e));
    }
  };

  return (
    <DetailScreen
      title="Reorder list"
      right={
        rows.length > 0 ? (
          <Button
            size="sm"
            variant="secondary"
            icon="share-outline"
            label="CSV"
            accessibilityLabel="Export reorder list as CSV"
            onPress={() => void exportCsv()}
          />
        ) : null
      }
    >
      {list.isPending ? (
        <View className="gap-3">
          <SkeletonRow />
          <SkeletonRow />
        </View>
      ) : list.error ? (
        <EmptyState
          icon="cloud-offline-outline"
          title="Couldn't load the reorder list"
          message={errorMessage(list.error)}
          actionLabel="Try again"
          onAction={() => void list.refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="checkmark-circle-outline"
          title="Nothing to reorder"
          message="Products show up here when they drop to their reorder point."
        />
      ) : (
        <View>
          <Card className="flex-row items-center gap-3">
            <View className="flex-1 gap-0.5">
              <Text variant="headline">
                {rows.length} {rows.length === 1 ? 'product' : 'products'} to order
              </Text>
              <Text variant="footnote" tone="muted">
                Quantities are each product’s order qty, or enough for twice the reorder point.
              </Text>
            </View>
            {totalCents > 0 ? (
              <Text variant="headline" numeric>
                ≈ {formatAmount(totalCents, currency)}
              </Text>
            ) : null}
          </Card>
          {exportError ? (
            <Text variant="footnote" tone="destructive" className="px-1 pt-2">
              {exportError}
            </Text>
          ) : null}

          {groupBySupplier(rows).map((group) => (
            <View key={group.supplier ?? '—'}>
              <SectionHeader title={group.supplier ?? 'No supplier'} />
              <ListGroup>
                {group.rows.map((r, i) => (
                  <ListRow
                    key={r.id ?? i}
                    title={r.brand ? `${r.brand} ${r.name}` : (r.name ?? '')}
                    subtitle={`${formatQuantity(r.on_hand ?? 0)} on hand · reorder at ${formatQuantity(r.reorder_point ?? 0)}`}
                    trailing={
                      <Text variant="headline" numeric>
                        × {formatQuantity(r.suggested_quantity ?? 0, r.unit)}
                      </Text>
                    }
                    onPress={
                      r.id
                        ? () => router.push({ pathname: '/inventory/[id]', params: { id: r.id! } })
                        : undefined
                    }
                    last={i === group.rows.length - 1}
                  />
                ))}
              </ListGroup>
            </View>
          ))}
        </View>
      )}
    </DetailScreen>
  );
}
