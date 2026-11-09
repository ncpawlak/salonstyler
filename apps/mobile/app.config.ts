import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * Extends app.json with Tap to Pay on iPhone, which only applies to custom iOS builds:
 * - The Stripe Terminal SDK's config plugin, when the optional dependency is installed (it isn't
 *   on every platform, and Expo Go can't load it anyway).
 * - Apple's Tap to Pay entitlement, only with `EXPO_PUBLIC_TAP_TO_PAY=1`. Builds signed without
 *   the entitlement on their provisioning profile fail, so leave it off until Apple grants it.
 * See supabase/README.md -> "Checkout and Tap to Pay".
 */
const TAP_TO_PAY_ENTITLEMENT = 'com.apple.developer.proximity-reader.payment.acceptance';
const TERMINAL_PLUGIN = '@stripe/stripe-terminal-react-native';

function hasTerminalSdk(): boolean {
  try {
    require.resolve(TERMINAL_PLUGIN);
    return true;
  } catch {
    return false;
  }
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const tapToPay = process.env.EXPO_PUBLIC_TAP_TO_PAY === '1';
  const plugins = [...(config.plugins ?? [])];
  if (hasTerminalSdk()) {
    plugins.push([
      TERMINAL_PLUGIN,
      {
        bluetoothBackgroundMode: false,
        locationWhenInUsePermission:
          'Chairside uses your location to take card payments with Tap to Pay.',
        tapToPayCheck: tapToPay,
      },
    ]);
  }
  return {
    ...config,
    name: config.name ?? 'Chairside',
    slug: config.slug ?? 'chairside',
    plugins,
    ios: {
      ...config.ios,
      entitlements: {
        ...config.ios?.entitlements,
        ...(tapToPay ? { [TAP_TO_PAY_ENTITLEMENT]: true } : {}),
      },
    },
  };
};
