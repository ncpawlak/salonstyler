import { describe, expect, it } from 'vitest';
import {
  applyBlanketSchedule,
  formatBlocks,
  formatClock12,
  paintDays,
  setTemplateDay,
  withOverride,
  withoutOverride,
} from './paint';
import { getWorkingBlocks } from './resolve';
import {
  buildWorkHours,
  diffOverrides,
  overrideFromRow,
  overrideToRow,
  templateToRows,
} from './rows';
import type { WorkHours, WorkHoursOverride } from './types';

const CHI = 'America/Chicago';
const lunch = [{ start: '12:00', end: '13:00' }];
const OPEN_10_2 = { start: '10:00', end: '14:00' };

function acceptanceHours(): WorkHours {
  let weekly = applyBlanketSchedule(
    {},
    { weekdays: [2, 3, 4, 5, 6], start: '09:00', end: '18:00', breaks: lunch },
  );
  weekly = setTemplateDay(weekly, 0, 'tentative', { start: '10:00', end: '14:00' });
  const base: WorkHours = { timeZone: CHI, weekly };
  return withOverride(base, paintDays(base, 'closed', '2026-12-24', '2026-12-26'));
}

describe('painting work hours', () => {
  it('builds the acceptance schedule from UI actions', () => {
    const h = acceptanceHours();
    expect(getWorkingBlocks(h, '2026-12-22').blocks).toEqual([
      { start: '09:00', end: '12:00', type: 'open' },
      { start: '13:00', end: '18:00', type: 'open' },
    ]);
    expect(getWorkingBlocks(h, '2026-12-27').status).toBe('tentative');
    expect(getWorkingBlocks(h, '2026-12-25')).toMatchObject({
      status: 'closed',
      override: { kind: 'vacation' },
    });
    expect(getWorkingBlocks(h, '2026-12-28').status).toBe('closed');
  });

  it('round-trips through DB rows', () => {
    const h = acceptanceHours();
    const rows = {
      timeZone: CHI,
      template: templateToRows(h.weekly),
      overrides: (h.overrides ?? []).map(overrideToRow),
    };
    expect(rows.template).toHaveLength(7);
    expect(rows.overrides).toEqual([
      {
        start_date: '2026-12-24',
        end_date: '2026-12-26',
        kind: 'vacation',
        blocks: [],
        breaks: [],
        note: null,
      },
    ]);
    const rebuilt = buildWorkHours(rows);
    for (const d of ['2026-12-22', '2026-12-25', '2026-12-27', '2026-12-28']) {
      const { override: _a, ...rebuiltDay } = getWorkingBlocks(rebuilt, d);
      const { override: _b, ...originalDay } = getWorkingBlocks(h, d);
      expect(rebuiltDay).toEqual(originalDay);
    }
    expect(overrideFromRow(rows.overrides[0]!)).toMatchObject({ from: '2026-12-24', blocks: [] });
  });

  it('painting a usual day tentative keeps its hours and lunch', () => {
    const h = acceptanceHours();
    const o = paintDays(h, 'tentative', '2026-07-07');
    expect(o).toMatchObject({ kind: 'custom', breaks: lunch });
    expect(getWorkingBlocks(withOverride(h, o), '2026-07-07').blocks).toEqual([
      { start: '09:00', end: '12:00', type: 'tentative' },
      { start: '13:00', end: '18:00', type: 'tentative' },
    ]);
  });

  it('painting a normally closed day open uses the given range, else 9–5', () => {
    const h = acceptanceHours();
    expect(paintDays(h, 'open', '2026-07-06').blocks).toEqual([
      { start: '09:00', end: '17:00', type: 'open' },
    ]);
    expect(
      paintDays(h, 'open', '2026-07-06', '2026-07-06', { start: '15:00', end: '20:00' }).blocks,
    ).toEqual([{ start: '15:00', end: '20:00', type: 'open' }]);
    expect(paintDays(h, 'closed', '2026-07-06').kind).toBe('day_off');
  });

  it('re-painting replaces; clearing falls back to the template', () => {
    let h = acceptanceHours();
    h = withOverride(h, paintDays(h, 'open', '2026-12-24', '2026-12-26'));
    expect(h.overrides).toHaveLength(1);
    expect(getWorkingBlocks(h, '2026-12-25').status).toBe('open');
    h = withoutOverride(h, '2026-12-24', '2026-12-26');
    expect(h.overrides).toEqual([]);
  });

  it('painting over part of a range splits it, and the result survives a DB round-trip', () => {
    let h = acceptanceHours();
    h = withOverride(h, paintDays(h, 'open', '2026-12-25', '2026-12-25', OPEN_10_2));
    expect((h.overrides as WorkHoursOverride[]).map((o) => [o.from, o.to, o.kind])).toEqual([
      ['2026-12-24', '2026-12-24', 'vacation'],
      ['2026-12-26', '2026-12-26', 'vacation'],
      ['2026-12-25', '2026-12-25', 'custom'],
    ]);
    // A wider range painted later replaces what it covers, even after a reload.
    h = withOverride(h, paintDays(h, 'tentative', '2026-12-20', '2026-12-31'));
    expect(h.overrides).toHaveLength(1);
    h = withOverride(h, paintDays(h, 'closed', '2026-12-28'));
    const rebuilt = buildWorkHours({
      timeZone: CHI,
      template: templateToRows(h.weekly),
      overrides: (h.overrides ?? []).map(overrideToRow),
    });
    for (let d = 18; d <= 31; d++) {
      const date = `2026-12-${d}`;
      expect(getWorkingBlocks(rebuilt, date).blocks).toEqual(getWorkingBlocks(h, date).blocks);
    }
    expect(getWorkingBlocks(rebuilt, '2026-12-28').status).toBe('closed');
    expect(getWorkingBlocks(rebuilt, '2026-12-29').status).toBe('tentative');
  });

  it('clearing part of a range reverts just those days to the template', () => {
    let h = acceptanceHours();
    h = withoutOverride(h, '2026-12-25');
    expect(getWorkingBlocks(h, '2026-12-25').source).toBe('template');
    expect(getWorkingBlocks(h, '2026-12-24').source).toBe('override');
    expect(getWorkingBlocks(h, '2026-12-26').source).toBe('override');
  });

  it('diffs edited overrides against saved rows', () => {
    const saved = [
      { id: 'a', ...overrideToRow({ from: '2026-12-24', to: '2026-12-26', blocks: [] }) },
      { id: 'b', ...overrideToRow({ from: '2027-01-02', blocks: [] }) },
      { id: 'c', ...overrideToRow({ from: '2027-01-03', blocks: [] }) },
    ];
    let h: WorkHours = buildWorkHours({ timeZone: CHI, template: [], overrides: saved });
    expect(diffOverrides(saved, h.overrides ?? [])).toEqual({ upserts: [], deletes: [] });
    h = withOverride(h, paintDays(h, 'open', '2026-12-25', '2026-12-25', OPEN_10_2));
    h = withoutOverride(h, '2027-01-03');
    h = withOverride(h, paintDays(h, 'tentative', '2027-01-02', '2027-01-02', OPEN_10_2));
    const { upserts, deletes } = diffOverrides(saved, h.overrides ?? []);
    expect(deletes.sort()).toEqual(['a', 'c']);
    expect(upserts.map((r) => `${r.start_date}..${r.end_date}:${r.kind}`).sort()).toEqual([
      '2026-12-24..2026-12-24:day_off',
      '2026-12-25..2026-12-25:custom',
      '2026-12-26..2026-12-26:day_off',
      '2027-01-02..2027-01-02:custom',
    ]);
  });

  it('rejects bad input', () => {
    const h = acceptanceHours();
    expect(() => paintDays(h, 'open', '2026-07-08', '2026-07-07')).toThrow();
    expect(() => setTemplateDay({}, 1, 'open', { start: '18:00', end: '09:00' })).toThrow();
    expect(() =>
      applyBlanketSchedule({}, { weekdays: [1], start: '09:00', end: '09:00' }),
    ).toThrow();
  });

  it('formats readable labels', () => {
    expect(formatClock12('09:00')).toBe('9 AM');
    expect(formatClock12('13:30')).toBe('1:30 PM');
    expect(formatClock12('00:00')).toBe('12 AM');
    expect(formatClock12('24:00')).toBe('12 AM');
    expect(
      formatBlocks([
        { start: '09:00', end: '12:00' },
        { start: '13:00', end: '18:00' },
      ]),
    ).toBe('9 AM–12 PM, 1 PM–6 PM');
    expect(formatBlocks([])).toBe('Closed');
  });
});
