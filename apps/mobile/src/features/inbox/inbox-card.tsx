import { formatDuration } from '@chairside/core';
import type {
  AppointmentServiceSnapshot,
  AppointmentWithDetails,
} from '@chairside/db/appointments';
import type { CapturedRequestAppointment } from '@chairside/db/inbox';
import type { ClientReply } from '@chairside/db/replies';
import { View } from 'react-native';
import Animated, { FadeOut, LinearTransition, useReducedMotion } from 'react-native-reanimated';

import { Avatar, Badge, type BadgeTone, Button, Card, Icon, Text } from '@/components/ui';

import { formatDay, formatTime } from '../appointments/format';
import { replyStatusLabel } from '../replies/compose';
import { formatPrice } from '../services/data';
import { ServicePills } from '../today/service-pills';
import type { InboxItem } from './api';
import { channelLabel } from './capture';

export type InboxAction =
  'approve' | 'decline' | 'other_time' | 'dismiss' | 'cancel_appointment' | 'offer';

const INTENT: Record<string, { label: string; tone: BadgeTone }> = {
  booking: { label: 'Booking', tone: 'warning' },
  reschedule: { label: 'Reschedule', tone: 'primary' },
  cancel: { label: 'Cancel', tone: 'destructive' },
};

type Slot = Pick<CapturedRequestAppointment, 'starts_at' | 'ends_at' | 'price_cents'>;

function slotLabel(slot: Slot, timeZone: string, withLength = true) {
  const start = Date.parse(slot.starts_at);
  const minutes = Math.round((Date.parse(slot.ends_at) - start) / 60_000);
  return [
    `${formatDay(start, timeZone)} · ${formatTime(start, timeZone)}`,
    withLength ? formatDuration(minutes) : null,
    withLength && slot.price_cents != null ? formatPrice(slot.price_cents) : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function receivedLabel(iso: string, timeZone: string) {
  const ms = Date.parse(iso);
  const sameDay = formatDay(ms, timeZone) === formatDay(Date.now(), timeZone);
  return sameDay ? formatTime(ms, timeZone) : formatDay(ms, timeZone);
}

/** What the card shows, whether the request came in by text or another way. */
function describe(item: InboxItem) {
  if (item.kind === 'appointment') {
    const a: AppointmentWithDetails = item.appointment;
    return {
      name: a.client?.name ?? 'Walk-in',
      isNew: false,
      intent: 'booking',
      source: 'Booking request',
      message: a.notes || null,
      note: null,
      slot: a as Slot,
      services: a.services,
      target: null,
      appointmentId: a.id,
    };
  }
  const r = item.request;
  const parsedServices: AppointmentServiceSnapshot[] = (r.parsed.services ?? []).map((s) => ({
    serviceId: s.serviceId,
    variantId: s.variantId ?? null,
    name: s.name ?? 'Service',
  }));
  return {
    name: r.client?.name ?? r.sender ?? 'Unknown sender',
    isNew: r.client_created || !!r.client?.pending,
    intent: r.intent,
    source: channelLabel(r.channel, r.sender_phone),
    message: r.message,
    note: r.note,
    slot: r.appointment?.status === 'requested' ? (r.appointment as Slot) : null,
    services: r.appointment?.services.length ? r.appointment.services : parsedServices,
    target: r.target,
    appointmentId: r.appointment?.status === 'requested' ? r.appointment.id : null,
  };
}

/** Inbox card: what they asked for, the slot the engine is holding, and what to do about it. */
export function InboxCard({
  item,
  timeZone,
  reply,
  onAction,
}: {
  item: InboxItem;
  timeZone: string;
  /** The latest reply texted about this request, if any. */
  reply?: Pick<ClientReply, 'kind' | 'status' | 'channel'> | null;
  onAction: (action: InboxAction) => void;
}) {
  const reduceMotion = useReducedMotion();
  const d = describe(item);
  const intent = INTENT[d.intent] ?? INTENT.booking!;
  const isCancel = item.kind === 'captured' && d.intent === 'cancel';
  const received =
    item.kind === 'captured' ? ` · ${receivedLabel(item.request.received_at, timeZone)}` : '';

  return (
    <Animated.View
      exiting={reduceMotion ? undefined : FadeOut.duration(200)}
      layout={reduceMotion ? undefined : LinearTransition}
    >
      <Card className="gap-3" testID="inbox-card">
        <View className="flex-row items-center gap-3">
          <Avatar name={d.name} size={40} />
          <View className="flex-1">
            <View className="flex-row flex-wrap items-center gap-2">
              <Text variant="headline" numberOfLines={1} className="shrink">
                {d.name}
              </Text>
              <Badge label={intent.label} tone={intent.tone} />
              {d.isNew ? <Badge label="New client" tone="primary" /> : null}
            </View>
            <View className="flex-row items-center gap-1">
              <Icon
                name={item.kind === 'captured' ? 'chatbubble-outline' : 'globe-outline'}
                size={14}
                color="muted-foreground"
              />
              <Text variant="footnote" tone="muted" numberOfLines={1}>
                {d.source}
                {received}
              </Text>
            </View>
          </View>
        </View>

        {d.message ? (
          <View className="rounded-lg bg-muted px-3 py-2">
            <Text variant="subhead">“{d.message}”</Text>
          </View>
        ) : null}

        {!isCancel ? <ServicePills services={d.services} /> : null}

        {d.target && d.intent !== 'booking' ? (
          <View className="flex-row items-center gap-2">
            <Icon
              name={isCancel ? 'close-circle-outline' : 'swap-horizontal'}
              size={16}
              color="muted-foreground"
            />
            <Text variant="subhead" tone="muted" className="flex-1">
              {isCancel ? 'Cancel ' : 'Move from '}
              {slotLabel(d.target, timeZone, false)}
            </Text>
          </View>
        ) : null}

        {d.slot ? (
          <View className="flex-row items-center gap-2">
            <Icon name="sparkles" size={16} color="primary" />
            <Text variant="subhead" numeric className="flex-1 font-semibold">
              {slotLabel(d.slot, timeZone)}
            </Text>
          </View>
        ) : null}

        {d.note ? (
          <View className="flex-row items-start gap-2">
            <Icon name="information-circle-outline" size={16} color="warning" />
            <Text variant="footnote" tone="warning" className="flex-1">
              {d.note}
            </Text>
          </View>
        ) : null}

        {reply ? (
          <View className="flex-row items-center gap-2" testID="inbox-card-reply">
            <Icon name="paper-plane-outline" size={16} color="success" />
            <Text variant="footnote" tone="success" className="flex-1">
              {replyStatusLabel(reply)}
            </Text>
          </View>
        ) : null}

        {isCancel ? (
          <View className="flex-row gap-3">
            <Button
              variant="outline"
              label="Dismiss"
              grow
              accessibilityLabel={`Dismiss ${d.name}'s message`}
              onPress={() => onAction('dismiss')}
            />
            {d.target ? (
              <Button
                variant="destructive"
                label="Cancel appointment"
                grow
                accessibilityLabel={`Cancel ${d.name}'s appointment`}
                onPress={() => onAction('cancel_appointment')}
              />
            ) : null}
          </View>
        ) : d.appointmentId ? (
          <View className="gap-2">
            <View className="flex-row gap-3">
              <Button
                variant="outline"
                label="Decline"
                haptic="warning"
                grow
                accessibilityLabel={`Decline ${d.name}'s request`}
                onPress={() => onAction('decline')}
              />
              <Button
                label="Approve"
                icon="checkmark"
                haptic={false}
                grow
                accessibilityLabel={`Approve ${d.name} for ${d.slot ? slotLabel(d.slot, timeZone, false) : 'this time'}`}
                onPress={() => onAction('approve')}
              />
            </View>
            <View className="flex-row gap-3">
              {item.kind === 'captured' ? (
                <Button
                  variant="ghost"
                  size="sm"
                  label={reply?.kind === 'offer' ? 'Resend' : 'Offer'}
                  icon="chatbubble-ellipses-outline"
                  grow
                  accessibilityLabel={`Text ${d.name} this time and wait for a yes`}
                  onPress={() => onAction('offer')}
                />
              ) : null}
              <Button
                variant="ghost"
                size="sm"
                label="Other time"
                icon="time-outline"
                grow
                accessibilityLabel={`Pick another time for ${d.name}`}
                onPress={() => onAction('other_time')}
              />
              {item.kind === 'captured' ? (
                <Button
                  variant="ghost"
                  size="sm"
                  label="Dismiss"
                  grow
                  accessibilityLabel={`Dismiss ${d.name}'s message and release the hold`}
                  onPress={() => onAction('dismiss')}
                />
              ) : null}
            </View>
          </View>
        ) : (
          <Button
            variant="outline"
            label="Dismiss"
            fullWidth
            accessibilityLabel={`Dismiss ${d.name}'s message`}
            onPress={() => onAction('dismiss')}
          />
        )}
      </Card>
    </Animated.View>
  );
}
