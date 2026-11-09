# Schema (foundation)

| Table | Purpose | Access (authenticated) |
|---|---|---|
| `salons` | Tenant root: name, unique `slug`, IANA `timezone` | Members read; owners update/delete. Created **only** via `create_salon()` |
| `salon_members` | `(salon_id, user_id, role)`; role = `owner` \| `stylist` | Members read co-members; owners manage; anyone can leave. A salon always keeps ≥ 1 owner |
| `settings` | 1:1 per salon: autonomy (`draft`), booking rules (`booking_window_days` 60, `min_notice_minutes` 120, `slot_grid_minutes` 15), hold expiry / follow-up nudge (24h) | Members read; owners update |
| `work_hours_template` | `(salon_id, weekday 0=Sun..6)`: `blocks` (`{start,end,type: open\|tentative}`) + `breaks`, `HH:MM` salon-local | Members read; owners manage |
| `work_hours_override` | Date or date range (`start_date..end_date`) with `kind` = `custom` (own blocks/breaks) \| `day_off` \| `vacation`. Beats the template; narrower/newer overrides win | Members read; owners manage |
| `audit_log` | Append-only event log | Members read and append as themselves; no update/delete |
| `push_tokens` | Expo push tokens per user per salon | Users manage only their own tokens |

`anon` has no table access; the public booking page will go through Edge Functions.

RPCs (authenticated only):
- `create_salon(p_name, p_slug, p_timezone)`: creates the salon, makes the caller `owner`, creates default `settings`, writes `audit_log`.
- `is_salon_slug_available(p_slug)`: boolean check for the create-salon form.

Helpers in the non-exposed `private` schema: `is_salon_member(salon_id)`, `has_salon_role(salon_id, role)`.

# Schema (service builder, #4)

| Table | Purpose | Access (authenticated) |
|---|---|---|
| `services` | Menu item: name, category, price, `color_tag`, buffers, flags (`consultation_required`, `bookable_online`, `new_clients_only`), `is_combo`, `archived_at` | Members read; owners manage |
| `service_segments` | Ordered `busy` / `processing` / `style` segments of a service **or** an add-on (exactly one of `service_id` / `addon_id`) | Members read; owners manage |
| `service_variants` | e.g. hair length: `delta_minutes` added to busy/style time | Members read; owners manage |
| `service_addons` | Toner, deep conditioning…: own segments, `placement` = `before_finish` \| `end` | Members read; owners manage |
| `service_combo_items` | Ordered services in a combo (`replaces_previous_finish`); no nested combos | Members read; owners manage |

RPCs (authenticated, owners only; write `audit_log`):
- `save_service(p_salon_id, p_service jsonb)`: creates (no `id`) or replaces a service/combo with its segments, variants and items atomically. Uses the `ServiceDefinition` shape from `@chairside/core`. Validates segments the same way the availability engine does.
- `save_service_addon(p_salon_id, p_addon jsonb)`: the same for add-ons.

New salons get the Appendix A starter menu (an `after insert` trigger on `salons` → `private.seed_starter_menu`). Salons that already have services are left alone. Resolution (variants, add-ons, combos) is done in `@chairside/core` (`resolveService` / `resolveCombo`); `@chairside/db` has `listServiceMenu` / `saveService`.

## Adding a tenant table

1. Add a new migration: `npx supabase migration new <name>`.
2. Include `salon_id uuid not null references public.salons(id) on delete cascade`.
3. `enable row level security` and write policies with `private.is_salon_member(salon_id)` / `private.has_salon_role(salon_id, 'owner')`.
4. Regenerate types: `npm run gen:types` in `packages/db`.

`tests/database/00_tenancy.test.sql` fails if any `public` table lacks RLS, lacks a NOT NULL `salon_id`, or is readable by `anon`.
