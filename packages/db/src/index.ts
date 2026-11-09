import {
  createClient,
  type SupabaseClient,
  type SupabaseClientOptions,
} from '@supabase/supabase-js';

import type { Database } from './database.types';

export type { Database, Json } from './database.types';

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
export type SalonRole = Enums<'salon_role'>;

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
): Promise<Array<Salon & { role: SalonRole }>> {
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
