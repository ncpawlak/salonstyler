import { describe, expect, it } from 'vitest';
import {
  appt,
  at,
  FRI,
  MENS_CUT,
  ROOT_TOUCH_UP,
  weekdayHours,
} from '../availability/test-helpers.ts';
import { bookingErrorMessage, planBooking, serviceFromSegments, snapToGrid } from './plan.ts';

const hours = weekdayHours();
const color = appt('color', at(FRI, '10:00'), [
  ['busy', 30],
  ['processing', 35],
  ['style', 30],
]);

describe('planBooking', () => {
  it('books a cut inside another client’s processing time', () => {
    const plan = planBooking({
      service: { segments: MENS_CUT },
      start: at(FRI, '10:30'),
      hours,
      existing: [color],
    });
    expect(plan).toMatchObject({ ok: true, start: at(FRI, '10:30'), end: at(FRI, '11:00') });
    expect(plan.ok && plan.warning).toBeFalsy();
  });

  it('blocks busy-over-busy with a named, clear message', () => {
    const plan = planBooking({
      service: { segments: MENS_CUT },
      start: at(FRI, '10:15'),
      hours,
      existing: [color],
      names: { color: 'Karina' },
    });
    expect(plan).toMatchObject({ ok: false, reason: 'conflict', conflictWith: 'color' });
    expect(!plan.ok && plan.message).toContain("Karina's appointment at 10:15");
  });

  it('treats buffers as blocking', () => {
    const plan = planBooking({
      service: { segments: MENS_CUT, bufferBeforeMinutes: 10 },
      start: at(FRI, '11:10'),
      hours,
      existing: [color],
    });
    expect(plan).toMatchObject({ ok: false, reason: 'conflict' });
  });

  it('returns all segments including buffers for the RPC', () => {
    const plan = planBooking({
      service: { segments: ROOT_TOUCH_UP, bufferAfterMinutes: 10 },
      start: at(FRI, '13:00'),
      hours,
      existing: [color],
    });
    expect(plan.ok && plan.segments.map((s) => s.kind)).toEqual([
      'busy',
      'processing',
      'style',
      'buffer',
    ]);
    expect(plan.ok && plan.end).toBe(at(FRI, '14:35'));
  });

  it('allows outside-hours bookings for the owner with a warning', () => {
    const plan = planBooking({
      service: { segments: MENS_CUT },
      start: at(FRI, '18:00'),
      hours,
      existing: [],
    });
    expect(plan).toMatchObject({ ok: true, warning: 'outside-hours' });
  });

  it('rejects an invalid service', () => {
    const plan = planBooking({
      service: { segments: [{ kind: 'processing', minutes: 30 }] },
      start: at(FRI, '12:00'),
      hours,
      existing: [],
    });
    expect(plan).toMatchObject({ ok: false, reason: 'invalid' });
  });
});

describe('serviceFromSegments', () => {
  it('round-trips a laid-out appointment so it can be moved', () => {
    const placed = appt('x', at(FRI, '09:50'), [
      ['buffer', 10],
      ['busy', 30],
      ['processing', 35],
      ['style', 30],
      ['buffer', 5],
    ]).segments;
    const { service, start } = serviceFromSegments(placed);
    expect(start).toBe(Date.parse(at(FRI, '10:00')));
    expect(service).toEqual({
      segments: [
        { kind: 'busy', minutes: 30 },
        { kind: 'processing', minutes: 35 },
        { kind: 'style', minutes: 30 },
      ],
      bufferBeforeMinutes: 10,
      bufferAfterMinutes: 5,
    });
    const moved = planBooking({ service, start: at(FRI, '13:00'), hours, existing: [color] });
    expect(moved.ok && moved.segments[0]!.start).toBe(at(FRI, '12:50'));
  });
});

describe('helpers', () => {
  it('snaps to the grid', () => {
    expect(snapToGrid(Date.parse('2026-03-06T15:07:00Z'), 15)).toBe(
      Date.parse('2026-03-06T15:00:00Z'),
    );
    expect(snapToGrid(Date.parse('2026-03-06T15:08:00Z'), 15)).toBe(
      Date.parse('2026-03-06T15:15:00Z'),
    );
  });

  it('maps exclusion violations to a friendly message', () => {
    expect(bookingErrorMessage({ code: '23P01', message: 'x' })).toMatch(/overlaps another/);
    expect(bookingErrorMessage({ message: 'Nope' })).toBe('Nope');
  });
});
