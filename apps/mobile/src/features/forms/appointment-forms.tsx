import { useState } from 'react';
import { View } from 'react-native';

import { Badge, Button, Text } from '@/components/ui';
import { errorMessage } from '@/features/appointments/api';
import { formatDay } from '@/features/appointments/format';
import { webOrigin } from '@/features/client-self-service/api';
import { SEND_ICON, SEND_LABEL, sendClientText } from '@/features/replies/send';
import { useCurrentSalon } from '@/providers/session-provider';

import { useAppointmentForms } from './api';
import { formsText } from './forms-text';

/**
 * Appointment sheet → Forms: what this visit needs signed (from its services, or because it's a
 * new client) and whether it is. Missing ones get a one-tap "text the link". Hidden when the
 * visit needs no forms.
 */
export function AppointmentForms({
  appointmentId,
  manageToken,
  client,
  startsAt,
  timeZone,
  active,
}: {
  appointmentId: string;
  manageToken: string;
  client: { name: string; phone: string | null } | null;
  startsAt: string;
  timeZone: string;
  active: boolean;
}) {
  const salon = useCurrentSalon();
  const forms = useAppointmentForms(client ? appointmentId : undefined);
  const [notice, setNotice] = useState<{ text: string; tone: 'success' | 'destructive' } | null>(
    null,
  );
  const list = forms.data ?? [];
  if (!client || list.length === 0) return null;
  const missing = list.filter((f) => !f.done);

  const send = async () => {
    setNotice(null);
    try {
      const result = await sendClientText({
        to: client.phone,
        body: formsText(
          { clientName: client.name, startsAt, manageToken, missing: missing.map((f) => f.name) },
          salon.name,
          timeZone,
          webOrigin(),
        ),
      });
      if (result === 'copied') setNotice({ text: 'Forms link copied.', tone: 'success' });
    } catch (e) {
      setNotice({ text: errorMessage(e), tone: 'destructive' });
    }
  };

  return (
    <View className="gap-2" testID="appointment-forms">
      <Text variant="headline">Forms</Text>
      {list.map((f) => (
        <View key={f.templateId} className="flex-row items-center justify-between gap-3">
          <Text variant="body" className="flex-1">
            {f.name}
          </Text>
          {f.done ? (
            <Badge
              label={
                f.submittedAt
                  ? `Signed ${formatDay(Date.parse(f.submittedAt), timeZone)}`
                  : 'Signed'
              }
              tone="success"
            />
          ) : (
            <Badge label="Missing" tone="warning" />
          )}
        </View>
      ))}
      {missing.length && active ? (
        <Button
          variant="outline"
          size="sm"
          icon={SEND_ICON}
          label={SEND_LABEL === 'Copy' ? 'Copy forms link' : 'Text forms link'}
          disabled={!client.phone && SEND_LABEL === 'Send'}
          onPress={() => void send()}
        />
      ) : null}
      {notice ? (
        <Text variant="footnote" tone={notice.tone} accessibilityLiveRegion="polite">
          {notice.text}
        </Text>
      ) : null}
    </View>
  );
}
