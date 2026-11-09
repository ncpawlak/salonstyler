import { describe, expect, it } from 'vitest';
import { applyDurationOverrides, busyRanges, findBusyConflicts, layoutService, processingRanges, toTstzRanges } from './segments';
import { FRI, ROOT_TOUCH_UP, appt, at } from './test-helpers';

const M = 60_000;

describe('segments', () => {
  it('lays out a service with buffers around the client time', () => {
    const t = layoutService({ segments: ROOT_TOUCH_UP, bufferBeforeMinutes: 5, bufferAfterMinutes: 10 }, 0);
    expect(t.map((s) => [s.kind, s.start / M, s.end / M])).toEqual([
      ['buffer', -5, 0],
      ['busy', 0, 30],
      ['processing', 30, 65],
      ['style', 65, 95],
      ['buffer', 95, 105],
    ]);
  });

  it('applies per-client duration overrides', () => {
    const out = applyDurationOverrides(ROOT_TOUCH_UP, [{ index: 2, deltaMinutes: 20 }, { index: 1, minutes: 45 }]);
    expect(out.map((s) => s.minutes)).toEqual([30, 45, 50]);
    expect(ROOT_TOUCH_UP[2]!.minutes).toBe(30);
    expect(() => applyDurationOverrides(ROOT_TOUCH_UP, [{ index: 9, deltaMinutes: 1 }])).toThrow();
    expect(() => applyDurationOverrides(ROOT_TOUCH_UP, [{ index: 0, deltaMinutes: -30 }])).toThrow();
  });

  it('rejects invalid services', () => {
    expect(() => layoutService({ segments: [] }, 0)).toThrow();
    expect(() => layoutService({ segments: [{ kind: 'processing', minutes: 10 }] }, 0)).toThrow();
    expect(() => layoutService({ segments: [{ kind: 'busy', minutes: 7.5 }] }, 0)).toThrow();
    expect(() => layoutService({ segments: [{ kind: 'busy', minutes: 10 }], bufferAfterMinutes: -1 }, 0)).toThrow();
  });

  it('computes busy ranges (busy + style + buffer, merged) for the DB exclusion constraint', () => {
    const a = appt('a', at(FRI, '09:55'), [['buffer', 5], ['busy', 30], ['processing', 35], ['style', 30], ['buffer', 10]]);
    expect(toTstzRanges(busyRanges(a.segments))).toEqual([
      `[${at(FRI, '09:55')},${at(FRI, '10:30')})`,
      `[${at(FRI, '11:05')},${at(FRI, '11:45')})`,
    ]);
    expect(toTstzRanges(processingRanges(a.segments))).toEqual([`[${at(FRI, '10:30')},${at(FRI, '11:05')})`]);
  });

  it('detects busy overlaps but allows busy inside processing and back-to-back', () => {
    const color = appt('color', at(FRI, '10:00'), [['busy', 30], ['processing', 35], ['style', 30]]);
    const cutInGap = appt('cut', at(FRI, '10:30'), [['busy', 30]]);
    const backToBack = appt('next', at(FRI, '11:35'), [['busy', 30]]);
    expect(findBusyConflicts([color, cutInGap, backToBack])).toEqual([]);

    const clash = appt('clash', at(FRI, '10:15'), [['busy', 30]]);
    expect(findBusyConflicts([color, clash])).toEqual([
      { a: 'color', b: 'clash', overlap: { start: Date.parse(at(FRI, '10:15')), end: Date.parse(at(FRI, '10:30')) } },
    ]);
  });
});
