import { describe, expect, it } from 'vitest';

import { appt, at, FRI, weekdayHours } from '../availability/test-helpers.ts';
import { planRunningLate, runningLateOptions } from './running-late.ts';

const hours = weekdayHours();

// 10:00 color (apply 30 · process 35 · style 30), 10:30 cut inside the processing, 11:30 cut,
// 13:00 cut after a long gap.
const color = appt('color', at(FRI, '10:00'), [
  ['busy', 30],
  ['processing', 35],
  ['style', 30],
]);
const cutInProcessing = appt('cut1', at(FRI, '10:30'), [['busy', 30]]);
const cut = appt('cut2', at(FRI, '11:35'), [['busy', 30]]);
const afterLunch = appt('cut3', at(FRI, '13:00'), [['busy', 30]]);
const day = [color, cutInProcessing, cut, afterLunch];

const ids = (p: { moves: { id: string }[] }) => p.moves.map((m) => m.id);

describe('planRunningLate · ripple (squeeze)', () => {
  it('moves the late client by the delay and only knocks on as far as needed', () => {
    const plan = planRunningLate({ appointments: day, delayMinutes: 15, now: at(FRI, '09:50') });
    expect(plan.ok).toBe(true);
    expect(plan.firstId).toBe('color');
    // The cut at 10:30 still fits: the color's apply now ends 10:45, so the cut moves to 10:45,
    // and the color's style (now 11:20–11:50) pushes the 11:35 cut to 11:50. 13:00 is untouched.
    expect(plan.moves.map((m) => [m.id, m.shiftMinutes])).toEqual([
      ['color', 15],
      ['cut1', 15],
      ['cut2', 15],
    ]);
    expect(plan.unchanged).toEqual(['cut3']);
    expect(plan.moves[0]!.to.start).toBe(at(FRI, '10:15'));
    expect(plan.moves[0]!.segments).toHaveLength(3);
    expect(plan.overtimeMinutes).toBe(0);
  });

  it('lets processing time absorb a short delay', () => {
    // 'mid' sits in the color's processing (10:30–11:05); 'cut' follows its style (until 11:35).
    const late = appt('cut', at(FRI, '11:35'), [['busy', 30]]);
    const plan = planRunningLate({
      appointments: [color, appt('mid', at(FRI, '10:35'), [['busy', 25]]), late],
      delayMinutes: 5,
      firstId: 'color',
    });
    // Color → 10:05 (apply until 10:35, processing 10:35–11:10, style 11:10–11:40).
    // 'mid' (10:35–11:00) still fits in the new processing window; the 11:35 cut clashes with
    // the style and moves right after it.
    expect(plan.unchanged).toContain('mid');
    expect(plan.moves.find((m) => m.id === 'cut')?.to.start).toBe(at(FRI, '11:40'));
  });

  it('stops at a free gap', () => {
    const a = appt('a', at(FRI, '09:00'), [['busy', 60]]);
    const b = appt('b', at(FRI, '10:30'), [['busy', 60]]);
    const plan = planRunningLate({ appointments: [a, b], delayMinutes: 20, firstId: 'a' });
    expect(ids(plan)).toEqual(['a']);
    expect(plan.unchanged).toEqual(['b']);
  });

  it('rounds knock-on shifts up to the grid', () => {
    const a = appt('a', at(FRI, '09:00'), [['busy', 60]]);
    const b = appt('b', at(FRI, '10:07'), [['busy', 30]]);
    const plan = planRunningLate({ appointments: [a, b], delayMinutes: 10, firstId: 'a' });
    // a ends 10:10, so b needs 3 minutes → rounded up to 5.
    expect(plan.moves.map((m) => m.shiftMinutes)).toEqual([10, 5]);
  });

  it('never moves fixed or earlier appointments, and works around them', () => {
    const done = appt('done', at(FRI, '09:00'), [['busy', 30]]);
    const next = appt('next', at(FRI, '09:30'), [['busy', 30]]);
    const plan = planRunningLate({
      appointments: [done, next],
      delayMinutes: 10,
      fixedIds: ['done'],
      now: at(FRI, '09:25'),
    });
    expect(plan.firstId).toBe('next');
    expect(ids(plan)).toEqual(['next']);
  });

  it('treats a client due a few minutes ago as still waiting', () => {
    const plan = planRunningLate({ appointments: day, delayMinutes: 15, now: at(FRI, '10:10') });
    expect(plan.firstId).toBe('color');
    const later = planRunningLate({ appointments: day, delayMinutes: 15, now: at(FRI, '10:20') });
    expect(later.firstId).toBe('cut1');
  });

  it('flags overtime past closing', () => {
    const last = appt('last', at(FRI, '16:30'), [['busy', 30]]);
    const plan = planRunningLate({ appointments: [last], delayMinutes: 20, hours });
    expect(plan.overtimeMinutes).toBe(20);
  });

  it('returns an empty plan when nothing is left today', () => {
    const plan = planRunningLate({ appointments: day, delayMinutes: 15, now: at(FRI, '18:00') });
    expect(plan).toMatchObject({ firstId: null, moves: [], ok: true });
  });

  it('rejects bad delays and unknown first appointments', () => {
    expect(() => planRunningLate({ appointments: day, delayMinutes: 0 })).toThrow(RangeError);
    expect(() => planRunningLate({ appointments: day, delayMinutes: 7.5 })).toThrow(RangeError);
    expect(() => planRunningLate({ appointments: day, delayMinutes: 500 })).toThrow(RangeError);
    expect(() => planRunningLate({ appointments: day, delayMinutes: 5, firstId: 'nope' })).toThrow(
      RangeError,
    );
  });
});

describe('planRunningLate · other strategies', () => {
  it('shift_all moves everyone after the late client by the full delay', () => {
    const plan = planRunningLate({
      appointments: day,
      delayMinutes: 15,
      firstId: 'color',
      strategy: 'shift_all',
    });
    expect(plan.moves.map((m) => [m.id, m.shiftMinutes])).toEqual([
      ['color', 15],
      ['cut1', 15],
      ['cut2', 15],
      ['cut3', 15],
    ]);
    expect(plan.ok).toBe(true);
  });

  it('move_one reports the clash when the late client would overlap the next', () => {
    const plan = planRunningLate({
      appointments: day,
      delayMinutes: 15,
      firstId: 'color',
      strategy: 'move_one',
    });
    expect(plan.ok).toBe(false);
    expect(ids(plan)).toEqual(['color']);
    expect(plan.conflicts.map((c) => [c.a, c.b].sort())).toContainEqual(['color', 'cut1']);
  });

  it('options drop duplicates', () => {
    const a = appt('a', at(FRI, '09:00'), [['busy', 60]]);
    const b = appt('b', at(FRI, '11:00'), [['busy', 60]]);
    const options = runningLateOptions({ appointments: [a, b], delayMinutes: 15, firstId: 'a' });
    // ripple == move_one (only a moves); shift_all differs.
    expect(options.map((o) => o.strategy)).toEqual(['ripple', 'shift_all']);
  });
});
