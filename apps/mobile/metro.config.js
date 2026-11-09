const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');

// Expo's default config auto-detects the npm workspaces monorepo.
const config = getDefaultConfig(__dirname);

module.exports = withNativeWind(config, { input: './src/global.css' });
