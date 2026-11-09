import { formatDuration } from '@chairside/core';
import type { AppointmentWithDetails } from '@chairside/db/appointments';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import Animated, {
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { Avatar, Badge, Button, Card, Icon, Text } from '@/components/ui';
import { haptics } from '@/lib/haptics';
import { useTheme } from '@/theme/theme-provider';
import { radius } from '@/theme/tokens';

import { formatPrice } from '../services/data';
import { formatDay, formatTime } from '../appointments/format';
import { ServicePills } from './service-pills';
import { clientSpan } from './summary';

const THRESHOLD = 110;
const FLING_VELOCITY = 900;

const styles = StyleSheet.create({
  reveal: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radius.xl,
    paddingHorizontal: 24,
  },
});

export type RequestDecision = 'approve' | 'decline';

/**
 * Pending booking requests as a card stack: swipe right to approve, left to decline. The buttons
 * do the same for anyone who can't (or would rather not) swipe.
 */
export function RequestStack({
  requests,
  timeZone,
  onDecide,
  onOpen,
}: {
  requests: AppointmentWithDetails[];
  timeZone: string;
  onDecide: (appt: AppointmentWithDetails, decision: RequestDecision) => void;
  onOpen: (appt: AppointmentWithDetails) => void;
}) {
  const [top, ...rest] = requests;
  if (!top) return null;
  const peeks = rest.slice(0, 2);

  return (
    <View testID="request-stack" style={{ paddingBottom: peeks.length * 8 }}>
      {peeks
        .map((r, i) => (
          <View
            key={r.id}
            pointerEvents="none"
            importantForAccessibility="no-hide-descendants"
            accessibilityElementsHidden
            className="absolute inset-x-0 top-0"
            style={{
              bottom: peeks.length * 8,
              transform: [{ translateY: (i + 1) * 8 }, { scale: 1 - (i + 1) * 0.04 }],
              opacity: 1 - (i + 1) * 0.25,
            }}
          >
            <Card className="h-full">
              <View />
            </Card>
          </View>
        ))
        .reverse()}
      <SwipeCard
        key={top.id}
        request={top}
        timeZone={timeZone}
        onDecide={(d) => onDecide(top, d)}
        onOpen={() => onOpen(top)}
      />
    </View>
  );
}

function SwipeCard({
  request,
  timeZone,
  onDecide,
  onOpen,
}: {
  request: AppointmentWithDetails;
  timeZone: string;
  onDecide: (decision: RequestDecision) => void;
  onOpen: () => void;
}) {
  const { width } = useWindowDimensions();
  const { colors } = useTheme();
  const reduceMotion = useReducedMotion();
  const x = useSharedValue(0);
  const armed = useSharedValue(0);

  const span = clientSpan(request);
  const name = request.client?.name ?? 'Walk-in';
  const minutes = Math.round((span.end - span.start) / 60_000);
  const when = `${formatDay(span.start, timeZone)} · ${formatTime(span.start, timeZone)}`;

  const decide = (decision: RequestDecision) => {
    if (decision === 'approve') haptics.success();
    else haptics.warning();
    onDecide(decision);
  };
  const arm = () => haptics.selection();

  const flyOut = (decision: RequestDecision) => {
    if (reduceMotion) return decide(decision);
    x.value = withTiming(
      (decision === 'approve' ? 1 : -1) * (width + 80),
      { duration: 200 },
      (finished) => {
        if (finished) scheduleOnRN(decide, decision);
      },
    );
  };

  const pan = usePanGesture({
    activeOffsetX: [-12, 12],
    failOffsetY: [-14, 14],
    onUpdate: (e) => {
      'worklet';
      x.value = e.translationX;
      const next = Math.abs(e.translationX) > THRESHOLD ? Math.sign(e.translationX) : 0;
      if (next !== armed.value) {
        armed.value = next;
        if (next !== 0) scheduleOnRN(arm);
      }
    },
    onDeactivate: (e) => {
      'worklet';
      armed.value = 0;
      const fling = Math.abs(e.velocityX) > FLING_VELOCITY;
      if (!e.canceled && (Math.abs(e.translationX) > THRESHOLD || fling)) {
        const decision: RequestDecision =
          (fling ? e.velocityX : e.translationX) > 0 ? 'approve' : 'decline';
        x.value = withTiming(
          (decision === 'approve' ? 1 : -1) * (width + 80),
          { duration: 180 },
          (finished) => {
            if (finished) scheduleOnRN(decide, decision);
          },
        );
      } else {
        x.value = withSpring(0, { damping: 18, stiffness: 220 });
      }
    },
  });

  const cardStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: x.value },
      { rotate: `${interpolate(x.value, [-width, 0, width], [-10, 0, 10])}deg` },
    ],
  }));
  const approveStyle = useAnimatedStyle(() => ({
    opacity: interpolate(x.value, [0, THRESHOLD], [0, 1], 'clamp'),
  }));
  const declineStyle = useAnimatedStyle(() => ({
    opacity: interpolate(x.value, [-THRESHOLD, 0], [1, 0], 'clamp'),
  }));

  return (
    <View>
      {/* Revealed behind the card as it slides. Animated.View takes no className on web. */}
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          styles.reveal,
          { backgroundColor: colors.success, justifyContent: 'flex-start' },
          approveStyle,
        ]}
      >
        <Icon name="checkmark-circle" size={28} color="success-foreground" />
        <Text variant="headline" className="ml-2 text-success-foreground">
          Approve
        </Text>
      </Animated.View>
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          styles.reveal,
          { backgroundColor: colors.destructive, justifyContent: 'flex-end' },
          declineStyle,
        ]}
      >
        <Text variant="headline" className="mr-2 text-destructive-foreground">
          Decline
        </Text>
        <Icon name="close-circle" size={28} color="destructive-foreground" />
      </Animated.View>

      <GestureDetector gesture={pan}>
        <Animated.View
          style={cardStyle}
          testID="request-card"
          accessible
          accessibilityLabel={`Booking request from ${name}, ${when}`}
          accessibilityHint="Swipe right to approve or left to decline, or use the buttons"
          accessibilityActions={[
            { name: 'approve', label: 'Approve' },
            { name: 'decline', label: 'Decline' },
            { name: 'activate', label: 'Open details' },
          ]}
          onAccessibilityAction={(e) => {
            const action = e.nativeEvent.actionName;
            if (action === 'approve' || action === 'decline') flyOut(action);
            else onOpen();
          }}
        >
          <Card elevation="md" className="gap-3">
            <View className="flex-row items-center gap-3">
              <Avatar name={name} size={44} />
              <View className="flex-1">
                <View className="flex-row items-center gap-2">
                  <Text variant="headline" numberOfLines={1} className="shrink">
                    {name}
                  </Text>
                  <Badge label="Request" tone="warning" />
                </View>
                <View className="flex-row items-center gap-1">
                  <Icon name="time-outline" size={14} color="muted-foreground" />
                  <Text variant="footnote" tone="muted" numeric numberOfLines={1}>
                    {when} · {formatDuration(minutes)}
                    {request.price_cents != null ? ` · ${formatPrice(request.price_cents)}` : ''}
                  </Text>
                </View>
              </View>
              <Button
                variant="ghost"
                size="icon"
                icon="ellipsis-horizontal"
                accessibilityLabel={`Details for ${name}'s request`}
                onPress={onOpen}
              />
            </View>

            <ServicePills services={request.services} />

            {request.notes ? (
              <View className="rounded-lg bg-muted px-3 py-2">
                <Text variant="subhead" numberOfLines={2}>
                  “{request.notes}”
                </Text>
              </View>
            ) : null}

            <View className="flex-row gap-3">
              <Button
                variant="secondary"
                label="Decline"
                icon="close"
                grow
                accessibilityLabel={`Decline ${name}'s request`}
                onPress={() => flyOut('decline')}
              />
              <Button
                label="Approve"
                icon="checkmark"
                grow
                accessibilityLabel={`Approve ${name}'s request`}
                onPress={() => flyOut('approve')}
              />
            </View>
          </Card>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}
