import { Text, View } from 'react-native';

import { NumberStepper, Section } from './ui';
import type { BookingRulesState } from './use-work-hours';

const NOTICE = [0, 30, 60, 120, 240, 720, 1440, 2880] as const;
const WINDOW = [7, 14, 30, 60, 90, 120, 180, 365] as const;
const GRID = [5, 10, 15, 20, 30, 60] as const;
const HOLD = [1, 2, 4, 8, 12, 24, 48, 72, 168] as const;

function formatMinutes(m: number): string {
  if (m === 0) return 'None';
  if (m < 60) return `${m} min`;
  if (m < 1440) return `${m / 60} h`;
  return `${m / 1440} day${m === 1440 ? '' : 's'}`;
}

function formatDays(d: number): string {
  if (d % 7 === 0 && d < 60) return `${d / 7} wk`;
  if (d >= 30 && d % 30 === 0) return `${d / 30} mo`;
  return `${d} days`;
}

export function BookingRulesForm({
  rules,
  onChange,
}: {
  rules: BookingRulesState;
  onChange: (rules: BookingRulesState) => void;
}) {
  return (
    <Section title="Booking rules" hint="Applies to every slot clients are offered.">
      <NumberStepper
        label="Minimum notice"
        value={rules.minNoticeMinutes}
        options={NOTICE}
        format={formatMinutes}
        onChange={(minNoticeMinutes) => onChange({ ...rules, minNoticeMinutes })}
      />
      <NumberStepper
        label="Book up to"
        value={rules.bookingWindowDays}
        options={WINDOW}
        format={formatDays}
        onChange={(bookingWindowDays) => onChange({ ...rules, bookingWindowDays })}
      />
      <NumberStepper
        label="Start times every"
        value={rules.slotGridMinutes}
        options={GRID}
        format={(m) => `${m} min`}
        onChange={(slotGridMinutes) => onChange({ ...rules, slotGridMinutes })}
      />
      <NumberStepper
        label="Holds expire after"
        value={rules.holdExpiryHours}
        options={HOLD}
        format={(h) => formatMinutes(h * 60)}
        onChange={(holdExpiryHours) => onChange({ ...rules, holdExpiryHours })}
      />
      <View>
        <Text className="text-xs text-neutral-500">
          Clients can book up to {formatDays(rules.bookingWindowDays)} out,{' '}
          {rules.minNoticeMinutes
            ? `at least ${formatMinutes(rules.minNoticeMinutes)} ahead.`
            : 'with no minimum notice.'}
        </Text>
      </View>
    </Section>
  );
}
