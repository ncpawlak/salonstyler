import {
  formatAmount,
  PAYMENTS_STATUS_INFO,
  paymentsStatus,
  requirementLabel,
} from '@chairside/payments';
import { getStripeAccount, listPayments, type Payment, type PaymentStatus } from '@chairside/db';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Linking from 'expo-linking';
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { AppState, Platform, View } from 'react-native';

import { DetailScreen } from '@/components/shell/screen';
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  EmptyState,
  Icon,
  ListGroup,
  ListRow,
  SectionHeader,
  SkeletonRow,
  Text,
} from '@/components/ui';
import { invokePayments } from '@/features/payments/api';
import { supabase } from '@/lib/supabase';
import { useCurrentSalon } from '@/providers/session-provider';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Stripe-hosted pages: same tab on web (Stripe sends the user back here), system browser on native. */
function openStripe(url: string) {
  if (Platform.OS === 'web') window.location.assign(url);
  else void Linking.openURL(url);
}

const PAYMENT_STATUS_LABEL: Record<PaymentStatus, { label: string; tone: BadgeTone }> = {
  pending: { label: 'Pending', tone: 'neutral' },
  processing: { label: 'Processing', tone: 'warning' },
  succeeded: { label: 'Paid', tone: 'success' },
  failed: { label: 'Failed', tone: 'destructive' },
  canceled: { label: 'Canceled', tone: 'neutral' },
  partially_refunded: { label: 'Part refunded', tone: 'warning' },
  refunded: { label: 'Refunded', tone: 'neutral' },
};

function CheckRow({ title, done, last }: { title: string; done: boolean; last?: boolean }) {
  return (
    <ListRow
      title={title}
      chevron={false}
      leading={
        <Icon
          name={done ? 'checkmark-circle' : 'ellipse-outline'}
          color={done ? 'success' : 'subtle-foreground'}
        />
      }
      trailing={
        <Text variant="subhead" tone={done ? 'success' : 'muted'}>
          {done ? 'Yes' : 'Not yet'}
        </Text>
      }
      last={last}
    />
  );
}

function PaymentRow({ payment, last }: { payment: Payment; last: boolean }) {
  const status = PAYMENT_STATUS_LABEL[payment.status];
  const date = new Date(payment.created_at).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
  return (
    <ListRow
      title={formatAmount(payment.amount_cents, payment.currency)}
      subtitle={payment.description ? `${date} · ${payment.description}` : date}
      chevron={false}
      trailing={<Badge label={status.label} tone={status.tone} />}
      last={last}
    />
  );
}

export default function PaymentsSettingsScreen() {
  const salon = useCurrentSalon();
  const salonId = salon.id;
  const isOwner = salon.role === 'owner';
  const queryClient = useQueryClient();
  const params = useLocalSearchParams<{ stripe?: string }>();
  const [error, setError] = useState<string | null>(null);

  const account = useQuery({
    queryKey: ['stripe-account', salonId],
    queryFn: () => getStripeAccount(supabase, salonId),
  });
  const status = paymentsStatus(account.data);
  const info = PAYMENTS_STATUS_INFO[status];

  const payments = useQuery({
    queryKey: ['payments', salonId],
    queryFn: () => listPayments(supabase, salonId, 10),
    enabled: !!account.data,
  });

  // Re-sync from Stripe while onboarding is in progress (and right after Stripe sends us back),
  // since the user may have finished the form before the webhook arrives.
  const sync = useQuery({
    queryKey: ['stripe-account-sync', salonId],
    queryFn: async () => {
      const result = await invokePayments(supabase, { action: 'status', salonId });
      queryClient.setQueryData(['stripe-account', salonId], result.account);
      return result;
    },
    enabled: !!account.data && (status !== 'enabled' || params.stripe === 'return'),
    retry: false,
  });

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void queryClient.invalidateQueries({ queryKey: ['stripe-account-sync', salonId] });
        void queryClient.invalidateQueries({ queryKey: ['payments', salonId] });
      }
    });
    return () => sub.remove();
  }, [queryClient, salonId]);

  const connect = useMutation({
    mutationFn: () =>
      invokePayments(supabase, {
        action: 'onboard',
        salonId,
        // Stripe needs an http(s) return URL. On web that's this page; native apps use the
        // server's PAYMENTS_RETURN_URL and refresh when they come back to the foreground.
        ...(Platform.OS === 'web' ? { returnUrl: Linking.createURL('/settings/payments') } : {}),
      }),
    onMutate: () => setError(null),
    onSuccess: (r) => {
      if (r.account) queryClient.setQueryData(['stripe-account', salonId], r.account);
      openStripe(r.url);
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const dashboard = useMutation({
    mutationFn: () => invokePayments(supabase, { action: 'dashboard', salonId }),
    onMutate: () => setError(null),
    onSuccess: (r) => openStripe(r.url),
    onError: (e) => setError(errorMessage(e)),
  });

  const data = account.data ?? null;
  const busy = connect.isPending || dashboard.isPending;
  const configured = sync.data?.configured ?? true;

  return (
    <DetailScreen title="Payments">
      {account.isPending ? (
        <View className="gap-3">
          <SkeletonRow />
          <SkeletonRow />
        </View>
      ) : account.error ? (
        <EmptyState
          icon="cloud-offline-outline"
          title="Couldn't load payments"
          message={errorMessage(account.error)}
          actionLabel="Try again"
          onAction={() => void account.refetch()}
        />
      ) : (
        <View className="gap-1">
          <Card className="flex-row items-center gap-3">
            <Icon name="card-outline" color="primary" />
            <View className="flex-1 gap-0.5">
              <Text variant="headline">{info.label}</Text>
              <Text variant="footnote" tone="muted">
                {info.description}
              </Text>
            </View>
            <Badge
              label={status === 'enabled' ? 'On' : status === 'not_connected' ? 'Off' : 'Setup'}
              tone={info.tone}
            />
          </Card>

          {!isOwner ? (
            <Text variant="footnote" tone="warning" className="px-1 pt-2">
              Only the salon owner can connect Stripe.
            </Text>
          ) : null}
          {!configured ? (
            <Text variant="footnote" tone="warning" className="px-1 pt-2">
              Stripe isn’t configured on the server yet, so this status may be out of date.
            </Text>
          ) : null}

          {data ? (
            <>
              <SectionHeader title="Stripe account" />
              <ListGroup>
                <CheckRow title="Details submitted" done={data.details_submitted} />
                <CheckRow title="Charges enabled" done={data.charges_enabled} />
                <CheckRow title="Payouts enabled" done={data.payouts_enabled} last />
              </ListGroup>
              {data.requirements_due.length > 0 ? (
                <Text variant="footnote" tone="muted" className="px-1 pt-2">
                  Stripe still needs: {data.requirements_due.map(requirementLabel).join(', ')}.
                </Text>
              ) : null}
              {sync.isFetching ? (
                <Text variant="footnote" tone="muted" className="px-1 pt-2">
                  Checking with Stripe…
                </Text>
              ) : null}
            </>
          ) : null}

          {error ? (
            <Text
              variant="footnote"
              tone="destructive"
              className="px-1 pt-4"
              accessibilityLiveRegion="polite"
            >
              {error}
            </Text>
          ) : null}

          {isOwner ? (
            <View className="gap-3 pt-6">
              {info.cta ? (
                <Button
                  label={info.cta}
                  icon="open-outline"
                  fullWidth
                  loading={connect.isPending}
                  disabled={busy}
                  onPress={() => connect.mutate()}
                />
              ) : null}
              {data?.details_submitted ? (
                <Button
                  variant="outline"
                  label="Open Stripe dashboard"
                  icon="stats-chart-outline"
                  fullWidth
                  loading={dashboard.isPending}
                  disabled={busy}
                  onPress={() => dashboard.mutate()}
                />
              ) : null}
            </View>
          ) : null}

          {data ? (
            <>
              <SectionHeader title="Recent payments" />
              {payments.isPending ? (
                <SkeletonRow />
              ) : payments.data && payments.data.length > 0 ? (
                <ListGroup>
                  {payments.data.map((p, i) => (
                    <PaymentRow key={p.id} payment={p} last={i === payments.data.length - 1} />
                  ))}
                </ListGroup>
              ) : (
                <Text variant="footnote" tone="muted" className="px-1">
                  No payments yet. Card payments taken at checkout will show up here.
                </Text>
              )}
            </>
          ) : null}
        </View>
      )}
    </DetailScreen>
  );
}
