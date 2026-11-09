import type { AiErrorBody } from '@chairside/ai';
import type {
  ConciergeMessage,
  PublicBookResponse,
  PublicChatResponse,
  PublicMyBookingsResponse,
  PublicPageResponse,
  PublicSendCodeResponse,
  PublicSlotsResponse,
} from '@chairside/ai/public-booking';
import { createChairsideClient, type ChairsideClient } from '@chairside/db';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { AiRequestError } from '@/features/ai-settings/api';

/**
 * The booking page's own Supabase client. Clients who verify their email get a session here,
 * stored under its own key so it never mixes with the salon owner's app session.
 */
let clientAuth: ChairsideClient | null = null;
export function bookingClient(): ChairsideClient {
  if (clientAuth) return clientAuth;
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error('Supabase is not configured');
  clientAuth = createChairsideClient(url, anonKey, {
    auth: {
      storage: AsyncStorage,
      storageKey: 'chairside-client-auth',
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  });
  return clientAuth;
}

export { AiRequestError as BookingRequestError };

async function readError(error: unknown): Promise<AiRequestError> {
  const context = (error as { context?: unknown }).context;
  if (context instanceof Response) {
    try {
      const body = (await context.json()) as Partial<AiErrorBody>;
      if (body.error) return new AiRequestError(body.error.code, body.error.message);
    } catch {
      // fall through
    }
  }
  return new AiRequestError('network', 'Can’t reach the booking service. Check your connection.');
}

async function invoke<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await bookingClient().functions.invoke<T>('public-booking', { body });
  if (error) throw await readError(error);
  if (!data) throw new AiRequestError('invalid_response', 'Empty response from the booking page');
  return data;
}

export type BookingItem = { serviceId: string; variantId?: string | null };

/** Calls the `public-booking` Edge Function. Slots come from the scheduling engine server-side. */
export function publicBookingApi(slug: string) {
  return {
    page: () => invoke<PublicPageResponse>({ action: 'page', slug }),
    slots: (r: { services: BookingItem[]; date: string }) =>
      invoke<PublicSlotsResponse>({ action: 'slots', slug, ...r }),
    sendCode: (r: { email: string; phone: string }) =>
      invoke<PublicSendCodeResponse>({ action: 'send_code', slug, ...r }),
    book: (r: {
      services: BookingItem[];
      start: string;
      name: string;
      phone: string;
      notes?: string | null;
    }) => invoke<PublicBookResponse>({ action: 'book', slug, ...r }),
    myBookings: () => invoke<PublicMyBookingsResponse>({ action: 'my_bookings', slug }),
    chat: (r: { history: ConciergeMessage[]; text: string }) =>
      invoke<PublicChatResponse>({ action: 'chat', slug, ...r }),
  };
}

export type PublicBookingApi = ReturnType<typeof publicBookingApi>;

/** Confirms the 6-digit code from the email; the session stays on the booking page's client. */
export async function verifyEmailCode(email: string, code: string): Promise<void> {
  const { error } = await bookingClient().auth.verifyOtp({ email, token: code, type: 'email' });
  if (error) {
    throw new AiRequestError('invalid_code', 'That code didn’t work. Check it and try again.');
  }
}

/** The email of the client already verified on this device, if any. */
export async function verifiedEmail(): Promise<string | null> {
  const { data } = await bookingClient().auth.getSession();
  return data.session?.user.email ?? null;
}

export async function signOutClient(): Promise<void> {
  await bookingClient().auth.signOut({ scope: 'local' });
}
