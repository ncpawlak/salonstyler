# Full data export (#46)

No lock-in: an owner can download everything their salon owns and restore it into a fresh Chairside salon without losing anything.

## Using it

**Settings → Export your data** (owners only) has two parts:

- **Export now** calls the `data-export` Edge Function. It builds a zip, emails a download link to the owner, and returns a link for the share sheet (iOS/Android) or a download (web).
- **Restore from an export** uploads a zip and imports it into the current salon. The salon must be new and empty. Create the salon first, then restore.

## Archive layout

```
chairside-export-<slug>-<date>.zip
├── README.txt          what's inside and how to restore
├── data.json           the full export (the restore source of truth)
├── members.csv         who was on the team (informational; not restored)
├── csv/<table>.csv     one RFC 4180 CSV per table, for spreadsheets
└── photos/
    ├── <client photo files>
    └── links.csv       photos over the zip budget: signed links instead of files
```

`data.json` has `format`/`version`, the salon header (name, slug, timezone), and one array of rows per registered table. Bearer-token columns (manage, receipt, pay and waitlist tokens) are left out; the restore generates fresh ones. In the CSVs, text that starts with `= + - @` is prefixed with `'` so spreadsheets don't run it as a formula. Numbers and phone numbers are left as they are.

## How it works

- `public.export_salon_data(p_salon_id)` returns the JSON. Only the salon's **owner** can call it (`42501` otherwise), and it reads only rows where `salon_id = p_salon_id`.
- `public.import_salon_data(p_salon_id, p_export)` restores into an owned, empty salon (`55000` if the salon has data). It does this in one transaction:
  1. Assigns fresh UUIDs to every row and remaps every reference.
  2. Inserts the tables in foreign-key order.
  3. Checks the foreign keys itself, because the triggers are off during the load.
  4. Remaps user references (`stylist_id`, `created_by`, ...): a user who isn't in the new salon becomes the importing owner when the column is required, and is cleared when it's optional.
- Photos are re-uploaded to `client-photos` under the new salon.
- `private.data_export_diff(a, b)` compares two salons' exports with IDs normalised. The round-trip test uses it.
- The function `functions/data-export` verifies the caller's JWT. Its zip assembly and the photo, email and signed-URL logic live in `packages/ai/src/data-export` and `packages/core/src/data-export`, where they are unit tested.

## Security

- **Tenant isolation:** both RPCs check owner membership of the requested salon. The `data-exports` bucket is private, and its storage policies only let the owner of the first path segment (`{salon_id}/...`) read or delete. Uploads are only allowed at `{salon_id}/uploads/...`. The function also refuses restore paths outside the caller's salon.
- **Short-lived links:**
  - Share-sheet URL: 1 hour.
  - Emailed URL: 24 hours.
  - Exports and uploaded restore files are purged after 24 hours, on the next run.
- **Rate limits:** 5 exports and 5 restores per user per hour.

## Registering a new table (for future features)

Which tables are exported comes from the registry `private.data_export_tables`. **Every feature that adds a public table with a `salon_id` column registers it in its own migration**, so parallel PRs never edit a shared list:

```sql
-- in supabase/migrations/<your timestamp>_<feature>.sql, after the create table
select private.register_data_export('my_table');                         -- exported
select private.register_data_export('my_table', array['secret_token']);  -- minus a bearer token (needs a default)
select private.exclude_from_data_export('my_queue', 'Delivery queue');  -- deliberately not exported
```

- `supabase/tests/database/29_data_export.test.sql` **fails** when a `salon_id` table is in neither list, so a new table can't silently fall out of exports.
- Insert order on restore is derived from foreign keys, so you don't need to edit anything else. Foreign keys must be composite `(salon_id, id)` like the rest of the schema.
- If your migration ran before this one (as service recipes #18 did), register the table in a small follow-up migration with a later timestamp, like `20261109480001_data_export_service_recipes.sql`.
- Add a row to your own pgTAP seed if you want the round trip to cover your data. The shared test seeds every table that existed when #46 shipped.

## Local testing

```sh
npx supabase test db                       # 29_data_export: export A → import into B → diff is empty
npm test --workspace @chairside/core       # CSV / zip / remap
npm test --workspace @chairside/ai         # function handler: auth, isolation, links, purge
npx supabase functions serve data-export   # then use Settings → Export your data; the email lands in Mailpit
```

The function sends email through the same `EMAIL_FROM` / `PUBLIC_APP_URL` / `SMTP_*` (or `RESEND_API_KEY`) settings as the client emails. Locally, also set `PUBLIC_SUPABASE_URL=http://127.0.0.1:<api port>`: inside the functions runtime the API is `http://kong:8000`, which a browser can't open, so signed links get rewritten to this origin. Hosted projects don't need it.
