import type { AutoScheduleResponse, AutoScheduleSuggestion } from '@chairside/ai/inbox';
import type { Appointment } from '@chairside/db';
import { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';

import { Button, Text } from '@/components/ui';
import { errorMessage } from '@/features/appointments/api';
import { haptics } from '@/lib/haptics';

import { formatPrice } from '../services/data';
import { type SuggestionItem, SuggestionList } from '../scheduling/suggestion-list';
import { useAutoSchedule, useScheduleCapturedRequest } from './auto-schedule';

/**
 * Auto-Schedule (#84), inline on an Inbox card: the AI reads when the client wants to come in, the
 * engine ranks slots that really fit, and one tap books (or moves) the appointment.
 */
export function AutoSchedulePanel({
  requestId,
  name,
  onScheduled,
  onClose,
}: {
  requestId: string;
  name: string;
  onScheduled: (appointment: Appointment, result: AutoScheduleResponse) => void;
  onClose: () => void;
}) {
  const find = useAutoSchedule();
  const schedule = useScheduleCapturedRequest();
  const [picking, setPicking] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const { mutate: run } = find;

  useEffect(() => {
    run(requestId);
  }, [run, requestId]);

  const result = find.data;
  const items = useMemo<SuggestionItem[]>(
    () =>
      (result?.suggestions ?? []).map((s) => ({
        key: s.start,
        label: s.label,
        tentative: s.tentative,
        reasons: s.reasons,
      })),
    [result],
  );

  const pick = (item: SuggestionItem) => {
    if (!result) return;
    const s = result.suggestions.find((x) => x.start === item.key) as AutoScheduleSuggestion;
    setFailure(null);
    setPicking(item.key);
    // mutateAsync, not mutate callbacks: approving removes this card (and the panel) from the
    // inbox before per-call callbacks would run, and the screen still needs to draft the reply.
    schedule
      .mutateAsync({
        requestId,
        segments: s.segments,
        services: result.services,
        priceCents: result.priceCents,
      })
      .then(
        (appointment) => {
          haptics.success();
          onScheduled(appointment, result);
        },
        (e: unknown) => {
          haptics.error();
          setPicking(null);
          setFailure(errorMessage(e));
          run(requestId);
        },
      );
  };

  const summary = result
    ? [result.serviceSummary, result.priceCents != null ? formatPrice(result.priceCents) : null]
        .filter(Boolean)
        .join(' · ')
    : null;

  return (
    <View className="gap-2 rounded-xl bg-muted/50 p-3" testID="auto-schedule-panel">
      <View className="flex-row items-center justify-between gap-2">
        <Text variant="subhead" className="flex-1 font-semibold">
          {result?.intent === 'reschedule' ? `Move ${name} to…` : `Book ${name} for…`}
        </Text>
        <Button
          variant="ghost"
          size="sm"
          label="Close"
          accessibilityLabel="Close Auto-Schedule"
          onPress={onClose}
        />
      </View>
      {summary ? (
        <Text variant="footnote" tone="muted" numeric>
          {summary}
        </Text>
      ) : null}
      {failure ? (
        <Text variant="footnote" tone="destructive" accessibilityRole="alert">
          {failure}
        </Text>
      ) : null}
      <SuggestionList
        testID="auto-schedule"
        items={items}
        fits={result?.fits}
        windowLabel={result?.window?.label}
        loading={find.isPending}
        error={find.error ? errorMessage(find.error) : null}
        pickingKey={picking}
        onPick={pick}
      />
      {result && items.length ? (
        <Text variant="caption" tone="muted">
          Tap a time to {result.intent === 'reschedule' ? 'move' : 'book'} it.
          {result.interpreter === 'parsed' ? ' (AI off: using what the message said.)' : ''}
        </Text>
      ) : null}
    </View>
  );
}
