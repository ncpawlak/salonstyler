import type { PublicBookResponse, PublicService } from '@chairside/ai/public-booking';
import { formatAmount } from '@chairside/payments';
import { useMutation, useQuery } from '@tanstack/react-query';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  Badge,
  Button,
  Card,
  Chip,
  EmptyState,
  Icon,
  Input,
  SectionHeader,
  SkeletonRow,
  Text,
} from '@/components/ui';
import {
  publicBookingApi,
  signOutClient,
  verifiedEmail,
  verifyEmailCode,
  type BookingItem,
  type PublicBookingApi,
} from '@/features/public-booking/api';
import { ConciergePanel, type PickedSlot } from '@/features/public-booking/concierge-panel';

const DAYS_SHOWN = 14;

/** `YYYY-MM-DD` in the salon's time zone, `offset` days from today. */
function salonDate(timeZone: string, offset: number): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

function dayChipLabel(date: string, index: number): string {
  if (index === 0) return 'Today';
  if (index === 1) return 'Tomorrow';
  return new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

const duration = (minutes: number) =>
  minutes >= 60
    ? `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`
    : `${minutes}m`;

/**
 * Public booking page (`/b/<salon-slug>`): no account needed. Pick a service (or ask the concierge),
 * pick an open time from the engine, confirm with your email code. Bookings in Open hours confirm
 * straight away in Auto mode; Tentative hours, consultations and Draft mode make it a request.
 */
export default function PublicBookingScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const api = useMemo(() => publicBookingApi(slug), [slug]);
  const page = useQuery({ queryKey: ['public-booking', slug], queryFn: api.page, retry: false });
  const [picked, setPicked] = useState<PickedSlot | null>(null);
  const [booked, setBooked] = useState<{ status: 'confirmed' | 'requested'; label: string } | null>(
    null,
  );

  const title = page.data?.page.name ?? 'Book online';

  return (
    <SafeAreaView edges={['top']} className="flex-1 bg-background">
      <Stack.Screen options={{ title }} />
      <ScrollView className="flex-1" contentContainerClassName="px-4 pb-24 pt-6">
        <View className="w-full max-w-2xl gap-4 self-center">
          {page.isPending ? (
            <View className="gap-3">
              <SkeletonRow />
              <SkeletonRow />
            </View>
          ) : page.error || !page.data ? (
            <EmptyState
              icon="calendar-outline"
              title="Booking page not found"
              message={page.error?.message ?? 'Check the link and try again.'}
            />
          ) : !page.data.page.enabled ? (
            <EmptyState
              icon="calendar-outline"
              title={page.data.page.name}
              message="Online booking is turned off right now. Please contact the salon."
            />
          ) : (
            <>
              <View className="gap-2">
                <Text variant="title1" accessibilityRole="header">
                  {page.data.page.name}
                </Text>
                {page.data.page.intro ? (
                  <Text variant="body" tone="muted">
                    {page.data.page.intro}
                  </Text>
                ) : null}
              </View>
              {booked ? (
                <Confirmation
                  booked={booked}
                  salon={page.data.page.name}
                  onAnother={() => {
                    setBooked(null);
                    setPicked(null);
                  }}
                />
              ) : picked ? (
                <DetailsStep
                  api={api}
                  slot={picked}
                  onBack={() => setPicked(null)}
                  onBooked={setBooked}
                />
              ) : (
                <>
                  {page.data.page.concierge ? (
                    <ConciergePanel api={api} onPick={setPicked} />
                  ) : null}
                  <PickStep
                    api={api}
                    services={page.data.services}
                    currency={page.data.page.currency}
                    timeZone={page.data.page.timezone}
                    onPick={setPicked}
                  />
                </>
              )}
              {page.data.page.faq ? (
                <>
                  <SectionHeader title="Good to know" />
                  <Card>
                    <Text variant="subhead">{page.data.page.faq}</Text>
                  </Card>
                </>
              ) : null}
            </>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function PickStep({
  api,
  services,
  currency,
  timeZone,
  onPick,
}: {
  api: PublicBookingApi;
  services: PublicService[];
  currency: string;
  timeZone: string;
  onPick: (slot: PickedSlot) => void;
}) {
  const [item, setItem] = useState<BookingItem | null>(null);
  const [dayIndex, setDayIndex] = useState(0);
  const dates = useMemo(
    () => Array.from({ length: DAYS_SHOWN }, (_, i) => salonDate(timeZone, i)),
    [timeZone],
  );
  const date = dates[dayIndex]!;
  const slots = useQuery({
    queryKey: ['public-booking-slots', item, date],
    queryFn: () => api.slots({ services: [item!], date }),
    enabled: item !== null,
    retry: false,
  });

  if (!services.length) {
    return (
      <EmptyState
        icon="cut-outline"
        title="No services online yet"
        message="Please contact the salon to book."
      />
    );
  }

  return (
    <View className="gap-2">
      <SectionHeader title="1. Choose a service" />
      <View className="gap-2">
        {services.map((s) => {
          const selected = item?.serviceId === s.id;
          return (
            <Card key={s.id} className={selected ? 'gap-2 border-primary' : 'gap-2'}>
              <View className="flex-row items-start justify-between gap-3">
                <View className="flex-1 gap-0.5">
                  <Text variant="headline">{s.name}</Text>
                  <Text variant="footnote" tone="muted">
                    {[
                      duration(s.minutes),
                      s.priceCents != null ? formatAmount(s.priceCents, currency) : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                  {s.description ? (
                    <Text variant="footnote" tone="muted">
                      {s.description}
                    </Text>
                  ) : null}
                </View>
                <Button
                  size="sm"
                  variant={selected ? 'primary' : 'outline'}
                  label={selected ? 'Selected' : 'Select'}
                  accessibilityLabel={`Select ${s.name}`}
                  onPress={() => setItem({ serviceId: s.id, variantId: null })}
                />
              </View>
              {s.consultationRequired || s.newClientsOnly ? (
                <View className="flex-row gap-2">
                  {s.consultationRequired ? <Badge label="Request · stylist confirms" /> : null}
                  {s.newClientsOnly ? <Badge label="New clients" tone="primary" /> : null}
                </View>
              ) : null}
              {selected && s.variants.length ? (
                <View className="flex-row flex-wrap gap-2">
                  <Chip
                    label="Standard"
                    selected={!item?.variantId}
                    onPress={() => setItem({ serviceId: s.id, variantId: null })}
                  />
                  {s.variants.map((v) => (
                    <Chip
                      key={v.id}
                      label={`${v.name} · ${duration(v.minutes)}`}
                      selected={item?.variantId === v.id}
                      onPress={() => setItem({ serviceId: s.id, variantId: v.id })}
                    />
                  ))}
                </View>
              ) : null}
            </Card>
          );
        })}
      </View>

      {item ? (
        <>
          <SectionHeader title="2. Pick a day" />
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View className="flex-row gap-2">
              {dates.map((d, i) => (
                <Chip
                  key={d}
                  label={dayChipLabel(d, i)}
                  selected={i === dayIndex}
                  onPress={() => setDayIndex(i)}
                />
              ))}
            </View>
          </ScrollView>
          <SectionHeader title="3. Pick a time" />
          {slots.isPending ? (
            <SkeletonRow />
          ) : slots.error ? (
            <Text variant="subhead" tone="destructive">
              {slots.error.message}
            </Text>
          ) : (
            <View className="gap-3">
              {slots.data.card.requestedNote ? (
                <Text variant="subhead" tone="muted">
                  {slots.data.card.requestedNote}
                </Text>
              ) : null}
              {slots.data.card.days
                .filter((d) => d.slots.length > 0)
                .map((d) => (
                  <View key={d.date} className="gap-1.5">
                    <Text variant="subhead" className="font-medium">
                      {d.label}
                    </Text>
                    <View className="flex-row flex-wrap gap-2">
                      {d.slots.map((s) => (
                        <Chip
                          key={s.start}
                          label={s.requiresApproval ? `${s.time} · request` : s.time}
                          onPress={() =>
                            onPick({
                              items: [item],
                              serviceSummary: slots.data.card.serviceSummary,
                              start: s.start,
                              label: `${d.label} · ${s.time}`,
                            })
                          }
                        />
                      ))}
                    </View>
                  </View>
                ))}
              {slots.data.card.days.every((d) => d.slots.length === 0) ? (
                <Text variant="subhead" tone="muted">
                  Nothing open around this day. Try another day.
                </Text>
              ) : null}
            </View>
          )}
        </>
      ) : null}
    </View>
  );
}

function DetailsStep({
  api,
  slot,
  onBack,
  onBooked,
}: {
  api: PublicBookingApi;
  slot: PickedSlot;
  onBack: () => void;
  onBooked: (b: { status: 'confirmed' | 'requested'; label: string }) => void;
}) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [notes, setNotes] = useState('');
  const [code, setCode] = useState('');
  const [codeSentTo, setCodeSentTo] = useState<string | null>(null);
  const [verified, setVerified] = useState<string | null>(null);

  useEffect(() => {
    void verifiedEmail().then(setVerified);
  }, []);

  // A due deposit holds the slot; the booking counts once it is paid on the pay page.
  const done = (res: PublicBookResponse) => {
    const { deposit, status, label } = res.booking;
    if (deposit) router.push(`/pay/${deposit.payToken}`);
    else onBooked({ status: status === 'confirmed' ? 'confirmed' : 'requested', label });
  };

  const book = useMutation({
    mutationFn: () =>
      api.book({ services: slot.items, start: slot.start, name, phone, notes: notes || null }),
    onSuccess: done,
  });
  const sendCode = useMutation({
    mutationFn: () => api.sendCode({ email: email.trim(), phone }),
    onSuccess: () => setCodeSentTo(email.trim()),
  });
  const verify = useMutation({
    mutationFn: async () => {
      await verifyEmailCode(codeSentTo!, code.trim());
      setVerified(codeSentTo);
      return api.book({
        services: slot.items,
        start: slot.start,
        name,
        phone,
        notes: notes || null,
      });
    },
    onSuccess: done,
  });

  const detailsReady = name.trim().length > 0 && phone.trim().length >= 7;
  const error = book.error ?? sendCode.error ?? verify.error;

  return (
    <View className="gap-3">
      <Card className="flex-row items-center gap-3">
        <Icon name="calendar-outline" size={22} color="primary" />
        <View className="flex-1">
          <Text variant="headline">{slot.label}</Text>
          <Text variant="footnote" tone="muted">
            {slot.serviceSummary}
          </Text>
        </View>
        <Button variant="ghost" size="sm" label="Change" onPress={onBack} />
      </Card>

      {codeSentTo && !verified ? (
        <Card className="gap-3">
          <Text variant="headline">Check your email</Text>
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
            label="Confirm booking"
            fullWidth
            loading={verify.isPending}
            disabled={code.trim().length < 6}
            onPress={() => verify.mutate()}
          />
          <Button
            variant="ghost"
            label="Use a different email"
            onPress={() => {
              setCodeSentTo(null);
              setCode('');
            }}
          />
        </Card>
      ) : (
        <Card className="gap-3">
          <Input label="Your name" value={name} onChangeText={setName} autoComplete="name" />
          <Input
            label="Mobile number"
            value={phone}
            onChangeText={setPhone}
            keyboardType="phone-pad"
            autoComplete="tel"
          />
          {verified ? (
            <View className="flex-row items-center justify-between">
              <Text variant="footnote" tone="muted">
                Booking as {verified}
              </Text>
              <Button
                variant="ghost"
                size="sm"
                label="Not you?"
                onPress={() => void signOutClient().then(() => setVerified(null))}
              />
            </View>
          ) : (
            <Input
              label="Email"
              helper="We’ll email you a code to confirm."
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              autoCapitalize="none"
              autoComplete="email"
            />
          )}
          <Input
            label="Notes for the stylist (optional)"
            value={notes}
            onChangeText={setNotes}
            maxLength={500}
            multiline
          />
          {verified ? (
            <Button
              label="Book"
              fullWidth
              loading={book.isPending}
              disabled={!detailsReady}
              onPress={() => book.mutate()}
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
        </Card>
      )}
      {error ? (
        <Text variant="subhead" tone="destructive">
          {error.message}
        </Text>
      ) : null}
    </View>
  );
}

function Confirmation({
  booked,
  salon,
  onAnother,
}: {
  booked: { status: 'confirmed' | 'requested'; label: string };
  salon: string;
  onAnother: () => void;
}) {
  const confirmed = booked.status === 'confirmed';
  return (
    <Card className="items-center gap-3 py-6">
      <View
        className={`h-14 w-14 items-center justify-center rounded-full ${confirmed ? 'bg-success' : 'bg-warning'}`}
      >
        <Icon
          name={confirmed ? 'checkmark' : 'time-outline'}
          size={30}
          color={confirmed ? 'success-foreground' : 'warning-foreground'}
        />
      </View>
      <Text variant="title2" className="text-center">
        {confirmed ? 'You’re booked!' : 'Request sent'}
      </Text>
      <Text variant="body" tone="muted" className="text-center">
        {confirmed
          ? `${booked.label} at ${salon}. See you then!`
          : `${salon} will confirm ${booked.label} soon.`}
      </Text>
      <Button variant="ghost" label="Book something else" onPress={onAnother} />
    </Card>
  );
}
