/**
 * Root entry: the typed client and shared row types only. Feature queries live in their own
 * modules and are imported by subpath (`@chairside/db/clients`, `@chairside/db/appointments`, ...),
 * so adding a feature never edits this file.
 */
import {
  createClient,
  type SupabaseClient,
  type SupabaseClientOptions,
} from '@supabase/supabase-js';

import type { Database } from './database.types.ts';

export type { Database, Json } from './database.types.ts';
export type { Session, User } from '@supabase/supabase-js';

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
export type ClientServiceOverrideRow = Tables<'client_service_overrides'>;
export type ClientFormulaRow = Tables<'client_formulas'>;
export type ClientNoteRow = Tables<'client_notes'>;
export type ClientPhotoRow = Tables<'client_photos'>;
export type ClientSummary = PublicSchema['Views']['client_summaries']['Row'];
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
