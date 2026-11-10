import type { DayUtilization, UtilizationState } from '@chairside/core';
import { useId } from 'react';
import { View } from 'react-native';
import Svg, { Circle, Defs, G, Path, Pattern, Rect } from 'react-native-svg';

import { Text } from '@/components/ui';

import { useUtilizationPalette } from './palette';
import { dayRingFill, ringAccessibilityLabel } from './ring-fill';

const TAU = Math.PI * 2;

function point(c: number, r: number, fraction: number) {
  const a = fraction * TAU - Math.PI / 2;
  return { x: c + r * Math.cos(a), y: c + r * Math.sin(a) };
}

function arcPath(c: number, r: number, from: number, to: number) {
  const a = point(c, r, from);
  const b = point(c, r, to);
  const large = to - from > 0.5 ? 1 : 0;
  return `M ${a.x} ${a.y} A ${r} ${r} 0 ${large} 1 ${b.x} ${b.y}`;
}

/** Shared SVG stripe used for tentative hours. Ids must be unique per instance on web. */
export function useStripeId() {
  return `stripe-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

export function StripeDefs({ id, color, size = 5 }: { id: string; color: string; size?: number }) {
  return (
    <Defs>
      <Pattern
        id={id}
        patternUnits="userSpaceOnUse"
        width={size}
        height={size}
        patternTransform="rotate(45)"
      >
        <Rect x={0} y={0} width={size * 0.4} height={size} fill={color} />
      </Pattern>
    </Defs>
  );
}

export type DayRingProps = {
  day: DayUtilization;
  size?: number;
  strokeWidth?: number;
  showLabel?: boolean;
};

/**
 * Progress donut: the whole ring is that day's working hours (open + tentative + booked), and the
 * fill is how much of it is booked, starting at 12 o'clock. Booked = accent, free tentative =
 * striped amber, free open = soft green track. A day with no hours is a gray ring reading "Off".
 * *When* he's busy lives in the timeline strip next to it, not in the ring.
 */
export function DayRing({ day, size = 64, strokeWidth, showLabel = true }: DayRingProps) {
  const palette = useUtilizationPalette();
  const stripeId = useStripeId();
  const stroke = strokeWidth ?? Math.max(4, size / 8);
  const c = size / 2;
  const r = (size - stroke) / 2;
  const fill = dayRingFill(day);
  const large = size >= 96;

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={ringAccessibilityLabel(fill)}
      style={{ width: size, height: size }}
      className="items-center justify-center"
    >
      <Svg width={size} height={size} style={{ position: 'absolute' }}>
        <StripeDefs id={stripeId} color={palette.tentativeStripe} size={Math.max(4, stroke / 2)} />
        <Circle cx={c} cy={c} r={r} stroke={palette.closed} strokeWidth={stroke} fill="none" />
        {fill.slices.map((slice) => {
          const full = slice.to - slice.from >= 0.9999;
          const shape = (paint: string, key: string) =>
            full ? (
              <Circle
                key={key}
                cx={c}
                cy={c}
                r={r}
                stroke={paint}
                strokeWidth={stroke}
                fill="none"
              />
            ) : (
              <Path
                key={key}
                d={arcPath(c, r, slice.from, slice.to)}
                stroke={paint}
                strokeWidth={stroke}
                fill="none"
              />
            );
          return (
            <G key={slice.state}>
              {shape(palette[slice.state], 'fill')}
              {slice.state === 'tentative' ? shape(`url(#${stripeId})`, 'stripe') : null}
            </G>
          );
        })}
      </Svg>
      {showLabel ? (
        <View className="items-center">
          <Text
            numeric
            className="font-bold"
            tone={fill.closed ? 'subtle' : 'default'}
            style={{ fontSize: fill.closed ? size * 0.2 : size * (large ? 0.22 : 0.26) }}
            maxFontSizeMultiplier={1}
          >
            {fill.closed ? 'Off' : `${fill.percent}%`}
          </Text>
          {large && !fill.closed ? (
            <Text variant="caption" tone="muted" maxFontSizeMultiplier={1}>
              booked
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
export function minutesOf(day: DayUtilization, state: UtilizationState): number {
  switch (state) {
    case 'booked':
      return day.bookedMinutes;
    case 'open':
      return day.openMinutes;
    case 'tentative':
      return day.tentativeMinutes;
    case 'closed':
      return day.closedMinutes;
  }
}

/** Small color key: a swatch (striped for tentative) and a label. */
export function LegendSwatch({ state, size = 10 }: { state: UtilizationState; size?: number }) {
  const palette = useUtilizationPalette();
  const stripeId = useStripeId();
  return (
    <Svg width={size} height={size}>
      <StripeDefs id={stripeId} color={palette.tentativeStripe} size={4} />
      <Rect width={size} height={size} rx={size / 3} fill={palette[state]} />
      {state === 'tentative' ? (
        <Rect width={size} height={size} rx={size / 3} fill={`url(#${stripeId})`} />
      ) : null}
    </Svg>
  );
}
