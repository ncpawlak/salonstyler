# Sign in with Apple (manual)

Native iOS sign-in uses `expo-apple-authentication` and `supabase.auth.signInWithIdToken({ provider: 'apple', token })`, so no secret is needed for the iOS app itself.

1. Apple Developer → Identifiers: enable **Sign in with Apple** on the app's bundle ID.
2. (Web/public page only) Create a **Services ID** + a Sign in with Apple **key**, then generate the client secret JWT (it expires every 6 months).
3. Supabase dashboard → Auth → Providers → Apple: enable; **Client IDs** = `<bundle id>,<services id>`; secret = the JWT from step 2 (web only).
4. Locally: set `SUPABASE_AUTH_EXTERNAL_APPLE_CLIENT_ID` / `SUPABASE_AUTH_EXTERNAL_APPLE_SECRET` in `.env` and flip `[auth.external.apple] enabled = true` in `config.toml`.

App Store rule: if the app offers any third-party sign-in, it must also offer Sign in with Apple.
