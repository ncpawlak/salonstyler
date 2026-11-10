import { addDays, formatLocalDate, parseLocalDate, toSalonDate } from '@chairside/core';
import {
  formatRebookInterval,
  type RebookInterval,
  rebookInterval,
  rebookTargetDate,
} from '@chairside/core/rebook';
import type { NudgeCandidate, RebookNudgeDraft } from '@chairside/db/marketing';

/**
 * "Time for a touch-up?" (#27). The rebook engine from checkout (#42) works out when each client
 * is due back (their own rhythm, else the service's interval); a nudge is drafted `leadDays`
 * before that, and not at all for clients who already have something booked (Postgres filters
 * those out and skips any that book before the nudge goes).
 */

/** A nudge more than this many days past the due date is too late to be useful. */
export const NUDGE_GRACE_DAYS = 30;

export const NUDGE_SUBJECT = 'Time for a touch-up?';

export interface RebookNudgePlan {
  interval: RebookInterval;
  /** Local `YYYY-MM-DD` the client is due back. */
  targetDate: string;
  /** The first local day the nudge may go out. */
  sendFrom: string;
}

/** When the candidate is due back and from when to nudge, or null with nothing to go on. */
export function planRebookNudge(candidate: NudgeCandidate): RebookNudgePlan | null {
  const booked = new Set(candidate.visit.serviceIds);
  const services = candidate.services.filter((s) => booked.has(s.id));
  const interval = rebookInterval(services, candidate.history);
  if (!interval) return null;
  const targetDate = rebookTargetDate(candidate.visit.startsAt, interval.days, candidate.timeZone);
  const sendFrom = formatLocalDate(addDays(parseLocalDate(targetDate), -candidate.leadDays));
  return { interval, targetDate, sendFrom };
}

/** Whether the nudge should be drafted today (salon time). */
export function isNudgeDue(plan: RebookNudgePlan, today: string): boolean {
  const lastDay = formatLocalDate(addDays(parseLocalDate(plan.targetDate), NUDGE_GRACE_DAYS));
  return today >= plan.sendFrom && today <= lastDay;
}

/** "Friday, December 4" for a local date. */
function formatDay(localDate: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(new Date(`${localDate}T12:00:00Z`));
}

/** The default copy; the stylist can edit it before approving. Placeholders are filled on send. */
export function templateNudgeCopy(
  plan: RebookNudgePlan,
  today: string,
): { subject: string; body: string } {
  const service = plan.interval.serviceName;
  const rhythm = formatRebookInterval(plan.interval.days).replace(/^~/, 'about ');
  const when =
    plan.targetDate > today
      ? `so you're due for the next one around ${formatDay(plan.targetDate)}.`
      : `so you're due for the next one.`;
  return {
    subject: NUDGE_SUBJECT,
    body: [
      'Hi {firstName},',
      '',
      `Your ${service} usually lasts ${rhythm}, ${when}`,
      '',
      'Grab a time that works for you: {bookingLink}',
      '',
      'See you soon!',
      '{salonName}',
    ].join('\n'),
  };
}

/** Nudges for the candidates that are due today (each in its salon's time zone). */
export function draftRebookNudges(
  candidates: readonly NudgeCandidate[],
  now: number,
): RebookNudgeDraft[] {
  const drafts: RebookNudgeDraft[] = [];
  for (const candidate of candidates) {
    const plan = planRebookNudge(candidate);
    if (!plan) continue;
    const today = toSalonDate(now, candidate.timeZone);
    if (!isNudgeDue(plan, today)) continue;
    drafts.push({
      clientId: candidate.clientId,
      appointmentId: candidate.visit.appointmentId,
      ...templateNudgeCopy(plan, today),
      meta: {
        serviceName: plan.interval.serviceName,
        intervalDays: plan.interval.days,
        intervalSource: plan.interval.source,
        dueOn: plan.targetDate,
      },
    });
  }
  return drafts;
}
