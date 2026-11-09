# Hosted project setup (manual)

1. Create a project at https://supabase.com/dashboard (region near the salon). Note the project ref.
2. `npx supabase login` then `npx supabase link --project-ref <ref>`.
3. `npx supabase db push` to apply migrations.
4. **Auth → URL configuration:** set Site URL and add redirect URLs `chairside://**` (plus the web URL once deployed).
5. **Auth → Email templates → Magic link:** paste `supabase/templates/magic_link.html` (must include `{{ .Token }}` for the in-app code).
6. **Auth → SMTP:** configure a real sender (e.g. Resend); the built-in sender is heavily rate limited.
7. Put the project URL + anon/publishable key in the app's `.env` (`EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`). Never ship the service role key.
8. Deploy the AI gateway: `npx supabase functions deploy ai` (see [AI providers](ai-providers.md)). Vault is enabled by the migration.
9. Payments: deploy `payments` and `stripe-webhook` and set the Stripe secrets (see [Payments](payments.md)).

For the full pilot order (extensions, function deploys, Vault secrets, backups, TestFlight), see [docs/pilot-cutover.md](../../docs/pilot-cutover.md#3-hosted-supabase-checklist-manual).
