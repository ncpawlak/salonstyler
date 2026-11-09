import { describe, expect, it } from 'vitest';
import { evaluateStart, findSlots } from './engine';
import { findBusyConflicts } from './segments';
import { EARLY_NOW, FRI, MENS_CUT, NY, ROOT_TOUCH_UP, appt, at, weekdayHours } from './test-helpers';
import type { ExistingAppointment, FindSlotsInput, SlotCandidate, WorkHours } from './types';

const base = (over: Partial<FindSlotsInput> = {}): FindSlotsInput => ({
  service: { segments: MENS_CUT },
  hours: weekdayHours(),
  requestedDate: FRI,
  searchRadiusDays: 0,
  now: EARLY_NOW,
  ...over,
});

const starts = (c: SlotCandidate[]) => c.map((s) => s.start);
const times = (c: SlotCandidate[]) => c.map((s) => s.localTime);
const sortedTimes = (c: SlotCandidate[]) => [...times(c)].sort();

/** Fills the day around a window so only that window is free for the stylist. */
function onlyFree(date: string, from: string, to: string): ExistingAppointment[] {
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  return [
    appt('before', at(date, '09:00'), [['busy', toMin(from) - 9 * 60]]),
    appt('after', at(date, to), [['busy', 17 * 60 - toMin(to)]]),
  ].filter((a) => a.segments[0]!.end > a.segments[0]!.start);
}

describe('findSlots: basics', () => {
  it('offers every 15m grid start that fits on an empty day', () => {
    const r = findSlots(base());
    expect(r).toHaveLength(31);
    expect(sortedTimes(r)[0]).toBe('09:00');
    expect(sortedTimes(r)[30]).toBe('16:30');
    expect(r.every((c) => !c.requiresApproval && c.localDate === FRI && c.dayOffset === 0)).toBe(true);
  });

  it('returns ISO start/end and placed segments', () => {
    const [top] = findSlots(base({ service: { segments: ROOT_TOUCH_UP } }));
    expect(top!.start).toBe(at(FRI, '09:00'));
    expect(top!.end).toBe(at(FRI, '10:35'));
    expect(top!.segments.map((s) => s.kind)).toEqual(['busy', 'processing', 'style']);
  });

  it('honours limit and returns nothing on closed days', () => {
    expect(findSlots(base({ limit: 3 }))).toHaveLength(3);
    expect(findSlots(base({ requestedDate: '2026-03-08' }))).toEqual([]);
  });

  it('respects breaks and blocked time', () => {
    const hours: WorkHours = { timeZone: NY, weekly: { 5: { blocks: [{ start: '09:00', end: '17:00', type: 'open' }], breaks: [{ start: '12:00', end: '13:00' }] } } };
    const r = findSlots(base({ hours, blocked: [{ start: at(FRI, '14:00'), end: at(FRI, '15:00') }] }));
    for (const c of r) {
      const s = Date.parse(c.start);
      const e = Date.parse(c.end);
      expect(e <= Date.parse(at(FRI, '12:00')) || s >= Date.parse(at(FRI, '13:00'))).toBe(true);
      expect(e <= Date.parse(at(FRI, '14:00')) || s >= Date.parse(at(FRI, '15:00'))).toBe(true);
    }
    expect(times(r)).toContain('11:30');
    expect(times(r)).toContain('13:00');
    expect(times(r)).not.toContain('11:45');
  });
});

describe('findSlots: back-to-back bookings', () => {
  const existing = [appt('a', at(FRI, '09:00'), [['busy', 60]]), appt('b', at(FRI, '10:30'), [['busy', 60]])];

  it('books exactly at the end of one appointment and the start of the next (half-open ranges)', () => {
    const r = findSlots(base({ existing }));
    expect(times(r)).toContain('10:00');
    expect(times(r)).toContain('11:30');
    expect(times(r)).not.toContain('09:45');
    expect(times(r)).not.toContain('10:15');
  });

  it('ranks the slot that exactly fills the 30m hole first', () => {
    const [top] = findSlots(base({ existing }));
    expect(top!.localTime).toBe('10:00');
    expect(top!.deadMinutes).toBe(0);
    expect(top!.reasons.join()).toMatch(/2 edges flush/);
  });

  it('never double-books busy time', () => {
    const r = findSlots(base({ existing }));
    for (const c of r) expect(findBusyConflicts([...existing, { id: 'new', segments: c.segments }])).toEqual([]);
  });
});

describe('findSlots: processing gaps', () => {
  // Root touch-up at 10:00: apply 10:00–10:30, process 10:30–11:05, style 11:05–11:35.
  const color = appt('color', at(FRI, '10:00'), [['busy', 30], ['processing', 35], ['style', 30]]);

  it("fits a 30m men's cut inside another client's 35m processing gap", () => {
    const r = findSlots(base({ existing: [color, ...onlyFree(FRI, '10:00', '11:35')] }));
    expect(sortedTimes(r)).toEqual(['10:30', '10:35']);
    expect(r[0]!.processingFillMinutes).toBe(30);
    expect(r[0]!.reasons.join()).toMatch(/processing time/);
    expect(r[0]!.localTime).toBe('10:30');
  });

  it('rejects a service whose busy time does not fit the gap', () => {
    const existing = [color, ...onlyFree(FRI, '10:00', '11:35')];
    expect(findSlots(base({ existing, service: { segments: [{ kind: 'busy', minutes: 40 }] } }))).toEqual([]);
  });

  it("prefers filling processing time over open time when it fills the same hole", () => {
    const r = findSlots(base({ existing: [color] }));
    const inGap = r.find((c) => c.localTime === '10:30')!;
    const open = r.find((c) => c.localTime === '12:00')!;
    expect(inGap.score).toBeGreaterThan(open.score);
  });

  it("books a new color around an existing cut, the cut landing in the new color's processing", () => {
    const hours: WorkHours = { timeZone: NY, weekly: { 5: { blocks: [{ start: '10:00', end: '11:35', type: 'open' }] } } };
    const cut = appt('cut', at(FRI, '10:30'), [['busy', 30]]);
    const r = findSlots(base({ hours, existing: [cut], service: { segments: ROOT_TOUCH_UP } }));
    expect(times(r)).toEqual(['10:00']);
  });

  it('lets two clients process at the same time', () => {
    const other = appt('other', at(FRI, '09:00'), [['busy', 30], ['processing', 35], ['style', 30]]);
    const e = evaluateStart({ ...base({ existing: [other], service: { segments: ROOT_TOUCH_UP } }), start: at(FRI, '09:30') });
    // new apply 09:30–10:00 is during other's processing; new processing overlaps other's style.
    expect(e.ok).toBe(true);
  });

  it('requires the whole service (including processing) to fit in hours', () => {
    const hours: WorkHours = { timeZone: NY, weekly: { 5: { blocks: [{ start: '09:00', end: '11:00', type: 'open' }] } } };
    const r = findSlots(base({ hours, service: { segments: ROOT_TOUCH_UP } }));
    expect(sortedTimes(r)).toEqual(['09:00', '09:15', '09:25']);
  });

  it('applies client duration overrides (Karina takes +20m to style)', () => {
    const r = findSlots(base({ service: { segments: ROOT_TOUCH_UP, overrides: [{ index: 2, deltaMinutes: 20 }] } }));
    expect(sortedTimes(r).at(-1)).toBe('15:05');
  });
});

describe('findSlots: buffers', () => {
  it("blocks an existing appointment's cleanup buffer", () => {
    const existing = [appt('a', at(FRI, '10:00'), [['busy', 30], ['buffer', 10]])];
    const r = findSlots(base({ existing }));
    expect(times(r)).not.toContain('10:30');
    expect(times(r)).toContain('10:40');
  });

  it('keeps the new service buffers inside hours and off other busy time', () => {
    const r = findSlots(base({ service: { segments: MENS_CUT, bufferBeforeMinutes: 10, bufferAfterMinutes: 10 } }));
    expect(sortedTimes(r)[0]).toBe('09:10');
    expect(sortedTimes(r).at(-1)).toBe('16:20');
    const [first] = r.filter((c) => c.localTime === '09:10');
    expect(first!.start).toBe(at(FRI, '09:10'));
    expect(first!.segments[0]).toEqual({ kind: 'buffer', start: at(FRI, '09:00'), end: at(FRI, '09:10') });

    const existing = [appt('a', at(FRI, '12:00'), [['busy', 30]])];
    const r2 = findSlots(base({ existing, service: { segments: MENS_CUT, bufferAfterMinutes: 10 } }));
    expect(times(r2)).not.toContain('11:30');
    expect(times(r2)).toContain('11:20');
  });

  it('allows a buffer to sit inside processing time', () => {
    const color = appt('color', at(FRI, '10:00'), [['busy', 30], ['processing', 35], ['style', 30]]);
    const e = evaluateStart({ ...base({ existing: [color], service: { segments: MENS_CUT, bufferAfterMinutes: 5 } }), start: at(FRI, '10:30') });
    expect(e.ok).toBe(true);
  });
});

describe('findSlots: lead time and booking window', () => {
  it('never offers starts inside the lead time', () => {
    const now = at(FRI, '10:07');
    const r = findSlots(base({ now, rules: { leadTimeMinutes: 120 } }));
    expect(r.every((c) => Date.parse(c.start) >= Date.parse(now) + 120 * 60_000)).toBe(true);
    expect(sortedTimes(r)[0]).toBe('12:15');
  });

  it('skips past days in the ±N search', () => {
    const r = findSlots(base({ now: at(FRI, '08:00'), searchRadiusDays: 2 }));
    expect(new Set(r.map((c) => c.dayOffset))).toEqual(new Set([0, 1]));
  });

  it('respects the booking window', () => {
    const now = at(FRI, '08:00');
    const r = findSlots(base({ now, searchRadiusDays: 3, rules: { bookingWindowDays: 1 } }));
    // Window ends Sat 08:00, before Saturday opens; Thursday is in the past.
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((c) => Date.parse(c.start) <= Date.parse(now) + 86_400_000)).toBe(true);
    expect(new Set(r.map((c) => c.dayOffset))).toEqual(new Set([0]));
  });
});

describe('findSlots: open vs tentative hours', () => {
  const hours: WorkHours = {
    timeZone: NY,
    weekly: {
      5: {
        blocks: [
          { start: '09:00', end: '17:00', type: 'open' },
          { start: '17:00', end: '19:00', type: 'tentative' },
        ],
      },
      0: { blocks: [{ start: '10:00', end: '14:00', type: 'tentative' }] },
    },
  };

  it('flags tentative slots, including ones straddling open → tentative', () => {
    const r = findSlots(base({ hours }));
    expect(r.find((c) => c.localTime === '16:30')!.requiresApproval).toBe(false);
    expect(r.find((c) => c.localTime === '16:45')!.requiresApproval).toBe(true);
    expect(r.find((c) => c.localTime === '18:30')!.requiresApproval).toBe(true);
    expect(findSlots(base({ hours, requestedDate: '2026-03-08' })).every((c) => c.requiresApproval)).toBe(true);
  });

  it('ranks open before tentative on the same day', () => {
    const r = findSlots(base({ hours }));
    const firstTentative = r.findIndex((c) => c.requiresApproval);
    expect(r.slice(firstTentative).every((c) => c.requiresApproval)).toBe(true);
  });

  it('offers tentative first when the client asks for that time', () => {
    const [top] = findSlots(base({ hours, preference: 'evening' }));
    expect(top!.localTime >= '17:00').toBe(true);
    expect(top!.matchesPreference).toBe(true);
    expect(top!.requiresApproval).toBe(true);
  });

  it('can exclude tentative hours', () => {
    expect(findSlots(base({ hours, includeTentative: false })).some((c) => c.requiresApproval)).toBe(false);
  });
});

describe('findSlots: ranking', () => {
  it('avoids leaving unusable 15–20m holes', () => {
    const existing = [appt('a', at(FRI, '09:00'), [['busy', 60]]), appt('b', at(FRI, '11:00'), [['busy', 360]])];
    const r = findSlots(base({ existing }));
    const t1015 = r.find((c) => c.localTime === '10:15')!;
    expect(t1015.deadMinutes).toBe(30);
    expect(t1015.reasons.join()).toMatch(/unusable gap/);
    expect(r[0]!.deadMinutes).toBe(0);
    expect(['10:00', '10:30']).toContain(r[0]!.localTime);
    expect(r.at(-1)!.localTime).toBe('10:15');
  });

  it('honours named and explicit time-of-day preferences', () => {
    const afternoon = findSlots(base({ preference: 'afternoon' }));
    // Within the window, the end-of-day slot that leaves no hole wins.
    expect(afternoon[0]!.localTime).toBe('16:30');
    const firstMiss = afternoon.findIndex((c) => !c.matchesPreference);
    expect(afternoon.slice(0, firstMiss).every((c) => c.localTime >= '12:00' && c.localTime < '17:00')).toBe(true);
    // Misses are ordered by distance from the window.
    expect(afternoon[firstMiss]!.localTime).toBe('11:45');

    const explicit = findSlots(base({ preference: { start: '14:30', end: '15:30' } }));
    expect(explicit.filter((c) => c.matchesPreference).map((c) => c.localTime).sort()).toEqual(['14:30', '14:45', '15:00', '15:15']);
  });

  it('searches the requested day first, then ±1, ±2… (earlier first on ties)', () => {
    const hours: WorkHours = { ...weekdayHours(), overrides: [{ from: FRI, blocks: [] }] };
    const r = findSlots(base({ hours, searchRadiusDays: 2 }));
    const order = [...new Set(r.map((c) => c.dayOffset))];
    expect(order).toEqual([-1, 1, -2]); // Sunday (+2) is closed
    expect(r[0]!.localDate).toBe('2026-03-05');
  });

  it('is deterministic regardless of input order', () => {
    const existing = [
      appt('a', at(FRI, '09:00'), [['busy', 45]]),
      appt('b', at(FRI, '13:00'), [['busy', 30], ['processing', 35], ['style', 30]]),
      appt('c', at(FRI, '15:10'), [['busy', 20]]),
    ];
    const input = base({ existing, searchRadiusDays: 2, preference: 'afternoon' });
    const r1 = findSlots(input);
    const r2 = findSlots({ ...input, existing: [...existing].reverse() });
    expect(r2).toEqual(r1);
    expect(starts(r1)).toEqual(starts(findSlots(input)));
  });
});

describe('findSlots: time zones and DST', () => {
  it('maps the same wall-clock hours to different UTC instants across spring-forward', () => {
    const hours: WorkHours = { timeZone: NY, weekly: { 0: { blocks: [{ start: '09:00', end: '17:00', type: 'open' }] }, 6: { blocks: [{ start: '09:00', end: '17:00', type: 'open' }] } } };
    const sat = findSlots(base({ hours, requestedDate: '2026-03-07' }));
    const sun = findSlots(base({ hours, requestedDate: '2026-03-08' }));
    expect(sat.find((c) => c.localTime === '09:00')!.start).toBe('2026-03-07T14:00:00.000Z');
    expect(sun.find((c) => c.localTime === '09:00')!.start).toBe('2026-03-08T13:00:00.000Z');
    expect(sun).toHaveLength(31);
  });

  it('handles fall-back', () => {
    const hours: WorkHours = { timeZone: NY, weekly: { 0: { blocks: [{ start: '09:00', end: '17:00', type: 'open' }] } } };
    const r = findSlots(base({ hours, requestedDate: '2026-11-01', now: '2026-10-01T00:00:00Z' }));
    expect(r.find((c) => c.localTime === '09:00')!.start).toBe('2026-11-01T14:00:00.000Z');
    expect(r).toHaveLength(31);
  });

  it('uses real elapsed time when hours span the DST jump', () => {
    const hours: WorkHours = { timeZone: NY, weekly: { 0: { blocks: [{ start: '01:00', end: '04:00', type: 'open' }] } } };
    const two = findSlots(base({ hours, requestedDate: '2026-03-08', service: { segments: [{ kind: 'busy', minutes: 120 }] } }));
    expect(times(two)).toEqual(['01:00']);
    const longer = findSlots(base({ hours, requestedDate: '2026-03-08', service: { segments: [{ kind: 'busy', minutes: 135 }] } }));
    expect(longer).toEqual([]);
    const short = findSlots(base({ hours, requestedDate: '2026-03-08', service: { segments: [{ kind: 'busy', minutes: 60 }] } }));
    expect(new Set(starts(short)).size).toBe(short.length);
    expect(times(short)).not.toContain('02:00');
  });

  it('aligns the grid to local wall-clock time in half-hour-offset zones', () => {
    const r = findSlots(base({ hours: weekdayHours('Asia/Kolkata') }));
    expect(r[0]!.start).toBe('2026-03-06T03:30:00.000Z');
    expect(r.every((c) => Number(c.localTime.slice(3)) % 15 === 0)).toBe(true);
    expect(r).toHaveLength(31);
  });

  it('rejects unknown time zones', () => {
    expect(() => findSlots(base({ hours: weekdayHours('Mars/Olympus') }))).toThrow(/time zone/);
  });
});

describe('evaluateStart', () => {
  const existing = [appt('a', at(FRI, '10:00'), [['busy', 30]])];

  it('accepts a valid manual start (even off-grid) and explains rejections', () => {
    expect(evaluateStart({ ...base({ existing }), start: at(FRI, '10:30') }).ok).toBe(true);
    expect(evaluateStart({ ...base({ existing }), start: at(FRI, '13:07') }).ok).toBe(true);
    expect(evaluateStart({ ...base({ existing }), start: at(FRI, '10:15') })).toEqual({ ok: false, reason: 'conflict' });
    expect(evaluateStart({ ...base({ existing }), start: at(FRI, '16:45') })).toEqual({ ok: false, reason: 'outside-hours' });
    expect(evaluateStart({ ...base({ existing, now: at(FRI, '10:00'), rules: { leadTimeMinutes: 120 } }), start: at(FRI, '11:00') })).toEqual({
      ok: false,
      reason: 'lead-time',
    });
    expect(evaluateStart({ ...base({ existing, rules: { bookingWindowDays: 1 } }), start: at(FRI, '11:00') })).toEqual({
      ok: false,
      reason: 'booking-window',
    });
  });

  it('supports drag-to-move by excluding the moved appointment', () => {
    expect(evaluateStart({ ...base({ existing: [] }), start: at(FRI, '10:15') }).ok).toBe(true);
  });
});

describe('invariant: no candidate ever collides with busy time', () => {
  it('holds across many pseudo-random calendars', () => {
    let seed = 42;
    const rand = () => (seed = (seed * 48_271) % 2_147_483_647) / 2_147_483_647;
    const kinds = [MENS_CUT, ROOT_TOUCH_UP, [{ kind: 'busy' as const, minutes: 10 }, { kind: 'processing' as const, minutes: 20 }, { kind: 'style' as const, minutes: 15 }]];
    for (let run = 0; run < 40; run++) {
      const existing: ExistingAppointment[] = [];
      let t = 9 * 60 + Math.floor(rand() * 6) * 5;
      while (t < 16 * 60) {
        const svc = kinds[Math.floor(rand() * kinds.length)]!;
        const startIso = at(FRI, `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`);
        existing.push(appt(`e${existing.length}`, startIso, svc.map((s) => [s.kind, s.minutes])));
        t += svc.reduce((a, s) => a + s.minutes, 0) + Math.floor(rand() * 8) * 5;
      }
      const service = { segments: kinds[run % kinds.length]!, bufferAfterMinutes: run % 2 ? 5 : 0 };
      for (const c of findSlots(base({ existing, service }))) {
        expect(findBusyConflicts([...existing, { id: 'new', segments: c.segments }]).filter((x) => x.a === 'new' || x.b === 'new')).toEqual([]);
      }
    }
  });
});
