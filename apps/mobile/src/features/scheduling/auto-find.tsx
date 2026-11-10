import type { ServiceRequest, WorkHours } from '@chairside/core';
import { rebookInterval, type RebookService } from '@chairside/core/rebook';
import {
  analyzeHabits,
  dueDate,
  hasHabits,
  suggestSlots,
  type SlotSuggestion,
} from '@chairside/core/scheduling';
import type { AppointmentServiceSnapshot } from '@chairside/db/appointments';
import { useMemo, useState } from 'react';
import { View } from 'react-native';

import { Button } from '@/components/ui';
import { useCurrentSalon } from '@/providers/session-provider';

import { errorMessage } from '../appointments/api';
import { formatDay, formatTime } from '../appointments/format';
import { useClientVisits } from '../clients/api';
import { useWorkHours } from '../hours/use-work-hours';
import { useAppointmentsBetween, useServiceRebookIntervals } from '../rebook/api';
import { useServiceMenu } from '../services/data';
import { type SuggestionItem, SuggestionList } from './suggestion-list';

const DAY_MS = 86_400_000;
/** Salon history used for "popular times" when the client has none of their own. */
const POPULAR_LOOKBACK_DAYS = 56;
/** `suggestSlots` searches six weeks; due dates can push it a little further. */
const LOOKAHEAD_DAYS = 56;

export interface AutoFindProps {
  clientId: string;
  clientName: string;
  service: ServiceRequest;
  services: readonly AppointmentServiceSnapshot[];
  hours: WorkHours;
  /** The appointment being edited, so it doesn't block its own time. */
  excludeId?: string | null;
  onPick: (pick: { start: number; tentative: boolean }) => void;
}

/**
 * Auto-Find (#88): ranks open times by the client's own booking pattern (weekdays, time of day,
 * every-other-week…) or, for new clients, the soonest openings and the salon's popular times.
 * The engine checks every slot; picking one only fills the form.
 */
export function AutoFind(props: AutoFindProps) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <Button
        variant="secondary"
        icon="sparkles"
        label="Auto-Find"
        accessibilityLabel={`Find good times for ${props.clientName}`}
        accessibilityHint="Lists open times based on when this client usually books"
        onPress={() => setOpen(true)}
        testID="booking-auto-find"
      />
    );
  }
  return <AutoFindList {...props} onClose={() => setOpen(false)} />;
}

function AutoFindList({
  clientId,
  service,
  services,
  hours,
  excludeId,
  onPick,
  onClose,
}: AutoFindProps & { onClose: () => void }) {
  const salon = useCurrentSalon();
  const workHours = useWorkHours(salon.id);
  const rules = workHours.data?.rules;
  const [now] = useState(() => Date.now());
  const visits = useClientVisits(clientId);
  const intervals = useServiceRebookIntervals();
  const menu = useServiceMenu();
  const range = useMemo(
    () => ({
      from: new Date(now - POPULAR_LOOKBACK_DAYS * DAY_MS).toISOString(),
      to: new Date(now + LOOKAHEAD_DAYS * DAY_MS).toISOString(),
    }),
    [now],
  );
  const calendar = useAppointmentsBetween(range);
  const tz = hours.timeZone;

  const result = useMemo(() => {
    if (!visits.data || !intervals.data || !menu.data || !calendar.data || !rules) return null;
    const habits = analyzeHabits(
      visits.data.map((v) => ({ startsAt: v.startsAt, status: v.status })),
      tz,
      { now },
    );
    const defs = [...menu.data.services, ...menu.data.combos];
    const rebookServices: RebookService[] = services.map((s) => {
      const def = defs.find((d) => d.id === s.serviceId);
      return {
        id: s.serviceId,
        name: def?.name ?? s.name,
        category: def?.category ?? null,
        rebookIntervalDays: intervals.data.get(s.serviceId) ?? null,
      };
    });
    const history = visits.data.map((v) => ({
      startsAt: v.startsAt,
      serviceIds: v.services.map((s) => s.serviceId),
    }));
    const due = dueDate(habits, rebookInterval(rebookServices, history));
    const past = calendar.data.filter((a) => Date.parse(a.starts_at) <= now);
    const popular = hasHabits(habits)
      ? null
      : analyzeHabits(
          past.map((a) => ({ startsAt: a.starts_at, status: a.status })),
          tz,
          { recent: 500 },
        );
    return suggestSlots({
      service,
      hours,
      existing: calendar.data
        .filter((a) => a.id !== excludeId)
        .map((a) => ({ id: a.id, segments: a.segments })),
      rules: {
        leadTimeMinutes: rules.minNoticeMinutes,
        bookingWindowDays: rules.bookingWindowDays,
        slotGridMinutes: rules.slotGridMinutes,
      },
      now,
      habits,
      due,
      popular,
    });
  }, [
    visits.data,
    intervals.data,
    menu.data,
    calendar.data,
    tz,
    now,
    services,
    service,
    hours,
    rules,
    excludeId,
  ]);

  const byKey = useMemo(
    () =>
      new Map<string, SlotSuggestion>((result?.suggestions ?? []).map((s) => [s.slot.start, s])),
    [result],
  );
  const items = useMemo<SuggestionItem[]>(
    () =>
      (result?.suggestions ?? []).map((s) => {
        const start = Date.parse(s.slot.start);
        return {
          key: s.slot.start,
          label: `${formatDay(start, tz)} · ${formatTime(start, tz)}`,
          tentative: s.tentative,
          reasons: s.reasons,
        };
      }),
    [result, tz],
  );

  const failed = visits.error ?? intervals.error ?? menu.error ?? calendar.error ?? workHours.error;

  return (
    <View className="gap-2">
      <SuggestionList
        testID="auto-find"
        items={items}
        loading={!result && !failed}
        error={failed ? errorMessage(failed) : null}
        onPick={(item) => {
          const s = byKey.get(item.key);
          if (s) onPick({ start: Date.parse(s.slot.start), tentative: s.tentative });
        }}
      />
      <Button
        variant="ghost"
        size="sm"
        label="Hide suggestions"
        accessibilityLabel="Hide Auto-Find suggestions"
        onPress={onClose}
      />
    </View>
  );
}
