import type { ChairsideClient, Payment, StripeAccount } from './index.ts';

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
