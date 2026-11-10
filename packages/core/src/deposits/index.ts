/**
 * Optional deposits + cancellation policy (#12). Mirrors the SQL in
 * supabase/migrations/20261109340000_deposits.sql (private.deposit_due_cents and
 * private.cancellation_quote) so the app can preview what the database will decide.
 */

export type DepositKind = 'none' | 'flat' | 'percent';

export type DepositStatus = 'pending' | 'paid' | 'refund_due' | 'refunded' | 'kept' | 'canceled';

/** Stripe's card minimum in the smallest unit; smaller deposits are skipped. */
export const MIN_DEPOSIT_CENTS = 50;
export const MAX_DEPOSIT_CENTS = 10_000_000;
export const DEFAULT_CANCELLATION_WINDOW_HOURS = 24;
export const MAX_CANCELLATION_WINDOW_HOURS = 336;

export interface ServiceDeposit {
  depositKind: DepositKind;
  /** Cents for `flat`, 1–100 for `percent`, 0 for `none`. */
  depositValue: number;
  priceCents: number | null;
}

/** Deposit for one service, in cents (before the card minimum is applied). */
export function serviceDepositCents(service: ServiceDeposit): number {
  switch (service.depositKind) {
    case 'flat':
      return Math.max(0, Math.round(service.depositValue));
    case 'percent':
      return Math.round(((service.priceCents ?? 0) * service.depositValue) / 100);
    default:
      return 0;
  }
}

/** Deposit owed for a booking: the sum per service, or 0 below the card minimum. */
export function depositForServices(services: readonly ServiceDeposit[]): number {
  const total = services.reduce((sum, s) => sum + serviceDepositCents(s), 0);
  return total < MIN_DEPOSIT_CENTS ? 0 : Math.min(total, MAX_DEPOSIT_CENTS);
}

/** Returns an error message, or null when the service's deposit settings are valid. */
export function validateServiceDeposit(kind: DepositKind, value: number): string | null {
  if (!Number.isInteger(value)) return 'Enter a whole number.';
  if (kind === 'none') return value === 0 ? null : 'No deposit means a value of 0.';
  if (kind === 'percent') {
    return value >= 1 && value <= 100 ? null : 'A percentage deposit is 1–100%.';
  }
  if (value < MIN_DEPOSIT_CENTS) return 'A deposit must be at least 0.50.';
  if (value > MAX_DEPOSIT_CENTS) return 'That deposit is too large.';
  return null;
}

export type CancellationOutcome = 'free' | 'refund' | 'keep';

export interface CancellationInput {
  startsAt: Date | string;
  now?: Date;
  windowHours: number;
  depositStatus: DepositStatus | null;
}

export interface CancellationQuote {
  freeUntil: Date;
  late: boolean;
  /**
   * free: nothing paid (or already settled), just cancel; refund: paid and cancelled in time;
   * keep: paid and inside the window, so the deposit is the cancellation fee.
   */
  outcome: CancellationOutcome;
}

/** What cancelling now does with the deposit under the salon's policy. */
export function cancellationOutcome(input: CancellationInput): CancellationQuote {
  const startsAt = new Date(input.startsAt);
  const now = input.now ?? new Date();
  const freeUntil = new Date(startsAt.getTime() - input.windowHours * 3_600_000);
  const late = now.getTime() >= freeUntil.getTime();
  const outcome: CancellationOutcome =
    input.depositStatus !== 'paid' ? 'free' : late ? 'keep' : 'refund';
  return { freeUntil, late, outcome };
}

/** One-line policy for pay pages, replies and settings. */
export function policySummary(windowHours: number): string {
  if (windowHours <= 0) {
    return 'Your deposit is refunded if you cancel any time before your appointment.';
  }
  const span =
    windowHours % 24 === 0 && windowHours >= 48
      ? `${windowHours / 24} days`
      : `${windowHours} hour${windowHours === 1 ? '' : 's'}`;
  return `Free cancellation up to ${span} before your appointment. After that, or if you miss it, the deposit is kept.`;
}

export function depositStatusLabel(status: DepositStatus): string {
  switch (status) {
    case 'pending':
      return 'Deposit due';
    case 'paid':
      return 'Deposit paid';
    case 'refund_due':
      return 'Refund due';
    case 'refunded':
      return 'Deposit refunded';
    case 'kept':
      return 'Deposit kept';
    case 'canceled':
      return 'Deposit canceled';
  }
}
