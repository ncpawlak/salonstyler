import { existsSync } from 'node:fs';

import type { ExpoConfig } from 'expo/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import appJson from '../../app.json';
import resolveConfig, { appVariant, associatedDomain } from '../../app.config';

const base = appJson.expo as ExpoConfig;
const resolve = (config: ExpoConfig = base) =>
  resolveConfig({ config, projectRoot: '.', staticConfigPath: null, packageJsonPath: null });

const pluginNames = (config: ExpoConfig) =>
  (config.plugins ?? []).map((p) => (Array.isArray(p) ? p[0] : p));

afterEach(() => vi.unstubAllEnvs());

describe('appVariant', () => {
  it('defaults to production and rejects typos', () => {
    expect(appVariant(undefined)).toBe('production');
    expect(appVariant('preview')).toBe('preview');
    expect(() => appVariant('prod')).toThrow(/APP_VARIANT/);
  });
});

describe('associatedDomain', () => {
  it('only uses a real https host', () => {
    expect(associatedDomain('https://book.example.com/')).toBe('book.example.com');
    expect(associatedDomain('http://book.example.com')).toBeNull();
    expect(associatedDomain('https://localhost:8081')).toBeNull();
    expect(associatedDomain('not a url')).toBeNull();
    expect(associatedDomain(undefined)).toBeNull();
  });
});

describe('app.config', () => {
  it('gives each variant its own bundle ID and name', () => {
    vi.stubEnv('APP_VARIANT', 'development');
    const dev = resolve();
    expect(dev.ios?.bundleIdentifier).toBe(`${base.ios?.bundleIdentifier}.dev`);
    expect(dev.name).toBe('Chairside Dev');

    vi.stubEnv('APP_VARIANT', 'preview');
    expect(resolve().ios?.bundleIdentifier).toBe(`${base.ios?.bundleIdentifier}.preview`);

    vi.stubEnv('APP_VARIANT', 'production');
    const prod = resolve();
    expect(prod.ios?.bundleIdentifier).toBe(base.ios?.bundleIdentifier);
    expect(prod.name).toBe('Chairside');
    expect(prod.extra?.appVariant).toBe('production');
  });

  it('uses the APNs sandbox only for development builds', () => {
    const mode = (config: ExpoConfig) =>
      (config.plugins ?? []).find(
        (p): p is [string, { mode: string }] => Array.isArray(p) && p[0] === 'expo-notifications',
      )?.[1].mode;
    vi.stubEnv('APP_VARIANT', 'development');
    expect(mode(resolve())).toBe('development');
    vi.stubEnv('APP_VARIANT', 'production');
    expect(mode(resolve())).toBe('production');
  });

  it('turns EAS Update on only once there is a project ID', () => {
    vi.stubEnv('EAS_PROJECT_ID', '');
    expect(resolve().updates).toEqual({ enabled: false });

    const linked = resolve({ ...base, extra: { eas: { projectId: 'abc-123' } } });
    expect(linked.updates?.url).toBe('https://u.expo.dev/abc-123');
    expect(linked.runtimeVersion).toEqual({ policy: 'appVersion' });

    vi.stubEnv('EAS_PROJECT_ID', 'from-env');
    expect(resolve().extra?.eas?.projectId).toBe('from-env');
  });

  it('adds universal links for the public web URL', () => {
    vi.stubEnv('EXPO_PUBLIC_WEB_URL', '');
    expect(resolve().ios?.associatedDomains).toBeUndefined();
    vi.stubEnv('EXPO_PUBLIC_WEB_URL', 'https://book.example.com');
    expect(resolve().ios?.associatedDomains).toEqual([
      'applinks:book.example.com',
      'webcredentials:book.example.com',
    ]);
  });

  it('adds the Tap to Pay entitlement only when asked', () => {
    vi.stubEnv('EXPO_PUBLIC_TAP_TO_PAY', '');
    expect(resolve().ios?.entitlements).toEqual({});
    vi.stubEnv('EXPO_PUBLIC_TAP_TO_PAY', '1');
    expect(
      resolve().ios?.entitlements?.['com.apple.developer.proximity-reader.payment.acceptance'],
    ).toBe(true);
  });

  it('keeps the shipping settings TestFlight needs', () => {
    const config = resolve();
    expect(config.ios?.config?.usesNonExemptEncryption).toBe(false);
    expect(config.ios?.usesAppleSignIn).toBe(true);
    expect(config.scheme).toBe('chairside');
    expect(pluginNames(config)).toEqual(
      expect.arrayContaining([
        'expo-notifications',
        'expo-splash-screen',
        '@sentry/react-native',
        'expo-apple-authentication',
      ]),
    );
  });

  it('uploads Sentry source maps only with an auth token', () => {
    const sentry = (config: ExpoConfig) =>
      (config.plugins ?? []).find(
        (p): p is [string, { disableAutoUpload: boolean }] =>
          Array.isArray(p) && p[0] === '@sentry/react-native',
      )?.[1];
    vi.stubEnv('SENTRY_AUTH_TOKEN', '');
    expect(sentry(resolve())?.disableAutoUpload).toBe(true);
    vi.stubEnv('SENTRY_AUTH_TOKEN', 'x');
    expect(sentry(resolve())?.disableAutoUpload).toBe(false);
  });

  it('adds the iOS Share Extension, named per variant so dev and TestFlight builds coexist', () => {
    const share = (config: ExpoConfig) =>
      (config.plugins ?? []).find(
        (p): p is [string, Record<string, unknown>] =>
          Array.isArray(p) && p[0] === 'expo-share-intent',
      )?.[1];
    vi.stubEnv('APP_VARIANT', 'development');
    expect(share(resolve())).toMatchObject({
      iosShareExtensionName: 'Save to Chairside Dev',
      iosActivationRules: {
        NSExtensionActivationSupportsText: true,
        NSExtensionActivationSupportsImageWithMaxCount: 1,
      },
      disableAndroid: true,
    });
    vi.stubEnv('APP_VARIANT', 'production');
    expect(share(resolve())?.iosShareExtensionName).toBe('Save to Chairside');
  });

  it('adds the WidgetKit extension per variant, sharing the App Group with the share extension', () => {
    const widgets = (config: ExpoConfig) =>
      (config.plugins ?? []).find(
        (
          p,
        ): p is [
          string,
          {
            bundleIdentifier: string;
            groupIdentifier: string;
            widgets: { name: string; ios: { initialLayout: string } }[];
          },
        ] => Array.isArray(p) && p[0] === 'expo-widgets',
      )?.[1];
    vi.stubEnv('APP_VARIANT', 'preview');
    const preview = widgets(resolve());
    expect(preview?.bundleIdentifier).toBe('com.chairside.app.preview.widgets');
    expect(preview?.groupIdentifier).toBe('group.com.chairside.app.preview');
    vi.stubEnv('APP_VARIANT', 'production');
    const prod = widgets(resolve());
    expect(prod?.groupIdentifier).toBe('group.com.chairside.app');
    expect(prod?.widgets.map((w) => w.name)).toEqual([
      'ChairsideNextClient',
      'ChairsideDayBooked',
      'ChairsideRequests',
    ]);
    for (const w of prod?.widgets ?? [])
      expect(existsSync(new URL(`../../${w.ios.initialLayout}`, import.meta.url))).toBe(true);
  });
});
