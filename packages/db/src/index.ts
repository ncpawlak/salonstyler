import {
  createClient,
  type SupabaseClient,
  type SupabaseClientOptions,
} from '@supabase/supabase-js';

import type { Database, Json } from './database.types.ts';

export type { Database, Json } from './database.types.ts';
export type { Session, User } from '@supabase/supabase-js';
export * from './services.ts';
export * from './appointments.ts';
export * from './notifications.ts';

type PublicSchema = Database['public'];

export type Tables<T extends keyof PublicSchema['Tables']> = PublicSchema['Tables'][T]['Row'];
export type TablesInsert<T extends keyof PublicSchema['Tables']> =
  PublicSchema['Tables'][T]['Insert'];
export type TablesUpdate<T extends keyof PublicSchema['Tables']> =
  PublicSchema['Tables'][T]['Update'];
export type Enums<T extends keyof PublicSchema['Enums']> = PublicSchema['Enums'][T];

export type Salon = Tables<'salons'>;
export type SalonMember = Tables<'salon_members'>;
export type SalonSettings = Tables<'settings'>;
export type AuditLogEntry = Tables<'audit_log'>;
export type PushToken = Tables<'push_tokens'>;
export type ServiceRow = Tables<'services'>;
export type ServiceSegmentRow = Tables<'service_segments'>;
export type ServiceVariantRow = Tables<'service_variants'>;
export type ServiceAddonRow = Tables<'service_addons'>;
export type ServiceComboItemRow = Tables<'service_combo_items'>;
export type SalonRole = Enums<'salon_role'>;
export type WorkHoursTemplate = Tables<'work_hours_template'>;
export type WorkHoursOverride = Tables<'work_hours_override'>;
export type WorkHoursOverrideKind = Enums<'work_hours_override_kind'>;
export type ClientRow = Tables<'clients'>;
export type Appointment = Tables<'appointments'>;
export type AppointmentSegmentRow = Tables<'appointment_segments'>;
export type AppointmentStatus = Enums<'appointment_status'>;
export type AppointmentSource = Enums<'appointment_source'>;
export type AppointmentSegmentKind = Enums<'appointment_segment_kind'>;

/** Public AI settings. The API key itself lives in Supabase Vault and is never readable here. */
export type AiProviderConfig = Tables<'ai_provider_config'>;
export type AiUsage = Tables<'ai_usage'>;
export type AiProviderId = Enums<'ai_provider'>;

/** Stripe Connect account status, synced by the `payments` / `stripe-webhook` Edge Functions. */
export type StripeAccount = Tables<'stripe_accounts'>;
export type Payment = Tables<'payments'>;
export type PaymentStatus = Enums<'payment_status'>;

export type ChairsideClient = SupabaseClient<Database>;

/** Typed Supabase client. Use the anon key in apps; RLS scopes every query to the user's salons. */
export function createChairsideClient(
  url: string,
  anonKey: string,
  options?: SupabaseClientOptions<'public'>,
): ChairsideClient {
  if (!url || !anonKey) {
    throw new Error('createChairsideClient: Supabase URL and anon key are required');
  }
  return createClient<Database>(url, anonKey, options);
}

export interface CreateSalonInput {
  name: string;
  slug: string;
  /** IANA timezone, e.g. "America/Chicago". */
  timezone: string;
}

/** First-run: creates a salon owned by the signed-in user (plus default settings). */
export async function createSalon(
  client: ChairsideClient,
  input: CreateSalonInput,
): Promise<Salon> {
  const { data, error } = await client.rpc('create_salon', {
    p_name: input.name,
    p_slug: input.slug,
    p_timezone: input.timezone,
  });
  if (error) throw error;
  return data;
}

/** Salons the signed-in user belongs to, with their role. Empty => show the create-salon screen. */
export async function listMySalons(
  client: ChairsideClient,
): Promise<(Salon & { role: SalonRole })[]> {
  const { data: auth, error: authError } = await client.auth.getUser();
  if (authError) throw authError;
  const userId = auth.user?.id;
  if (!userId) return [];

  const { data, error } = await client
    .from('salon_members')
    .select('role, salons!inner(*)')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data.map(({ role, salons }) => ({ ...salons, role }));
}

export async function isSalonSlugAvailable(
  client: ChairsideClient,
  slug: string,
): Promise<boolean> {
  const { data, error } = await client.rpc('is_salon_slug_available', { p_slug: slug });
  if (error) throw error;
  return data;
}

export type BookingRulesSettings = Pick<
  SalonSettings,
  'min_notice_minutes' | 'booking_window_days' | 'slot_grid_minutes' | 'hold_expiry_hours'
>;

export interface WorkHoursData {
  /** `salons.timezone`; every wall-clock time below is in this zone. */
  timeZone: string;
  template: WorkHoursTemplate[];
  overrides: WorkHoursOverride[];
  bookingRules: BookingRulesSettings;
}

/**
 * Everything needed to resolve work hours (pass to `buildWorkHours` in `@chairside/core`).
 * `range` limits overrides to those touching `[from, to]` (local `YYYY-MM-DD`).
 */
export async function getWorkHours(
  client: ChairsideClient,
  salonId: string,
  range?: { from: string; to: string },
): Promise<WorkHoursData> {
  let overrides = client.from('work_hours_override').select('*').eq('salon_id', salonId);
  if (range) overrides = overrides.lte('start_date', range.to).gte('end_date', range.from);

  const [salon, template, override, settings] = await Promise.all([
    client.from('salons').select('timezone').eq('id', salonId).single(),
    client.from('work_hours_template').select('*').eq('salon_id', salonId).order('weekday'),
    overrides.order('start_date'),
    client
      .from('settings')
      .select('min_notice_minutes, booking_window_days, slot_grid_minutes, hold_expiry_hours')
      .eq('salon_id', salonId)
      .single(),
  ]);
  for (const r of [salon, template, override, settings]) if (r.error) throw r.error;
  return {
    timeZone: salon.data!.timezone,
    template: template.data!,
    overrides: override.data!,
    bookingRules: settings.data!,
  };
}

export interface WorkHoursTemplateInput {
  weekday: number;
  blocks: NonNullable<Json>;
  breaks: NonNullable<Json>;
}

/** Replaces the blanket weekly schedule (owners only). */
export async function saveWorkHoursTemplate(
  client: ChairsideClient,
  salonId: string,
  days: WorkHoursTemplateInput[],
): Promise<WorkHoursTemplate[]> {
  const { data, error } = await client
    .from('work_hours_template')
    .upsert(
      days.map((d) => ({ ...d, salon_id: salonId })),
      { onConflict: 'salon_id,weekday' },
    )
    .select();
  if (error) throw error;
  return data;
}

export interface WorkHoursOverrideInput {
  start_date: string;
  end_date: string;
  kind: WorkHoursOverrideKind;
  blocks: NonNullable<Json>;
  breaks: NonNullable<Json>;
  note?: string | null;
}

/** Paints a date or range; re-painting the same range replaces it (owners only). */
export async function upsertWorkHoursOverride(
  client: ChairsideClient,
  salonId: string,
  override: WorkHoursOverrideInput,
): Promise<WorkHoursOverride> {
  const { data, error } = await client
    .from('work_hours_override')
    .upsert({ ...override, salon_id: salonId }, { onConflict: 'salon_id,start_date,end_date' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

/** Removes an override so the date falls back to the weekly template. */
export async function deleteWorkHoursOverride(client: ChairsideClient, id: string): Promise<void> {
  const { error } = await client.from('work_hours_override').delete().eq('id', id);
  if (error) throw error;
}

export async function updateBookingRules(
  client: ChairsideClient,
  salonId: string,
  rules: Partial<BookingRulesSettings>,
): Promise<BookingRulesSettings> {
  const { data, error } = await client
    .from('settings')
    .update(rules)
    .eq('salon_id', salonId)
    .select('min_notice_minutes, booking_window_days, slot_grid_minutes, hold_expiry_hours')
    .single();
  if (error) throw error;
  return data;
}

export async function getAiProviderConfig(
  client: ChairsideClient,
  salonId: string,
): Promise<AiProviderConfig | null> {
  const { data, error } = await client
    .from('ai_provider_config')
    .select('*')
    .eq('salon_id', salonId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export interface SaveAiProviderConfigInput {
  salonId: string;
  provider: AiProviderId;
  model: string;
  monthlyTokenBudget: number;
  /** Write-only. Omit to keep the saved key (required on first save and when switching provider). */
  apiKey?: string;
}

/** Owner-only. The key goes straight into Vault; the response contains only a masked hint. */
export async function saveAiProviderConfig(
  client: ChairsideClient,
  input: SaveAiProviderConfigInput,
): Promise<AiProviderConfig> {
  const { data, error } = await client.rpc('save_ai_provider_config', {
    p_salon_id: input.salonId,
    p_provider: input.provider,
    p_model: input.model,
    p_monthly_token_budget: input.monthlyTokenBudget,
    ...(input.apiKey ? { p_api_key: input.apiKey } : {}),
  });
  if (error) throw error;
  return data;
}

/** Owner-only. Removes the settings and destroys the stored key. */
export async function deleteAiProviderConfig(
  client: ChairsideClient,
  salonId: string,
): Promise<void> {
  const { error } = await client.rpc('delete_ai_provider_config', { p_salon_id: salonId });
  if (error) throw error;
}

/** Tokens used this calendar month (salon timezone), for budget display. */
export async function getAiTokensUsedThisMonth(
  client: ChairsideClient,
  salonId: string,
): Promise<number> {
  const { data, error } = await client.rpc('ai_tokens_used_this_month', { p_salon_id: salonId });
  if (error) throw error;
  return Number(data ?? 0);
}

/** The salon's Stripe Connect account, or null if it hasn't connected Stripe yet (read-only). */
export async function getStripeAccount(
  client: ChairsideClient,
  salonId: string,
): Promise<StripeAccount | null> {
  const { data, error } = await client
    .from('stripe_accounts')
    .select('*')
    .eq('salon_id', salonId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** Most recent payments first (read-only; rows are written by the stripe-webhook function). */
export async function listPayments(
  client: ChairsideClient,
  salonId: string,
  limit = 20,
): Promise<Payment[]> {
  const { data, error } = await client
    .from('payments')
    .select('*')
    .eq('salon_id', salonId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
}

// Mirrors private.is_valid_salon_slug() in supabase/migrations/*_foundation.sql.
export const SALON_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
export const RESERVED_SALON_SLUGS: readonly string[] = [
  'admin',
  'api',
  'app',
  'auth',
  'book',
  'chairside',
  'help',
  'login',
  'settings',
  'signup',
  'support',
  'www',
];

export function isValidSalonSlug(slug: string): boolean {
  return SALON_SLUG_PATTERN.test(slug) && !RESERVED_SALON_SLUGS.includes(slug);
}

/** "Karina's Hair Studio!" -> "karinas-hair-studio" */
export function toSalonSlug(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}
