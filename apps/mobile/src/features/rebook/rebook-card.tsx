import type { SlotCandidate } from '@chairside/core';
import {
  formatRebookInterval,
  rebookInterval,
  suggestRebookSlots,
  type RebookInterval,
} from '@chairside/core/rebook';
import type { AppointmentWithDetails } from '@chairside/db/appointments';
import type { CheckoutWithItems } from '@chairside/db/checkout';
import * as Linking from 'expo-linking';
import { useMemo, useState } from 'react';
import { Platform, View } from 'react-native';

import {
  Button,
  Card,
  Icon,
  ListGroup,
  ListRow,
  SectionHeader,
  SegmentedControl,
  Text,
} from '@/components/ui';
import { haptics } from '@/lib/haptics';
import { useCurrentSalon } from '@/providers/session-provider';

import { errorMessage } from '../appointments/api';
import { formatDay, formatTime } from '../appointments/format';
import { resolveSelection, selectionFromSnapshots } from '../appointments/selection';
import { useClientOverrides, useClientVisits } from '../clients/api';
import { useWorkHours } from '../hours/use-work-hours';
import { useServiceMenu } from '../services/data';
import {
  useAppointmentDetail,
  useAppointmentsBetween,
  useRebookFromCheckout,
  useRebookStats,
  useServiceRebookIntervals,
  useSkipRebook,
} from './api';
import { rebookConfirmationLinks, rebookConfirmationMessage } from './confirmation';

const DAY_MS = 86_400_000;
const UPCOMING = new Set(['held', 'requested', 'confirmed']);

const statusOptions = [
  { value: 'confirmed', label: 'Confirm' },
  { value: 'held', label: 'Hold' },
] as const;

export interface RebookClient {
  name: string;
  phone: string | null;
  email: string | null;
}

/**
 * After payment: suggests the client's next visit from the service interval and books it in one
 * tap (docs/PLAN.md §11b, #42). Once booked, offers the confirmation text/email.
 */
export function RebookSection({
  checkout,
  client,
}: {
  checkout: CheckoutWithItems;
  client: RebookClient | null | undefined;
}) {
  const booked = useAppointmentDetail(checkout.rebook_appointment_id);
  if (!checkout.client_id || !checkout.appointment_id) return null;
  const active = booked.data && UPCOMING.has(booked.data.status) ? booked.data : null;

  return (
    <View className="mt-6">
      <SectionHeader title="Next visit" />
      {checkout.rebook_appointment_id && booked.isPending ? (
        <Card>
          <Text tone="muted">Loading…</Text>
        </Card>
      ) : active ? (
        <Booked appointment={active} client={client} />
      ) : (
        <Suggest
          checkout={checkout}
          clientId={checkout.client_id}
          appointmentId={checkout.appointment_id}
          clientName={client?.name}
        />
      )}
      <RebookRate />
    </View>
  );
}

function Suggest({
  checkout,
  clientId,
  appointmentId,
  clientName,
}: {
  checkout: CheckoutWithItems;
  clientId: string;
  appointmentId: string;
  clientName: string | undefined;
}) {
  const salon = useCurrentSalon();
  const visit = useAppointmentDetail(appointmentId);
  const menu = useServiceMenu();
  const intervals = useServiceRebookIntervals();
  const overrides = useClientOverrides(clientId);
  const visits = useClientVisits(clientId);
  const workHours = useWorkHours(salon.id);
  const rebook = useRebookFromCheckout(appointmentId);
  const skip = useSkipRebook(appointmentId);

  const [status, setStatus] = useState<'confirmed' | 'held'>('confirmed');
  const [expanded, setExpanded] = useState(!checkout.rebook_declined_at);
  const [openedAt] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);

  const appt = visit.data;
  const firstName = clientName?.trim().split(/\s+/)[0] ?? 'the client';

  const upcoming = useMemo(
    () =>
      visits.data
        ?.filter(
          (v) =>
            v.id !== appointmentId && UPCOMING.has(v.status) && Date.parse(v.startsAt) > openedAt,
        )
        .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))[0] ?? null,
    [visits.data, appointmentId, openedAt],
  );

  const interval = useMemo((): RebookInterval | null => {
    if (!appt || !menu.data || !intervals.data || !visits.data) return null;
    const defs = [...menu.data.services, ...menu.data.combos];
    const services = appt.services.map((s) => {
      const def = defs.find((d) => d.id === s.serviceId);
      return {
        id: s.serviceId,
        name: def?.name ?? s.name,
        category: def?.category ?? null,
        rebookIntervalDays: intervals.data.get(s.serviceId) ?? null,
      };
    });
    const history = visits.data
      .filter((v) => v.status === 'completed' || v.id === appointmentId)
      .map((v) => ({ startsAt: v.startsAt, serviceIds: v.services.map((s) => s.serviceId) }));
    return rebookInterval(services, history);
  }, [appt, menu.data, intervals.data, visits.data, appointmentId]);

  const resolved = useMemo(
    () =>
      appt && menu.data
        ? resolveSelection(menu.data, selectionFromSnapshots(appt.services), overrides.data ?? [])
        : null,
    [appt, menu.data, overrides.data],
  );

  // Rounding to whole weeks moves the due date by up to half a week; the search covers ±3 days
  // and up to three more weeks.
  const range = useMemo(() => {
    if (!appt || !interval) return null;
    const start = Date.parse(appt.starts_at);
    return {
      from: new Date(start + (interval.days - 8) * DAY_MS).toISOString(),
      to: new Date(start + (interval.days + 34) * DAY_MS).toISOString(),
    };
  }, [appt, interval]);
  const calendar = useAppointmentsBetween(range);

  const suggestion = useMemo(() => {
    if (!appt || !interval || !resolved || !workHours.data || !calendar.data) return null;
    return suggestRebookSlots({
      service: resolved.service,
      hours: workHours.data.hours,
      existing: calendar.data.map((a) => ({ id: a.id, segments: a.segments })),
      visitStart: appt.starts_at,
      intervalDays: interval.days,
      now: openedAt,
      rules: { slotGridMinutes: workHours.data.rules.slotGridMinutes },
    });
  }, [appt, interval, resolved, workHours.data, calendar.data, openedAt]);

  if (upcoming) {
    const tz = workHours.data?.hours.timeZone ?? salon.timezone;
    const ms = Date.parse(upcoming.startsAt);
    return (
      <Card>
        <Text variant="subhead">
          {firstName} is already booked for {formatDay(ms, tz)} at {formatTime(ms, tz)}.
        </Text>
      </Card>
    );
  }

  if (!expanded) {
    return (
      <ListGroup>
        <ListRow
          title={`Book ${firstName}'s next visit`}
          subtitle="Skipped at checkout"
          leading={<Icon name="calendar-outline" color="primary" />}
          onPress={() => setExpanded(true)}
          chevron
          last
        />
      </ListGroup>
    );
  }

  const failed = visit.error ?? menu.error ?? workHours.error ?? calendar.error;
  if (failed) {
    return (
      <Card>
        <Text tone="destructive">{errorMessage(failed)}</Text>
      </Card>
    );
  }
  if (!appt || !interval || !suggestion) {
    return (
      <Card>
        <Text tone="muted">Finding times for {firstName}&apos;s next visit…</Text>
      </Card>
    );
  }

  const tz = workHours.data!.hours.timeZone;
  const pick = async (slot: SlotCandidate) => {
    setError(null);
    try {
      await rebook.mutateAsync({
        checkoutId: checkout.id,
        segments: slot.segments,
        services: resolved?.snapshots ?? appt.services,
        status,
        priceCents: appt.price_cents,
      });
      haptics.success();
    } catch (e) {
      haptics.error();
      setError(errorMessage(e));
    }
  };

  return (
    <Card className="gap-3">
      <View className="gap-1">
        <Text variant="headline" accessibilityRole="header">
          Book {firstName}&apos;s next {interval.serviceName} in{' '}
          {formatRebookInterval(interval.days)}?
        </Text>
        <Text variant="footnote" tone="muted">
          {interval.source === 'client'
            ? `${firstName} comes back about every ${formatRebookInterval(interval.days).replace('~', '')}`
            : interval.source === 'service'
              ? `Your rebook interval for ${interval.serviceName}`
              : interval.source === 'typical'
                ? `Typical for ${interval.serviceName}`
                : 'Suggested interval'}
          {' · around '}
          {formatTime(Date.parse(appt.starts_at), tz)}
        </Text>
      </View>

      {suggestion.slots.length === 0 ? (
        <Text tone="muted">No open times in the next month around then.</Text>
      ) : (
        <View className="gap-2">
          {suggestion.slots.map((slot) => {
            const ms = Date.parse(slot.start);
            return (
              <Button
                key={slot.start}
                variant="outline"
                fullWidth
                icon="calendar-outline"
                label={`${formatDay(ms, tz)} · ${formatTime(ms, tz)}`}
                accessibilityHint={status === 'held' ? 'Places a hold' : 'Books this time'}
                loading={rebook.isPending && rebook.variables?.segments === slot.segments}
                disabled={rebook.isPending}
                onPress={() => void pick(slot)}
              />
            );
          })}
        </View>
      )}

      <SegmentedControl
        accessibilityLabel="Rebook as"
        options={statusOptions}
        value={status}
        onChange={setStatus}
      />

      {error ? (
        <View
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          className="rounded-xl bg-destructive/10 px-4 py-3"
        >
          <Text variant="subhead" tone="destructive">
            {error}
          </Text>
        </View>
      ) : null}

      <Button
        variant="ghost"
        label="Not now"
        disabled={rebook.isPending || skip.isPending}
        onPress={() => {
          setExpanded(false);
          if (!checkout.rebook_declined_at) skip.mutate(checkout.id);
        }}
      />
    </Card>
  );
}

function Booked({
  appointment,
  client,
}: {
  appointment: AppointmentWithDetails;
  client: RebookClient | null | undefined;
}) {
  const salon = useCurrentSalon();
  const workHours = useWorkHours(salon.id);
  const tz = workHours.data?.hours.timeZone ?? salon.timezone;
  const ms = Date.parse(appointment.starts_at);
  const held = appointment.status === 'held';
  const links = rebookConfirmationLinks({
    message: rebookConfirmationMessage({
      clientName: client?.name,
      salonName: salon.name,
      startsAt: appointment.starts_at,
      timeZone: tz,
      held,
    }),
    salonName: salon.name,
    phone: client?.phone,
    email: client?.email,
    platform: Platform.OS,
  });

  return (
    <ListGroup>
      <ListRow
        title={`${held ? 'Holding' : 'Booked'} ${formatDay(ms, tz)} · ${formatTime(ms, tz)}`}
        subtitle={held ? 'Releases automatically if not confirmed' : 'Next visit confirmed'}
        leading={<Icon name="checkmark-circle" color="success" />}
      />
      <ListRow
        title={held ? 'Text to confirm' : 'Text confirmation'}
        subtitle={client?.phone ?? undefined}
        leading={<Icon name="chatbubble-outline" color="primary" />}
        onPress={() => void Linking.openURL(links.sms)}
      />
      <ListRow
        title={held ? 'Email to confirm' : 'Email confirmation'}
        subtitle={client?.email ?? undefined}
        leading={<Icon name="mail-outline" color="primary" />}
        onPress={() => void Linking.openURL(links.email)}
        last
      />
    </ListGroup>
  );
}

function RebookRate() {
  const stats = useRebookStats();
  if (!stats.data || stats.data.rate == null) return null;
  return (
    <Text variant="footnote" tone="muted" className="mt-2 text-center">
      Rebook rate, last 30 days: {Math.round(stats.data.rate * 100)}% ({stats.data.rebooked} of{' '}
      {stats.data.checkouts})
    </Text>
  );
}
