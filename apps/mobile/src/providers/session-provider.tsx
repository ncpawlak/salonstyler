import { listMySalons, type Salon, type SalonRole, type Session, type User } from '@chairside/db';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as Linking from 'expo-linking';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { Platform } from 'react-native';

import { unregisterThisDevice } from '@/features/notifications/push';
import { createSessionFromUrl } from '@/lib/auth';
import { supabase } from '@/lib/supabase';

const CURRENT_SALON_KEY = 'chairside.currentSalonId';

export type MySalon = Salon & { role: SalonRole };

interface SessionContextValue {
  /** True until the stored session (and, if signed in, the salon list) has loaded. */
  isLoading: boolean;
  session: Session | null;
  user: User | null;
  salons: MySalon[];
  /** The salon the app is currently scoped to; null => first run (create a salon). */
  salon: MySalon | null;
  salonId: string | null;
  selectSalon: (salonId: string) => Promise<void>;
  refreshSalons: () => Promise<MySalon[]>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<Session | null>(null);
  const [isSessionLoading, setIsSessionLoading] = useState(true);
  const [storedSalonId, setStoredSalonId] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    void Promise.all([supabase.auth.getSession(), AsyncStorage.getItem(CURRENT_SALON_KEY)]).then(
      ([{ data }, salonId]) => {
        if (!mounted) return;
        setSession(data.session);
        setStoredSalonId(salonId);
        setIsSessionLoading(false);
      },
    );
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
    });
    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  // Native magic-link fallback: the emailed link opens the app with tokens in the URL.
  const incomingUrl = Linking.useURL();
  useEffect(() => {
    if (Platform.OS !== 'web' && incomingUrl) {
      createSessionFromUrl(incomingUrl).catch((e: unknown) => console.warn('Magic link failed', e));
    }
  }, [incomingUrl]);

  const userId = session?.user.id ?? null;
  const salonsQuery = useQuery({
    queryKey: ['my-salons', userId],
    queryFn: () => listMySalons(supabase),
    enabled: userId !== null,
  });
  const salons = useMemo(() => salonsQuery.data ?? [], [salonsQuery.data]);
  const salon = salons.find((s) => s.id === storedSalonId) ?? salons[0] ?? null;

  const selectSalon = useCallback(async (salonId: string) => {
    setStoredSalonId(salonId);
    await AsyncStorage.setItem(CURRENT_SALON_KEY, salonId);
  }, []);

  const refreshSalons = useCallback(async () => {
    const { data } = await salonsQuery.refetch();
    return data ?? [];
  }, [salonsQuery]);

  const signOut = useCallback(async () => {
    // Stop pushes to this device while the session can still delete its token.
    await unregisterThisDevice();
    await supabase.auth.signOut();
    await AsyncStorage.removeItem(CURRENT_SALON_KEY);
    setStoredSalonId(null);
    queryClient.clear();
  }, [queryClient]);

  const value = useMemo<SessionContextValue>(
    () => ({
      isLoading: isSessionLoading || (userId !== null && salonsQuery.isPending),
      session,
      user: session?.user ?? null,
      salons,
      salon,
      salonId: salon?.id ?? null,
      selectSalon,
      refreshSalons,
      signOut,
    }),
    [
      isSessionLoading,
      userId,
      salonsQuery.isPending,
      session,
      salons,
      salon,
      selectSalon,
      refreshSalons,
      signOut,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>');
  return ctx;
}

/** For screens behind the salon guard: the current salon, guaranteed non-null. */
export function useCurrentSalon(): MySalon {
  const { salon } = useSession();
  if (!salon) throw new Error('useCurrentSalon used before a salon was created/selected');
  return salon;
}
