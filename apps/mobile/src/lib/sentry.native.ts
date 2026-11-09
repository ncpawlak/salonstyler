// Crash and error reporting for native builds (EAS). Off in dev and when EXPO_PUBLIC_SENTRY_DSN is unset.
import * as Sentry from '@sentry/react-native';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';

const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;

if (dsn && !__DEV__) {
  const extra = Constants.expoConfig?.extra as { appVariant?: string } | undefined;
  Sentry.init({
    dsn,
    environment: extra?.appVariant ?? 'production',
    // Client names, phones and notes must never leave the device in error reports.
    sendDefaultPii: false,
    tracesSampleRate: 0,
    beforeBreadcrumb: (crumb) => (crumb.category === 'console' ? null : crumb),
  });
  Sentry.setTags({
    channel: Updates.channel ?? 'none',
    runtime_version: Updates.runtimeVersion ?? 'none',
    update_id: Updates.updateId ?? 'embedded',
  });
}
