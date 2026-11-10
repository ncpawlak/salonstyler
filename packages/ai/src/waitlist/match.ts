import {
  addDays,
  findSlots,
  formatLocalDate,
  parseLocalDate,
  planBooking,
  serviceFromSegments,
  toSalonDate,
  type SlotCandidate,
} from '@chairside/core';
import type {
  ClaimedOpening,
  WaitlistLinkRow,
  WaitlistOfferDraft,
  WaitlistSegment,
} from '@chairside/db/waitlist';

import { resolveItems } from '../assistant/menu.ts';
import type { WaitlistPort } from './types.ts';

const DAY = 86_400_000;

/** Offers drafted per cancelled slot; the first to accept gets it. */
export const MAX_OFFERS_PER_OPENING = 5;

const shiftDate = (date: string, days: number) =>
  formatLocalDate(addDays(parseLocalDate(date), days));

/**
 * The engine's fits for one cancelled slot: for each waiting client (oldest first), the open
 * start inside the freed time closest to when it began, for exactly the services they want and
 * inside their window. Open hours only; a client whose services no longer exist is skipped.
 */
export async function matchOpening(
  port: WaitlistPort,
  opening: ClaimedOpening,
  now: number,
): Promise<WaitlistOfferDraft[]> {
  if (opening.entries.length === 0) return [];
  const freedStart = Date.parse(opening.startsAt);
  const freedEnd = Date.parse(opening.endsAt);
  if (freedEnd <= now) return [];

  const [menu, schedule, existing] = await Promise.all([
    port.getMenu(opening.salonId),
    port.getSchedule(opening.salonId, {
      from: shiftDate(opening.day, -1),
      to: shiftDate(opening.day, 1),
    }),
    port.listBusy(opening.salonId, {
      from: new Date(freedStart - DAY).toISOString(),
      to: new Date(freedEnd + DAY).toISOString(),
    }),
  ]);

  const drafts: WaitlistOfferDraft[] = [];
  for (const entry of opening.entries) {
    if (drafts.length >= MAX_OFFERS_PER_OPENING) break;
    let resolved;
    try {
      const overrides = await port.clientOverrides(opening.salonId, entry.clientId);
      resolved = resolveItems(menu, entry.items, overrides);
    } catch {
      continue;
    }
    const window =
      entry.windowStart && entry.windowEnd
        ? { start: entry.windowStart, end: entry.windowEnd }
        : null;
    const fits = findSlots({
      service: resolved.service,
      hours: schedule.hours,
      requestedDate: opening.day,
      searchRadiusDays: 0,
      ...(window ? { preference: window } : {}),
      existing,
      rules: schedule.rules,
      now,
      includeTentative: false,
    }).filter((c) => {
      const start = Date.parse(c.start);
      return (
        c.localDate === opening.day &&
        !c.requiresApproval &&
        (!window || c.matchesPreference) &&
        start >= freedStart &&
        start < freedEnd
      );
    });
    const best = closestTo(fits, freedStart);
    if (!best) continue;

    const plan = planBooking({
      service: resolved.service,
      start: best.start,
      hours: schedule.hours,
      existing,
      rules: schedule.rules,
      now,
    });
    if (!plan.ok || plan.warning || plan.requiresApproval) continue;
    drafts.push({
      entryId: entry.entryId,
      startsAt: plan.start,
      endsAt: plan.end,
      segments: plan.segments.map((s) => ({ ...s, label: null })),
      services: resolved.snapshots,
      priceCents: resolved.service.priceCents ?? null,
    });
  }
  return drafts;
}

function closestTo(candidates: SlotCandidate[], target: number): SlotCandidate | null {
  let best: SlotCandidate | null = null;
  for (const c of candidates) {
    if (!best) {
      best = c;
      continue;
    }
    const d = Math.abs(Date.parse(c.start) - target);
    const bestD = Math.abs(Date.parse(best.start) - target);
    if (d < bestD || (d === bestD && c.score > best.score)) best = c;
  }
  return best;
}

/**
 * Re-checks an offer with the engine before it is booked: the same layout at the offered time
 * must still be an open slot (open hours, no overlap). Null when it isn't.
 */
export async function planAcceptance(
  port: WaitlistPort,
  link: WaitlistLinkRow & { offer: NonNullable<WaitlistLinkRow['offer']> },
  now: number,
): Promise<WaitlistSegment[] | null> {
  const current = [...link.offer.segments].sort(
    (a, b) => Date.parse(a.start) - Date.parse(b.start),
  );
  const { service } = serviceFromSegments(current);
  const start = Date.parse(link.offer.startsAt);
  const [schedule, existing] = await Promise.all([
    port.getSchedule(link.salonId, {
      from: toSalonDate(start - 2 * DAY, 'UTC'),
      to: toSalonDate(start + 2 * DAY, 'UTC'),
    }),
    port.listBusy(link.salonId, {
      from: new Date(start - DAY).toISOString(),
      to: new Date(start + DAY).toISOString(),
    }),
  ]);
  const plan = planBooking({
    service,
    start,
    hours: schedule.hours,
    existing,
    rules: schedule.rules,
    now,
  });
  if (!plan.ok || plan.warning || plan.requiresApproval) return null;
  if (plan.segments.length !== current.length) return null;
  return plan.segments.map((s, i) => ({ ...s, label: current[i]!.label ?? null }));
}
