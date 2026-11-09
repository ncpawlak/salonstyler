# Import services from Vagaro (#16)

Settings → Import services (also linked from Settings → Import from Vagaro) brings a salon's Vagaro service menu into the service builder. The owner gives one of three inputs:

- **Booking page link** (`vagaro.com/your-salon`). The `import-services` function fetches it **server-side**.
- **Menu screenshot.** The salon's AI reads it with a vision model.
- **Pasted menu text.** It's read by the salon's AI, or line by line when no key is set.

The model only **extracts** what the menu shows: names, categories, lengths, prices, and processing gaps when they're stated. It calls one tool, `record_services` (`packages/ai/src/import/services.ts`). Everything after that is deterministic code in `packages/core/src/import/services.ts`:

- `sanitizeExtractedServices` bounds every field, parses "1 hr 30 min" and "$85+", and dedupes by name.
- `planServiceImport` matches rows to the active menu by name, ignoring case and punctuation.
- `serviceImportIssues` blocks rows `save_service` would reject.
- `serviceImportPayload` builds the RPC payload.

Nothing is saved until the owner reviews every row.

## `functions/import-services`

`POST /functions/v1/import-services` with the user's JWT. Owners only (`403` otherwise). Bodies:

| `source` | Body | Notes |
|---|---|---|
| `url` | `{ salonId, url }` | Only `https://(www.)vagaro.com` URLs, with no port or credentials. Redirects are followed manually (≤3), and every hop is re-checked against that host. 10 s timeout, 3 MB cap. Scripts and markup are stripped; JSON-LD `Service`/`Offer` entries are kept. |
| `text` | `{ salonId, text }` | ≤20,000 characters. |
| `image` | `{ salonId, mimeType, data }` | Base64 PNG/JPEG/WebP/GIF, ≤8 MB. |

The response is `{ services: ExtractedService[], source: 'ai' | 'demo' | 'parser', notice? }`. Usage is metered as `purpose = 'import_services'`.

Failures, and what the app does with each:

| Error | When | App |
|---|---|---|
| `400 unsupported_url` | Not a vagaro.com link | Shows the message and offers a screenshot |
| `502 page_fetch_failed` | Network error, non-2xx, timeout, too large, or an off-site redirect | Offers a screenshot |
| `422 page_unreadable` | The page has no prices or lengths in its HTML | Offers a screenshot |
| `422 no_services_found` | Nothing usable came back | Offers a screenshot |
| `409 not_configured` / `429 budget_exceeded` | Screenshot without AI, or over the monthly budget | Suggests pasting the text |

Vagaro renders most service menus in the browser, so `page_unreadable` is the common answer for a link. The screenshot is the reliable path. The function never calls Vagaro's private APIs.

Text never fails for lack of AI. With no key, an exhausted budget, a provider error, or an unusable model answer, it falls back to `parseMenuText`, a line parser for "Name · 45 min · $65" lines and Vagaro's stacked name/length/price layout. That result is returned with `source: "parser"` and a notice. If the function can't be reached at all, the app runs the same parser on the device.

## Saving

The app (`apps/mobile/src/features/import/services-api.ts`) saves rows one by one through the existing **`save_service`** RPC, so imported services get the same validation and owner-only check as the Services editor. No new tables or RPCs are needed.

- **New** rows get one hands-on segment. With a processing gap, they get Apply → Process → Rinse & style, with the hands-on time split around the gap. They also get a color from the category, are bookable online, and have no buffers or variants. A row with no category goes under "Other". A row with no price stays "Price varies".
- **Matched** rows (same name as an active service) default to **skip**, so importing the same menu twice changes nothing. The owner can switch a row to **Update**, which changes the price and length but keeps the name, category, settings and variants. If the length is unchanged and no gap was given, the service's own timeline is kept too. The owner can also choose **Add new**.
- **Replace** mode hides (archives) the active services the import didn't keep, plus any combo that uses one of them. Add-ons are untouched. It only runs if every row saved. Archived services stay in history and can be restored in Services.

pgTAP: `supabase/tests/database/22_services_import.test.sql` covers imported payloads through `save_service`, owner-only saving, and archiving.

## Local check without a key

Serve the functions with `CHAIRSIDE_AI_DEMO=1` (same env file as in [Ask Chairside](ai-providers.md#ask-chairside-functionsai-assistant)). The flag is ignored unless `SUPABASE_URL` is local. In demo mode a screenshot returns a fixed fictional menu (`source: "demo"`), and text uses the line parser. A sample copied menu is in `packages/core/src/import/fixtures/vagaro-service-menu.txt`.
