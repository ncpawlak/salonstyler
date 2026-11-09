import { searchSalon, type SearchResult } from '@chairside/db/search';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';

import { supabase } from '@/lib/supabase';
import { useCurrentSalon } from '@/providers/session-provider';

export const searchKey = (salonId: string) => ['search', salonId] as const;

export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

/** Salon-wide fuzzy search. Keeps the last results on screen while the next query loads. */
export function useSalonSearch(query: string) {
  const salon = useCurrentSalon();
  const q = useDebounced(query.trim(), 120);
  const result = useQuery({
    queryKey: [...searchKey(salon.id), q],
    queryFn: () => searchSalon(supabase, salon.id, q),
    enabled: q.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  return { ...result, debouncedQuery: q, settling: q !== query.trim() || result.isFetching };
}

export interface RecentSearches {
  queries: string[];
  items: SearchResult[];
}

const MAX_QUERIES = 5;
const MAX_ITEMS = 6;
const EMPTY: RecentSearches = { queries: [], items: [] };

/** Recent queries and opened results, per salon, kept on the device. */
export function useRecentSearches() {
  const salon = useCurrentSalon();
  const storageKey = `chairside.search.recent.${salon.id}`;
  const [recent, setRecent] = useState<RecentSearches>(EMPTY);

  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(storageKey)
      .then((raw) => {
        if (!alive || !raw) return;
        const parsed = JSON.parse(raw) as Partial<RecentSearches>;
        setRecent({ queries: parsed.queries ?? [], items: parsed.items ?? [] });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [storageKey]);

  const update = useCallback(
    (fn: (r: RecentSearches) => RecentSearches) =>
      setRecent((r) => {
        const next = fn(r);
        void AsyncStorage.setItem(storageKey, JSON.stringify(next)).catch(() => {});
        return next;
      }),
    [storageKey],
  );

  const addQuery = useCallback(
    (query: string) => {
      const q = query.trim();
      if (q.length < 2) return;
      update((r) => ({
        ...r,
        queries: [q, ...r.queries.filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(
          0,
          MAX_QUERIES,
        ),
      }));
    },
    [update],
  );

  const addItem = useCallback(
    (item: SearchResult) =>
      update((r) => ({
        ...r,
        items: [item, ...r.items.filter((x) => x.kind !== item.kind || x.id !== item.id)].slice(
          0,
          MAX_ITEMS,
        ),
      })),
    [update],
  );

  const clear = useCallback(() => update(() => EMPTY), [update]);

  return { recent, addQuery, addItem, clear };
}
