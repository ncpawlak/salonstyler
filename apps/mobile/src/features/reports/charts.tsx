import { View } from 'react-native';

import { Text } from '@/components/ui';
import { useTheme } from '@/theme/theme-provider';

export type Bar = {
  key: string;
  /** Stacked from the bottom; omit `secondary` for single bars. */
  primary: number;
  secondary?: number;
  /** Short axis label, shown for the first, middle and last bars only. */
  label: string;
  /** Read by screen readers for the bar. */
  accessibilityLabel: string;
  /** Overrides the primary color (e.g. heat tints for utilization). */
  color?: string;
};

/** A glanceable column chart: no axes or grid, just relative heights and a few labels. */
export function BarChart({
  bars,
  height = 96,
  max: fixedMax,
}: {
  bars: readonly Bar[];
  height?: number;
  /** Fixed top of the scale (e.g. 1 for shares); defaults to the tallest bar. */
  max?: number;
}) {
  const { colors } = useTheme();
  const max = fixedMax ?? Math.max(1, ...bars.map((b) => b.primary + (b.secondary ?? 0)));
  const labelled = new Set([0, Math.floor((bars.length - 1) / 2), bars.length - 1]);
  const gap = bars.length > 40 ? 1 : bars.length > 14 ? 2 : 4;

  return (
    <View>
      <View className="flex-row items-end" style={{ height, gap }}>
        {bars.map((b) => {
          const total = b.primary + (b.secondary ?? 0);
          return (
            <View
              key={b.key}
              accessible
              accessibilityRole="image"
              accessibilityLabel={b.accessibilityLabel}
              className="flex-1 justify-end overflow-hidden rounded-t"
              style={{ height: '100%' }}
            >
              {b.secondary ? (
                <View
                  style={{
                    height: `${(b.secondary / max) * 100}%`,
                    backgroundColor: colors.warning,
                    opacity: 0.8,
                  }}
                />
              ) : null}
              <View
                style={{
                  height: total > 0 ? `${Math.max(2, (b.primary / max) * 100)}%` : 2,
                  backgroundColor: total > 0 ? (b.color ?? colors.primary) : colors.muted,
                }}
              />
            </View>
          );
        })}
      </View>
      <View className="mt-1 flex-row" style={{ gap }}>
        {bars.map((b, i) => (
          <View key={b.key} className="flex-1 items-center" style={{ overflow: 'visible' }}>
            {labelled.has(i) ? (
              <Text variant="caption" tone="muted" numberOfLines={1} style={{ minWidth: 40 }}>
                {b.label}
              </Text>
            ) : null}
          </View>
        ))}
      </View>
    </View>
  );
}

/** A thin horizontal bar split into proportional segments (services vs retail, etc.). */
export function SplitBar({
  parts,
}: {
  parts: readonly { key: string; value: number; color: string }[];
}) {
  const { colors } = useTheme();
  const total = parts.reduce((n, p) => n + Math.max(0, p.value), 0);
  return (
    <View
      className="h-2 flex-row overflow-hidden rounded-full"
      style={{ backgroundColor: colors.muted }}
      importantForAccessibility="no-hide-descendants"
    >
      {total > 0
        ? parts.map((p) =>
            p.value > 0 ? (
              <View key={p.key} style={{ flex: p.value / total, backgroundColor: p.color }} />
            ) : null,
          )
        : null}
    </View>
  );
}
