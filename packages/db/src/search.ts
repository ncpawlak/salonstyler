import type { AppointmentStatus, ChairsideClient } from './index.ts';

/**
 * Kinds the `search_salon` RPC returns. Products (#17) will be added here and in the RPC; callers
 * should ignore kinds they don't know so the app keeps working across a server upgrade.
 */
export type SearchResultKind = 'client' | 'appointment' | 'service';

export interface SearchResult {
  kind: SearchResultKind;
  id: string;
  title: string;
  subtitle: string | null;
  /** Appointments only (ISO UTC). */
  startsAt: string | null;
  /** Appointments only. */
  status: AppointmentStatus | null;
  colorTag: string | null;
  /** 0..1, higher is better; results are already ordered by kind, then score. */
  score: number;
}

const KINDS: readonly string[] = ['client', 'appointment', 'service'] satisfies SearchResultKind[];

/**
 * Fuzzy salon-wide search (name prefix/word/typo, phone digits, email, service names) through the
 * `search_salon` RPC. Up to `limitPerKind` results per kind; blank queries return nothing.
 */
export async function searchSalon(
  client: ChairsideClient,
  salonId: string,
  query: string,
  limitPerKind = 6,
): Promise<SearchResult[]> {
  const q = query.trim();
  if (!q) return [];
  const { data, error } = await client.rpc('search_salon', {
    p_salon_id: salonId,
    p_query: q,
    p_limit: limitPerKind,
  });
  if (error) throw error;
  return (data ?? [])
    .filter((r) => KINDS.includes(r.kind))
    .map((r) => ({
      kind: r.kind as SearchResultKind,
      id: r.id,
      title: r.title,
      subtitle: r.subtitle ?? null,
      startsAt: r.starts_at ? new Date(r.starts_at).toISOString() : null,
      status: (r.status as AppointmentStatus | null) ?? null,
      colorTag: r.color_tag ?? null,
      score: Number(r.score ?? 0),
    }));
}
