import { describe, expect, it } from 'vitest';

import { describeRequestTimeline, formatHours, nearestOption, toClock } from './format';

describe('notification settings formatting', () => {
  it('formats hour options', () => {
    expect(formatHours(1)).toBe('1 h');
    expect(formatHours(24)).toBe('1 day');
    expect(formatHours(72)).toBe('3 days');
    expect(formatHours(168)).toBe('1 wk');
  });

  it('trims Postgres times for the time stepper', () => {
    expect(toClock('21:00:00')).toBe('21:00');
    expect(toClock('07:30')).toBe('07:30');
  });

  it('snaps custom values to the nearest option', () => {
    expect(nearestOption(24, [1, 12, 24, 48])).toBe(24);
    expect(nearestOption(30, [1, 12, 24, 48])).toBe(24);
    expect(nearestOption(40, [1, 12, 24, 48])).toBe(48);
  });

  it('explains when the nudge and release happen', () => {
    expect(describeRequestTimeline(24, 24)).toBe(
      'If you don’t answer a request, you’re reminded after 1 day. It’s released 1 day after that.',
    );
  });
});
