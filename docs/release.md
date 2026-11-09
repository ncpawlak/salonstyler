# Releasing the iOS app (EAS Build, TestFlight, OTA updates)

How Chairside gets from this repo to an iPhone. The app is iPhone first (`ios.supportsTablet` is off). Android config exists but isn't built yet. The step-by-step pilot and Vagaro cutover is in [pilot-cutover.md](pilot-cutover.md).

## What's in the repo

| File | Purpose |
|---|---|
| `apps/mobile/eas.json` | Build profiles, update channels, remote build numbers |
| `apps/mobile/app.json` | Static config: name, scheme `chairside`, version, **bundle ID placeholder** `com.chairside.app`, icons, splash, permission strings, `runtimeVersion` |
| `apps/mobile/app.config.ts` | Per-variant bundle ID and name, push (APNs) mode, EAS Update URL, universal links, Sentry, Tap to Pay. Unit-tested in `src/lib/app-config.test.ts` |
| `apps/mobile/index.ts`, `src/lib/sentry.native.ts` | Entry point that starts Sentry before the router (native only, release builds only) |
| `.github/workflows/eas.yml` | Validates native config on PRs; builds or publishes updates on demand or on a `v*` tag |

## Profiles and variants

| Profile | `APP_VARIANT` | Bundle ID | Home-screen name | Distribution | Update channel | EAS environment | APNs |
|---|---|---|---|---|---|---|---|
| `development` | development | `<base>.dev` | Chairside Dev | internal (registered devices) | `development` | development | sandbox |
| `development-simulator` | development | `<base>.dev` | Chairside Dev | iOS Simulator (Mac only) | `development` | development | sandbox |
| `preview` | preview | `<base>.preview` | Chairside Preview | internal (registered devices) | `preview` | preview | production |
| `production` | production | `<base>` | Chairside | store → **TestFlight**, later the App Store | `production` | production | production |

`<base>` is `ios.bundleIdentifier` in `app.json`. All three variants can sit on one phone. The pilot uses **production builds through TestFlight**, so no device registration is needed for the stylist. `development` is for the developer's own phone (it needs `expo start` running), and `preview` is optional.

Without `APP_VARIANT` (local `npx expo start`, `eas update`), config resolves as production.

## Environment variables

Nothing secret is committed. `EXPO_PUBLIC_*` values end up in the app bundle, so they must be public by design (the Supabase **anon/publishable** key is; the service role key must never be used here).

Set these as **EAS environment variables**, once per environment (`development`, `preview`, `production`), in expo.dev → Project → Environment variables or with `eas env:create`. Builds and `eas update --environment <env>` read them; GitHub doesn't need them.

| Variable | Visibility | Needed | What |
|---|---|---|---|
| `EXPO_PUBLIC_SUPABASE_URL` | Plain text | **Yes** | `https://<ref>.supabase.co` |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | Plain text | **Yes** | Project anon/publishable key |
| `EXPO_PUBLIC_WEB_URL` | Plain text | Recommended | Public web origin (booking page, receipts). An `https` value also turns on universal links for that host |
| `EXPO_PUBLIC_BRIDGE_SHORTCUT_URL` | Plain text | Recommended | Published Chairside Bridge shortcut ([shortcut-bridge.md](shortcut-bridge.md)) |
| `EXPO_PUBLIC_SENTRY_DSN` | Plain text | Recommended | Sentry DSN. Unset = no error reporting |
| `SENTRY_ORG`, `SENTRY_PROJECT` | Plain text | With Sentry | For source map upload |
| `SENTRY_AUTH_TOKEN` | **Secret** | With Sentry | Uploads source maps during builds. Unset = builds still work, stack traces are minified |
| `EXPO_PUBLIC_TAP_TO_PAY` | Plain text | Only after #1 | `1` once Apple grants the Tap to Pay entitlement ([checkout.md](../supabase/docs/checkout.md)) |

`APP_VARIANT` is set per profile in `eas.json`. `EAS_PROJECT_ID` is only a fallback; the project ID normally lives in `app.json` (below).

Locally, `apps/mobile/.env` (from `.env.example`) still drives `expo start`. To pull an EAS environment into it: `npx eas-cli@latest env:pull --environment development`.

GitHub needs a single repository secret, **`EXPO_TOKEN`** (expo.dev → Account settings → Access tokens, a robot user's token is best). Until it exists the EAS workflow skips its build/update job with a notice and stays green.

## Versions

- **`version`** in `app.json` (e.g. `0.1.0`) is the user-facing version. Bump it by hand, and **always** when native code changes (new native module, config plugin, permission, entitlement, Expo SDK upgrade).
- **Build number** (`CFBundleVersion`) is managed by EAS (`cli.appVersionSource: remote`) and incremented on every production build (`autoIncrement`). Nobody edits it. To start from a specific number: `npx eas-cli@latest build:version:set -p ios`.
- **`runtimeVersion`** uses the `appVersion` policy, so it equals `version`. An OTA update only reaches builds with the same runtime version. That's why `version` must change with native changes: old binaries keep getting compatible JS-only updates, and new JS that needs new native code only reaches the new binary.

## Release strategy

1. **JS-only change** (screens, copy, logic, most bug fixes): merge to `main`, then publish an OTA update (below). The stylist gets it the next time the app launches from cold (it downloads in the background and applies on the following launch; `checkAutomatically: ON_LOAD`, `fallbackToCacheTimeout: 0`, so launch is never blocked).
2. **Native change** (new native dependency, plugin, permission, entitlement, push/associated-domain change, SDK upgrade, icon/splash): bump `version`, merge, then tag `v<version>` and push the tag. The workflow builds production and auto-submits to TestFlight. Install it from the TestFlight app (it takes ~10–30 min for Apple to process).
3. **Database migration**: apply it to the hosted project (`npx supabase db push`) **before** shipping app code that needs it. Migrations must stay backward compatible with the app version currently on the phone (add columns/RPCs; don't drop or rename until the old app is gone).
4. **Edge Function change**: `npx supabase functions deploy <name>` (flags in [pilot-cutover.md](pilot-cutover.md#3-hosted-supabase-checklist-manual)). Functions should accept requests from the previous app version.

Order for a release that touches everything: migration → functions → OTA update or build.

### Commands (from `apps/mobile`)

```bash
# OTA update to the TestFlight/production app (preview a channel first if you like)
npx eas-cli@latest update --channel production --environment production --message "Fix X"

# Build manually (the tag workflow does this for you)
npx eas-cli@latest build -p ios --profile production --auto-submit
npx eas-cli@latest build -p ios --profile development     # dev client for your own phone
```

Or use **Actions → EAS → Run workflow** (`action: build|update`, `profile`). Tagging `v0.2.0` runs a production build plus TestFlight submit.

### Rolling back

- **Bad OTA update:** `npx eas-cli@latest update:rollback` (pick the channel; it rolls back to the previous update or to the embedded bundle), or republish a known-good commit with `eas update`. Phones pick it up on the next cold start.
- **Bad binary:** in App Store Connect → TestFlight, expire the build. In the TestFlight app on the phone, **Previous Builds** installs an earlier one. Fix forward with a new tag.
- **Bad migration:** there are no down migrations. Write a new forward migration. For data loss, restore from a backup (see the pilot runbook).

## Error reporting (Sentry)

`src/lib/sentry.native.ts` starts Sentry only in release builds with `EXPO_PUBLIC_SENTRY_DSN` set. It sends no default PII, drops console breadcrumbs (they can contain client data), records no performance traces, and tags each event with the update channel, runtime version and update ID. The environment is the app variant. The web build doesn't include Sentry.

Builds upload source maps when `SENTRY_AUTH_TOKEN` is set. For OTA updates, upload them after publishing: `SENTRY_AUTH_TOKEN=... npx sentry-expo-upload-sourcemaps dist` (from `apps/mobile`, using the `dist/` that `eas update` just wrote).

## CI checks

`.github/workflows/eas.yml` → **Validate native config** runs on PRs that touch native config (`app.json`, `app.config.ts`, `eas.json`, assets, dependencies). For each variant it resolves the config, runs `expo prebuild --platform ios` on Linux, and checks the bundle ID, APNs environment, Sign in with Apple and associated-domain entitlements, the encryption-exemption key, the photo permission strings and the EAS Update URL. It also runs `expo-doctor`.

`eas build --local` needs macOS + Xcode, so CI doesn't run it.
