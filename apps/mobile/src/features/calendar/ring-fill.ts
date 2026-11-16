import type { DayUtilization } from '@chairside/core';

import { formatMinutes } from './format';

/** A slice of the day ring, as fractions 0..1 of the working day, clockwise from 12 o'clock. */
export interface RingSlice {
  state: 'booked' | 'tentative' | 'open';
  from: number;
  to: number;
  minutes: number;
}

export interface DayRingFill {
  /** No working hours and nothing booked: the ring reads "Off". */
  closed: boolean;
  /** Whole ring: the day's working time (booked + open + tentative). */
  workMinutes: number;
  bookedMinutes: number;
  /** Still free: open + tentative. `bookedMinutes + freeMinutes === workMinutes`. */
  freeMinutes: number;
  /** Rounded share booked; see `bookedPercent`. */
  percent: number;
  /** Booked, then free tentative, then free open. Zero-length slices are dropped. */
  slices: RingSlice[];
}

/**
 * `booked / total` as a whole percent that never contradicts the free time next to it: anything
 * booked shows at least 1%, and anything still free shows at most 99%.
 */
export function bookedPercent(booked: number, total: number): number {
  if (total <= 0 || booked <= 0) return 0;
  if (booked >= total) return 100;
  return Math.min(99, Math.max(1, Math.round((booked / total) * 100)));
}

/**
 * Progress-donut layout for one day. The full ring is that day's working hours, so a day that's
 * 86% booked looks nearly full. *When* things happen lives in the timeline strip, not here.
 */
export function dayRingFill(
  day: Pick<DayUtilization, 'bookedMinutes' | 'openMinutes' | 'tentativeMinutes'>,
): DayRingFill {
  const booked = Math.max(0, day.bookedMinutes);
  const tentative = Math.max(0, day.tentativeMinutes);
  const open = Math.max(0, day.openMinutes);
  const work = booked + tentative + open;
  const slices: RingSlice[] = [];
  if (work > 0) {
    let at = 0;
    for (const [state, minutes] of [
      ['booked', booked],
      ['tentative', tentative],
      ['open', open],
    ] as const) {
      if (minutes <= 0) continue;
      const to = Math.min(1, at + minutes / work);
      slices.push({ state, from: at, to, minutes });
      at = to;
    }
    // Float drift: the last slice always closes the ring.
    slices[slices.length - 1]!.to = 1;
  }
  return {
    closed: work === 0,
    workMinutes: work,
    bookedMinutes: booked,
    freeMinutes: tentative + open,
    percent: bookedPercent(booked, work),
    slices,
  };
}

/** `86% booked` / `Off`. */
export function bookedLabel(fill: DayRingFill): string {
  return fill.closed ? 'Off' : `${fill.percent}% booked`;
}

/** `1h 5m free` / `Fully booked` / `Off`, matching the empty part of the ring. */
export function freeLabel(fill: DayRingFill): string {
  if (fill.closed) return 'Off';
  return fill.freeMinutes > 0 ? `${formatMinutes(fill.freeMinutes)} free` : 'Fully booked';
}

/**
 * Screen-reader text for the ring, e.g.
 * `86% booked, 1h 5m free of 8h. 30m of the free time is tentative.`
 */
export function ringAccessibilityLabel(fill: DayRingFill): string {
  if (fill.closed) return 'Day off';
  const tentative = fill.slices.find((s) => s.state === 'tentative');
  const work = formatMinutes(fill.workMinutes);
  const free =
    fill.freeMinutes > 0
      ? `${formatMinutes(fill.freeMinutes)} free of ${work}`
      : `all ${work} taken`;
  return [
    `${fill.percent}% booked, ${free}.`,
    tentative ? `${formatMinutes(tentative.minutes)} of the free time is tentative.` : null,
  ]
    .filter(Boolean)
    .join(' ');
}
