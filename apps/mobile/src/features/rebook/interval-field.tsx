import { typicalRebookDays } from '@chairside/core/rebook';
import { useState } from 'react';
import { View } from 'react-native';

import { Chip, SectionHeader, Text } from '@/components/ui';

import { errorMessage } from '../appointments/api';
import { useServiceRebookIntervals, useSetServiceRebookInterval } from './api';

const WEEKS = [2, 3, 4, 5, 6, 8, 10, 12] as const;

/** "Rebook every" on the service editor; saves on tap (#42). */
export function RebookIntervalField({
  service,
  canEdit,
}: {
  service: { id: string; name: string; category: string };
  canEdit: boolean;
}) {
  const intervals = useServiceRebookIntervals();
  const save = useSetServiceRebookInterval();
  const [error, setError] = useState<string | null>(null);
  const saved = intervals.data?.get(service.id) ?? null;
  const current = save.isPending ? (save.variables?.days ?? null) : saved;
  const typical = typicalRebookDays(service);

  const choose = (days: number | null) => {
    if (!canEdit || days === current) return;
    setError(null);
    save.mutate({ serviceId: service.id, days }, { onError: (e) => setError(errorMessage(e)) });
  };

  return (
    <>
      <SectionHeader title="Rebook every" />
      <View className="flex-row flex-wrap gap-2">
        <Chip label="Auto" selected={current == null} onPress={() => choose(null)} />
        {WEEKS.map((w) => (
          <Chip
            key={w}
            label={`${w} wk`}
            selected={current === w * 7}
            onPress={() => choose(w * 7)}
          />
        ))}
        {current != null && current % 7 !== 0 ? (
          <Chip label={`${current} days`} selected onPress={() => undefined} />
        ) : null}
      </View>
      <Text variant="footnote" tone="muted" className="mt-2">
        {current == null
          ? typical
            ? `Auto uses each client's own rhythm, else about ${Math.round(typical / 7)} weeks.`
            : "Auto uses each client's own rhythm, else six weeks."
          : 'Suggested at checkout unless the client has their own rhythm.'}
      </Text>
      {error ? (
        <Text variant="footnote" tone="destructive" className="mt-1">
          {error}
        </Text>
      ) : null}
    </>
  );
}
