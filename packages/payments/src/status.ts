/** Onboarding/payout state of a salon's Stripe Connect account (mirrors `public.stripe_accounts`). */
export interface StripeAccountState {
  stripe_account_id: string;
  details_submitted: boolean;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  /** Stripe requirement keys currently or past due, e.g. `external_account`. */
  requirements_due: string[];
  disabled_reason: string | null;
}

export type PaymentsStatus =
  'not_connected' | 'onboarding' | 'action_required' | 'in_review' | 'enabled';

export function paymentsStatus(account: StripeAccountState | null | undefined): PaymentsStatus {
  if (!account) return 'not_connected';
  if (account.charges_enabled && account.payouts_enabled) return 'enabled';
  if (!account.details_submitted) return 'onboarding';
  if (account.requirements_due.length > 0) return 'action_required';
  return 'in_review';
}

export type PaymentsStatusTone = 'neutral' | 'success' | 'warning' | 'destructive';

export const PAYMENTS_STATUS_INFO: Record<
  PaymentsStatus,
  { label: string; description: string; tone: PaymentsStatusTone; cta: string | null }
> = {
  not_connected: {
    label: 'Not connected',
    description: 'Connect a Stripe account to take card payments. Payouts go to your bank.',
    tone: 'neutral',
    cta: 'Connect with Stripe',
  },
  onboarding: {
    label: 'Setup not finished',
    description: 'Finish the Stripe form to add your details and bank account.',
    tone: 'warning',
    cta: 'Continue setup',
  },
  action_required: {
    label: 'Action required',
    description: 'Stripe needs more information before you can take payments or get paid.',
    tone: 'destructive',
    cta: 'Update details',
  },
  in_review: {
    label: 'In review',
    description: 'Stripe is verifying your details. This usually takes a few minutes.',
    tone: 'warning',
    cta: null,
  },
  enabled: {
    label: 'Payments enabled',
    description: 'You can take card payments. Payouts go to your bank automatically.',
    tone: 'success',
    cta: null,
  },
};

const REQUIREMENT_LABELS: Record<string, string> = {
  external_account: 'Bank account',
  tos_acceptance: 'Accept Stripe terms',
  business_profile: 'Business details',
  'business_profile.url': 'Business website',
  'business_profile.mcc': 'Business category',
  business_type: 'Business type',
  'individual.verification.document': 'ID document',
  'individual.id_number': 'Social Security number',
  'individual.ssn_last_4': 'Last 4 of SSN',
  'individual.dob.day': 'Date of birth',
  'individual.address.line1': 'Address',
  'individual.phone': 'Phone number',
  'individual.email': 'Email',
};

/** "individual.verification.document" -> "ID document"; unknown keys become readable text. */
export function requirementLabel(key: string): string {
  const known = REQUIREMENT_LABELS[key];
  if (known) return known;
  const last = key.split('.').filter((p) => p !== 'individual' && p !== 'company');
  const text = (last.join(' ') || key).replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** 12345, "usd" -> "$123.45" */
export function formatAmount(amountCents: number, currency: string, locale?: string): string {
  const code = currency.toUpperCase();
  let digits = 2;
  try {
    digits =
      new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions()
        .maximumFractionDigits ?? 2;
  } catch {
    return `${(amountCents / 100).toFixed(2)} ${code}`;
  }
  return new Intl.NumberFormat(locale, { style: 'currency', currency: code }).format(
    amountCents / 10 ** digits,
  );
}
