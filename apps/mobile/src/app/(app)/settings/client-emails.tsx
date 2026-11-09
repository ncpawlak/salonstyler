import { MAX_REMINDERS, REMINDER_HOUR_OPTIONS } from '@chairside/db/client-self-service';
import { useState } from 'react';
import { Switch, View } from 'react-native';

import { DetailScreen } from '@/components/shell/screen';
import {
  Badge,
  Card,
  Chip,
  EmptyState,
  Icon,
  SectionHeader,
  SkeletonRow,
  Text,
} from '@/components/ui';
import { errorMessage } from '@/features/appointments/api';
import {
  useClientEmailSettings,
  useUpdateClientEmailSettings,
} from '@/features/client-self-service/api';
import { useCurrentSalon } from '@/providers/session-provider';

function ToggleRow({
  label,
  hint,
  value,
  onChange,
  disabled,
}: {
  label: string;
  hint: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <View className="flex-row items-center gap-3">
      <View className="flex-1 gap-0.5">
        <Text variant="body">{label}</Text>
        <Text variant="footnote" tone="muted">
          {hint}
        </Text>
      </View>
      <Switch
        accessibilityLabel={label}
        value={value}
        onValueChange={onChange}
        disabled={disabled}
      />
    </View>
  );
}

const hoursLabel = (h: number) =>
  h % 24 === 0
    ? `${h / 24} day${h === 24 ? '' : 's'} before`
    : `${h} hour${h === 1 ? '' : 's'} before`;

/** Settings → Client emails: confirmations, reminders and the client's manage link. */
export default function ClientEmailsSettingsScreen() {
  const salon = useCurrentSalon();
  const isOwner = salon.role === 'owner';
  const settings = useClientEmailSettings(salon.id);
  const update = useUpdateClientEmailSettings(salon.id);
  const [notice, setNotice] = useState<string | null>(null);

  const saved = settings.data ?? null;
  const save = (changes: Parameters<typeof update.mutate>[0], message: string) =>
    update.mutate(changes, { onSuccess: () => setNotice(message) });

  const toggleHour = (h: number) => {
    if (!saved) return;
    const current = saved.client_reminder_hours;
    const next = current.includes(h)
      ? current.filter((x) => x !== h)
      : [...current, h].sort((a, b) => b - a);
    if (next.length > MAX_REMINDERS) {
      setNotice(`Pick up to ${MAX_REMINDERS} reminders.`);
      return;
    }
    save(
      { client_reminder_hours: next },
      next.length ? 'Reminder times saved.' : 'Reminder emails are off.',
    );
  };

  return (
    <DetailScreen title="Client emails">
      {settings.isPending ? (
        <View className="gap-3">
          <SkeletonRow />
          <SkeletonRow />
        </View>
      ) : settings.error || !saved ? (
        <EmptyState
          icon="cloud-offline-outline"
          title="Couldn't load client emails"
          message={settings.error ? errorMessage(settings.error) : undefined}
          actionLabel="Try again"
          onAction={() => void settings.refetch()}
        />
      ) : (
        <View className="gap-1">
          <Card className="flex-row items-center gap-3">
            <Icon name="mail-outline" color="primary" />
            <View className="flex-1 gap-0.5">
              <Text variant="headline">Emails to clients</Text>
              <Text variant="footnote" tone="muted">
                Clients with an email get a confirmation with a calendar invite, reminders, and a
                link to cancel or move their appointment themselves.
              </Text>
            </View>
            {saved.client_emails_enabled ? (
              <Badge label="On" tone="success" />
            ) : (
              <Badge label="Off" />
            )}
          </Card>
          {!isOwner ? (
            <Text variant="footnote" tone="warning" className="px-1 pt-2">
              Only the salon owner can change these.
            </Text>
          ) : null}

          <SectionHeader title="Emails" />
          <Card className="gap-4">
            <ToggleRow
              label="Send client emails"
              hint="Confirmations, changes, cancellations and reminders."
              value={saved.client_emails_enabled}
              disabled={!isOwner || update.isPending}
              onChange={(v) =>
                save(
                  { client_emails_enabled: v },
                  v ? 'Client emails are on.' : 'Client emails are off.',
                )
              }
            />
            <ToggleRow
              label="Let clients cancel or reschedule"
              hint="Adds a manage link to emails and texts. Moves only offer your open hours."
              value={saved.client_self_service_enabled}
              disabled={!isOwner || update.isPending}
              onChange={(v) =>
                save(
                  { client_self_service_enabled: v },
                  v ? 'Clients can manage their bookings.' : 'Manage links now say to contact you.',
                )
              }
            />
          </Card>

          <SectionHeader title="Reminder emails" />
          <Card className="gap-3">
            <View className="flex-row flex-wrap gap-2">
              {REMINDER_HOUR_OPTIONS.map((h) => (
                <Chip
                  key={h}
                  label={hoursLabel(h)}
                  selected={saved.client_reminder_hours.includes(h)}
                  onPress={isOwner && !update.isPending ? () => toggleHour(h) : undefined}
                />
              ))}
            </View>
            <Text variant="footnote" tone="muted">
              Up to {MAX_REMINDERS}. Only confirmed appointments get reminders. To text reminders
              from your phone instead, use “Remind tomorrow” on Today.
            </Text>
          </Card>

          {notice && !update.error ? (
            <Text
              variant="footnote"
              tone="success"
              className="px-1 pt-4"
              accessibilityLiveRegion="polite"
            >
              {notice}
            </Text>
          ) : null}
          {update.error ? (
            <Text
              variant="footnote"
              tone="destructive"
              className="px-1 pt-4"
              accessibilityLiveRegion="polite"
            >
              {errorMessage(update.error)}
            </Text>
          ) : null}
        </View>
      )}
    </DetailScreen>
  );
}
