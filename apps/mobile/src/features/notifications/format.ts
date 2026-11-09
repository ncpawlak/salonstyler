import { NUDGE_DELAY_OPTIONS } from '@chairside/notifications';

export { NUDGE_DELAY_OPTIONS };
/** Same choices as Work hours → Booking rules → Holds expire after. */
export const HOLD_EXPIRY_OPTIONS = [1, 2, 4, 8, 12, 24, 48, 72, 168] as const;

/** `1 h`, `12 h`, `1 day`, `3 days`, `1 wk`. */
export function formatHours(h: number): string {
  if (h < 24) return `${h} h`;
  if (h % 168 === 0) return `${h / 168} wk`;
  if (h % 24 === 0) return `${h / 24} day${h === 24 ? '' : 's'}`;
  return `${h} h`;
}

/** Postgres `time` (`21:00:00`) → `21:00` for TimeStepper. */
export function toClock(time: string): string {
  return time.slice(0, 5);
}

/** Picks the nearest allowed option so a value set elsewhere still shows in a stepper. */
export function nearestOption(value: number, options: readonly number[]): number {
  return options.reduce((best, o) => (Math.abs(o - value) < Math.abs(best - value) ? o : best));
}

/** Explains the nudge → release timeline on the settings screen. */
export function describeRequestTimeline(nudgeHours: number, expiryHours: number): string {
  return `If you don’t answer a request, you’re reminded after ${formatHours(
    nudgeHours,
  )}. It’s released ${formatHours(expiryHours)} after that.`;
}
