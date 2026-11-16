// What a hosted Chairside project needs, in one place. `npm run check:hosted` (CI) fails when the code
// reads a function secret or Vault secret that isn't listed here, or a function isn't in config.toml,
// so new features can't silently skip the go-live checklist (docs/pilot-cutover.md).
//
// Things that can be read from the repo itself (functions, cron jobs, extensions, buckets) are
// derived in lib.mjs instead of listed here.

/**
 * Edge Function secrets (`supabase secrets set`). `need`:
 *   required     the pilot doesn't work without it
 *   recommended  a feature is off or degraded without it
 *   optional     has a sensible default
 * `derive` fills an empty value from other keys when `hosted:secrets` runs.
 */
export const FUNCTION_SECRETS = [
  {
    name: 'NOTIFIER_SECRET',
    need: 'required',
    group: 'core',
    about:
      'Shared secret pg_cron uses to call notifier, waitlist and marketing. Must equal Vault `notifier_secret` (npm run hosted:vault copies it).',
  },
  {
    name: 'EXPO_ACCESS_TOKEN',
    need: 'optional',
    group: 'push',
    about: 'Only if Expo push "enhanced security" is on for the project.',
  },
  {
    name: 'EMAIL_FROM',
    need: 'recommended',
    group: 'email',
    about:
      'Sender for client emails (confirmations, reminders, waitlist offers, marketing, export links), e.g. "Studio K <hello@yourdomain.com>". Without it these stay queued.',
  },
  {
    name: 'PUBLIC_APP_URL',
    need: 'recommended',
    group: 'email',
    about: 'Public web app origin (https://app.yourdomain.com). Links in emails point here.',
  },
  {
    name: 'RESEND_API_KEY',
    need: 'recommended',
    group: 'email',
    about: 'Resend API key (re_…). Preferred: hosted functions often cannot reach SMTP ports.',
  },
  { name: 'SMTP_HOST', need: 'optional', group: 'email', about: 'Only if not using Resend.' },
  { name: 'SMTP_PORT', need: 'optional', group: 'email', about: '465 (TLS) or 587 (STARTTLS).' },
  { name: 'SMTP_USER', need: 'optional', group: 'email', about: 'SMTP user name.' },
  { name: 'SMTP_PASS', need: 'optional', group: 'email', about: 'SMTP password.' },
  {
    name: 'SMTP_SECURITY',
    need: 'optional',
    group: 'email',
    about: 'tls | starttls | none (default from the port).',
  },
  {
    name: 'STRIPE_SECRET_KEY',
    need: 'recommended',
    group: 'stripe',
    about:
      'Platform secret key, sk_test_… for the pilot. Without it card payments, deposits and Connect onboarding return 503 stripe_not_configured.',
  },
  {
    name: 'STRIPE_WEBHOOK_SECRET',
    need: 'recommended',
    group: 'stripe',
    about:
      'Signing secrets of both webhook destinations (your account + connected accounts), comma-separated: whsec_a,whsec_b.',
  },
  {
    name: 'PAYMENTS_RETURN_URL',
    need: 'recommended',
    group: 'stripe',
    about:
      'https page Stripe onboarding returns to from iOS. Defaults to PUBLIC_APP_URL + /settings/payments.',
    derive: (env) =>
      env.PUBLIC_APP_URL ? `${trimSlash(env.PUBLIC_APP_URL)}/settings/payments` : '',
  },
  {
    name: 'PUBLIC_WEB_URL',
    need: 'optional',
    group: 'stripe',
    about: 'Deposits only let Stripe Checkout return to this origin. Defaults to PUBLIC_APP_URL.',
    derive: (env) => (env.PUBLIC_APP_URL ? trimSlash(env.PUBLIC_APP_URL) : ''),
  },
  {
    name: 'STRIPE_CONNECT_COUNTRY',
    need: 'optional',
    group: 'stripe',
    about: 'Two-letter country for new Connect accounts (default US).',
  },
  {
    name: 'STRIPE_TERMINAL_LOCATION_ID',
    need: 'optional',
    group: 'stripe',
    about: 'Fixed Stripe Terminal location (tml_…). Unset: one is created per salon.',
  },
  {
    name: 'PUBLIC_FUNCTIONS_URL',
    need: 'optional',
    group: 'marketing',
    about:
      'Marketing one-click unsubscribe URL. Defaults to https://<ref>.supabase.co/functions/v1/marketing.',
    derive: (_env, ref) => (ref ? `${functionsBase(ref)}/marketing` : ''),
  },
];

/** Provided by the platform on hosted projects; `supabase secrets set` refuses SUPABASE_* names. */
export const PLATFORM_ENV = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_DB_URL',
];

/** Read by functions but only meaningful on a local stack. Never set them on a hosted project. */
export const LOCAL_ONLY_ENV = ['CHAIRSIDE_AI_DEMO', 'PUBLIC_SUPABASE_URL'];

/** Keys in .env.hosted for the scripts themselves; never sent to the functions. */
export const TOOLING_ENV = [
  'SUPABASE_PROJECT_REF',
  'SUPABASE_ACCESS_TOKEN',
  'SUPABASE_DB_PASSWORD',
  'SUPABASE_DB_URL',
];

/** Vault secrets the pg_cron jobs read (vault.decrypted_secrets). */
export const VAULT_SECRETS = [
  {
    name: 'notifier_url',
    need: 'required',
    value: (_env, ref) => `${functionsBase(ref)}/notifier`,
    about: 'pg_cron → notifier (pushes, client emails).',
  },
  {
    name: 'notifier_secret',
    need: 'required',
    value: (env) => env.NOTIFIER_SECRET ?? '',
    secret: true,
    about: 'Same value as the NOTIFIER_SECRET function secret.',
  },
  {
    name: 'waitlist_url',
    need: 'optional',
    about: 'Defaults to notifier_url with /notifier → /waitlist. Leave unset.',
  },
  {
    name: 'marketing_url',
    need: 'optional',
    about: 'Defaults to notifier_url with /notifier → /marketing. Leave unset.',
  },
];

/** Stripe events stripe-webhook handles (HANDLED_STRIPE_EVENTS in @chairside/payments/server). */
export const STRIPE_WEBHOOK_EVENTS = [
  'account.updated',
  'payment_intent.processing',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
  'charge.refunded',
];

export function trimSlash(url) {
  return url.trim().replace(/\/+$/, '');
}

export function functionsBase(ref) {
  return `https://${ref}.supabase.co/functions/v1`;
}
