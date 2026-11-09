# AI providers (bring your own key)

Owners pick OpenAI, Anthropic or Gemini in **Settings → AI assistant** (`apps/mobile/src/app/(app)/settings/ai.tsx`) and paste an API key. The LLM only interprets requests; slot math stays in `packages/core`.

| Object | Purpose | Access (authenticated) |
|---|---|---|
| `ai_provider_config` | 1:1 per salon: provider, model, `monthly_token_budget` (0 = AI off), masked `key_hint` | Members read; written **only** via the RPCs below |
| `ai_usage` | One row per LLM call: provider, model, purpose, input/output tokens | Members read; inserted only by the `ai` Edge Function (service role) |
| `private.ai_provider_secrets` | `salon_id → vault.secrets.id`. The key itself is encrypted in Supabase Vault | No access |

RPCs:
- `save_ai_provider_config(p_salon_id, p_provider, p_model, p_monthly_token_budget, p_api_key?)`: owner only. Writes the key to Vault and returns the public row (never the key). A key is required on first save and when switching provider; omit it to keep the saved key.
- `delete_ai_provider_config(p_salon_id)`: owner only. Also destroys the Vault secret.
- `ai_tokens_used_this_month(p_salon_id)`: members; calendar month in the salon's timezone.
- `get_ai_provider_secret(p_salon_id)`: **service role only** (the Edge Function). Returns the decrypted key.

All LLM calls go through the `ai` Edge Function (`functions/ai`), which verifies the user's JWT, checks membership, enforces the monthly budget, loads the key server-side, calls the provider via `@chairside/ai`, and records usage. Provider errors are returned with the key redacted. Actions: `test` (owner; tests the saved key, or a pasted key before saving), `chat` (any member) and `map_columns` (any member; see [Import from Vagaro](import-vagaro.md)).

```bash
npx supabase functions serve ai   # local; uses the local stack's URL and keys automatically
```

Deploy: `npx supabase functions deploy ai`. The function imports `packages/ai/src` through `functions/ai/deno.json`, so deploy from the repo root. `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are provided by the platform; provider keys are **not** function secrets, they come from Vault per salon.

Provider contract tests replay fixtures in `packages/ai/fixtures` (no network in CI). To re-record against the live APIs: `OPENAI_API_KEY=… ANTHROPIC_API_KEY=… GEMINI_API_KEY=… npm run record:fixtures --workspace @chairside/ai` (keys are redacted from fixtures; review the diff before committing).

## Ask Chairside (`functions/ai-assistant`)

The owner's chat assistant. It uses the same JWT, membership, Vault-key and budget wiring as `ai` (shared in `functions/_shared/ai-deps.ts`) and runs the tool-calling loop from `@chairside/ai/assistant` server-side. Tools read and write through the **caller's JWT**, so RLS scopes them to their salon. The model only interprets the request and calls tools: `find_client`, `list_services`, `find_slots` (the `packages/core` engine on the requested day and the days around it), `get_day_summary`, `propose_booking` (a `held` appointment with notes `Drafted by Ask Chairside`) and `cancel_draft`. Confirming is **not** a model tool; the app calls it when the owner taps Confirm. Every tool call is written to `audit_log` (`entity_type = 'ai_assistant'`).

Actions: `status`, `message` (`{history, text}`; the app resends the returned `messages` as history, so nothing is stored server-side), `propose`, `confirm`, `discard`, `create_client`, `draft_running_late` (#37) and `draft_reply` (#7, see [Client replies](client-replies.md)). With no key, `message` returns `409 not_configured` and the app links to Settings → AI assistant.

```bash
npx supabase functions serve                     # serves ai + ai-assistant
# Local demo without a key: a scripted, rule-based provider (never in production; it only turns on
# when SUPABASE_URL is a local stack). Put CHAIRSIDE_AI_DEMO=1 in an env file outside the repo:
npx supabase functions serve --env-file /tmp/chairside-demo.env
SUPABASE_ANON_KEY=… npm run smoke:assistant --workspace @chairside/ai   # end-to-end check
```

Deploy: `npx supabase functions deploy ai-assistant` (from the repo root, like `ai`).
