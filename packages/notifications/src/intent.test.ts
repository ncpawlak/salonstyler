import { describe, expect, it } from 'vitest';

import { CATEGORY_ACTIONS, DEFAULT_ACTION_ID, NOTIFICATION_CATEGORIES } from './categories.ts';
import { notificationIntent } from './intent.ts';

const request = { type: 'request', salonId: 's1', appointmentId: 'a1' };
const nudge = { type: 'request_nudge', salonId: 's1', appointmentId: 'a1' };

describe('notification categories', () => {
  it('uses ids expo-notifications accepts', () => {
    for (const id of Object.values(NOTIFICATION_CATEGORIES)) expect(id).toMatch(/^[A-Za-z0-9_]+$/);
  });

  it('offers Approve / Other time / Decline on requests and Respond / Ignore on nudges', () => {
    expect(CATEGORY_ACTIONS.appointmentRequest.map((a) => a.buttonTitle)).toEqual([
      'Approve',
      'Other time',
      'Decline',
    ]);
    expect(CATEGORY_ACTIONS.requestNudge.map((a) => a.buttonTitle)).toEqual(['Respond', 'Ignore']);
  });
});

describe('notificationIntent', () => {
  it('approves, declines and ignores from the lock screen', () => {
    expect(notificationIntent('approve', request)).toEqual({
      kind: 'approve',
      appointmentId: 'a1',
    });
    expect(notificationIntent('decline', request)).toEqual({
      kind: 'decline',
      appointmentId: 'a1',
    });
    expect(notificationIntent('ignore', nudge)).toEqual({ kind: 'ignore', appointmentId: 'a1' });
  });

  it('opens the request for Other time, Respond or a plain tap', () => {
    for (const action of ['otherTime', 'respond', DEFAULT_ACTION_ID, null]) {
      expect(notificationIntent(action, nudge)).toEqual({ kind: 'open', href: '/requests/a1' });
    }
  });

  it('opens Today for the agenda and the calendar for cancellations', () => {
    expect(notificationIntent(DEFAULT_ACTION_ID, { type: 'daily_agenda' })).toEqual({
      kind: 'open',
      href: '/',
    });
    expect(
      notificationIntent(DEFAULT_ACTION_ID, { type: 'cancellation', appointmentId: 'a1' }),
    ).toEqual({
      kind: 'open',
      href: '/calendar',
    });
  });

  it('opens Settings → Payments for the evening payout summary', () => {
    expect(
      notificationIntent(DEFAULT_ACTION_ID, { type: 'payout_summary', salonId: 's1' }),
    ).toEqual({ kind: 'open', href: '/settings/payments' });
  });

  it('ignores malformed payloads and unknown actions', () => {
    expect(notificationIntent('approve', null)).toEqual({ kind: 'none' });
    expect(notificationIntent('approve', { type: 'cancellation', appointmentId: 'a1' })).toEqual({
      kind: 'none',
    });
    expect(notificationIntent('somethingElse', request)).toEqual({ kind: 'none' });
  });
});
