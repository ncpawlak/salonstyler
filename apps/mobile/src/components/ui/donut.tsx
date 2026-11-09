import { View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

import { useTheme } from '@/theme/theme-provider';

import { Text } from './text';

export type DonutProps = {
  /** 0..1 share of the working day that is booked. */
  value: number;
  size?: number;
  strokeWidth?: number;
  showLabel?: boolean;
  label?: string;
};

/** Busyness ring used on Today and on every calendar day. */
export function Donut({ value, size = 64, strokeWidth, showLabel = true, label }: DonutProps) {
  const { colors } = useTheme();
  const clamped = Math.min(1, Math.max(0, value));
  const stroke = strokeWidth ?? Math.max(3, size / 9);
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const pct = Math.round(clamped * 100);
  const ringColor = clamped >= 0.9 ? colors.warning : colors.primary;

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={label ?? `${pct}% booked`}
      style={{ width: size, height: size }}
      className="items-center justify-center"
    >
      <Svg width={size} height={size} style={{ position: 'absolute' }}>
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={colors.muted}
          strokeWidth={stroke}
          fill="none"
        />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={ringColor}
          strokeWidth={stroke}
          strokeDasharray={`${circumference} ${circumference}`}
          strokeDashoffset={circumference * (1 - clamped)}
          strokeLinecap="round"
          fill="none"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      {showLabel ? (
        <Text
          numeric
          className="font-bold"
          style={{ fontSize: size * 0.26 }}
          maxFontSizeMultiplier={1}
        >
          {pct}%
        </Text>
      ) : null}
    </View>
  );
}
