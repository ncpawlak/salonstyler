import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';

import { Card, Icon, Text } from '@/components/ui';
import { haptics } from '@/lib/haptics';

import { serviceColor } from './service-pills';
import { formatClock, type ProcessingTimer } from './summary';

/**
 * Live countdowns for color/treatments that are processing right now (derived from the
 * appointment's processing segments). Live Activities / Dynamic Island come with #40.
 */
export function ProcessingTimers({ timers }: { timers: ProcessingTimer[] }) {
  const [now, setNow] = useState(() => Date.now());
  const buzzed = useRef(new Set<string>());

  useEffect(() => {
    if (!timers.length) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [timers.length]);

  useEffect(() => {
    for (const t of timers) {
      const key = `${t.appointment.id}-${t.end}`;
      if (t.end <= now && !buzzed.current.has(key)) {
        buzzed.current.add(key);
        haptics.warning();
      }
    }
  }, [now, timers]);

  if (!timers.length) return null;
  return (
    <View className="gap-3">
      {timers.map((t) => {
        const left = t.end - now;
        const done = left <= 0;
        const progress = Math.min(1, Math.max(0, (now - t.start) / (t.end - t.start)));
        const hex = serviceColor(t.appointment.services[0]?.colorTag);
        const name = t.appointment.client?.name ?? 'Walk-in';
        return (
          <Card
            key={`${t.appointment.id}-${t.start}`}
            className="gap-2"
            accessible
            accessibilityLiveRegion="polite"
            accessibilityLabel={
              done
                ? `${name}: ${t.label} is done`
                : `${name}: ${t.label}, ${Math.ceil(left / 60_000)} minutes left`
            }
          >
            <View className="flex-row items-center gap-2">
              <Icon name="hourglass-outline" size={16} color={hex} />
              <Text
                variant="footnote"
                tone="muted"
                className="flex-1 font-semibold"
                numberOfLines={1}
              >
                {t.label} · {name}
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
          </Card>
        );
      })}
    </View>
  );
}
