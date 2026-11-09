import { cardLabel, formatAmount } from '@chairside/payments';
import { getPayoutSummary, listPaidCheckouts, type PaidCheckout } from '@chairside/db';
import { useMutation, useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import {
  Badge,
  Button,
  Card,
  ListGroup,
  ListRow,
  SectionHeader,
  SkeletonRow,
  Text,
} from '@/components/ui';
import { supabase } from '@/lib/supabase';
import { useCurrentSalon } from '@/providers/session-provider';

import { checkoutErrorMessage, invokeCheckout, useInvalidateAfterPayment } from './api';

/** Today's takings by method (salon timezone). The evening push summarises the same numbers. */
export function TodayTakings() {
  const salon = useCurrentSalon();
  const summary = useQuery({
    queryKey: ['payout-summary', salon.id],
    queryFn: () => getPayoutSummary(supabase, salon.id),
  });

  return (
    <>
      <SectionHeader title="Today’s takings" />
      {summary.isPending ? (
        <SkeletonRow />
      ) : summary.error ? (
        <Text variant="footnote" tone="destructive" className="px-1">
          {checkoutErrorMessage(summary.error)}
        </Text>
      ) : (
        <Card className="gap-2">
          <View className="flex-row items-end justify-between">
            <Text variant="headline" tone="muted">
              {summary.data.checkouts === 1 ? '1 checkout' : `${summary.data.checkouts} checkouts`}
            </Text>
            <Text variant="title2" numeric>
              {formatAmount(summary.data.totalCents, summary.data.currency)}
            </Text>
          </View>
          <Line label="Card" cents={summary.data.cardCents} currency={summary.data.currency} />
          <Line label="Cash" cents={summary.data.cashCents} currency={summary.data.currency} />
          {summary.data.otherCents > 0 ? (
            <Line label="Other" cents={summary.data.otherCents} currency={summary.data.currency} />
          ) : null}
          <Line label="Tips" cents={summary.data.tipCents} currency={summary.data.currency} />
          {summary.data.refundedCents > 0 ? (
            <Line
              label="Refunded"
              cents={-summary.data.refundedCents}
              currency={summary.data.currency}
            />
          ) : null}
        </Card>
      )}
    </>
  );
}

function Line({ label, cents, currency }: { label: string; cents: number; currency: string }) {
  return (
    <View className="flex-row justify-between">
      <Text variant="subhead" tone="muted">
        {label}
      </Text>
      <Text variant="subhead" numeric>
        {cents < 0 ? `−${formatAmount(-cents, currency)}` : formatAmount(cents, currency)}
      </Text>
    </View>
  );
}

/** Recent checkouts with receipts; owners can refund card payments in full. */
export function RecentCheckouts() {
  const salon = useCurrentSalon();
  const isOwner = salon.role === 'owner';
  const checkouts = useQuery({
    queryKey: ['paid-checkouts', salon.id],
    queryFn: () => listPaidCheckouts(supabase, salon.id, 10),
  });
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const invalidate = useInvalidateAfterPayment();
  const refund = useMutation({
    mutationFn: (checkoutId: string) => invokeCheckout(supabase, { action: 'refund', checkoutId }),
    onMutate: () => setError(null),
    onSuccess: () => {
      setConfirming(null);
      void invalidate();
    },
    onError: (e) => setError(checkoutErrorMessage(e)),
  });

  return (
    <>
      <SectionHeader title="Recent checkouts" />
      {checkouts.isPending ? (
        <SkeletonRow />
      ) : checkouts.error ? (
        <Text variant="footnote" tone="destructive" className="px-1">
          {checkoutErrorMessage(checkouts.error)}
        </Text>
      ) : checkouts.data.length === 0 ? (
        <Text variant="footnote" tone="muted" className="px-1">
          No checkouts yet. Ring up a client from Today or their appointment.
        </Text>
      ) : (
        <ListGroup>
          {checkouts.data.map((c, i) => (
            <CheckoutRow
              key={c.id}
              checkout={c}
              last={i === checkouts.data.length - 1}
              canRefund={isOwner}
              confirming={confirming === c.id}
              refunding={refund.isPending && refund.variables === c.id}
              onRefund={() => setConfirming(c.id)}
              onCancel={() => setConfirming(null)}
              onConfirm={() => refund.mutate(c.id)}
            />
          ))}
        </ListGroup>
      )}
      {error ? (
        <Text variant="footnote" tone="destructive" className="px-1 pt-2">
          {error}
        </Text>
      ) : null}
    </>
  );
}

function CheckoutRow({
  checkout: c,
  last,
  canRefund,
  confirming,
  refunding,
  onRefund,
  onCancel,
  onConfirm,
}: {
  checkout: PaidCheckout;
  last: boolean;
  canRefund: boolean;
  confirming: boolean;
  refunding: boolean;
  onRefund: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const method =
    c.method === 'card'
      ? cardLabel(c.card_brand, c.card_last4)
      : c.method === 'cash'
        ? 'Cash'
        : 'Other';
  const date = c.paid_at
    ? new Date(c.paid_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : '';
  const fullyRefunded = c.refunded_cents >= c.amount_due_cents && c.refunded_cents > 0;
  const refundable = canRefund && c.method === 'card' && !fullyRefunded;

  return (
    <View>
      <ListRow
        title={`${formatAmount(c.amount_due_cents, c.currency)} · ${c.client?.name ?? 'Walk-in'}`}
        subtitle={`${date} · ${method}`}
        trailing={
          fullyRefunded ? (
            <Badge label="Refunded" tone="neutral" />
          ) : c.refunded_cents > 0 ? (
            <Badge label="Part refunded" tone="warning" />
          ) : refundable && !confirming ? (
            <Button variant="ghost" size="sm" label="Refund" onPress={onRefund} />
          ) : undefined
        }
        accessibilityHint="Opens the receipt"
        onPress={() => router.push(`/receipt/${c.receipt_token}`)}
        last={last && !confirming}
      />
      {confirming ? (
        <View className="gap-2 px-4 pb-3">
          <Text variant="footnote" tone="muted">
            Refund {formatAmount(c.amount_due_cents, c.currency)} to {method}? This can’t be undone.
          </Text>
          <View className="flex-row gap-3">
            <Button variant="secondary" size="sm" label="Keep" grow onPress={onCancel} />
            <Button
              variant="destructive"
              size="sm"
              label="Refund"
              grow
              loading={refunding}
              onPress={onConfirm}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}
