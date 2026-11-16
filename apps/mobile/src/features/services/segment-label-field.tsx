import { useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';

import { Chip, Input } from '@/components/ui';

import { filterLabels } from './labels';

/**
 * Segment label with suggestions from labels already used across the salon's services (#85).
 * Focus shows them, typing filters, tapping one fills it; any new label can still be typed.
 */
export function SegmentLabelField({
  value,
  onChange,
  labels,
  accessibilityLabel,
  editable,
}: {
  value: string;
  onChange: (label: string) => void;
  labels: readonly string[];
  accessibilityLabel: string;
  editable: boolean;
}) {
  const [open, setOpen] = useState(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suggestions = useMemo(() => filterLabels(labels, value), [labels, value]);
  useEffect(() => () => clearTimeout(blurTimer.current ?? undefined), []);

  return (
    <View className="gap-2">
      <Input
        value={value}
        onChangeText={onChange}
        placeholder="Label (e.g. Apply)"
        accessibilityLabel={accessibilityLabel}
        editable={editable}
        autoCapitalize="sentences"
        maxLength={40}
        onFocus={() => {
          clearTimeout(blurTimer.current ?? undefined);
          setOpen(true);
        }}
        // On web the input blurs before a suggestion's press lands; wait a beat.
        onBlur={() => {
          blurTimer.current = setTimeout(() => setOpen(false), 200);
        }}
      />
      {open && editable && suggestions.length > 0 ? (
        <View
          className="flex-row flex-wrap gap-2"
          accessibilityLabel={`Existing labels for ${accessibilityLabel.toLowerCase()}`}
        >
          {suggestions.map((label) => (
            <Chip
              key={label}
              label={label}
              icon="pricetag-outline"
              onPress={() => {
                onChange(label);
                setOpen(false);
              }}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}
