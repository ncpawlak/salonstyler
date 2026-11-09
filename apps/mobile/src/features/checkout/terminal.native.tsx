import type { CheckoutRecord } from '@chairside/payments';
import { createContext, use, useMemo, useRef, type ComponentType, type ReactNode } from 'react';
import { Platform } from 'react-native';

import { PaymentsRequestError } from '@/features/payments/api';
import { supabase } from '@/lib/supabase';

import { invokeCheckout } from './api';
import { testReader, type CardReader } from './reader';

/**
 * The slice of `@stripe/stripe-terminal-react-native` this screen uses. The SDK is an optional
 * dependency and needs a custom dev build (it isn't in Expo Go), so it's loaded lazily and typed
 * locally rather than imported.
 */
type StripeError = { code: string; message: string };
type PaymentIntent = { id: string };
type TerminalHook = {
  isInitialized: boolean;
  connectedReader: unknown;
  initialize(): Promise<{ error?: StripeError }>;
  easyConnect(params: {
    discoveryMethod: 'tapToPay';
    locationId: string;
    onBehalfOf?: string;
    merchantDisplayName?: string;
    tosAcceptancePermitted?: boolean;
    autoReconnectOnUnexpectedDisconnect?: boolean;
  }): Promise<{ error?: StripeError }>;
  retrievePaymentIntent(
    clientSecret: string,
  ): Promise<{ paymentIntent?: PaymentIntent; error?: StripeError }>;
  processPaymentIntent(params: {
    paymentIntent: PaymentIntent;
  }): Promise<{ paymentIntent?: PaymentIntent; error?: StripeError }>;
};
type TerminalSdk = {
  StripeTerminalProvider: ComponentType<{
    tokenProvider: () => Promise<string>;
    logLevel?: 'verbose' | 'error' | 'warning';
    children: ReactNode;
  }>;
  useStripeTerminal(): TerminalHook;
};

/**
 * Real Tap to Pay needs Apple's entitlement (com.apple.developer.proximity-reader.payment.acceptance),
 * a dev build with the SDK, and `EXPO_PUBLIC_TAP_TO_PAY=1`. Anything less uses the test reader.
 */
function loadSdk(): TerminalSdk | null {
  if (Platform.OS !== 'ios' || process.env.EXPO_PUBLIC_TAP_TO_PAY !== '1') return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@stripe/stripe-terminal-react-native') as TerminalSdk;
  } catch {
    return null;
  }
}

const sdk = loadSdk();

type Connection = { locationId: string; onBehalfOf: string };
const SalonContext = createContext<{ salonId: string; connection: { current: Connection | null } }>(
  { salonId: '', connection: { current: null } },
);

export function CardReaderProvider({
  salonId,
  children,
}: {
  salonId: string;
  children: ReactNode;
}) {
  const connection = useRef<Connection | null>(null);
  const value = useMemo(() => ({ salonId, connection }), [salonId]);
  if (!sdk) return children;
  const { StripeTerminalProvider } = sdk;
  const tokenProvider = async () => {
    const token = await invokeCheckout(supabase, { action: 'connection_token', salonId });
    connection.current = { locationId: token.locationId, onBehalfOf: token.onBehalfOf };
    return token.secret;
  };
  return (
    <SalonContext value={value}>
      <StripeTerminalProvider tokenProvider={tokenProvider} logLevel="error">
        {children}
      </StripeTerminalProvider>
    </SalonContext>
  );
}

function fail(error: StripeError): never {
  throw new PaymentsRequestError(error.code, error.message);
}

export function useCardReader(): CardReader {
  if (!sdk) return testReader;
  // `sdk` is fixed for the app's lifetime, so this branch never changes between renders.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useTapToPay(sdk);
}

function useTapToPay(terminalSdk: TerminalSdk): CardReader {
  const { salonId, connection } = use(SalonContext);
  const terminal = terminalSdk.useStripeTerminal();

  return {
    mode: 'tap_to_pay',
    chargeLabel: 'Charge with Tap to Pay',
    async charge(checkoutId): Promise<CheckoutRecord> {
      if (!terminal.isInitialized) {
        const { error } = await terminal.initialize();
        if (error) fail(error);
      }
      if (!terminal.connectedReader) {
        if (!connection.current) {
          const token = await invokeCheckout(supabase, { action: 'connection_token', salonId });
          connection.current = { locationId: token.locationId, onBehalfOf: token.onBehalfOf };
        }
        const { error } = await terminal.easyConnect({
          discoveryMethod: 'tapToPay',
          locationId: connection.current.locationId,
          onBehalfOf: connection.current.onBehalfOf,
          tosAcceptancePermitted: true,
          autoReconnectOnUnexpectedDisconnect: true,
        });
        if (error) fail(error);
      }

      const intent = await invokeCheckout(supabase, { action: 'create_intent', checkoutId });
      if ('checkout' in intent) return intent.checkout;

      const retrieved = await terminal.retrievePaymentIntent(intent.clientSecret);
      if (retrieved.error || !retrieved.paymentIntent) {
        fail(retrieved.error ?? { code: 'retrieve_failed', message: 'Couldn’t load the payment' });
      }
      const processed = await terminal.processPaymentIntent({
        paymentIntent: retrieved.paymentIntent,
      });
      if (processed.error) fail(processed.error);

      const { checkout } = await invokeCheckout(supabase, { action: 'complete', checkoutId });
      return checkout;
    },
  };
}
