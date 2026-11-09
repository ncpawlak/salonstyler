import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { Avatar, Card, Icon, Text } from '@/components/ui';
import { haptics } from '@/lib/haptics';
import { MOCK_NOW_MINUTES, serviceById, todayAppointments } from '@/mocks/data';
import { useTheme } from '@/theme/theme-provider';

/** Live processing countdown (stands in for the Live Activity / Dynamic Island timer). */
export function ProcessingTimer() {
  const { tag } = useTheme();
  const appt = todayAppointments.find((a) => a.status === 'in-progress');
  const svc = appt ? serviceById(appt.serviceIds[0] ?? '') : undefined;
  const seg = svc?.segments.find((s) => s.kind === 'processing');

  // Processing started at 9:30; mock "now" is 9:42.
  const initial = seg && appt ? (appt.start + 30 + seg.minutes - MOCK_NOW_MINUTES) * 60 : 0;
  const [left, setLeft] = useState(initial);

  useEffect(() => {
    const id = setInterval(() => {
      setLeft((s) => {
        if (s <= 1) {
          haptics.warning();
          return initial;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [initial]);

  if (!appt || !svc || !seg) return null;
  const c = tag(svc.tag);
  const mm = String(Math.floor(left / 60)).padStart(2, '0');
  const ss = String(left % 60).padStart(2, '0');
  const progress = 1 - left / (seg.minutes * 60);

  return (
    <Card
      className="flex-1 gap-2"
      accessible
      accessibilityLabel={`${appt.client}, ${svc.name} processing, ${Math.ceil(left / 60)} minutes left`}
    >
      <View className="flex-row items-center gap-1.5">
        <Icon name="hourglass-outline" size={16} color={c.solid} />
        <Text variant="footnote" tone="muted" className="font-semibold">
          Processing
        </Text>
      </View>
      <Text variant="title1" numeric>
        {mm}:{ss}
      </Text>
      <Text variant="footnote" tone="muted" numberOfLines={1}>
        {appt.client.split(' ')[0]} · {svc.name}
      </Text>
      <View className="h-1.5 overflow-hidden rounded-full bg-muted">
        <View
          className="h-full rounded-full"
          style={{ width: `${Math.round(progress * 100)}%`, backgroundColor: c.solid }}
        />
      </View>
    </Card>
  );
}

export function ClientLine({ name, detail }: { name: string; detail: string }) {
  return (
    <View className="flex-row items-center gap-3">
      <Avatar name={name} size={44} />
      <View className="flex-1">
        <Text variant="title3" numberOfLines={1}>
          {name}
        </Text>
        <Text variant="subhead" tone="muted" numberOfLines={1}>
          {detail}
        </Text>
      </View>
    </View>
  );
}
