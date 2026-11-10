# Supabase (backend)

Multi-tenant Postgres for Chairside. Every tenant row carries `salon_id`, and RLS scopes access by `salon_members` (see [`docs/PLAN.md` §13](../docs/PLAN.md#13-data-model-all-rows-carry-salon_id-rls-by-membership)).

Docs are split by feature so parallel PRs don't edit the same file. When you add a feature, add a new `docs/<feature>.md` and one line here.

- [Local development](docs/local-development.md): start the stack, reset, run the pgTAP tests, smoke check.
- [Schema](docs/schema.md): foundation tables, the service builder, and adding a tenant table.
- [AI providers](docs/ai-providers.md): bring your own key, the `ai` gateway, and Ask Chairside (`functions/ai-assistant`).
- [Inbox agent](docs/inbox.md): `functions/inbox` (#34).
- [Client replies](docs/client-replies.md) (#7).
- [Public booking page](docs/public-booking.md): `functions/public-booking` (#14).
- [Import from Vagaro](docs/import-vagaro.md) (#15).
- [Import services from Vagaro](docs/import-vagaro-services.md): `functions/import-services` (#16).
- [Payments](docs/payments.md): Stripe Connect.
- [Checkout and Tap to Pay](docs/checkout.md) (#11).
- [Rebook at checkout](docs/rebook.md) (#42).
- [Deposits and cancellation policy](docs/deposits.md): `functions/deposits` (#12).
- [Push notifications](docs/push-notifications.md) (#8), including the notifier Vault secrets.
- [Client self-service](docs/client-self-service.md) (#10): manage link (`functions/manage-booking`), client emails and the reminder queue.
- [Hosted project setup](docs/hosted-setup.md).
- [Sign in with Apple](docs/sign-in-with-apple.md).

`packages/db/src/database.types.ts` is generated: after a migration run `npm run gen:types --workspace @chairside/db`. CI fails if it is stale. On a merge conflict in it, take either side and re-run the command.