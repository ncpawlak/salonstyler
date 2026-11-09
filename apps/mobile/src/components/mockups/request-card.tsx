import { useState } from 'react';
import { View } from 'react-native';
import Animated, { FadeOut, LinearTransition, useReducedMotion } from 'react-native-reanimated';

import { Avatar, Badge, Button, Card, Chip, Icon, Text, type IconName } from '@/components/ui';
import { haptics } from '@/lib/haptics';
import { formatDuration, serviceById, serviceMinutes, type BookingRequest } from '@/mocks/data';
import { inboxStore } from '@/mocks/inbox-store';

const sourceMeta: Record<BookingRequest['source'], { icon: IconName; label: string }> = {
  instagram: { icon: 'logo-instagram', label: 'Instagram DM' },
  text: { icon: 'chatbubble-outline', label: 'Text' },
  web: { icon: 'globe-outline', label: 'Booking page' },
};

/** Inbox request card: what they asked for, the AI-proposed slot, approve/decline. */
export function RequestCard({ request, compact }: { request: BookingRequest; compact?: boolean }) {
  const reduceMotion = useReducedMotion();
  const [slot, setSlot] = useState(request.proposed);
  const source = sourceMeta[request.source];
  const svc = request.serviceIds.map(serviceById);
  const minutes = svc.reduce((sum, s) => sum + serviceMinutes(s), 0);
  const price = svc.reduce((sum, s) => sum + s.price, 0);

  return (
    <Animated.View
      exiting={reduceMotion ? undefined : FadeOut.duration(200)}
      layout={reduceMotion ? undefined : LinearTransition}
    >
      <Card className="gap-3">
        <View className="flex-row items-center gap-3">
          <Avatar name={request.client} size={40} tag={svc[0]?.tag} />
          <View className="flex-1">
            <View className="flex-row items-center gap-2">
              <Text variant="headline" numberOfLines={1} className="shrink">
                {request.client}
              </Text>
              {request.isNewClient ? <Badge label="New" tone="primary" /> : null}
            </View>
            <View className="flex-row items-center gap-1">
              <Icon name={source.icon} size={14} color="muted-foreground" />
              <Text variant="footnote" tone="muted">
                {source.label} · {request.receivedAgo} ago
              </Text>
            </View>
          </View>
        </View>

        {!compact ? (
          <View className="rounded-lg bg-muted px-3 py-2">
            <Text variant="subhead">“{request.message}”</Text>
          </View>
        ) : null}

        <View className="gap-2">
          <View className="flex-row flex-wrap gap-2">
            {svc.map((s) => (
              <Chip key={s.id} label={s.name} tag={s.tag} />
            ))}
          </View>
          <View className="flex-row items-center gap-2">
            <Icon name="sparkles" size={16} color="primary" />
            <Text variant="subhead" className="flex-1 font-semibold">
              {slot}
            </Text>
            <Text variant="footnote" tone="muted" numeric>
              {formatDuration(minutes)} · ${price}
            </Text>
          </View>
          {!compact && request.alternatives.length ? (
            <View className="flex-row flex-wrap gap-2">
              {[request.proposed, ...request.alternatives].map((a) => (
                <Chip
                  key={a}
                  label={a === request.proposed ? 'Suggested' : a}
                  selected={slot === a}
                  onPress={() => setSlot(a)}
                />
              ))}
            </View>
          ) : null}
        </View>

        <View className="flex-row gap-3">
          <Button
            variant="outline"
            label="Decline"
            haptic="warning"
            accessibilityLabel={`Decline ${request.client}`}
            onPress={() => inboxStore.resolve(request.id)}
            grow
          />
          <Button
            label="Approve"
            icon="checkmark"
            haptic={false}
            accessibilityLabel={`Approve ${request.client} for ${slot}`}
            onPress={() => {
              haptics.success();
              inboxStore.resolve(request.id);
            }}
            grow
          />
        </View>
      </Card>
    </Animated.View>
  );
}
