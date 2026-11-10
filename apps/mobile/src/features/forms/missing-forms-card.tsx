import type { AppointmentMissingForms } from '@chairside/db/forms';
import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { Badge, Button, ListGroup, ListRow, SectionHeader, Text } from '@/components/ui';
import { errorMessage } from '@/features/appointments/api';
import { formatDay, formatTime } from '@/features/appointments/format';
import { webOrigin } from '@/features/client-self-service/api';
import { SEND_ICON, SEND_LABEL, sendClientText } from '@/features/replies/send';
import { useCurrentSalon } from '@/providers/session-provider';

import { useAppointmentsMissingForms } from './api';
import { formsText } from './forms-text';

/**
 * Today → "Forms needed": upcoming appointments (next 7 days) whose client still has to sign a
 * required form. One tap texts them the forms link. Hidden when everything's signed.
 */
export function MissingFormsCard({ timeZone }: { timeZone: string }) {
  const salon = useCurrentSalon();
  const missing = useAppointmentsMissingForms(salon.id);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<Set<string>>(() => new Set());

  const items = missing.data ?? [];
  if (items.length === 0) return null;

  const send = async (item: AppointmentMissingForms) => {
    setError(null);
    try {
      const result = await sendClientText({
        to: item.phone,
        body: formsText(item, salon.name, timeZone, webOrigin()),
      });
      if (result !== 'cancelled') setSent((s) => new Set(s).add(item.appointmentId));
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <View testID="missing-forms">
      <SectionHeader title={`Forms needed · ${items.length}`} />
      <ListGroup>
        {items.slice(0, 8).map((item, i, arr) => {
          const at = Date.parse(item.startsAt);
          return (
            <ListRow
              key={item.appointmentId}
              title={item.clientName}
              subtitle={`${formatDay(at, timeZone)} ${formatTime(at, timeZone)} · ${item.missing.join(', ')}`}
              onPress={() => router.push(`/clients/${item.clientId}`)}
              trailing={
                sent.has(item.appointmentId) ? (
                  <Badge label={SEND_LABEL === 'Copy' ? 'Copied' : 'Sent'} tone="success" />
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    icon={SEND_ICON}
                    label={SEND_LABEL}
                    accessibilityLabel={`Text ${item.clientName} the forms link`}
                    disabled={!item.phone && SEND_LABEL === 'Send'}
                    onPress={() => void send(item)}
                  />
                )
              }
              last={i === arr.length - 1}
            />
          );
        })}
      </ListGroup>
      {error ? (
        <Text
          variant="footnote"
          tone="destructive"
          className="px-1 pt-2"
          accessibilityLiveRegion="polite"
        >
          {error}
        </Text>
      ) : null}
    </View>
  );
}
