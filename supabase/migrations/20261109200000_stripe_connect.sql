-- Stripe Connect onboarding and payments (docs/PLAN.md §9), issue #9.
--
-- * public.stripe_accounts: one Stripe Connect Express account per salon plus its onboarding
--   status (details submitted, charges enabled, payouts enabled). Written only by the `payments`
--   and `stripe-webhook` Edge Functions (service role); members can read it.
-- * public.payments: one row per Stripe PaymentIntent, kept in sync by the `stripe-webhook`
--   Edge Function. Members can read their salon's payments; nobody writes them from the app.
-- * Stripe secrets (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET) are Edge Function secrets, never
--   stored in the database.

-- ---------------------------------------------------------------------------
-- stripe_accounts (1:1 with salons, optional)
-- ---------------------------------------------------------------------------

create table public.stripe_accounts (
  salon_id          uuid primary key references public.salons (id) on delete cascade,
  stripe_account_id text not null unique check (stripe_account_id ~ '^acct_[A-Za-z0-9]+$'),
  details_submitted boolean not null default false,
  charges_enabled   boolean not null default false,
  payouts_enabled   boolean not null default false,
  -- Stripe requirement keys that are currently due or past due, e.g. {external_account}.
  requirements_due  text[] not null default '{}',
  disabled_reason   text,
  country           text check (country ~ '^[A-Z]{2}$'),
  default_currency  text check (default_currency ~ '^[a-z]{3}$'),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.stripe_accounts is
  'Stripe Connect Express account per salon. Synced from Stripe by the payments / stripe-webhook Edge Functions.';

create trigger stripe_accounts_set_updated_at
  before update on public.stripe_accounts
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- payments (one row per PaymentIntent)
-- ---------------------------------------------------------------------------

create type public.payment_status as enum (
  'pending',             -- requires a payment method / confirmation / action / capture
  'processing',
  'succeeded',
  'failed',
  'canceled',
  'partially_refunded',
  'refunded'
);

create table public.payments (
  id                       uuid primary key default gen_random_uuid(),
  salon_id                 uuid not null references public.salons (id) on delete cascade,
  -- The appointment this payment settles (optional; set by checkout, #11).
  appointment_id           uuid,
  stripe_payment_intent_id text not null unique check (stripe_payment_intent_id ~ '^pi_[A-Za-z0-9_]+$'),
  stripe_charge_id         text,
  stripe_account_id        text,
  amount_cents             bigint not null check (amount_cents >= 0),
  amount_refunded_cents    bigint not null default 0 check (amount_refunded_cents >= 0),
  currency                 text not null check (currency ~ '^[a-z]{3}$'),
  status                   public.payment_status not null,
  description              text,
  failure_message          text,
  livemode                 boolean not null default false,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  -- Composite key keeps the appointment in the same salon; deleting it keeps the payment record.
  constraint payments_appointment_fkey foreign key (salon_id, appointment_id)
    references public.appointments (salon_id, id) on delete set null (appointment_id)
);

create index payments_salon_created_idx on public.payments (salon_id, created_at desc);
create index payments_appointment_idx on public.payments (appointment_id) where appointment_id is not null;

comment on table public.payments is
  'Stripe PaymentIntents for a salon, written by the stripe-webhook Edge Function (service role). Amounts are in the smallest currency unit.';
comment on column public.payments.appointment_id is
  'Appointment being paid for (same salon). Set to null if the appointment is deleted.';

create trigger payments_set_updated_at
  before update on public.payments
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row level security: members read, only the service role writes
-- ---------------------------------------------------------------------------

alter table public.stripe_accounts enable row level security;
alter table public.payments        enable row level security;

revoke all on public.stripe_accounts, public.payments from anon;
revoke insert, update, delete, truncate on public.stripe_accounts, public.payments from authenticated;

create policy "members can read stripe account" on public.stripe_accounts
  for select to authenticated using (private.is_salon_member(salon_id));

create policy "members can read payments" on public.payments
  for select to authenticated using (private.is_salon_member(salon_id));
