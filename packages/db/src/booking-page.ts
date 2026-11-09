import type { ChairsideClient, SalonSettings } from './index.ts';

/** Settings → Booking page: the public `/b/{slug}` page and whether its bookings auto-confirm. */
export type BookingPageSettings = Pick<
  SalonSettings,
  'public_booking_enabled' | 'booking_page_intro' | 'booking_page_faq' | 'autonomy'
>;

export type Autonomy = 'draft' | 'auto';

const BOOKING_PAGE_COLUMNS =
  'public_booking_enabled, booking_page_intro, booking_page_faq, autonomy';

export async function getBookingPageSettings(
  client: ChairsideClient,
  salonId: string,
): Promise<BookingPageSettings> {
  const { data, error } = await client
    .from('settings')
    .select(BOOKING_PAGE_COLUMNS)
    .eq('salon_id', salonId)
    .single();
  if (error) throw error;
  return data;
}

/** Owners only (RLS). */
export async function updateBookingPageSettings(
  client: ChairsideClient,
  salonId: string,
  changes: Partial<BookingPageSettings>,
): Promise<BookingPageSettings> {
  const { data, error } = await client
    .from('settings')
    .update(changes)
    .eq('salon_id', salonId)
    .select(BOOKING_PAGE_COLUMNS)
    .single();
  if (error) throw error;
  return data;
}
