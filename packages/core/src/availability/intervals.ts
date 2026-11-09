import type { Interval } from './types.ts';

/** Sorts and merges overlapping or touching intervals; drops empty ones. */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ start: i.start, end: i.end });
  }
  return out;
}

/** `a − b`. Inputs need not be merged; output is merged and sorted. */
export function subtractIntervals(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const cut = mergeIntervals(b);
  const out: Interval[] = [];
  for (const base of mergeIntervals(a)) {
    let cursor = base.start;
    for (const c of cut) {
      if (c.end <= cursor) continue;
      if (c.start >= base.end) break;
      if (c.start > cursor) out.push({ start: cursor, end: c.start });
      cursor = Math.max(cursor, c.end);
      if (cursor >= base.end) break;
    }
    if (cursor < base.end) out.push({ start: cursor, end: base.end });
  }
  return out;
}

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

export function overlapMs(a: Interval, b: Interval): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

export function contains(outer: Interval, inner: Interval): boolean {
  return outer.start <= inner.start && inner.end <= outer.end;
}
