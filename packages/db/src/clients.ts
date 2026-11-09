import type { ClientServiceOverride } from '@chairside/core';

import type { AppointmentServiceSnapshot } from './appointments.ts';
import type {
  AppointmentStatus,
  ChairsideClient,
  ClientFormulaRow,
  ClientNoteRow,
  ClientPhotoRow,
  ClientRow,
  ClientServiceOverrideRow,
  ClientSummary,
  PaymentStatus,
} from './index.ts';

/** Private Storage bucket for client photos; objects live at `{salon_id}/{client_id}/{file}`. */
export const CLIENT_PHOTOS_BUCKET = 'client-photos';

const blank = (v?: string | null) => (v?.trim() ? v.trim() : null);

/** Escapes a search term for a PostgREST `ilike` filter (wildcards and filter syntax are literal). */
function ilikeTerm(search: string): string {
  return search.trim().replace(/[%,()*\\_]/g, ' ');
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export async function getClient(
  client: ChairsideClient,
  clientId: string,
): Promise<ClientRow | null> {
  const { data, error } = await client.from('clients').select('*').eq('id', clientId).maybeSingle();
  if (error) throw error;
  return data;
}

export interface UpdateClientInput {
  name?: string;
  phone?: string | null;
  email?: string | null;
  notes?: string | null;
  tags?: string[];
  marketingOptIn?: boolean;
  preferredServiceIds?: string[];
}

/** Normalises tags: trimmed, de-duplicated (case-insensitive), at most 20. */
export function normalizeClientTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim().replace(/\s+/g, ' ').slice(0, 30);
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
  }
  return out.slice(0, 20);
}

export async function updateClient(
  client: ChairsideClient,
  clientId: string,
  input: UpdateClientInput,
): Promise<ClientRow> {
  const patch: Partial<ClientRow> = {};
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.phone !== undefined) patch.phone = blank(input.phone);
  if (input.email !== undefined) patch.email = blank(input.email);
  if (input.notes !== undefined) patch.notes = blank(input.notes);
  if (input.tags !== undefined) patch.tags = normalizeClientTags(input.tags);
  if (input.marketingOptIn !== undefined) patch.marketing_opt_in = input.marketingOptIn;
  if (input.preferredServiceIds !== undefined) {
    patch.preferred_service_ids = [...new Set(input.preferredServiceIds)].slice(0, 20);
  }
  const { data, error } = await client
    .from('clients')
    .update(patch)
    .eq('id', clientId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

/** Owners only (RLS). Appointments keep their history with `client_id` cleared. */
export async function deleteClient(client: ChairsideClient, clientId: string): Promise<void> {
  const { error } = await client.from('clients').delete().eq('id', clientId);
  if (error) throw error;
}

/** Visit counts, no-shows, last/next visit and net paid, keyed by client id. */
export async function listClientSummaries(
  client: ChairsideClient,
  salonId: string,
  clientIds?: readonly string[],
): Promise<Map<string, ClientSummary>> {
  let query = client.from('client_summaries').select('*').eq('salon_id', salonId);
  if (clientIds) {
    if (clientIds.length === 0) return new Map();
    query = query.in('client_id', [...clientIds]);
  }
  const { data, error } = await query;
  if (error) throw error;
  return new Map(data.filter((s) => s.client_id).map((s) => [s.client_id!, s]));
}

export async function getClientSummary(
  client: ChairsideClient,
  clientId: string,
): Promise<ClientSummary | null> {
  const { data, error } = await client
    .from('client_summaries')
    .select('*')
    .eq('client_id', clientId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** Client ids whose color formulas mention `search` (e.g. "7N" or "20vol"). */
export async function searchClientFormulas(
  client: ChairsideClient,
  salonId: string,
  search: string,
  limit = 50,
): Promise<{ clientId: string; formula: string }[]> {
  const term = ilikeTerm(search);
  if (!term.trim()) return [];
  const { data, error } = await client
    .from('client_formulas')
    .select('client_id, formula')
    .eq('salon_id', salonId)
    .ilike('formula', `%${term}%`)
    .order('visit_date', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data.map((r) => ({ clientId: r.client_id, formula: r.formula }));
}

// ---------------------------------------------------------------------------
// Visit history
// ---------------------------------------------------------------------------

export interface ClientVisitPayment {
  amountCents: number;
  refundedCents: number;
  status: PaymentStatus;
}

export interface ClientVisit {
  id: string;
  status: AppointmentStatus;
  startsAt: string;
  endsAt: string;
  priceCents: number | null;
  notes: string | null;
  services: AppointmentServiceSnapshot[];
  payments: ClientVisitPayment[];
}

/** The client's appointments, newest first, with what was booked and what was paid. */
export async function listClientVisits(
  client: ChairsideClient,
  clientId: string,
  limit = 50,
): Promise<ClientVisit[]> {
  const { data, error } = await client
    .from('appointments')
    .select(
      `id, status, starts_at, ends_at, price_cents, notes, services,
       payments(amount_cents, amount_refunded_cents, status)`,
    )
    .eq('client_id', clientId)
    .order('starts_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data.map((a) => ({
    id: a.id,
    status: a.status,
    startsAt: a.starts_at,
    endsAt: a.ends_at,
    priceCents: a.price_cents,
    notes: a.notes,
    services: (Array.isArray(a.services)
      ? a.services
      : []) as unknown as AppointmentServiceSnapshot[],
    payments: a.payments.map((p) => ({
      amountCents: p.amount_cents,
      refundedCents: p.amount_refunded_cents,
      status: p.status,
    })),
  }));
}

// ---------------------------------------------------------------------------
// Duration overrides
// ---------------------------------------------------------------------------

export async function listClientOverrideRows(
  client: ChairsideClient,
  clientId: string,
): Promise<ClientServiceOverrideRow[]> {
  const { data, error } = await client
    .from('client_service_overrides')
    .select('*')
    .eq('client_id', clientId)
    .order('created_at');
  if (error) throw error;
  return data;
}

export function toClientServiceOverride(row: ClientServiceOverrideRow): ClientServiceOverride {
  return {
    serviceId: row.service_id,
    deltaMinutes: row.delta_minutes,
    segmentIndex: row.segment_index,
  };
}

/** The client's overrides in the shape the core resolvers take (`overrideFor`). */
export async function listClientOverrides(
  client: ChairsideClient,
  clientId: string,
): Promise<ClientServiceOverride[]> {
  return (await listClientOverrideRows(client, clientId)).map(toClientServiceOverride);
}

export interface SaveClientOverrideInput {
  salonId: string;
  clientId: string;
  serviceId: string;
  deltaMinutes: number;
  segmentIndex?: number | null;
  note?: string | null;
  source?: 'manual' | 'suggested' | 'ai';
}

/** Creates or replaces the client's override for a service. */
export async function saveClientOverride(
  client: ChairsideClient,
  input: SaveClientOverrideInput,
): Promise<ClientServiceOverrideRow> {
  const { data, error } = await client
    .from('client_service_overrides')
    .upsert(
      {
        salon_id: input.salonId,
        client_id: input.clientId,
        service_id: input.serviceId,
        delta_minutes: Math.round(input.deltaMinutes),
        segment_index: input.segmentIndex ?? null,
        note: blank(input.note),
        source: input.source ?? 'manual',
      },
      { onConflict: 'client_id,service_id' },
    )
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteClientOverride(client: ChairsideClient, id: string): Promise<void> {
  const { error } = await client.from('client_service_overrides').delete().eq('id', id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Notes and formulas
// ---------------------------------------------------------------------------

export async function listClientNotes(
  client: ChairsideClient,
  clientId: string,
): Promise<ClientNoteRow[]> {
  const { data, error } = await client
    .from('client_notes')
    .select('*')
    .eq('client_id', clientId)
    .order('pinned', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

export async function addClientNote(
  client: ChairsideClient,
  input: { salonId: string; clientId: string; body: string; source?: 'owner' | 'ai' | 'import' },
): Promise<ClientNoteRow> {
  const { data, error } = await client
    .from('client_notes')
    .insert({
      salon_id: input.salonId,
      client_id: input.clientId,
      body: input.body.trim(),
      source: input.source ?? 'owner',
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteClientNote(client: ChairsideClient, id: string): Promise<void> {
  const { error } = await client.from('client_notes').delete().eq('id', id);
  if (error) throw error;
}

export async function listClientFormulas(
  client: ChairsideClient,
  clientId: string,
): Promise<ClientFormulaRow[]> {
  const { data, error } = await client
    .from('client_formulas')
    .select('*')
    .eq('client_id', clientId)
    .order('visit_date', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

export interface AddClientFormulaInput {
  salonId: string;
  clientId: string;
  formula: string;
  serviceName?: string | null;
  notes?: string | null;
  /** `YYYY-MM-DD`; defaults to today. */
  visitDate?: string;
  appointmentId?: string | null;
}

export async function addClientFormula(
  client: ChairsideClient,
  input: AddClientFormulaInput,
): Promise<ClientFormulaRow> {
  const { data, error } = await client
    .from('client_formulas')
    .insert({
      salon_id: input.salonId,
      client_id: input.clientId,
      formula: input.formula.trim(),
      service_name: blank(input.serviceName),
      notes: blank(input.notes),
      appointment_id: input.appointmentId ?? null,
      ...(input.visitDate ? { visit_date: input.visitDate } : {}),
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteClientFormula(client: ChairsideClient, id: string): Promise<void> {
  const { error } = await client.from('client_formulas').delete().eq('id', id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Photos (Supabase Storage)
// ---------------------------------------------------------------------------

export interface ClientPhoto extends ClientPhotoRow {
  /** Short-lived signed URL, or null if signing failed (e.g. file missing). */
  url: string | null;
}

const PHOTO_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

/** `{salon_id}/{client_id}/{uuid}.{ext}`: the folder the Storage and table policies require. */
export function clientPhotoPath(
  salonId: string,
  clientId: string,
  contentType: string,
  id: string = crypto.randomUUID(),
): string {
  const ext = PHOTO_EXTENSIONS[contentType];
  if (!ext) throw new Error(`Unsupported photo type: ${contentType}`);
  return `${salonId}/${clientId}/${id}.${ext}`;
}

export async function listClientPhotos(
  client: ChairsideClient,
  clientId: string,
  expiresInSeconds = 3600,
): Promise<ClientPhoto[]> {
  const { data, error } = await client
    .from('client_photos')
    .select('*')
    .eq('client_id', clientId)
    .order('taken_at', { ascending: false });
  if (error) throw error;
  if (data.length === 0) return [];
  const signed = await client.storage.from(CLIENT_PHOTOS_BUCKET).createSignedUrls(
    data.map((p) => p.storage_path),
    expiresInSeconds,
  );
  const urls = new Map<string, string>();
  for (const s of signed.data ?? []) if (s.path && s.signedUrl) urls.set(s.path, s.signedUrl);
  return data.map((p) => ({ ...p, url: urls.get(p.storage_path) ?? null }));
}

export interface UploadClientPhotoInput {
  salonId: string;
  clientId: string;
  /** Blob/File on web, ArrayBuffer on native. */
  body: Blob | ArrayBuffer;
  contentType: string;
  kind?: 'before' | 'after' | 'other';
  caption?: string | null;
  appointmentId?: string | null;
}

/** Uploads to Storage, then records the row; removes the file again if the insert fails. */
export async function uploadClientPhoto(
  client: ChairsideClient,
  input: UploadClientPhotoInput,
): Promise<ClientPhotoRow> {
  const path = clientPhotoPath(input.salonId, input.clientId, input.contentType);
  const bucket = client.storage.from(CLIENT_PHOTOS_BUCKET);
  const upload = await bucket.upload(path, input.body, {
    contentType: input.contentType,
    upsert: false,
  });
  if (upload.error) throw upload.error;
  const { data, error } = await client
    .from('client_photos')
    .insert({
      salon_id: input.salonId,
      client_id: input.clientId,
      storage_path: path,
      kind: input.kind ?? 'after',
      caption: blank(input.caption),
      appointment_id: input.appointmentId ?? null,
    })
    .select()
    .single();
  if (error) {
    await bucket.remove([path]);
    throw error;
  }
  return data;
}

export async function deleteClientPhoto(
  client: ChairsideClient,
  photo: Pick<ClientPhotoRow, 'id' | 'storage_path'>,
): Promise<void> {
  const { error } = await client.from('client_photos').delete().eq('id', photo.id);
  if (error) throw error;
  const removed = await client.storage.from(CLIENT_PHOTOS_BUCKET).remove([photo.storage_path]);
  if (removed.error) throw removed.error;
}
