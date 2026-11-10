import { useMutation } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { Button, Card, Chip, Icon, Input, Text } from '@/components/ui';
import {
  type BookingItem,
  type PublicBookingApi,
  verifiedEmail,
  verifyEmailCode,
} from '@/features/public-booking/api';

import { joinWaitlist } from './api';

/** Rough parts of the day a client can wait for; the engine still checks the exact fit. */
export const WAITLIST_WINDOWS = [
  { key: 'any', label: 'Any time', start: null, end: null },
  { key: 'morning', label: 'Morning', start: '08:00', end: '12:00' },
  { key: 'afternoon', label: 'Afternoon', start: '12:00', end: '17:00' },
  { key: 'evening', label: 'Evening', start: '17:00', end: '21:00' },
] as const;

/**
 * "Nothing works? Join the waitlist" under the booking page's times (#21). The client picks a
 * part of the day and verifies their email like a booking; if a matching time frees up they get
 * an offer, and the first to claim it books it.
 */
export function WaitlistJoin({
  api,
  item,
  date,
  dayLabel,
}: {
  api: PublicBookingApi;
  item: BookingItem;
  date: string;
  dayLabel: string;
}) {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const [open, setOpen] = useState(false);
  const [windowKey, setWindowKey] = useState<(typeof WAITLIST_WINDOWS)[number]['key']>('any');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [codeSentTo, setCodeSentTo] = useState<string | null>(null);
  const [verified, setVerified] = useState<string | null>(null);

  useEffect(() => {
    if (open) void verifiedEmail().then(setVerified);
  }, [open]);

  const span = WAITLIST_WINDOWS.find((w) => w.key === windowKey)!;
  const join = useMutation({
    mutationFn: () =>
      joinWaitlist({
        slug,
        date,
        windowStart: span.start,
        windowEnd: span.end,
        items: [item],
        name: name.trim() || undefined,
        phone: phone.trim() || undefined,
      }),
    onSuccess: (r) => router.push(`/w/${r.token}`),
  });
  const sendCode = useMutation({
    mutationFn: () => api.sendCode({ email: email.trim(), phone }),
    onSuccess: () => setCodeSentTo(email.trim()),
  });
  const verify = useMutation({
    mutationFn: async () => {
      await verifyEmailCode(codeSentTo!, code.trim());
      setVerified(codeSentTo);
      return join.mutateAsync();
    },
  });

  if (!open) {
    return (
      <Card className="flex-row items-center gap-3" testID="waitlist-join">
        <Icon name="time-outline" color="primary" />
        <View className="flex-1">
          <Text variant="headline">No time that works?</Text>
          <Text variant="footnote" tone="muted">
            Join the waitlist for {dayLabel}. If a spot opens up, you’ll get first dibs.
          </Text>
        </View>
        <Button size="sm" variant="outline" label="Join waitlist" onPress={() => setOpen(true)} />
      </Card>
    );
  }

  const detailsReady = name.trim().length > 0 && phone.trim().length >= 7;
  const error = join.error ?? sendCode.error ?? verify.error;

  return (
    <Card className="gap-3" testID="waitlist-join">
      <Text variant="headline">Waitlist for {dayLabel}</Text>
      <View className="flex-row flex-wrap gap-2">
        {WAITLIST_WINDOWS.map((w) => (
          <Chip
            key={w.key}
            label={w.label}
            selected={w.key === windowKey}
            onPress={() => setWindowKey(w.key)}
          />
        ))}
      </View>
      {codeSentTo && !verified ? (
        <>
          <Text variant="subhead" tone="muted">
            We sent a 6-digit code to {codeSentTo}.
          </Text>
          <Input
            label="Code"
            value={code}
            onChangeText={setCode}
            keyboardType="number-pad"
            autoComplete="one-time-code"
            maxLength={10}
          />
          <Button
            label="Join the waitlist"
            fullWidth
            loading={verify.isPending}
            disabled={code.trim().length < 6}
            onPress={() => verify.mutate()}
          />
        </>
      ) : (
        <>
          <Input label="Your name" value={name} onChangeText={setName} autoComplete="name" />
          <Input
            label="Mobile number"
            value={phone}
            onChangeText={setPhone}
            keyboardType="phone-pad"
            autoComplete="tel"
          />
          {verified ? (
            <Text variant="footnote" tone="muted">
              Joining as {verified}
            </Text>
          ) : (
            <Input
              label="Email"
              helper="We’ll email you a code to confirm, and your offer if a spot opens."
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              autoCapitalize="none"
              autoComplete="email"
            />
          )}
          {verified ? (
            <Button
              label="Join the waitlist"
              fullWidth
              loading={join.isPending}
              disabled={!detailsReady}
              onPress={() => join.mutate()}
            />
          ) : (
            <Button
              label="Email me a code"
              fullWidth
              loading={sendCode.isPending}
              disabled={!detailsReady || !/^\S+@\S+\.\S+$/.test(email.trim())}
              onPress={() => sendCode.mutate()}
            />
          )}
        </>
      )}
      {error ? (
        <Text variant="subhead" tone="destructive" accessibilityLiveRegion="polite">
          {error.message}
        </Text>
      ) : null}
      <Button variant="ghost" label="Not now" onPress={() => setOpen(false)} />
    </Card>
  );
}
