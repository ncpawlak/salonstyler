import type { ReminderQueueItem } from '@chairside/db/client-self-service';
import { useState } from 'react';
import { View } from 'react-native';

import { Badge, Button, ListGroup, ListRow, SectionHeader, Text } from '@/components/ui';
import { errorMessage } from '@/features/appointments/api';
import { formatLocalDateLong, formatTime } from '@/features/appointments/format';
import { SEND_ICON, SEND_LABEL, sendClientText } from '@/features/replies/send';
import { useCurrentSalon } from '@/providers/session-provider';

import { useMarkTextReminderSent, useReminderQueue, webOrigin } from './api';
import { reminderText } from './reminder-text';

/**
 * Today → "Remind tomorrow's clients": one tap opens Messages with a reminder (and the client's
 * manage link) prefilled, so reminders come from the stylist's own number. Emails go out on their
 * own; this is for clients who'd rather get a text. Hidden when nobody's booked tomorrow.
 */
export function ReminderQueueCard({ timeZone }: { timeZone: string }) {
  const salon = useCurrentSalon();
  const queue = useReminderQueue(salon.id);
  const mark = useMarkTextReminderSent(salon.id);
  const [error, setError] = useState<string | null>(null);

  const items = queue.data?.items ?? [];
  if (!queue.data || items.length === 0) return null;
  const left = items.filter((i) => !i.textReminderSentAt).length;

  const send = async (item: ReminderQueueItem) => {
    setError(null);
    try {
      const result = await sendClientText({
        to: item.phone,
        body: reminderText(item, salon.name, timeZone, webOrigin()),
      });
      if (result !== 'cancelled') {
        mark.mutate({ appointmentId: item.appointmentId, sent: true });
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <View testID="reminder-queue">
      <SectionHeader
        title={left ? `Remind tomorrow · ${left}` : 'Remind tomorrow'}
        action={
          <Text variant="footnote" tone="subtle">
            {formatLocalDateLong(queue.data.day)}
          </Text>
        }
      />
      <ListGroup>
        {items.map((item, i, arr) => (
          <ListRow
            key={item.appointmentId}
            title={item.clientName ?? 'Walk-in'}
            subtitle={[formatTime(Date.parse(item.startsAt), timeZone), item.services]
              .filter(Boolean)
              .join(' · ')}
            trailing={
              item.textReminderSentAt ? (
                <View className="flex-row items-center gap-1">
                  <Badge label="Reminded" tone="success" />
                  <Button
                    variant="ghost"
                    size="icon"
                    icon="arrow-undo-outline"
                    accessibilityLabel={`Mark ${item.clientName ?? 'client'} not reminded`}
                    onPress={() => mark.mutate({ appointmentId: item.appointmentId, sent: false })}
                  />
                </View>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  icon={SEND_ICON}
                  label={SEND_LABEL}
                  accessibilityLabel={`Text ${item.clientName ?? 'client'} a reminder`}
                  disabled={!item.phone && SEND_LABEL === 'Send'}
                  onPress={() => void send(item)}
                />
              )
            }
            last={i === arr.length - 1}
          />
        ))}
      </ListGroup>
      {error || mark.error ? (
        <Text
          variant="footnote"
          tone="destructive"
          className="px-1 pt-2"
          accessibilityLiveRegion="polite"
        >
          {error ?? errorMessage(mark.error)}
        </Text>
      ) : null}
    </View>
  );
}
