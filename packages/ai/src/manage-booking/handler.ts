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
  ManageBookingRow,
  ManageBookingView,
  ManageCancelResponse,
  ManageErrorBody,
  ManageRescheduleResponse,
  ManageSegment,
  ManageSlotDay,
  ManageSlotsResponse,
  ManageViewResponse,
} from '@chairside/db/client-self-service';
import { z } from 'zod';

import { formatDayLabel, formatTime, pickSpread } from '../assistant/tool-kit.ts';
import type { ManageBookingPort } from './types.ts';

/**
 * Hits allowed per window. The token is 256 bits so guessing is hopeless; the IP limits stop
 * scraping, and the per-token limits stop one leaked link from hammering a salon's calendar.
 */
export const MANAGE_LIMITS = {
  view: { limit: 60, windowSeconds: 60 },
  slots: { limit: 60, windowSeconds: 60 },
  changeIp: { limit: 20, windowSeconds: 3600 },
  changeToken: { limit: 6, windowSeconds: 3600 },
} as const;

const DAY = 86_400_000;
const SEARCH_RADIUS_DAYS = 3;
const SLOTS_PER_DAY = 8;

const token = z.string().regex(/^[0-9a-f]{64}$/, 'Invalid link');
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const manageBookingRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('view'), token }),
  z.object({ action: z.literal('slots'), token, date: localDate }),
  z.object({ action: z.literal('cancel'), token }),
  z.object({ action: z.literal('reschedule'), token, start: z.iso.datetime({ offset: true }) }),
]);

export interface ManageBookingDeps {
  port: ManageBookingPort;
  now?: () => number;
}

export type ManageBookingResult =
  | {
      status: 200;
      body:
        ManageViewResponse | ManageSlotsResponse | ManageCancelResponse | ManageRescheduleResponse;
    }
  | { status: 400 | 403 | 404 | 409 | 429 | 500; body: ManageErrorBody };

const fail = (
  status: Exclude<ManageBookingResult['status'], 200>,
  code: string,
  message: string,
): ManageBookingResult => ({ status, body: { error: { code, message } } });

const SLOW_DOWN = 'Too many requests. Please wait a bit and try again.';
const NOT_FOUND = 'This link doesn’t work anymore. Contact the salon to change your appointment.';

const shiftDate = (date: string, days: number) =>
  formatLocalDate(addDays(parseLocalDate(date), days));

/** What the client may see: never the salon/stylist ids or the segment layout. */
export function toView(row: ManageBookingRow): ManageBookingView {
  return {
    status: row.status,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    services: row.services,
    clientFirstName: row.clientFirstName,
    salon: row.salon,
    canCancel: row.canCancel,
    canReschedule: row.canReschedule,
    policyMessage: row.policyMessage,
    feeCents: row.feeCents,
  };
}

/** Segments in time order (the order they're stored and re-laid out in). */
const sortedSegments = (row: ManageBookingRow) =>
  [...row.segments].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));

/** Open-hours slots for the same service shape, around `date`. */
export async function manageSlots(
  port: ManageBookingPort,
  row: ManageBookingRow,
  date: string,
  now: number,
): Promise<ManageSlotsResponse> {
  const { service, start: currentStart } = serviceFromSegments(sortedSegments(row));
  const schedule = await port.getSchedule(row.salonId, {
    from: shiftDate(date, -SEARCH_RADIUS_DAYS),
    to: shiftDate(date, SEARCH_RADIUS_DAYS),
  });
  const base = Date.parse(`${date}T12:00:00Z`);
  const existing = (
    await port.listBusy(row.salonId, {
      from: new Date(base - (SEARCH_RADIUS_DAYS + 2) * DAY).toISOString(),
      to: new Date(base + (SEARCH_RADIUS_DAYS + 2) * DAY).toISOString(),
    })
  ).filter((a) => a.id !== row.appointmentId);
  const candidates = findSlots({
    service,
    hours: schedule.hours,
    requestedDate: date,
    searchRadiusDays: SEARCH_RADIUS_DAYS,
    existing,
    rules: schedule.rules,
    now,
    // Tentative hours need the stylist's approval; the client asks the salon for those.
    includeTentative: false,
  });

  const byDate = new Map<string, SlotCandidate[]>();
  for (const c of candidates) {
    if (c.requiresApproval || Date.parse(c.start) === currentStart) continue;
    byDate.set(c.localDate, [...(byDate.get(c.localDate) ?? []), c]);
  }
  const { timeZone } = schedule.hours;
  const days: ManageSlotDay[] = [];
  for (let offset = -SEARCH_RADIUS_DAYS; offset <= SEARCH_RADIUS_DAYS; offset++) {
    const day = shiftDate(date, offset);
    const found = byDate.get(day);
    if (!found && offset !== 0) continue;
    days.push({
      date: day,
      label: formatDayLabel(day),
      slots: pickSpread(found ?? [], SLOTS_PER_DAY).map((c) => ({
        start: c.start,
        end: c.end,
        time: formatTime(c.start, timeZone),
      })),
    });
  }
  days.sort((a, b) => a.date.localeCompare(b.date));
  return { date, days };
}

/**
 * Lays the same service out at `start` and re-checks it with the engine: it must be an open
 * slot right now (open hours, after the lead time, within the window, no overlap). Labels carry
 * over by position. Null when the time isn't available.
 */
export async function planReschedule(
  port: ManageBookingPort,
  row: ManageBookingRow,
  start: string,
  now: number,
): Promise<ManageSegment[] | null> {
  const startMs = Date.parse(start);
  const current = sortedSegments(row);
  const { service } = serviceFromSegments(current);
  const schedule = await port.getSchedule(row.salonId, {
    from: toSalonDate(startMs - 2 * DAY, 'UTC'),
    to: toSalonDate(startMs + 2 * DAY, 'UTC'),
  });
  const existing = (
    await port.listBusy(row.salonId, {
      from: new Date(startMs - DAY).toISOString(),
      to: new Date(startMs + DAY).toISOString(),
    })
  ).filter((a) => a.id !== row.appointmentId);
  const plan = planBooking({
    service,
    start: startMs,
    hours: schedule.hours,
    existing,
    rules: schedule.rules,
    now,
  });
  if (!plan.ok || plan.warning || plan.requiresApproval) return null;
  if (plan.segments.length !== current.length) return null;
  return plan.segments.map((s, i) => ({ ...s, label: current[i]!.label }));
}

/**
 * The client's manage link API. The token is the only credential: it unlocks exactly one
 * appointment, and nothing returned names other clients or exposes salon internals.
 */
export async function handleManageBookingRequest(
  rawBody: unknown,
  meta: { ip: string },
  deps: ManageBookingDeps,
): Promise<ManageBookingResult> {
  const parsed = manageBookingRequestSchema.safeParse(rawBody);
  if (!parsed.success) return fail(400, 'invalid_request', z.prettifyError(parsed.error));
  const request = parsed.data;
  const now = deps.now ?? (() => Date.now());
  const { port } = deps;
  const limited = async (key: string, rule: { limit: number; windowSeconds: number }) =>
    !(await port.hitRateLimit(key, rule.limit, rule.windowSeconds));

  const change = request.action === 'cancel' || request.action === 'reschedule';
  const ipRule = change ? MANAGE_LIMITS.changeIp : MANAGE_LIMITS[request.action];
  if (await limited(`ip:manage:${request.action}:${meta.ip}`, ipRule)) {
    return fail(429, 'rate_limited', SLOW_DOWN);
  }
  if (change && (await limited(`token:manage:${request.token}`, MANAGE_LIMITS.changeToken))) {
    return fail(429, 'rate_limited', SLOW_DOWN);
  }

  const row = await port.getBooking(request.token);
  if (!row) return fail(404, 'not_found', NOT_FOUND);

  switch (request.action) {
    case 'view':
      return { status: 200, body: { booking: toView(row) } };

    case 'slots': {
      if (!row.canReschedule) {
        return fail(403, 'not_allowed', row.policyMessage ?? 'This appointment can’t be moved.');
      }
      try {
        parseLocalDate(request.date);
      } catch {
        return fail(400, 'invalid_date', 'Pick a valid date.');
      }
      return { status: 200, body: await manageSlots(port, row, request.date, now()) };
    }

    case 'cancel': {
      if (row.status === 'cancelled') {
        return { status: 200, body: { booking: toView(row), feeCents: 0 } };
      }
      if (!row.canCancel) {
        return fail(
          403,
          'not_allowed',
          row.policyMessage ?? 'This appointment can’t be cancelled.',
        );
      }
      const result = await port.cancel(request.token);
      if (!result.ok) return changeFailed(result);
      const after = await port.getBooking(request.token);
      return {
        status: 200,
        body: { booking: toView(after ?? row), feeCents: result.feeCents ?? 0 },
      };
    }

    case 'reschedule': {
      if (!row.canReschedule) {
        return fail(403, 'not_allowed', row.policyMessage ?? 'This appointment can’t be moved.');
      }
      const segments = await planReschedule(port, row, request.start, now());
      if (!segments) {
        return fail(409, 'slot_unavailable', 'That time isn’t available anymore. Pick another.');
      }
      const result = await port.reschedule(request.token, segments);
      if (!result.ok) return changeFailed(result);
      const after = await port.getBooking(request.token);
      return { status: 200, body: { booking: toView(after ?? row) } };
    }
  }
}

function changeFailed(result: { reason: string; message?: string | null }): ManageBookingResult {
  switch (result.reason) {
    case 'not_found':
      return fail(404, 'not_found', NOT_FOUND);
    case 'conflict':
    case 'unavailable':
      return fail(
        409,
        'slot_unavailable',
        result.message ?? 'That time isn’t available anymore. Pick another.',
      );
    case 'invalid':
      return fail(400, 'invalid_request', result.message ?? 'That change isn’t valid.');
    default:
      return fail(
        403,
        result.reason === 'disabled' ? 'disabled' : 'not_allowed',
        result.message ?? 'Contact the salon to change this appointment.',
      );
  }
}
