import { confirmationText } from '@chairside/ai/shortcut';
import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { Screen } from '@/components/shell/screen';
import { Button, Card, EmptyState, SkeletonRow, Text } from '@/components/ui';
import { errorMessage } from '@/features/appointments/api';
import { formatDay, formatTime } from '@/features/appointments/format';
import {
  type InboxItem,
  useDecideRequest,
  useInbox,
  useInboxBridge,
  useResolveCapturedRequest,
} from '@/features/inbox/api';
import { BridgeHealthBanner } from '@/features/inbox/bridge-ui';
import { type InboxAction, InboxCard } from '@/features/inbox/inbox-card';
import { SHARE_TEXT_LABEL, shareClientText } from '@/features/today/share-text';
import { haptics } from '@/lib/haptics';
import { useCurrentSalon } from '@/providers/session-provider';

export default function InboxScreen() {
  const salon = useCurrentSalon();
  const inbox = useInbox();
  const decide = useDecideRequest();
  const resolve = useResolveCapturedRequest();
  const bridge = useInboxBridge();
  const [failure, setFailure] = useState<string | null>(null);
  // After approving a texted request: the confirmation to send, which also teaches the keyword.
  const [confirmation, setConfirmation] = useState<{ name: string; text: string } | null>(null);
  const items = inbox.items ?? [];

  const onError = (e: unknown) => {
    haptics.error();
    setFailure(errorMessage(e));
  };

  const act = (item: InboxItem, action: InboxAction) => {
    setFailure(null);
    const appointmentId =
      item.kind === 'appointment' ? item.appointment.id : item.request.appointment_id;
    if (action === 'other_time') {
      if (appointmentId) router.push({ pathname: '/requests/[id]', params: { id: appointmentId } });
      return;
    }
    if (action === 'approve' || action === 'decline') {
      if (!appointmentId) return;
      if (action === 'approve') haptics.success();
      setConfirmation(null);
      decide.mutate(
        { appointmentId, approve: action === 'approve' },
        {
          onError,
          onSuccess: () => {
            if (action !== 'approve' || item.kind !== 'captured') return;
            const startsAt = item.request.appointment?.starts_at;
            if (!startsAt) return;
            const ms = Date.parse(startsAt);
            const name = item.request.client?.name ?? item.request.sender ?? 'the client';
            setConfirmation({
              name,
              text: confirmationText({
                clientName: item.request.client?.name,
                when: `${formatDay(ms, salon.timezone)} at ${formatTime(ms, salon.timezone)}`,
                salonName: salon.name,
                keyword: bridge.data?.keyword,
              }),
            });
          },
        },
      );
      return;
    }
    if (item.kind === 'captured') {
      if (action === 'cancel_appointment') haptics.warning();
      resolve.mutate({ id: item.request.id, action }, { onError });
    }
  };

  return (
    <Screen
      title="Inbox"
      subtitle={
        inbox.isPending
          ? undefined
          : items.length
            ? `${items.length} ${items.length === 1 ? 'request' : 'requests'} waiting for you`
            : 'All caught up'
      }
    >
      <BridgeHealthBanner />
      {confirmation ? (
        <Card className="mb-3 gap-2" testID="inbox-confirmation">
          <Text variant="headline">Approved. Let {confirmation.name} know?</Text>
          <Text variant="subhead" tone="muted" selectable>
            {confirmation.text}
          </Text>
          <View className="flex-row gap-2">
            <Button
              grow
              label={SHARE_TEXT_LABEL}
              icon="share-outline"
              onPress={() =>
                void shareClientText(confirmation.text)
                  .then(() => setConfirmation(null))
                  .catch(onError)
              }
            />
            <Button grow variant="ghost" label="Not now" onPress={() => setConfirmation(null)} />
          </View>
        </Card>
      ) : null}
      {failure ? (
        <View
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          className="mb-3 rounded-xl bg-destructive/10 px-4 py-3"
        >
          <Text variant="subhead" tone="destructive">
            {failure}
          </Text>
        </View>
      ) : null}
      {inbox.isPending ? (
        <View className="gap-3">
          <SkeletonRow />
          <SkeletonRow />
        </View>
      ) : inbox.error && !inbox.items ? (
        <EmptyState
          icon="cloud-offline-outline"
          title="Couldn't load the inbox"
          message={errorMessage(inbox.error)}
          actionLabel="Try again"
          onAction={() => void inbox.refetch()}
        />
      ) : items.length ? (
        <View className="gap-3">
          {items.map((item) => (
            <InboxCard
              key={item.id}
              item={item}
              timeZone={salon.timezone}
              onAction={(action) => act(item, action)}
            />
          ))}
        </View>
      ) : (
        <EmptyState
          icon="file-tray-outline"
          title="Inbox zero"
          message="Booking texts forwarded by your Shortcut land here with a time already held. Set it up in Settings → Text bridge."
          actionLabel="Set up text bridge"
          onAction={() => router.push('/settings/text-bridge')}
        />
      )}
    </Screen>
  );
}
