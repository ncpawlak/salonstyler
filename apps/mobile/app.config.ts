import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * Dynamic layer over app.json. Every input is a non-secret build-time env var, set per profile in
 * eas.json (`APP_VARIANT`) or as EAS environment variables. See docs/release.md.
 *
 * - `APP_VARIANT` = development | preview | production (default). Development and preview get
 *   their own bundle ID and name so they install next to the TestFlight app.
 * - `extra.eas.projectId` (app.json, written once after `eas init`) or `EAS_PROJECT_ID` turns on
 *   EAS Update. Without it the build has OTA updates off and push tokens report "no project".
 * - `EXPO_PUBLIC_WEB_URL` (https) adds universal links + shared web credentials for that host, so
 *   `/b/<slug>` and `/receipt/<token>` links open the app when it's installed.
 * - Sentry: the plugin is always on; source maps upload only when `SENTRY_AUTH_TOKEN` is present.
 * - Tap to Pay on iPhone, which only applies to custom iOS builds:
 *   - The Stripe Terminal SDK's config plugin, when the optional dependency is installed (it isn't
 *     on every platform, and Expo Go can't load it anyway).
 *   - Apple's Tap to Pay entitlement, only with `EXPO_PUBLIC_TAP_TO_PAY=1`. Builds signed without
 *     the entitlement on their provisioning profile fail, so leave it off until Apple grants it.
 *     See supabase/docs/checkout.md.
 */
const TAP_TO_PAY_ENTITLEMENT = 'com.apple.developer.proximity-reader.payment.acceptance';
const TERMINAL_PLUGIN = '@stripe/stripe-terminal-react-native';

export type AppVariant = 'development' | 'preview' | 'production';

const VARIANTS: Record<AppVariant, { suffix: string; nameSuffix: string }> = {
  development: { suffix: '.dev', nameSuffix: ' Dev' },
  preview: { suffix: '.preview', nameSuffix: ' Preview' },
  production: { suffix: '', nameSuffix: '' },
};

export function appVariant(value = process.env.APP_VARIANT): AppVariant {
  if (!value) return 'production';
  if (value in VARIANTS) return value as AppVariant;
  throw new Error(`APP_VARIANT must be development, preview or production (got "${value}").`);
}

/** Hostname for universal links, only for a real https origin (not localhost). */
export function associatedDomain(webUrl = process.env.EXPO_PUBLIC_WEB_URL): string | null {
  if (!webUrl) return null;
  try {
    const { protocol, hostname } = new URL(webUrl);
    if (protocol !== 'https:' || hostname === 'localhost') return null;
    return hostname;
  } catch {
    return null;
  }
}

function hasTerminalSdk(): boolean {
  try {
    require.resolve(TERMINAL_PLUGIN);
    return true;
  } catch {
    return false;
  }
}

type Extra = { eas?: { projectId?: string } } & Record<string, unknown>;

export default ({ config }: ConfigContext): ExpoConfig => {
  const variant = appVariant();
  const { suffix, nameSuffix } = VARIANTS[variant];
  const tapToPay = process.env.EXPO_PUBLIC_TAP_TO_PAY === '1';
  const extra = (config.extra ?? {}) as Extra;
  const projectId = extra.eas?.projectId || process.env.EAS_PROJECT_ID || undefined;
  const domain = associatedDomain();
  const baseBundleId = config.ios?.bundleIdentifier ?? 'com.chairside.app';
  const basePackage = config.android?.package ?? 'com.chairside.app';

  const plugins: NonNullable<ExpoConfig['plugins']> = [
    ...(config.plugins ?? []),
    // Development builds talk to the APNs sandbox; preview/TestFlight/App Store use production.
    ['expo-notifications', { mode: variant === 'development' ? 'development' : 'production' }],
    [
      '@sentry/react-native',
      {
        organization: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        disableAutoUpload: !process.env.SENTRY_AUTH_TOKEN,
      },
    ],
  ];
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
    name: `${config.name ?? 'Chairside'}${nameSuffix}`,
    slug: config.slug ?? 'chairside',
    plugins,
    extra: {
      ...extra,
      appVariant: variant,
      ...(projectId ? { eas: { ...extra.eas, projectId } } : {}),
    },
    updates: projectId
      ? {
          url: `https://u.expo.dev/${projectId}`,
          // Launch immediately from the cached bundle; a downloaded update applies on next launch.
          checkAutomatically: 'ON_LOAD',
          fallbackToCacheTimeout: 0,
        }
      : { enabled: false },
    ios: {
      ...config.ios,
      bundleIdentifier: `${baseBundleId}${suffix}`,
      ...(domain ? { associatedDomains: [`applinks:${domain}`, `webcredentials:${domain}`] } : {}),
      entitlements: {
        ...config.ios?.entitlements,
        ...(tapToPay ? { [TAP_TO_PAY_ENTITLEMENT]: true } : {}),
      },
    },
    android: {
      ...config.android,
      package: `${basePackage}${suffix}`,
    },
  };
};
