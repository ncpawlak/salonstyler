/** Stripe's minimum card charge for USD and most currencies. */
export const MIN_CARD_AMOUNT_CENTS = 50;

export interface CheckoutLine {
  quantity: number;
  unitAmountCents: number;
}

export interface CheckoutTotals {
  subtotalCents: number;
  tipCents: number;
  depositCents: number;
  amountDueCents: number;
}

/** Client-side mirror of `private.recompute_checkout` so the screen updates as lines change. */
export function checkoutTotals(
  lines: readonly CheckoutLine[],
  tipCents: number,
  depositCents: number,
): CheckoutTotals {
  const subtotalCents = lines.reduce((sum, l) => sum + l.quantity * l.unitAmountCents, 0);
  return {
    subtotalCents,
    tipCents,
    depositCents,
    amountDueCents: Math.max(subtotalCents + tipCents - depositCents, 0),
  };
}

export const TIP_PERCENTS = [15, 20, 25] as const;

/** Tip on the service subtotal (before any deposit), rounded to whole cents. */
export function tipForPercent(subtotalCents: number, percent: number): number {
  return Math.round((subtotalCents * percent) / 100);
}

/** "12.50" / "12,50" / "$12" -> 1250; null when it isn't a non-negative amount. */
export function parseAmountInput(text: string): number | null {
  const cleaned = text.replace(/[^\d.,]/g, '').replace(',', '.');
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  const [whole, fraction = ''] = cleaned.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

/** Masks a card for receipts and lists: "visa", "4242" -> "Visa •••• 4242". */
export function cardLabel(brand: string | null, last4: string | null): string {
  const name = brand
    ? brand === 'amex'
      ? 'Amex'
      : brand.charAt(0).toUpperCase() + brand.slice(1)
    : 'Card';
  return last4 ? `${name} •••• ${last4}` : name;
}
