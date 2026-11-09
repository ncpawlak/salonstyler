import { cardLabel, formatAmount } from '@chairside/payments';
import { getReceipt, type Receipt } from '@chairside/db/checkout';
import { useQuery } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button, Card, EmptyState, Icon, SkeletonRow, Text } from '@/components/ui';
import { supabase } from '@/lib/supabase';

/** Public receipt page (`/receipt/<token>`): the link texted or emailed to the client. */
export default function ReceiptScreen() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const receipt = useQuery({
    queryKey: ['receipt', token],
    queryFn: () => getReceipt(supabase, token),
    retry: false,
  });

  return (
    <SafeAreaView edges={['top']} className="flex-1 bg-background">
      <View className="w-full max-w-2xl flex-1 self-center">
        {router.canGoBack() ? (
          <View className="flex-row px-2 pt-1">
            <Button
              variant="ghost"
              size="icon"
              icon="chevron-back"
              accessibilityLabel="Back"
              onPress={() => router.back()}
            />
          </View>
        ) : null}
        <ScrollView className="flex-1" contentContainerClassName="px-4 pb-24 pt-6">
          {receipt.isPending ? (
            <View className="gap-3">
              <SkeletonRow />
              <SkeletonRow />
            </View>
          ) : receipt.error || !receipt.data ? (
            <EmptyState
              icon="receipt-outline"
              title="Receipt not found"
              message="This link may be mistyped, or the payment was not completed."
            />
          ) : (
            <ReceiptView receipt={receipt.data} />
          )}
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

function ReceiptView({ receipt }: { receipt: Receipt }) {
  const money = (cents: number) => formatAmount(cents, receipt.currency);
  const paidAt = new Date(receipt.paidAt).toLocaleString(undefined, {
    timeZone: receipt.timezone,
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const method =
    receipt.method === 'card'
      ? cardLabel(receipt.cardBrand, receipt.cardLast4)
      : receipt.method === 'cash'
        ? 'Cash'
        : 'Other payment';

  return (
    <View className="gap-4">
      <View className="items-center gap-2">
        <View className="h-14 w-14 items-center justify-center rounded-full bg-success">
          <Icon name="checkmark" size={32} color="success-foreground" />
        </View>
        <Text variant="title2" accessibilityRole="header" className="text-center">
          {receipt.salonName}
        </Text>
        <Text variant="subhead" tone="muted" className="text-center">
          {receipt.clientName ? `Receipt for ${receipt.clientName} · ${paidAt}` : paidAt}
        </Text>
      </View>

      <Card className="gap-3">
        {receipt.items.map((item, i) => (
          <View key={i} className="flex-row justify-between gap-3">
            <Text variant="body" className="flex-1">
              {item.quantity > 1 ? `${item.name} × ${item.quantity}` : item.name}
            </Text>
            <Text variant="body" numeric>
              {money(item.amountCents)}
            </Text>
          </View>
        ))}
        <View className="h-px bg-border" />
        <Row label="Subtotal" value={money(receipt.subtotalCents)} />
        {receipt.tipCents > 0 ? <Row label="Tip" value={money(receipt.tipCents)} /> : null}
        {receipt.depositCents > 0 ? (
          <Row label="Deposit" value={`−${money(receipt.depositCents)}`} />
        ) : null}
        <View className="flex-row items-end justify-between pt-1">
          <Text variant="headline">Paid</Text>
          <Text variant="title2" numeric>
            {money(receipt.amountDueCents)}
          </Text>
        </View>
        <Row label="Payment" value={method} />
        {receipt.refundedCents > 0 ? (
          <Row label="Refunded" value={`−${money(receipt.refundedCents)}`} />
        ) : null}
      </Card>

      <Text variant="footnote" tone="subtle" className="text-center">
        Thank you!
      </Text>
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row justify-between">
      <Text variant="subhead" tone="muted">
        {label}
      </Text>
      <Text variant="subhead" numeric>
        {value}
      </Text>
    </View>
  );
}
