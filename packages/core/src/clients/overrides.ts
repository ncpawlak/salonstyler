/**
 * Per-client duration overrides ("Karina's color +20m"). See docs/PLAN.md §11 and issue #13.
 *
 * An override belongs to one client and one menu item (service or combo). The resolvers apply it
 * through `ResolveOptions.clientAdjustment`, so every booking path (booking sheet, Ask Chairside)
 * books the longer time without anyone remembering to add it.
 */
import type { ClientDurationAdjustment } from '../services/types.ts';

/** Hard limit on an override, mirrored by the `client_service_overrides` check constraint. */
export const MAX_OVERRIDE_MINUTES = 240;

export interface ClientServiceOverride extends ClientDurationAdjustment {
  /** `services.id` of the service or combo. */
  serviceId: string;
}

/** The client's adjustment for a menu item, or null. */
export function overrideFor(
  overrides: readonly ClientServiceOverride[] | null | undefined,
  serviceId: string,
): ClientDurationAdjustment | null {
  const o = overrides?.find((x) => x.serviceId === serviceId);
  if (!o || o.deltaMinutes === 0) return null;
  return { deltaMinutes: o.deltaMinutes, segmentIndex: o.segmentIndex ?? null };
}

/** 20 -> "+20m", -15 -> "−15m", 75 -> "+1h15". */
export function formatOverride(deltaMinutes: number): string {
  const m = Math.abs(Math.round(deltaMinutes));
  const body = m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
  return `${deltaMinutes < 0 ? '−' : '+'}${body}`;
}

/** One past visit: how much longer (or shorter) than the menu time it was booked for. */
export interface DurationSample {
  /** ISO start, used to keep only the most recent visits. */
  startsAt: string;
  /** Booked client minutes minus the service's standard minutes (variant included). */
  deltaMinutes: number;
}

export interface OverrideSuggestion {
  deltaMinutes: number;
  /** How many recent visits the suggestion is based on. */
  visits: number;
}

export interface SuggestOverrideOptions {
  /** The override already saved for this client and service (0 if none). */
  currentDeltaMinutes?: number;
  /** Only the most recent visits count. Default 5. */
  recentVisits?: number;
  /** Minimum visits before suggesting anything. Default 2. */
  minVisits?: number;
  /** Ignore differences smaller than this. Default 10. */
  minDeltaMinutes?: number;
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Suggests an override from history: the median difference of the recent visits, rounded to 5
 * minutes, when it's consistent (at least two thirds of the visits ran over/under by 5+ minutes in
 * the same direction) and differs from what's already saved. Returns null otherwise.
 */
export function suggestDurationOverride(
  samples: readonly DurationSample[],
  options: SuggestOverrideOptions = {},
): OverrideSuggestion | null {
  const {
    currentDeltaMinutes = 0,
    recentVisits = 5,
    minVisits = 2,
    minDeltaMinutes = 10,
  } = options;
  const recent = [...samples]
    .filter((s) => Number.isFinite(s.deltaMinutes))
    .sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt))
    .slice(0, recentVisits);
  if (recent.length < minVisits) return null;

  const deltas = recent.map((s) => s.deltaMinutes);
  const rounded = Math.max(
    -MAX_OVERRIDE_MINUTES,
    Math.min(MAX_OVERRIDE_MINUTES, Math.round(median(deltas) / 5) * 5),
  );
  if (Math.abs(rounded) < minDeltaMinutes) return null;
  const agree = deltas.filter((d) => Math.sign(d) === Math.sign(rounded) && Math.abs(d) >= 5);
  if (agree.length * 3 < recent.length * 2) return null;
  if (Math.abs(rounded - currentDeltaMinutes) < 5) return null;
  return { deltaMinutes: rounded, visits: recent.length };
}
