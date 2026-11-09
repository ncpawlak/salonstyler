import type { DayUtilization, UtilizationState } from '@chairside/core';
import { useId } from 'react';
import { View } from 'react-native';
import Svg, { Circle, Defs, G, Line, Path, Pattern, Rect } from 'react-native-svg';

import { Text } from '@/components/ui';
import { useTheme } from '@/theme/theme-provider';

import { formatMinutes, stateLabel, useUtilizationPalette } from './palette';

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
  /** Draws a marker at this instant when it falls on the day. */
  now?: number;
  /** Hour ticks at 12a / 6a / 12p / 6p. Defaults on for large rings. */
  ticks?: boolean;
};

/**
 * 24-hour ring: the day runs clockwise from midnight at the top, so where the color sits tells
 * him *when* he's booked or free. Booked = accent, open = green, tentative = striped amber,
 * off = gray. The center shows % booked of bookable time.
 */
export function DayRing({
  day,
  size = 64,
  strokeWidth,
  showLabel = true,
  now,
  ticks = size >= 120,
}: DayRingProps) {
  const { colors } = useTheme();
  const palette = useUtilizationPalette();
  const stripeId = useStripeId();
  const stroke = strokeWidth ?? Math.max(4, size / 8);
  const c = size / 2;
  const r = (size - stroke) / 2;
  const span = day.end - day.start;
  const frac = (ms: number) => (ms - day.start) / span;
  const pct = Math.round(day.utilization * 100);
  const closed = day.capacityMinutes === 0;

  const arcs = day.runs.filter((run) => run.state !== 'closed');
  const nowFrac = now !== undefined && now >= day.start && now < day.end ? frac(now) : null;

  const summary = closed
    ? 'Closed'
    : `${pct}% booked. ${(['booked', 'open', 'tentative'] as const)
        .map((s) => `${stateLabel[s]} ${formatMinutes(minutesOf(day, s))}`)
        .join(', ')}`;

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={summary}
      style={{ width: size, height: size }}
      className="items-center justify-center"
    >
      <Svg width={size} height={size} style={{ position: 'absolute' }}>
        <StripeDefs id={stripeId} color={palette.tentativeStripe} size={Math.max(4, stroke / 2)} />
        <Circle cx={c} cy={c} r={r} stroke={palette.closed} strokeWidth={stroke} fill="none" />
        {arcs.map((run) => {
          const from = frac(run.start);
          const to = frac(run.end);
          const full = to - from >= 0.9999;
          const color = palette[run.state];
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
                d={arcPath(c, r, from, to)}
                stroke={paint}
                strokeWidth={stroke}
                fill="none"
              />
            );
          return (
            <G key={run.start}>
              {shape(color, 'fill')}
              {run.state === 'tentative' ? shape(`url(#${stripeId})`, 'stripe') : null}
            </G>
          );
        })}
        {ticks
          ? [0, 0.25, 0.5, 0.75].map((f) => {
              const a = point(c, r - stroke / 2 - 2, f);
              const b = point(c, r - stroke / 2 - 7, f);
              return (
                <Line
                  key={f}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke={colors['subtle-foreground']}
                  strokeWidth={1.5}
                  strokeLinecap="round"
                />
              );
            })
          : null}
        {nowFrac !== null ? (
          <Circle
            cx={point(c, r, nowFrac).x}
            cy={point(c, r, nowFrac).y}
            r={Math.max(2.5, stroke / 2.6)}
            fill={colors.destructive}
            stroke={colors.card}
            strokeWidth={1.5}
          />
        ) : null}
      </Svg>
      {showLabel ? (
        <View className="items-center">
          <Text
            numeric
            className="font-bold"
            tone={closed ? 'subtle' : 'default'}
            style={{ fontSize: closed ? size * 0.16 : size * 0.24 }}
            maxFontSizeMultiplier={1}
          >
            {closed ? 'Off' : `${pct}%`}
          </Text>
          {size >= 96 && !closed ? (
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
