import type { WaitlistLinkView } from '@chairside/db/waitlist';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Badge, Button, Card, EmptyState, Icon, SkeletonRow, Text } from '@/components/ui';
import { formatDay, formatLocalDateLong, formatTime } from '@/features/appointments/format';
import { waitlistLinkApi } from '@/features/waitlist/api';
import { windowLabel } from '@/features/waitlist/offer-text';

const STATUS: Record<
  WaitlistLinkView['entry']['status'],
  { label: string; tone?: 'success' | 'warning' | 'primary' }
> = {
  waiting: { label: 'On the waitlist', tone: 'primary' },
  offered: { label: 'Spot offered', tone: 'warning' },
  booked: { label: 'Booked', tone: 'success' },
  expired: { label: 'Ended' },
  cancelled: { label: 'Left' },
};

/**
 * A client's waitlist link (`/w/<token>`), from joining on the booking page or an offer email
 * or text. Signed out: the token alone unlocks this one entry. Claim an offered time (the first
 * client to claim it books it), or leave the waitlist.
 */
export default function WaitlistLinkScreen() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const view = useQuery({
    queryKey: ['waitlist-link', token],
    queryFn: waitlistLinkApi(token).view,
    retry: false,
  });

  return (
    <SafeAreaView edges={['top']} className="flex-1 bg-background">
      <View className="w-full max-w-2xl flex-1 self-center">
        <ScrollView className="flex-1" contentContainerClassName="px-4 pb-24 pt-6">
          {view.isPending ? (
            <View className="gap-3">
              <SkeletonRow />
              <SkeletonRow />
            </View>
          ) : view.error || !view.data ? (
            <EmptyState
              icon="time-outline"
              title="Waitlist link not found"
              message={
                view.error?.message ?? 'This link may be mistyped or expired. Contact the salon.'
              }
            />
          ) : (
            <LinkView token={token} link={view.data.link} />
          )}
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

function LinkView({ token, link }: { token: string; link: WaitlistLinkView }) {
  const queryClient = useQueryClient();
  const api = waitlistLinkApi(token);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const setLink = (next: WaitlistLinkView) =>
    queryClient.setQueryData(['waitlist-link', token], { link: next });
  const tz = link.salon.timezone;
  const status = STATUS[link.entry.status];
  const window = windowLabel(link.entry.windowStart, link.entry.windowEnd);

  const accept = useMutation({
    mutationFn: (offerId: string) => api.accept(offerId),
    onSuccess: (r) => {
      setLink(r.link);
      setNotice('You’re booked! A confirmation is on its way.');
    },
    onError: () => void queryClient.invalidateQueries({ queryKey: ['waitlist-link', token] }),
  });
  const leave = useMutation({
    mutationFn: api.leave,
    onSuccess: (r) => {
      setLink(r.link);
      setConfirmLeave(false);
      setNotice('You’ve left the waitlist.');
    },
  });

  const offer = link.offer;
  const booking = link.booking;
  const live = link.entry.status === 'waiting' || link.entry.status === 'offered';

  return (
    <View className="gap-4">
      <View className="items-center gap-1">
        <Text variant="title2" accessibilityRole="header" className="text-center">
          {link.salon.name}
        </Text>
        <Text variant="subhead" tone="muted" className="text-center">
          {link.entry.clientFirstName ? `Hi ${link.entry.clientFirstName}, ` : ''}here’s your
          waitlist spot
        </Text>
      </View>

      <Card className="gap-2" testID="waitlist-card">
        <View className="flex-row items-center justify-between gap-3">
          <Text variant="headline" className="flex-1">
            {link.entry.servicesLabel}
          </Text>
          <Badge label={status.label} tone={status.tone} />
        </View>
        <View className="flex-row items-center gap-2">
          <Icon name="calendar-outline" size={18} color="muted-foreground" />
          <Text variant="body">
            {formatLocalDateLong(link.entry.day)} · {window ?? 'Any time'}
          </Text>
        </View>
      </Card>

      {offer && link.entry.status === 'offered' ? (
        <Card className="gap-3 border-primary" testID="waitlist-offer">
          <Text variant="headline">A spot opened up!</Text>
          <View className="flex-row items-center gap-2">
            <Icon name="time-outline" size={18} color="primary" />
            <Text variant="body" testID="waitlist-offer-when">
              {formatDay(Date.parse(offer.startsAt), tz)} ·{' '}
              {formatTime(Date.parse(offer.startsAt), tz)}
            </Text>
          </View>
          <Text variant="footnote" tone="muted">
            It goes to whoever claims it first. Offer ends at{' '}
            {formatTime(Date.parse(offer.expiresAt), tz)}.
          </Text>
          <Button
            label="Claim this time"
            fullWidth
            loading={accept.isPending}
            onPress={() => {
              setNotice(null);
              accept.mutate(offer.offerId);
            }}
          />
        </Card>
      ) : null}

      {booking ? (
        <Card className="gap-3" testID="waitlist-booked">
          <View className="flex-row items-center gap-2">
            <Icon name="checkmark-circle" size={22} color="success" />
            <Text variant="headline">
              Booked for {formatDay(Date.parse(booking.startsAt), tz)} at{' '}
              {formatTime(Date.parse(booking.startsAt), tz)}
            </Text>
          </View>
          <Button
            variant="outline"
            label="View or change your appointment"
            fullWidth
            onPress={() => router.push(`/m/${booking.manageToken}`)}
          />
        </Card>
      ) : null}

      {notice ? (
        <Text
          variant="subhead"
          tone="success"
          accessibilityLiveRegion="polite"
          testID="waitlist-notice"
        >
          {notice}
        </Text>
      ) : null}
      {accept.error || leave.error ? (
        <Text variant="subhead" tone="destructive" accessibilityLiveRegion="polite">
          {(accept.error ?? leave.error)!.message}
        </Text>
      ) : null}

      {link.entry.status === 'waiting' ? (
        <Text variant="footnote" tone="muted" className="text-center">
          We’ll email you if a time opens up that day. Keep this link to check or leave.
        </Text>
      ) : null}

      {live ? (
        confirmLeave ? (
          <Card className="gap-3">
            <Text variant="body">Leave the waitlist for this day?</Text>
            <View className="flex-row gap-2">
              <Button grow variant="outline" label="Stay" onPress={() => setConfirmLeave(false)} />
              <Button
                grow
                variant="destructive"
                label="Leave"
                loading={leave.isPending}
                onPress={() => leave.mutate()}
              />
            </View>
          </Card>
        ) : (
          <Button
            variant="ghost"
            label="Leave the waitlist"
            fullWidth
            onPress={() => setConfirmLeave(true)}
          />
        )
      ) : !booking ? (
        <Button
          variant="outline"
          label="Book another time"
          fullWidth
          onPress={() => router.push(`/b/${link.salon.slug}`)}
        />
      ) : null}
    </View>
  );
}
