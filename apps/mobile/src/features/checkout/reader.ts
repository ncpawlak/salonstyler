import type { CheckoutRecord } from '@chairside/payments';

import { supabase } from '@/lib/supabase';

import { invokeCheckout } from './api';

export type CardReaderMode = 'tap_to_pay' | 'test_reader';

export interface CardReader {
  /** `tap_to_pay` is the phone's NFC reader; `test_reader` is Stripe's simulated reader. */
  mode: CardReaderMode;
  chargeLabel: string;
  /** Collects the card for the checkout's amount due and returns the paid checkout. */
  charge(checkoutId: string): Promise<CheckoutRecord>;
}

/**
 * Charges through a Stripe simulated reader driven server-side (test mode only). Used on web,
 * in Expo Go, and on iOS until the Tap to Pay entitlement ships (see supabase/README.md).
 */
export const testReader: CardReader = {
  mode: 'test_reader',
  chargeLabel: 'Charge card (test reader)',
  async charge(checkoutId) {
    const { checkout } = await invokeCheckout(supabase, { action: 'simulate', checkoutId });
    return checkout;
  },
};
