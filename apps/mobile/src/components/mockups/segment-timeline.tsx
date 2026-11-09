import { View } from 'react-native';

import { Text } from '@/components/ui';
import { useTheme } from '@/theme/theme-provider';
import type { ServiceTag } from '@/theme/tokens';
import { formatDuration, type Segment } from '@/mocks/data';

/**
 * Horizontal service timeline: solid = hands-on time, hatched/soft = processing
 * (the stylist is free to take another client).
 */
export function SegmentTimeline({
  segments,
  tag,
  showLabels = true,
  height = 40,
}: {
  segments: Segment[];
  tag: ServiceTag;
  showLabels?: boolean;
  height?: number;
}) {
  const { tag: tagColors, colors } = useTheme();
  const c = tagColors(tag);
  const total = segments.reduce((sum, s) => sum + s.minutes, 0) || 1;

  return (
    <View className="gap-1.5">
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={segments
          .map((s) => `${s.label} ${s.minutes} minutes${s.kind === 'processing' ? ', free' : ''}`)
          .join(', ')}
        className="flex-row gap-0.5 overflow-hidden rounded-md"
        style={{ height }}
      >
        {segments.map((s, i) => {
          const processing = s.kind === 'processing';
          return (
            <View
              key={`${s.label}-${i}`}
              className="items-center justify-center"
              style={{
                flex: s.minutes / total,
                backgroundColor: processing ? c.soft : c.solid,
                borderWidth: processing ? 1.5 : 0,
                borderStyle: 'dashed',
                borderColor: c.solid,
                borderRadius: 4,
              }}
            >
              {height >= 32 && s.minutes / total > 0.14 ? (
                <Text
                  variant="caption"
                  numeric
                  numberOfLines={1}
                  maxFontSizeMultiplier={1.2}
                  style={{ color: processing ? c.text : colors.card }}
                >
                  {s.minutes}m
                </Text>
              ) : null}
            </View>
          );
        })}
      </View>
      {showLabels ? (
        <View className="flex-row gap-0.5">
          {segments.map((s, i) => (
            <View key={`${s.label}-l-${i}`} style={{ flex: s.minutes / total }}>
              <Text variant="caption" tone="muted" numberOfLines={1}>
                {s.kind === 'processing' ? `${s.label} · free` : s.label}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

export function timelineSummary(segments: Segment[]) {
  const total = segments.reduce((sum, s) => sum + s.minutes, 0);
  const free = segments
    .filter((s) => s.kind === 'processing')
    .reduce((sum, s) => sum + s.minutes, 0);
  return { total, busy: total - free, free, label: `${formatDuration(total)} total` };
}
