import {
  addDays,
  findSlots,
  formatLocalDate,
  getWorkingBlocks,
  parseLocalDate,
  planBooking,
  resolveService,
  toSalonDate,
  type BookingSegment,
  type SlotCandidate,
  type TimeOfDay,
} from '@chairside/core';
import type { AppointmentServiceSnapshot } from '@chairside/db/appointments';
import type { ServiceMenu } from '@chairside/db/services';

import { resolveItems } from '../assistant/menu.ts';
import { formatDayLabel, formatTime, pickSpread } from '../assistant/tools.ts';
import type { BookingItem, SlotDay } from '../assistant/types.ts';
import type { PublicBookingPort, PublicService, PublicSlotsCard } from './types.ts';

const DAY = 86_400_000;

/** Reasons a client-facing booking step fails; the message is safe to show. */
export class PublicBookingError extends Error {
  constructor(
    readonly code: 'unknown_service' | 'slot_unavailable' | 'invalid_date',
    message: string,
  ) {
    super(message);
    this.name = 'PublicBookingError';
  }
}

const shiftDate = (date: string, days: number) =>
  formatLocalDate(addDays(parseLocalDate(date), days));

const isPublic = (s: { bookableOnline: boolean; archivedAt: string | null }) =>
  s.bookableOnline && !s.archivedAt;

/** The services and combos a stranger may book. Add-ons are owner-only for now. */
export function publicMenu(menu: ServiceMenu): PublicService[] {
  const services = menu.services.filter(isPublic).map((s): PublicService => ({
    id: s.id,
    name: s.name,
    category: s.category ?? null,
    description: s.description ?? null,
    priceCents: s.priceCents ?? null,
    minutes: resolveService(s).totalMinutes,
    combo: false,
    consultationRequired: s.consultationRequired,
    newClientsOnly: s.newClientsOnly,
    variants: s.variants.flatMap((v) =>
      v.id
        ? [{ id: v.id, name: v.name, minutes: resolveService(s, { variant: v }).totalMinutes }]
        : [],
    ),
  }));
  const combos = menu.combos.filter(isPublic).flatMap((c): PublicService[] => {
    try {
      return [
        {
          id: c.id,
          name: c.name,
          category: c.category ?? null,
          description: c.description ?? null,
          priceCents: c.priceCents ?? null,
          minutes: resolveItems(menu, [{ serviceId: c.id }]).totalMinutes,
          combo: true,
          consultationRequired: c.consultationRequired,
          newClientsOnly: c.newClientsOnly,
          variants: [],
        },
      ];
    } catch {
      // A combo whose parts were removed can't be booked.
      return [];
    }
  });
  return [...services, ...combos];
}

/**
 * Resolves items a client picked, accepting only public menu items. Variants must belong to the
 * service. Client duration overrides are owner knowledge and are never applied here.
 */
export function resolvePublicItems(menu: ServiceMenu, items: readonly BookingItem[]) {
  const allowed = new Map(publicMenu(menu).map((s) => [s.id, s]));
  for (const item of items) {
    const service = allowed.get(item.serviceId);
    if (!service) {
      throw new PublicBookingError('unknown_service', 'That service can’t be booked online.');
    }
    if (item.variantId && !service.variants.some((v) => v.id === item.variantId)) {
      throw new PublicBookingError('unknown_service', 'That option isn’t available.');
    }
  }
  const resolved = resolveItems(menu, items);
  return {
    ...resolved,
    consultationRequired: items.some((i) => allowed.get(i.serviceId)!.consultationRequired),
  };
}

export interface PublicSlotsInput {
  items: BookingItem[];
  /** Local `YYYY-MM-DD`. */
  date: string;
  radiusDays?: number;
  timeOfDay?: TimeOfDay | null;
  perDay?: number;
}

/**
 * Open slots from the engine for the public page (and the concierge). Only start times leave
 * the server: no client names or appointment details.
 */
export async function publicSlots(
  port: PublicBookingPort,
  salonId: string,
  input: PublicSlotsInput,
  now: number,
): Promise<PublicSlotsCard> {
  try {
    parseLocalDate(input.date);
  } catch {
    throw new PublicBookingError('invalid_date', 'Pick a valid date.');
  }
  const menu = await port.getMenu(salonId);
  const resolved = resolvePublicItems(menu, input.items);
  const radius = input.radiusDays ?? 3;
  const schedule = await port.getSchedule(salonId, {
    from: shiftDate(input.date, -radius),
    to: shiftDate(input.date, radius),
  });
  const { timeZone } = schedule.hours;
  const base = Date.parse(`${input.date}T12:00:00Z`);
  const existing = await port.listBusy(salonId, {
    from: new Date(base - (radius + 2) * DAY).toISOString(),
    to: new Date(base + (radius + 2) * DAY).toISOString(),
  });
  const candidates = findSlots({
    service: resolved.service,
    hours: schedule.hours,
    requestedDate: input.date,
    searchRadiusDays: radius,
    ...(input.timeOfDay ? { preference: input.timeOfDay } : {}),
    existing,
    rules: schedule.rules,
    now,
  });

  const byDate = new Map<string, SlotCandidate[]>();
  for (const c of candidates) {
    if (input.timeOfDay && !c.matchesPreference) continue;
    byDate.set(c.localDate, [...(byDate.get(c.localDate) ?? []), c]);
  }
  const days: SlotDay[] = [];
  for (let offset = -radius; offset <= radius; offset++) {
    const date = shiftDate(input.date, offset);
    const found = byDate.get(date);
    if (!found && offset !== 0) continue;
    days.push({
      date,
      label: formatDayLabel(date),
      dayOffset: offset,
      slots: pickSpread(found ?? [], input.perDay ?? 6).map((c) => ({
        start: c.start,
        end: c.end,
        time: formatTime(c.start, timeZone),
        requiresApproval: c.requiresApproval || resolved.consultationRequired,
      })),
    });
  }
  // The requested day first, then the nearest alternatives.
  days.sort((a, b) => Math.abs(a.dayOffset) - Math.abs(b.dayOffset) || a.dayOffset - b.dayOffset);
  const requested = days[0]!;
  let requestedNote: string | null = null;
  if (requested.slots.length === 0) {
    const blocks = getWorkingBlocks(schedule.hours, input.date);
    requestedNote =
      blocks.status === 'closed'
        ? `Closed on ${requested.label}.`
        : `${requested.label} is fully booked for this service.`;
  }
  return {
    type: 'slots',
    items: input.items,
    serviceSummary: resolved.summary,
    requestedDate: input.date,
    requestedNote,
    days,
  };
}

export interface PlannedPublicBooking {
  segments: BookingSegment[];
  services: AppointmentServiceSnapshot[];
  priceCents: number | null;
  start: string;
  end: string;
  serviceSummary: string;
  label: string;
  /** Tentative hours or a consultation service: the owner approves it first. */
  requiresApproval: boolean;
}

/**
 * Re-checks a slot the client picked with the engine before anything is written: it must be an
 * open slot right now (inside hours, after the lead time, within the booking window, no overlap).
 */
export async function planPublicBooking(
  port: PublicBookingPort,
  salonId: string,
  input: { items: BookingItem[]; start: string },
  now: number,
): Promise<PlannedPublicBooking> {
  const start = Date.parse(input.start);
  if (Number.isNaN(start)) throw new PublicBookingError('invalid_date', 'Pick a time.');
  const menu = await port.getMenu(salonId);
  const resolved = resolvePublicItems(menu, input.items);
  const schedule = await port.getSchedule(salonId, {
    from: toSalonDate(start - 2 * DAY, 'UTC'),
    to: toSalonDate(start + 2 * DAY, 'UTC'),
  });
  const existing = await port.listBusy(salonId, {
    from: new Date(start - DAY).toISOString(),
    to: new Date(start + DAY).toISOString(),
  });
  const plan = planBooking({
    service: resolved.service,
    start,
    hours: schedule.hours,
    existing,
    rules: schedule.rules,
    now,
  });
  if (!plan.ok || plan.warning) {
    throw new PublicBookingError(
      'slot_unavailable',
      'That time was just taken or is no longer available. Pick another time.',
    );
  }
  const { timeZone } = schedule.hours;
  return {
    segments: plan.segments,
    services: resolved.snapshots,
    priceCents: resolved.service.priceCents ?? null,
    start: plan.start,
    end: plan.end,
    serviceSummary: resolved.summary,
    label: `${formatDayLabel(toSalonDate(plan.start, timeZone))} · ${formatTime(plan.start, timeZone)}`,
    requiresApproval: plan.requiresApproval || resolved.consultationRequired,
  };
}
