# Service categories (#86)

Migration: `20261109510000_service_categories.sql` · Tests: `tests/database/33_service_categories.test.sql`
· Client: `@chairside/db/service-categories`.

`services.category` stays free text (1–40 chars). `public.service_categories (salon_id, name, position)`
is the salon's ordered list of category names, so owners can create, rename, merge and reorder them.

## Staying in sync

- Trigger `services_ensure_category` (after insert / update of `category` on `services`) appends any
  new name to the list. So the starter menu seed, `save_service`, and the Vagaro services import
  (#16) need no changes: whatever category they write shows up.
- Existing salons were backfilled: categories in use (ordered by their first service), then any
  unused starter categories.
- Names match exactly. The editor reuses an existing name typed in another case.
- Clients read the list with `listServiceCategories` and merge it with the categories services use
  (`orderCategories`). A restore from an export that predates this table leaves the list empty
  (triggers don't fire during import), and every category still shows, in first-use order.

## Writes (owners only, `42501` otherwise)

Members can read; there are no direct write grants. All writes go through RPCs:

| RPC | Effect |
| --- | --- |
| `add_service_category(salon, name)` | Appends a trimmed name (no-op if it exists). |
| `rename_service_category(salon, from, to)` | Renames in place and moves its services. If `to` exists it merges. Audited. |
| `delete_service_category(salon, name, move_to?)` | Removes it. If services (archived included) use it, `move_to` is required (`23503` otherwise) and they move there. Audited. |
| `reorder_service_categories(salon, names[])` | Listed names first, in order; the rest keep their relative order. |

## Where the order shows

- Services list (`(app)/services`) groups by category in this order; **Categories** opens the
  manage screen (`(app)/services/categories`).
- Service editor: pick a category, create one inline, or jump to the manage screen. Segment labels
  autocomplete from labels already used across the menu (#85, client-side, most-used first).
- Public booking page (`/b/<slug>`): `publicMenu` sorts services by this order and the page shows a
  heading per category.

## Data export

Registered with `private.register_data_export('service_categories')`.
