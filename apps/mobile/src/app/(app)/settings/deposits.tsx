import {
  DEFAULT_CANCELLATION_WINDOW_HOURS,
  MAX_CANCELLATION_WINDOW_HOURS,
  policySummary,
} from '@chairside/core/deposits';
import { getStripeAccount } from '@chairside/db/payments';
import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { Switch, View } from 'react-native';

import { DetailScreen } from '@/components/shell/screen';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Icon,
  Input,
  SectionHeader,
  SkeletonRow,
  Text,
} from '@/components/ui';
import { errorMessage } from '@/features/appointments/api';
import { useDepositSettings, useUpdateDepositSettings } from '@/features/deposits/api';
import { supabase } from '@/lib/supabase';
import { useCurrentSalon } from '@/providers/session-provider';

/**
 * Settings → Deposits & cancellations. Deposits are optional and off by default; clients still
 * pay for the service at checkout, where a paid deposit is credited.
 */
export default function DepositSettingsScreen() {
  const salon = useCurrentSalon();
  const isOwner = salon.role === 'owner';
  const settings = useDepositSettings(salon.id);
  const update = useUpdateDepositSettings(salon.id);
  const account = useQuery({
    queryKey: ['stripe-account', salon.id],
    queryFn: () => getStripeAccount(supabase, salon.id),
  });
  const stripeReady = !!account.data?.charges_enabled;

  const [hours, setHours] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const saved = settings.data ?? null;
  const [loaded, setLoaded] = useState(saved);
  if (saved !== loaded) {
    setLoaded(saved);
    setHours(String(saved?.cancellation_window_hours ?? DEFAULT_CANCELLATION_WINDOW_HOURS));
  }

  const parsedHours = Number(hours);
  const hoursValid =
    /^\d+$/.test(hours.trim()) && parsedHours >= 0 && parsedHours <= MAX_CANCELLATION_WINDOW_HOURS;
  const hoursChanged =
    saved !== null && hoursValid && parsedHours !== saved.cancellation_window_hours;

  const save = (changes: Parameters<typeof update.mutate>[0], message: string) =>
    update.mutate(changes, { onSuccess: () => setNotice(message) });

  return (
    <DetailScreen title="Deposits & cancellations">
      {settings.isPending ? (
        <View className="gap-3">
          <SkeletonRow />
          <SkeletonRow />
        </View>
      ) : settings.error || !saved ? (
        <EmptyState
          icon="cloud-offline-outline"
          title="Couldn't load deposit settings"
          message={settings.error ? errorMessage(settings.error) : undefined}
          actionLabel="Try again"
          onAction={() => void settings.refetch()}
        />
      ) : (
        <View className="gap-1">
          <Card className="flex-row items-center gap-3">
            <Icon name="shield-checkmark-outline" color="primary" />
            <View className="flex-1 gap-0.5">
              <Text variant="headline">Deposits</Text>
              <Text variant="footnote" tone="muted">
                Optional. Clients pay a deposit to lock in a booking; the rest is paid at checkout
                after the service, where the deposit is taken off the total.
              </Text>
            </View>
            {saved.deposits_enabled ? <Badge label="On" tone="success" /> : <Badge label="Off" />}
          </Card>
          {!isOwner ? (
            <Text variant="footnote" tone="warning" className="px-1 pt-2">
              Only the salon owner can change these.
            </Text>
          ) : null}

          <SectionHeader title="Deposits" />
          <Card className="gap-4">
            <View className="flex-row items-center gap-3">
              <View className="flex-1 gap-0.5">
                <Text variant="body">Ask for deposits</Text>
                <Text variant="footnote" tone="muted">
                  Services with a deposit hold the time until the client pays by card. Set the
                  amount on each service.
                </Text>
              </View>
              <Switch
                accessibilityLabel="Ask for deposits"
                value={saved.deposits_enabled}
                disabled={!isOwner || update.isPending}
                onValueChange={(v) =>
                  save(
                    { deposits_enabled: v },
                    v ? 'Deposits are on.' : 'Deposits are off. Bookings no longer ask for one.',
                  )
                }
              />
            </View>
            {saved.deposits_enabled && account.isSuccess && !stripeReady ? (
              <View className="flex-row items-start gap-2" accessibilityRole="alert">
                <Icon name="alert-circle-outline" color="warning" size={18} />
                <Text variant="footnote" tone="warning" className="flex-1">
                  Card payments aren’t set up yet, so no deposit is asked for. Finish Stripe setup
                  in Payments.
                </Text>
              </View>
            ) : null}
            <View className="flex-row gap-3">
              <Button
                variant="secondary"
                label="Service deposits"
                icon="cut-outline"
                grow
                onPress={() => router.push('/services')}
              />
              {!stripeReady ? (
                <Button
                  variant="secondary"
                  label="Payments"
                  icon="card-outline"
                  grow
                  onPress={() => router.push('/settings/payments')}
                />
              ) : null}
            </View>
          </Card>

          <SectionHeader title="Cancellation window" />
          <Input
            accessibilityLabel="Free cancellation window in hours"
            testID="cancellation-window-hours"
            value={hours}
            onChangeText={setHours}
            editable={isOwner}
            keyboardType="number-pad"
            maxLength={3}
            helper={
              hoursValid
                ? policySummary(parsedHours)
                : `Enter 0–${MAX_CANCELLATION_WINDOW_HOURS} hours.`
            }
          />
          <Text variant="footnote" tone="muted" className="px-1">
            Cancel in time and the deposit is refunded. Later cancellations and no-shows keep it.
            When you cancel, you choose.
          </Text>
          {isOwner && hoursChanged ? (
            <Button
              variant="outline"
              label="Save window"
              fullWidth
              className="mt-2"
              loading={update.isPending}
              onPress={() => save({ cancellation_window_hours: parsedHours }, 'Saved.')}
            />
          ) : null}

          {notice && !update.error ? (
            <Text
              variant="footnote"
              tone="success"
              className="px-1 pt-4"
              accessibilityLiveRegion="polite"
            >
              {notice}
            </Text>
          ) : null}
          {update.error ? (
            <Text
              variant="footnote"
              tone="destructive"
              className="px-1 pt-4"
              accessibilityLiveRegion="polite"
            >
              {errorMessage(update.error)}
            </Text>
          ) : null}
        </View>
      )}
    </DetailScreen>
  );
}
