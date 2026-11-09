const { getSentryExpoConfig } = require('@sentry/react-native/metro');
const { withNativeWind } = require('nativewind/metro');

// Expo's default config (it auto-detects the npm workspaces monorepo) plus Sentry debug IDs, so
// uploaded source maps match the bundles in EAS builds and updates.
const config = getSentryExpoConfig(__dirname);

module.exports = withNativeWind(config, { input: './src/global.css' });
