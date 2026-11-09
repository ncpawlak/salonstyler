import type { NotificationSettings } from '@chairside/db';
import { useState } from 'react';
import { Linking, Platform, Switch, View } from 'react-native';

import { DetailScreen } from '@/components/shell/screen';
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  EmptyState,
  Icon,
  SkeletonRow,
  Text,
} from '@/components/ui';
import { NumberStepper, Section, TimeStepper } from '@/features/hours/ui';
import {
  useEnablePush,
  useNotificationSettings,
  usePushStatus,
  useUpdateNotificationSettings,
} from '@/features/notifications/api';
import {
  describeRequestTimeline,
  formatHours,
  HOLD_EXPIRY_OPTIONS,
  nearestOption,
  NUDGE_DELAY_OPTIONS,
  toClock,
} from '@/features/notifications/format';
import { pushSupported, type PushStatus } from '@/features/notifications/push';
import { useCurrentSalon } from '@/providers/session-provider';

interface FormState {
  nudgeHours: number;
  holdExpiryHours: number;
  quietEnabled: boolean;
  quietStart: string;
  quietEnd: string;
  agendaEnabled: boolean;
  payoutEnabled: boolean;
}

function toForm(s: NotificationSettings): FormState {
  return {
    nudgeHours: s.followup_nudge_hours,
    holdExpiryHours: s.hold_expiry_hours,
    quietEnabled: s.quiet_hours_enabled,
    quietStart: toClock(s.quiet_hours_start),
    quietEnd: toClock(s.quiet_hours_end),
    agendaEnabled: s.daily_agenda_enabled,
    payoutEnabled: s.payout_summary_enabled,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ToggleRow({
  label,
  hint,
  value,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <View className="flex-row items-center gap-3">
      <View className="flex-1 gap-0.5">
        <Text variant="body">{label}</Text>
        {hint ? (
          <Text variant="footnote" tone="muted">
            {hint}
          </Text>
        ) : null}
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

function DeviceCard({ salonId }: { salonId: string }) {
  const status = usePushStatus(salonId);
  const enable = useEnablePush(salonId);
  const s: PushStatus | undefined = pushSupported ? status.data : { state: 'unsupported' };

  const copy: Record<PushStatus['state'], { badge: string; tone: BadgeTone; text: string }> = {
    registered: {
      badge: 'On',
      tone: 'success',
      text: 'This device gets booking requests, reminders and your daily agenda.',
    },
    denied: {
      badge: 'Off',
      tone: 'warning',
      text: 'Notifications are turned off for Chairside. Turn them on in your phone’s Settings.',
    },
    'no-project': {
      badge: 'Dev',
      tone: 'neutral',
      text: 'Push needs an EAS development or store build of Chairside.',
    },
    unsupported: {
      badge: 'App only',
      tone: 'neutral',
      text: 'Push notifications go to the Chairside app on your iPhone or Android phone.',
    },
    error: { badge: 'Error', tone: 'warning', text: 'Couldn’t set up notifications.' },
  };
  const c = s ? copy[s.state] : null;

  return (
    <Card className="gap-3">
      <View className="flex-row items-center gap-3">
        <Icon name="notifications-outline" color="primary" />
        <View className="flex-1 gap-0.5">
          <Text variant="headline">This device</Text>
          <Text variant="footnote" tone="muted">
            {c ? c.text : 'Checking…'}
            {s?.state === 'error' ? ` ${s.message}` : ''}
          </Text>
        </View>
        {c ? <Badge label={c.badge} tone={c.tone} /> : null}
      </View>
      {s?.state === 'denied' && Platform.OS !== 'web' ? (
        <Button
          variant="outline"
          size="sm"
          label="Open Settings"
          onPress={() => void Linking.openSettings()}
        />
      ) : null}
      {s?.state === 'error' ? (
        <Button
          variant="outline"
          size="sm"
          label="Try again"
          loading={enable.isPending}
          onPress={() => enable.mutate()}
        />
      ) : null}
    </Card>
  );
}

export default function NotificationSettingsScreen() {
  const salon = useCurrentSalon();
  const isOwner = salon.role === 'owner';
  const settings = useNotificationSettings(salon.id);
  const update = useUpdateNotificationSettings(salon.id);

  const [form, setForm] = useState<FormState | null>(null);
  const [loaded, setLoaded] = useState(settings.data);
  const [notice, setNotice] = useState<string | null>(null);
  if (settings.data && settings.data !== loaded) {
    setLoaded(settings.data);
    setForm(toForm(settings.data));
  }
  const state = form ?? (settings.data ? toForm(settings.data) : null);
  const saved = settings.data ? toForm(settings.data) : null;
  const dirty = !!state && !!saved && JSON.stringify(state) !== JSON.stringify(saved);

  const set = (patch: Partial<FormState>) => {
    setNotice(null);
    update.reset();
    setForm({ ...state!, ...patch });
  };

  const save = () =>
    update.mutate(
      {
        followup_nudge_hours: state!.nudgeHours,
        hold_expiry_hours: state!.holdExpiryHours,
        quiet_hours_enabled: state!.quietEnabled,
        quiet_hours_start: state!.quietStart,
        quiet_hours_end: state!.quietEnd,
        daily_agenda_enabled: state!.agendaEnabled,
        payout_summary_enabled: state!.payoutEnabled,
      },
      { onSuccess: () => setNotice('Saved.') },
    );

  const quietInvalid = !!state && state.quietEnabled && state.quietStart === state.quietEnd;

  return (
    <DetailScreen title="Notifications">
      {settings.isPending ? (
        <View className="gap-3">
          <SkeletonRow />
          <SkeletonRow />
        </View>
      ) : settings.error || !state ? (
        <EmptyState
          icon="cloud-offline-outline"
          title="Couldn't load notification settings"
          message={errorMessage(settings.error)}
          actionLabel="Try again"
          onAction={() => void settings.refetch()}
        />
      ) : (
        <View className="gap-4">
          <DeviceCard salonId={salon.id} />
          {!isOwner ? (
            <Text variant="footnote" tone="warning" className="px-1">
              Only the salon owner can change these.
            </Text>
          ) : null}

          <Section
            title="Booking requests"
            hint="New requests arrive with Approve, Other time and Decline buttons. Requests in Tentative hours always need your approval."
          >
            <NumberStepper
              label="Remind me after"
              value={nearestOption(state.nudgeHours, NUDGE_DELAY_OPTIONS)}
              options={NUDGE_DELAY_OPTIONS}
              format={formatHours}
              onChange={(nudgeHours) => isOwner && set({ nudgeHours })}
            />
            <NumberStepper
              label="Then release after"
              value={nearestOption(state.holdExpiryHours, HOLD_EXPIRY_OPTIONS)}
              options={HOLD_EXPIRY_OPTIONS}
              format={formatHours}
              onChange={(holdExpiryHours) => isOwner && set({ holdExpiryHours })}
            />
            <Text variant="footnote" tone="muted">
              {describeRequestTimeline(state.nudgeHours, state.holdExpiryHours)} Also used for holds
              (Work hours → Booking rules).
            </Text>
          </Section>

          <Section
            title="Quiet hours"
            hint={`No notifications during these hours (${salon.timezone}). Anything due waits until they end.`}
          >
            <ToggleRow
              label="Quiet hours"
              value={state.quietEnabled}
              disabled={!isOwner}
              onChange={(quietEnabled) => set({ quietEnabled })}
            />
            {state.quietEnabled ? (
              <View className="flex-row gap-3">
                <TimeStepper
                  label="From"
                  value={state.quietStart}
                  max={23 * 60 + 30}
                  onChange={(quietStart) => isOwner && set({ quietStart })}
                />
                <TimeStepper
                  label="Until"
                  value={state.quietEnd}
                  max={23 * 60 + 30}
                  onChange={(quietEnd) => isOwner && set({ quietEnd })}
                />
              </View>
            ) : null}
            {quietInvalid ? (
              <Text variant="footnote" tone="destructive">
                Start and end must be different.
              </Text>
            ) : null}
          </Section>

          <Section
            title="Daily summaries"
            hint="Salon time: your agenda at 8:00 AM, takings at 8:00 PM."
          >
            <ToggleRow
              label="Morning agenda"
              hint="Only sent on days with appointments or requests."
              value={state.agendaEnabled}
              disabled={!isOwner}
              onChange={(agendaEnabled) => set({ agendaEnabled })}
            />
            <ToggleRow
              label="Evening takings"
              hint="Card, cash and tips. Owners only; sent on days with checkouts."
              value={state.payoutEnabled}
              disabled={!isOwner}
              onChange={(payoutEnabled) => set({ payoutEnabled })}
            />
          </Section>

          <Card className="flex-row items-center gap-3">
            <Icon name="close-circle-outline" color="primary" />
            <Text variant="footnote" tone="muted" className="flex-1">
              You’re always alerted when a client cancels or a request expires.
            </Text>
          </Card>

          {notice ? (
            <Text
              variant="footnote"
              tone="success"
              className="px-1"
              accessibilityLiveRegion="polite"
            >
              {notice}
            </Text>
          ) : null}
          {update.error ? (
            <Text
              variant="footnote"
              tone="destructive"
              className="px-1"
              accessibilityLiveRegion="polite"
            >
              {errorMessage(update.error)}
            </Text>
          ) : null}

          {isOwner ? (
            <Button
              label="Save"
              fullWidth
              loading={update.isPending}
              disabled={!dirty || quietInvalid || update.isPending}
              onPress={save}
            />
          ) : null}
        </View>
      )}
    </DetailScreen>
  );
}
