import type { AppointmentWithDetails } from '@chairside/db/appointments';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';

import { Button, Card, Icon, Text } from '@/components/ui';
import { useProcessingTimers } from '@/features/timers/use-processing-timers';
import { haptics } from '@/lib/haptics';

import { serviceColor } from './service-pills';
import { formatClock } from './summary';

/**
 * Processing timers for color/treatments (#40). They start on their own at the booked time (or
 * when the stylist taps "Start processing"), can be extended or stopped, and are mirrored to a
 * Live Activity / Dynamic Island and a "done" alert by `useGlanceSync`.
 */
export function ProcessingTimers({
  appointments,
}: {
  appointments: readonly AppointmentWithDetails[];
}) {
  const [now, setNow] = useState(() => Date.now());
  const { board, start, extend, dismiss } = useProcessingTimers(appointments, now);
  const buzzed = useRef(new Set<string>());
  const live = board.running.length + board.finished.length > 0;

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), live ? 1000 : 15_000);
    return () => clearInterval(id);
  }, [live]);

  useEffect(() => {
    for (const t of board.finished) {
      const key = `${t.key}-${t.end}`;
      if (!buzzed.current.has(key) && now - t.end < 60_000) {
        buzzed.current.add(key);
        haptics.warning();
      }
    }
  }, [now, board.finished]);

  if (!live && !board.startable.length) return null;
  return (
    <View className="gap-3">
      {[...board.running, ...board.finished].map((t) => {
        const left = t.end - now;
        const done = left <= 0;
        const progress = Math.min(1, Math.max(0, (now - t.start) / (t.end - t.start)));
        const hex = serviceColor(t.appointment.services[0]?.colorTag);
        return (
          <Card key={t.key} className="gap-2">
            <View
              className="flex-row items-center gap-2"
              accessible
              accessibilityLiveRegion="polite"
              accessibilityLabel={
                done
                  ? `${t.clientName}: ${t.label} is done`
                  : `${t.clientName}: ${t.label}, ${Math.ceil(left / 60_000)} minutes left`
              }
            >
              <Icon name="hourglass-outline" size={16} color={hex} />
              <Text
                variant="footnote"
                tone="muted"
                className="flex-1 font-semibold"
                numberOfLines={1}
              >
                {t.label} · {t.clientName}
              </Text>
              <Text variant="title2" numeric tone={done ? 'success' : 'default'}>
                {done ? 'Done' : formatClock(left)}
              </Text>
            </View>
            <View className="h-1.5 overflow-hidden rounded-full bg-muted">
              <View
                className="h-full rounded-full"
                style={{ width: `${Math.round(progress * 100)}%`, backgroundColor: hex }}
              />
            </View>
            <View className="flex-row justify-end gap-2">
              <Button
                size="sm"
                variant="secondary"
                icon="add"
                label="5 min"
                accessibilityLabel={`Add 5 minutes to ${t.clientName}’s ${t.label}`}
                onPress={() => extend(t, 5)}
              />
              <Button
                size="sm"
                variant="ghost"
                label={done ? 'Dismiss' : 'Stop'}
                accessibilityLabel={`${done ? 'Dismiss' : 'Stop'} ${t.clientName}’s timer`}
                onPress={() => dismiss(t.key)}
              />
            </View>
          </Card>
        );
      })}
      {board.startable.map((seg) => {
        const hex = serviceColor(seg.appointment.services[0]?.colorTag);
        const minutes = Math.round((seg.scheduledEnd - seg.scheduledStart) / 60_000);
        return (
          <Card key={seg.key} className="flex-row items-center gap-3">
            <Icon name="hourglass-outline" size={16} color={hex} />
            <View className="flex-1">
              <Text variant="subhead" className="font-semibold" numberOfLines={1}>
                {seg.label} · {seg.clientName}
              </Text>
              <Text variant="footnote" tone="muted">
                {minutes} min processing
              </Text>
            </View>
            <Button
              size="sm"
              icon="play"
              label="Start processing"
              accessibilityLabel={`Start ${seg.clientName}’s ${seg.label} timer`}
              onPress={() => start(seg)}
            />
          </Card>
        );
      })}
    </View>
  );
}
