import type { AppointmentWithDetails } from '@chairside/db/appointments';
import type { CapturedRequestWithDetails } from '@chairside/db/inbox';
import { describe, expect, it } from 'vitest';

import { mergeInbox } from './merge';

const request = (id: string, appointmentId: string | null) =>
  ({ id, appointment_id: appointmentId }) as CapturedRequestWithDetails;
const appointment = (id: string) => ({ id }) as AppointmentWithDetails;

describe('mergeInbox', () => {
  it('lists captured texts first and each held slot once', () => {
    const items = mergeInbox(
      [request('r1', 'a1'), request('r2', null)],
      [appointment('a1'), appointment('a2')],
    );
    expect(items.map((i) => `${i.kind}:${i.id}`)).toEqual([
      'captured:r1',
      'captured:r2',
      'appointment:a2',
    ]);
  });

  it('is empty when nothing is waiting', () => {
    expect(mergeInbox([], [])).toEqual([]);
  });
});
