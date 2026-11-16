import type { AssistantCard, DraftCard, SlotOption, SlotsCard } from '@chairside/ai/assistant';

/**
 * What a suggested slot looks like now that the conversation has moved on:
 * - `open`: still bookable from this card
 * - `held` / `booked`: this slot became the draft / confirmed appointment
 * - `taken`: another live draft overlaps it, or this card already produced a booking
 */
export type SlotState = 'open' | 'held' | 'booked' | 'taken';

/** Latest version of every draft shown in the chat (cards are replaced in place, but be safe). */
export function latestDrafts(cards: AssistantCard[]): DraftCard[] {
  const byId = new Map<string, DraftCard>();
  for (const c of cards) if (c.type === 'draft') byId.set(c.appointmentId, c);
  return [...byId.values()];
}

const overlaps = (a: { start: string; end: string }, b: { start: string; end: string }) =>
  Date.parse(a.start) < Date.parse(b.end) && Date.parse(b.start) < Date.parse(a.end);

const cardSlots = (card: SlotsCard) => card.days.flatMap((d) => d.slots);

/** The live (held or confirmed) draft that was picked from this card, if any. */
function pickedDraft(card: SlotsCard, live: DraftCard[]): DraftCard | undefined {
  if (!card.client) return undefined;
  const starts = new Set(cardSlots(card).map((s) => s.start));
  return live.find((d) => d.client.id === card.client!.id && starts.has(d.start));
}

/**
 * Slot chips are a snapshot from when the assistant searched. Once a slot is held or booked the
 * card must stop offering it (and its siblings) so a second tap can't double-book.
 */
export function slotStates(card: SlotsCard, drafts: DraftCard[]): Map<string, SlotState> {
  const live = drafts.filter((d) => d.status !== 'cancelled');
  const picked = pickedDraft(card, live);
  const states = new Map<string, SlotState>();
  for (const slot of cardSlots(card)) states.set(slot.start, slotState(slot, live, picked));
  return states;
}

function slotState(slot: SlotOption, live: DraftCard[], picked: DraftCard | undefined): SlotState {
  if (picked && picked.start === slot.start)
    return picked.status === 'confirmed' ? 'booked' : 'held';
  if (picked) return 'taken';
  return live.some((d) => overlaps(slot, d)) ? 'taken' : 'open';
}
