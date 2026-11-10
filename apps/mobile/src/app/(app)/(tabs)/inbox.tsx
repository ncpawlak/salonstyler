import type { ReplyKind } from '@chairside/ai/assistant';
import { OUTBOX_BRIDGE_VERSION, parseBridgeVersion } from '@chairside/ai/shortcut';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { View } from 'react-native';

import { Screen } from '@/components/shell/screen';
import { Button, EmptyState, SkeletonRow, Text } from '@/components/ui';
import { errorMessage } from '@/features/appointments/api';
import {
  type InboxItem,
  useDecideRequest,
  useInbox,
  useInboxBridge,
  useResolveCapturedRequest,
} from '@/features/inbox/api';
import { BridgeHealthBanner } from '@/features/inbox/bridge-ui';
import { type InboxAction, InboxCard } from '@/features/inbox/inbox-card';
import { useReplySettings, useRequestReplies } from '@/features/replies/api';
import { latestReplyByRequest } from '@/features/replies/compose';
import { type ReplyTarget, ReplySheet } from '@/features/replies/reply-sheet';
import { haptics } from '@/lib/haptics';
import { useCurrentSalon } from '@/providers/session-provider';

/** Who to text about an Inbox item, and the appointment the text is about. */
function replyTarget(item: InboxItem, kind: ReplyKind): ReplyTarget {
  if (item.kind === 'appointment') {
    const a = item.appointment;
    return {
      kind,
      name: a.client?.name ?? 'Client',
      phone: a.client?.phone ?? null,
      appointmentId: a.id,
      clientId: a.client?.id ?? null,
      start: a.starts_at,
      services: a.services.map((s) => s.name),
    };
  }
  const r = item.request;
  const appt = kind === 'cancelled' ? (r.target ?? r.appointment) : (r.appointment ?? r.target);
  return {
    kind,
    name: r.client?.name ?? r.sender ?? 'Client',
    phone: r.client?.phone ?? r.sender_phone ?? null,
    requestId: r.id,
    appointmentId: appt?.id ?? null,
    clientId: r.client_id,
    start: appt?.starts_at ?? null,
    services: appt?.services.map((s) => s.name) ?? [],
  };
}

export default function InboxScreen() {
  const salon = useCurrentSalon();
  const inbox = useInbox();
  const decide = useDecideRequest();
  const resolve = useResolveCapturedRequest();
  const replySettings = useReplySettings();
  const bridge = useInboxBridge();
  const [failure, setFailure] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<ReplyTarget | null>(null);
  const items = useMemo(() => inbox.items ?? [], [inbox.items]);

  const requestIds = useMemo(
    () => items.flatMap((i) => (i.kind === 'captured' ? [i.request.id] : [])),
    [items],
  );
  const replies = useRequestReplies(requestIds);
  const latestReply = useMemo(() => latestReplyByRequest(replies.data ?? []), [replies.data]);
  // With auto-send on, the database queues the confirmation for texted requests (a v3+ Shortcut
  // sends it), so the editor only opens when nothing else will reply.
  const autoSends =
    !!replySettings.data?.autoSendReplies &&
    (parseBridgeVersion(bridge.data?.last_bridge_version) ?? 0) >= OUTBOX_BRIDGE_VERSION;

  const onError = (e: unknown) => {
    haptics.error();
    setFailure(errorMessage(e));
  };

  const act = (item: InboxItem, action: InboxAction) => {
    setFailure(null);
    const appointmentId =
      item.kind === 'appointment' ? item.appointment.id : item.request.appointment_id;
    const thenReply = (kind: ReplyKind) => () => {
      const target = replyTarget(item, kind);
      if (kind !== 'decline' && item.kind === 'captured' && autoSends && target.phone) return;
      setReplyTo(target);
    };
    if (action === 'other_time') {
      if (appointmentId) router.push({ pathname: '/requests/[id]', params: { id: appointmentId } });
      return;
    }
    if (action === 'offer') {
      setReplyTo(replyTarget(item, 'offer'));
      return;
    }
    if (action === 'approve' || action === 'decline') {
      if (!appointmentId) return;
      if (action === 'approve') haptics.success();
      decide.mutate(
        { appointmentId, approve: action === 'approve' },
        { onError, onSuccess: thenReply(action === 'approve' ? 'confirm' : 'decline') },
      );
      return;
    }
    if (item.kind === 'captured') {
      if (action === 'cancel_appointment') haptics.warning();
      resolve.mutate(
        { id: item.request.id, action },
        {
          onError,
          onSuccess: action === 'cancel_appointment' ? thenReply('cancelled') : undefined,
        },
      );
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
      toolbar={
        <View className="flex-row gap-2 px-4 pb-2">
          <Button
            label="Paste request"
            icon="clipboard-outline"
            variant="secondary"
            size="sm"
            onPress={() => router.push('/capture')}
            testID="inbox-capture"
          />
          <Button
            label="Screenshot"
            icon="image-outline"
            variant="secondary"
            size="sm"
            onPress={() => router.push('/capture')}
            testID="inbox-capture-screenshot"
          />
        </View>
      }
    >
      <BridgeHealthBanner />
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
              reply={item.kind === 'captured' ? latestReply.get(item.request.id) : null}
              onAction={(action) => act(item, action)}
            />
          ))}
        </View>
      ) : (
        <EmptyState
          icon="file-tray-outline"
          title="Inbox zero"
          message="Booking texts forwarded by your Shortcut land here with a time already held. Got one in Instagram or WhatsApp? Tap Paste request or Screenshot above."
          actionLabel="Set up text bridge"
          onAction={() => router.push('/settings/text-bridge')}
        />
      )}
      <ReplySheet target={replyTo} onClose={() => setReplyTo(null)} />
    </Screen>
  );
}
