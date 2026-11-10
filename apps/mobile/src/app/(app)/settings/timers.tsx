import { Platform, Switch, View } from 'react-native';

import { DetailScreen } from '@/components/shell/screen';
import { Text } from '@/components/ui';
import { Section } from '@/features/hours/ui';
import { setTimerPrefs, useTimerState } from '@/features/timers/store';
import type { TimerPrefs } from '@/features/timers/timers';

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

const ios = Platform.OS === 'ios';
const native = ios || Platform.OS === 'android';

/** Processing timers, Live Activities and widgets (#40). Preferences stay on this device. */
export default function TimersSettingsScreen() {
  const { prefs, loaded } = useTimerState();
  const toggle = (key: keyof TimerPrefs) => (value: boolean) => setTimerPrefs({ [key]: value });

  return (
    <DetailScreen title="Timers & widgets">
      <View className="gap-4">
        <Section
          title="Processing timers"
          hint="Color and treatments with processing time get a countdown on Today. These settings are for this device."
        >
          <ToggleRow
            label="Start at the booked time"
            hint="Off: timers only start when you tap “Start processing”."
            value={prefs.autoStart}
            onChange={toggle('autoStart')}
            disabled={!loaded}
          />
          <ToggleRow
            label="Alert when time is up"
            hint={
              native
                ? 'A notification and buzz when processing is done, even with Chairside closed.'
                : 'Available in the iPhone and Android apps.'
            }
            value={prefs.alerts}
            onChange={toggle('alerts')}
            disabled={!loaded || !native}
          />
          <ToggleRow
            label="Live Activities"
            hint={
              ios
                ? 'Show running timers on the Lock Screen and in the Dynamic Island.'
                : 'Available in the iPhone app.'
            }
            value={prefs.liveActivities}
            onChange={toggle('liveActivities')}
            disabled={!loaded || !ios}
          />
        </Section>
        <Section
          title="Home Screen widgets"
          hint="Next client, how booked today is, and requests waiting — kept up to date as your book changes."
        >
          <Text variant="subhead" tone="muted">
            {ios
              ? 'Touch and hold the Home Screen or Lock Screen, tap Edit › Add Widget, then search for Chairside.'
              : 'Widgets are available in the iPhone app.'}
          </Text>
        </Section>
      </View>
    </DetailScreen>
  );
}
