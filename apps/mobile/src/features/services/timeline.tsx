import { formatDuration, segmentLabel, type ServiceSegment } from '@chairside/core';
import { View } from 'react-native';

import { Text } from '@/components/ui';
import { useTheme } from '@/theme/theme-provider';

import { COLOR_HEX } from './colors';

interface Props {
  segments: readonly ServiceSegment[];
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
  colorTag?: keyof typeof COLOR_HEX;
  showLabels?: boolean;
  height?: number;
}

/**
 * Proportional bar of a service: solid = stylist busy, soft + dashed = processing (chair free for
 * another client), muted = buffers.
 */
export function SegmentTimeline({
  segments,
  bufferBeforeMinutes = 0,
  bufferAfterMinutes = 0,
  colorTag = 'indigo',
  showLabels = true,
  height = 36,
}: Props) {
  const { colors } = useTheme();
  const color = COLOR_HEX[colorTag];
  const blocks = [
    ...(bufferBeforeMinutes > 0
      ? [{ key: 'bb', minutes: bufferBeforeMinutes, label: 'Buffer', kind: 'buffer' as const }]
      : []),
    ...segments.map((s, i) => ({
      key: `s${i}`,
      minutes: s.minutes,
      label: segmentLabel(s),
      kind: s.kind,
    })),
    ...(bufferAfterMinutes > 0
      ? [{ key: 'ba', minutes: bufferAfterMinutes, label: 'Buffer', kind: 'buffer' as const }]
      : []),
  ].filter((b) => b.minutes > 0);

  return (
    <View className="gap-1.5">
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={blocks
          .map((b) => `${b.label} ${b.minutes} minutes${b.kind === 'processing' ? ', free' : ''}`)
          .join(', ')}
        className="flex-row gap-0.5 overflow-hidden rounded-md"
        style={{ height }}
      >
        {blocks.map((b) => {
          const processing = b.kind === 'processing';
          const buffer = b.kind === 'buffer';
          return (
            <View
              key={b.key}
              className="items-center justify-center"
              style={{
                flexGrow: b.minutes,
                flexBasis: 0,
                borderRadius: 4,
                backgroundColor: buffer ? colors.muted : processing ? `${color}33` : color,
                borderWidth: processing ? 1.5 : 0,
                borderStyle: 'dashed',
                borderColor: color,
              }}
            >
              {b.minutes >= 15 ? (
                <Text
                  variant="caption"
                  numeric
                  numberOfLines={1}
                  maxFontSizeMultiplier={1.2}
                  style={{ color: processing || buffer ? colors['muted-foreground'] : '#FFFFFF' }}
                >
                  {b.minutes}
                </Text>
              ) : null}
            </View>
          );
        })}
      </View>
      {showLabels ? (
        <Text variant="footnote" tone="muted">
          {blocks.map((b) => `${b.label} ${formatDuration(b.minutes)}`).join(' → ')}
        </Text>
      ) : null}
    </View>
  );
}
