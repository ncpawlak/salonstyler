import type { CancellationOutcome } from '@chairside/core/deposits';

import type { Database } from './database.types.ts';
import type { Appointment, ChairsideClient, SalonSettings, ServiceRow } from './index.ts';

type PublicSchema = Database['public'];

/** A deposit row as members see it (the pay token is only shown via `getDepositPayToken`). */
export type AppointmentDeposit = PublicSchema['Tables']['appointment_deposits']['Row'];
export type DepositStatus = PublicSchema['Enums']['deposit_status'];
export type DepositKind = PublicSchema['Enums']['deposit_kind'];

/** Settings → Deposits & cancellations. */
export type DepositSettings = Pick<SalonSettings, 'deposits_enabled' | 'cancellation_window_hours'>;

const DEPOSIT_SETTINGS_COLUMNS = 'deposits_enabled, cancellation_window_hours';
const DEPOSIT_COLUMNS =
  'id, salon_id, appointment_id, amount_cents, currency, status, status_after, paid_at, refunded_cents, resolved_at, resolution, created_at, updated_at, stripe_checkout_session_id, stripe_payment_intent_id, stripe_customer_id, stripe_payment_method_id';

export type MemberDeposit = Omit<AppointmentDeposit, 'pay_token'>;

/** private.cancellation_quote: what cancelling now does with the deposit. */
export interface CancellationQuote {
  appointmentId: string;
  status: Appointment['status'];
  startsAt: string;
  windowHours: number;
  freeUntil: string;
  late: boolean;
  depositStatus: DepositStatus | null;
  depositCents: number;
  currency: string | null;
  outcome: CancellationOutcome;
}

export interface CancelWithPolicyResult {
  appointment: Appointment;
  quote: CancellationQuote;
  deposit: MemberDeposit | null;
}

export async function getDepositSettings(
  client: ChairsideClient,
  salonId: string,
): Promise<DepositSettings> {
  const { data, error } = await client
    .from('settings')
    .select(DEPOSIT_SETTINGS_COLUMNS)
    .eq('salon_id', salonId)
    .single();
  if (error) throw error;
  return data;
}

/** Owners only (RLS). */
export async function updateDepositSettings(
  client: ChairsideClient,
  salonId: string,
  changes: Partial<DepositSettings>,
): Promise<DepositSettings> {
  const { data, error } = await client
    .from('settings')
    .update(changes)
    .eq('salon_id', salonId)
    .select(DEPOSIT_SETTINGS_COLUMNS)
    .single();
  if (error) throw error;
  return data;
}

export type ServiceDepositFields = Pick<ServiceRow, 'deposit_kind' | 'deposit_value'>;

export async function getServiceDeposit(
  client: ChairsideClient,
  serviceId: string,
): Promise<ServiceDepositFields | null> {
  const { data, error } = await client
    .from('services')
    .select('deposit_kind, deposit_value')
    .eq('id', serviceId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** Owners only (RLS). `deposit_value` is cents for flat, 1–100 for percent, 0 for none. */
export async function updateServiceDeposit(
  client: ChairsideClient,
  serviceId: string,
  changes: ServiceDepositFields,
): Promise<ServiceDepositFields> {
  const { data, error } = await client
    .from('services')
    .update(changes)
    .eq('id', serviceId)
    .select('deposit_kind, deposit_value')
    .single();
  if (error) throw error;
  return data;
}

export async function getAppointmentDeposit(
  client: ChairsideClient,
  appointmentId: string,
): Promise<MemberDeposit | null> {
  const { data, error } = await client
    .from('appointment_deposits')
    .select(DEPOSIT_COLUMNS)
    .eq('appointment_id', appointmentId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** The pay-page token of a pending deposit (for sharing the link). Members only (RLS). */
export async function getDepositPayToken(
  client: ChairsideClient,
  appointmentId: string,
): Promise<string | null> {
  const { data, error } = await client
    .from('appointment_deposits')
    .select('pay_token, status')
    .eq('appointment_id', appointmentId)
    .maybeSingle();
  if (error) throw error;
  return data?.status === 'pending' ? data.pay_token : null;
}

export async function getCancellationQuote(
  client: ChairsideClient,
  appointmentId: string,
): Promise<CancellationQuote> {
  const { data, error } = await client.rpc('cancellation_quote', {
    p_appointment_id: appointmentId,
  });
  if (error) throw error;
  return data as unknown as CancellationQuote;
}

/**
 * Cancels and settles the deposit by the salon's policy. Members may override with
 * `deposit: 'refund' | 'keep'`; service-role callers (the client's manage link) always get the
 * policy. A `refund_due` deposit still needs `refundDeposit` (the deposits Edge Function).
 */
export async function cancelAppointmentWithPolicy(
  client: ChairsideClient,
  appointmentId: string,
  options: { reason?: string; deposit?: 'refund' | 'keep' } = {},
): Promise<CancelWithPolicyResult> {
  const { data, error } = await client.rpc('cancel_appointment_with_policy', {
    p_appointment_id: appointmentId,
    ...(options.reason ? { p_reason: options.reason } : {}),
    ...(options.deposit ? { p_deposit: options.deposit } : {}),
  });
  if (error) throw error;
  return data as unknown as CancelWithPolicyResult;
}
