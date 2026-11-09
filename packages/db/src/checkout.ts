import type { Json } from './database.types.ts';
import type { ChairsideClient, Enums, Tables } from './index.ts';

export type Checkout = Tables<'checkouts'>;
export type CheckoutItem = Tables<'checkout_items'>;
export type CheckoutStatus = Enums<'checkout_status'>;
export type CheckoutMethod = Enums<'checkout_method'>;
export type CheckoutItemKind = Enums<'checkout_item_kind'>;

export interface CheckoutWithItems extends Checkout {
  items: CheckoutItem[];
}

/** A line as sent to `update_checkout`. */
export interface CheckoutItemInput {
  kind: CheckoutItemKind;
  name: string;
  quantity?: number;
  unitAmountCents: number;
  sourceId?: string | null;
}

export async function getCheckout(
  client: ChairsideClient,
  checkoutId: string,
): Promise<CheckoutWithItems> {
  const { data, error } = await client
    .from('checkouts')
    .select('*, items:checkout_items(*)')
    .eq('id', checkoutId)
    .order('position', { referencedTable: 'checkout_items' })
    .single();
  if (error) throw error;
  return data;
}

/** Returns the appointment's checkout, drafting it from the booked services the first time. */
export async function startCheckout(
  client: ChairsideClient,
  appointmentId: string,
): Promise<CheckoutWithItems> {
  const { data, error } = await client.rpc('start_checkout', {
    p_appointment_id: appointmentId,
  });
  if (error) throw error;
  return getCheckout(client, data.id);
}

/** Replaces the lines and tip of an open checkout; totals and deposits are recomputed. */
export async function updateCheckout(
  client: ChairsideClient,
  checkoutId: string,
  items: CheckoutItemInput[],
  tipCents: number,
): Promise<CheckoutWithItems> {
  const { error } = await client.rpc('update_checkout', {
    p_checkout_id: checkoutId,
    p_items: items as unknown as Json,
    p_tip_cents: tipCents,
  });
  if (error) throw error;
  return getCheckout(client, checkoutId);
}

/** Settles an open checkout in cash or another off-app method; completes the appointment. */
export async function payCheckoutOffline(
  client: ChairsideClient,
  checkoutId: string,
  method: Exclude<CheckoutMethod, 'card'>,
): Promise<Checkout> {
  const { data, error } = await client.rpc('pay_checkout_offline', {
    p_checkout_id: checkoutId,
    p_method: method,
  });
  if (error) throw error;
  return data;
}

export interface ReceiptItem {
  kind: CheckoutItemKind;
  name: string;
  quantity: number;
  unitAmountCents: number;
  amountCents: number;
}

/** What the public receipt page shows (see public.get_receipt). */
export interface Receipt {
  salonName: string;
  timezone: string;
  clientName: string | null;
  appointmentStartsAt: string | null;
  paidAt: string;
  currency: string;
  subtotalCents: number;
  tipCents: number;
  depositCents: number;
  amountDueCents: number;
  method: CheckoutMethod;
  cardBrand: string | null;
  cardLast4: string | null;
  refundedCents: number;
  items: ReceiptItem[];
}

/** Public (anon): a paid checkout by its receipt token, or null. */
export async function getReceipt(client: ChairsideClient, token: string): Promise<Receipt | null> {
  const { data, error } = await client.rpc('get_receipt', { p_token: token });
  if (error) throw error;
  return (data as unknown as Receipt | null) ?? null;
}

export interface PayoutSummary {
  day: string;
  currency: string;
  checkouts: number;
  totalCents: number;
  cardCents: number;
  cashCents: number;
  otherCents: number;
  tipCents: number;
  refundedCents: number;
}

/** A day's takings (salon timezone; defaults to today). */
export async function getPayoutSummary(
  client: ChairsideClient,
  salonId: string,
  day?: string,
): Promise<PayoutSummary> {
  const { data, error } = await client.rpc('payout_summary', {
    p_salon_id: salonId,
    ...(day ? { p_day: day } : {}),
  });
  if (error) throw error;
  return data as unknown as PayoutSummary;
}

export type PaidCheckout = Pick<
  Checkout,
  | 'id'
  | 'appointment_id'
  | 'amount_due_cents'
  | 'tip_cents'
  | 'currency'
  | 'method'
  | 'card_brand'
  | 'card_last4'
  | 'paid_at'
  | 'stripe_payment_intent_id'
  | 'receipt_token'
> & { client: { name: string } | null; refunded_cents: number };

/** Most recent paid checkouts first, with card refunds (Settings → Payments, refunds). */
export async function listPaidCheckouts(
  client: ChairsideClient,
  salonId: string,
  limit = 20,
): Promise<PaidCheckout[]> {
  const { data, error } = await client
    .from('checkouts')
    .select(
      'id, appointment_id, amount_due_cents, tip_cents, currency, method, card_brand, card_last4, paid_at, stripe_payment_intent_id, receipt_token, client:clients(name)',
    )
    .eq('salon_id', salonId)
    .eq('status', 'paid')
    .order('paid_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  const intents = data.flatMap((c) =>
    c.stripe_payment_intent_id ? [c.stripe_payment_intent_id] : [],
  );
  const refunded = new Map<string, number>();
  if (intents.length) {
    const payments = await client
      .from('payments')
      .select('stripe_payment_intent_id, amount_refunded_cents')
      .eq('salon_id', salonId)
      .in('stripe_payment_intent_id', intents);
    if (payments.error) throw payments.error;
    for (const p of payments.data) {
      refunded.set(p.stripe_payment_intent_id, p.amount_refunded_cents);
    }
  }
  return data.map((c) => ({
    ...c,
    refunded_cents: c.stripe_payment_intent_id
      ? (refunded.get(c.stripe_payment_intent_id) ?? 0)
      : 0,
  }));
}
