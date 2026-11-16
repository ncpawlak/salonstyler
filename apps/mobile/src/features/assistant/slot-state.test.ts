import type { DraftCard, SlotsCard } from '@chairside/ai/assistant';
import { describe, expect, it } from 'vitest';

import { latestDrafts, slotStates } from './slot-state';

const KARINA = { id: 'c1', name: 'Karina' };
const slot = (start: string, end: string, time: string) => ({
  start,
  end,
  time,
  requiresApproval: false,
});

const card = (client: SlotsCard['client'] = KARINA): SlotsCard => ({
  type: 'slots',
  client,
  items: [{ serviceId: 's1' }],
  serviceSummary: 'Haircut · 60 min',
  requestedDate: '2026-12-18',
  days: [
    {
      date: '2026-12-18',
      label: 'Fri, Dec 18',
      dayOffset: 0,
      slots: [
        slot('2026-12-18T14:00:00Z', '2026-12-18T15:00:00Z', '9:00 AM'),
        slot('2026-12-18T15:00:00Z', '2026-12-18T16:00:00Z', '10:00 AM'),
        slot('2026-12-18T16:00:00Z', '2026-12-18T17:00:00Z', '11:00 AM'),
      ],
    },
  ],
});

const draft = (over: Partial<DraftCard> = {}): DraftCard => ({
  type: 'draft',
  appointmentId: 'a1',
  client: KARINA,
  items: [{ serviceId: 's1' }],
  start: '2026-12-18T15:00:00Z',
  end: '2026-12-18T16:00:00Z',
  label: 'Fri, Dec 18 · 10:00 AM',
  serviceSummary: 'Haircut · 60 min',
  status: 'held',
  holdExpiresAt: null,
  requiresApproval: false,
  ...over,
});

const states = (c: SlotsCard, drafts: DraftCard[]) => [...slotStates(c, drafts).values()];

describe('slotStates', () => {
  it('leaves every slot open before anything is picked', () => {
    expect(states(card(), [])).toEqual(['open', 'open', 'open']);
  });

  it('marks the booked slot and locks the rest after confirming', () => {
    expect(states(card(), [draft({ status: 'confirmed' })])).toEqual(['taken', 'booked', 'taken']);
  });

  it('shows a held slot and locks siblings while the draft is pending', () => {
    expect(states(card(), [draft()])).toEqual(['taken', 'held', 'taken']);
  });

  it('reopens the card when the hold is released', () => {
    expect(states(card(), [draft({ status: 'cancelled' })])).toEqual(['open', 'open', 'open']);
  });

  it("blocks slots on another client's card that overlap a live booking", () => {
    const other = card({ id: 'c2', name: 'Maya' });
    const booked = draft({
      status: 'confirmed',
      start: '2026-12-18T15:30:00Z',
      end: '2026-12-18T16:30:00Z',
    });
    expect(states(other, [booked])).toEqual(['open', 'taken', 'taken']);
  });
});

describe('latestDrafts', () => {
  it('keeps the newest version of each draft', () => {
    const held = draft();
    const booked = draft({ status: 'confirmed' });
    expect(latestDrafts([held, card(), booked])).toEqual([booked]);
  });
});
