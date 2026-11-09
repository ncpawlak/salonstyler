import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { Screen } from '@/components/shell/screen';
import { EmptyState, SkeletonRow, Text } from '@/components/ui';
import { errorMessage } from '@/features/appointments/api';
import {
  type InboxItem,
  useDecideRequest,
  useInbox,
  useResolveCapturedRequest,
} from '@/features/inbox/api';
import { type InboxAction, InboxCard } from '@/features/inbox/inbox-card';
import { haptics } from '@/lib/haptics';
import { useCurrentSalon } from '@/providers/session-provider';

export default function InboxScreen() {
  const salon = useCurrentSalon();
  const inbox = useInbox();
  const decide = useDecideRequest();
  const resolve = useResolveCapturedRequest();
  const [failure, setFailure] = useState<string | null>(null);
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
      decide.mutate({ appointmentId, approve: action === 'approve' }, { onError });
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
