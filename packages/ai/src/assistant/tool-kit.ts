import {
  addDays,
  formatDuration,
  formatLocalDate,
  parseLocalDate,
  toSalonDate,
  type SlotCandidate,
} from '@chairside/core';
import type { AppointmentWithDetails } from '@chairside/db/appointments';
import { z } from 'zod';

import type { JsonSchema } from '../types.ts';
import { resolveItems, usualItems } from './menu.ts';
import type {
  AssistantCard,
  AssistantClient,
  AssistantPort,
  BookingItem,
  DraftCard,
} from './types.ts';

/** Shared building blocks for the assistant's tools (one tool per file in `./tools/`). */

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const DRAFT_NOTE = 'Drafted by Ask Chairside';

export interface ToolContext {
  port: AssistantPort;
  now: () => number;
}

export interface ToolOutput {
  /** Sent back to the model as the tool message (JSON). */
  result: unknown;
  card?: AssistantCard;
}

export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

export interface AssistantTool<N extends string = string, S extends z.ZodType = z.ZodType> {
  name: N;
  /** Position in the tool list the model sees (ascending). */
  order: number;
  description: string;
  /** JSON Schema the model sees. Kept by hand so descriptions read well for every provider. */
  parameters: JsonSchema;
  /** Validates the model's arguments before `handler` runs. */
  schema: S;
  handler: (ctx: ToolContext, args: z.infer<S>) => Promise<ToolOutput>;
}

/** Declares a tool. Export it as the default of a file in `./tools/`, then run `npm run gen:tools`. */
export const defineTool = <N extends string, S extends z.ZodType>(
  tool: AssistantTool<N, S>,
): AssistantTool<N, S> => tool;

// ---------------------------------------------------------------------------------------------
// Formatting (salon time zone)
// ---------------------------------------------------------------------------------------------

export const formatTime = (iso: string | number, timeZone: string) =>
  new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone });

/** "Fri, Dec 18" for a local `YYYY-MM-DD`. */
export function formatDayLabel(date: string): string {
  const d = parseLocalDate(date);
  return new Date(Date.UTC(d.year, d.month - 1, d.day, 12)).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export const shiftDate = (date: string, days: number) =>
  formatLocalDate(addDays(parseLocalDate(date), days));

// ---------------------------------------------------------------------------------------------
// Argument schemas
// ---------------------------------------------------------------------------------------------

export const localDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((s) => {
    try {
      parseLocalDate(s);
      return true;
    } catch {
      return false;
    }
  }, 'Not a real date');
const itemSchema = z.object({
  serviceId: z.string().min(1),
  variantId: z.string().min(1).nullish(),
});
export const itemsSchema = z.array(itemSchema).min(1).max(5);

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

export async function requireClient(port: AssistantPort, id: string): Promise<AssistantClient> {
  const client = await port.getClient(id);
  if (!client) throw new ToolError('unknown_client', 'No client with that id. Call find_client.');
  return client;
}

export async function itemsFor(
  port: AssistantPort,
  clientId: string | null | undefined,
  given: BookingItem[] | null | undefined,
) {
  const [menu, overrides] = await Promise.all([
    port.getMenu(),
    clientId ? port.clientOverrides(clientId) : [],
  ]);
  let items = given ?? null;
  if (!items && clientId) items = usualItems(menu, await port.clientVisits(clientId, 10));
  if (!items) {
    throw new ToolError(
      'service_required',
      'No service given and the client has no booking history. Ask which service (see list_services).',
    );
  }
  try {
    return { items, resolved: resolveItems(menu, items, overrides) };
  } catch (e) {
    throw new ToolError('unknown_service', (e as Error).message);
  }
}

export const toExisting = (appointments: AppointmentWithDetails[]) =>
  appointments.map((a) => ({ id: a.id, segments: a.segments }));

/** Picks up to `n` well-spread, high-scoring slots for one day, returned in time order. */
export function pickSpread(candidates: SlotCandidate[], n: number): SlotCandidate[] {
  const byScore = [...candidates].sort(
    (a, b) => b.score - a.score || Date.parse(a.start) - Date.parse(b.start),
  );
  const picked: SlotCandidate[] = [];
  for (const minGap of [90, 45, 0]) {
    for (const c of byScore) {
      if (picked.length >= n) break;
      if (picked.includes(c)) continue;
      const t = Date.parse(c.start);
      if (picked.every((p) => Math.abs(Date.parse(p.start) - t) >= minGap * 60_000)) picked.push(c);
    }
  }
  return picked.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

export function draftCard(
  appointment: AppointmentWithDetails,
  timeZone: string,
  client: { id: string; name: string },
): DraftCard {
  const date = toSalonDate(appointment.starts_at, timeZone);
  const minutes = Math.round(
    (Date.parse(appointment.ends_at) - Date.parse(appointment.starts_at)) / 60_000,
  );
  const names = appointment.services.map((s) =>
    s.variantName ? `${s.name} (${s.variantName})` : s.name,
  );
  return {
    type: 'draft',
    appointmentId: appointment.id,
    client,
    items: appointment.services.map((s) => ({
      serviceId: s.serviceId,
      variantId: s.variantId ?? null,
    })),
    start: new Date(appointment.starts_at).toISOString(),
    end: new Date(appointment.ends_at).toISOString(),
    label: `${formatDayLabel(date)} · ${formatTime(appointment.starts_at, timeZone)}`,
    serviceSummary: `${names.join(' + ')} · ${formatDuration(minutes)}`,
    status:
      appointment.status === 'held'
        ? 'held'
        : appointment.status === 'cancelled'
          ? 'cancelled'
          : 'confirmed',
    holdExpiresAt: appointment.hold_expires_at,
    requiresApproval: false,
  };
}
