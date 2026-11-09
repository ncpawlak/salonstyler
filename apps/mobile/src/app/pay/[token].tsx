import { formatAmount, type DepositPageResponse } from '@chairside/payments';
import { useMutation, useQuery } from '@tanstack/react-query';
import * as Linking from 'expo-linking';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button, Card, EmptyState, Icon, SkeletonRow, Text } from '@/components/ui';
import { depositsApi, payUrl } from '@/features/deposits/api';

/**
 * Public deposit page (`/pay/<token>`): where the booking page sends clients when a deposit is
 * due, and the link the salon can text. Stripe Checkout returns here with `?paid=1`.
 */
export default function PayDepositScreen() {
  const { token, paid } = useLocalSearchParams<{ token: string; paid?: string }>();
  const returned = paid === '1';
  const page = useQuery({
    queryKey: ['deposit-page', token, returned],
    // After Checkout, `status` asks Stripe directly so the page doesn't wait on the webhook.
    queryFn: () => (returned ? depositsApi.status(token) : depositsApi.page(token)),
    retry: false,
  });

  return (
    <SafeAreaView edges={['top']} className="flex-1 bg-background">
      <View className="w-full max-w-2xl flex-1 self-center">
        <ScrollView className="flex-1" contentContainerClassName="px-4 pb-24 pt-6">
          {page.isPending ? (
            <View className="gap-3">
              <SkeletonRow />
              <SkeletonRow />
            </View>
          ) : page.error || !page.data ? (
            <EmptyState
              icon="link-outline"
              title="Link not found"
              message="This link may be mistyped or out of date. Contact the salon to book."
            />
          ) : (
            <PayView data={page.data} token={token} onRefresh={() => void page.refetch()} />
          )}
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

function openUrl(url: string) {
  if (Platform.OS === 'web' && typeof window !== 'undefined') window.location.assign(url);
  else void Linking.openURL(url);
}

function PayView({
  data: { page, stripeReady },
  token,
  onRefresh,
}: {
  data: DepositPageResponse;
  token: string;
  onRefresh: () => void;
}) {
  const start = useMutation({
    mutationFn: () => depositsApi.start(token, payUrl(token)),
    onSuccess: ({ url }) => openUrl(url),
  });
  const money = formatAmount(page.amountCents, page.currency);
  const when = (iso: string) =>
    new Date(iso).toLocaleString(undefined, {
      timeZone: page.timezone,
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  const cancelled = page.appointmentStatus === 'cancelled';
  const [now] = useState(() => Date.now());
  const holdLapsed =
    page.status === 'pending' &&
    !!page.holdExpiresAt &&
    new Date(page.holdExpiresAt).getTime() < now;

  const header =
    page.status === 'paid'
      ? { icon: 'checkmark' as const, title: "You're booked", tone: 'bg-success' }
      : page.status === 'refunded' || page.status === 'refund_due'
        ? { icon: 'return-up-back' as const, title: 'Deposit refunded', tone: 'bg-muted' }
        : page.status === 'kept'
          ? { icon: 'close' as const, title: 'Appointment cancelled', tone: 'bg-muted' }
          : cancelled || page.status === 'canceled' || holdLapsed
            ? { icon: 'time-outline' as const, title: 'This hold has ended', tone: 'bg-muted' }
            : { icon: 'card-outline' as const, title: `Pay ${money} to book`, tone: 'bg-primary' };

  return (
    <View className="gap-4" testID="deposit-pay-page">
      <View className="items-center gap-2">
        <View className={`h-14 w-14 items-center justify-center rounded-full ${header.tone}`}>
          <Icon name={header.icon} size={30} color="primary-foreground" />
        </View>
        <Text
          variant="title2"
          accessibilityRole="header"
          className="text-center"
          testID="deposit-title"
        >
          {header.title}
        </Text>
        <Text variant="subhead" tone="muted" className="text-center">
          {page.salonName}
        </Text>
      </View>

      <Card className="gap-3">
        <Row label="When" value={when(page.startsAt)} />
        {page.services ? <Row label="Services" value={page.services} /> : null}
        <Row label="Deposit" value={money} />
        {page.status === 'refund_due' ? (
          <Text variant="footnote" tone="muted">
            Your refund is on its way.
          </Text>
        ) : null}
      </Card>

      {page.status === 'pending' && !cancelled && !holdLapsed ? (
        <>
          {page.holdExpiresAt ? (
            <Text variant="footnote" tone="muted" className="text-center">
              We’re holding this time until {when(page.holdExpiresAt)}.
            </Text>
          ) : null}
          {stripeReady ? (
            <Button
              size="lg"
              fullWidth
              label={`Pay ${money} deposit`}
              icon="lock-closed-outline"
              loading={start.isPending}
              onPress={() => start.mutate()}
              testID="deposit-pay"
            />
          ) : (
            <Card className="flex-row items-start gap-2" testID="deposit-unavailable">
              <Icon name="alert-circle-outline" color="warning" size={18} />
              <Text variant="footnote" className="flex-1">
                {page.salonName} can’t take card payments online right now. Please contact the salon
                to confirm your booking.
              </Text>
            </Card>
          )}
          {start.error ? (
            <Text variant="footnote" tone="destructive" className="text-center">
              {start.error.message}
            </Text>
          ) : null}
        </>
      ) : null}

      {page.status === 'pending' && !cancelled && !holdLapsed && stripeReady ? (
        <Button variant="ghost" label="I've paid — refresh" onPress={onRefresh} />
      ) : null}

      <Text variant="footnote" tone="muted" className="text-center" testID="deposit-policy">
        The rest is paid at the salon after your appointment; the deposit comes off the bill.{' '}
        {page.windowHours > 0
          ? `Cancel before ${when(page.freeUntil)} for a full refund. Later cancellations and no-shows keep the deposit.`
          : 'Cancel any time before your appointment for a full refund.'}
      </Text>

      {page.salonSlug ? (
        <Button
          variant="ghost"
          label={`Back to ${page.salonName}`}
          onPress={() => router.replace(`/b/${page.salonSlug}`)}
        />
      ) : null}
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row justify-between gap-3">
      <Text variant="subhead" tone="muted">
        {label}
      </Text>
      <Text variant="subhead" className="flex-1 text-right">
        {value}
      </Text>
    </View>
  );
}
