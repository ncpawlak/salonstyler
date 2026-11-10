# Service recipes and AI inventory commands (#18)

Each service can have a **recipe**: the products one appointment of it uses (say Full Color = 1 tube of 6N + 60 ml developer). When the appointment is **completed**, or its checkout is **paid**, Chairside takes the recipe out of stock, exactly once. Ask Chairside can also look up stock and draft stock changes ("used 2 tubes of 6N", "what do I need to reorder?"). Builds on [inventory](inventory.md) (#17).

## In the app

- **Settings → Service recipes** (`/inventory/recipes`) lists the menu's services with their recipe. Tap one (`/inventory/recipes/[serviceId]`) to add products from inventory and set an amount per appointment, in the product's unit (2 decimals, so `0.5` tube works). Only owners can edit. Stylists see the recipe read-only.
- Combos have no recipe of their own; a booked combo uses the recipes of the services inside it.
- Recipes are per service, not per variant.

App code: `apps/mobile/src/features/inventory/recipes*.ts` and `apps/mobile/src/app/(app)/inventory/recipes`. Data access: `@chairside/db/recipes`.

## Database

Migration `20261109480000_service_recipes.sql`. pgTAP tests are in `supabase/tests/database/30_service_recipes.test.sql`.

| Object | Purpose |
|---|---|
| `service_recipes` | `service_id`, `product_id`, `quantity` (> 0, 2 decimals), one row per product per service. Members read; nobody writes directly |
| `set_service_recipe(service, lines jsonb)` | Owners only. Replaces the whole recipe atomically (`[]` clears it) from `[{ productId, quantity }]`. Rejects combos, duplicates, other salons' products and more than 30 lines. Audited as `service.recipe_set` |
| `stock_movements.appointment_id` | Set on recipe deductions. A unique index on `(appointment_id, product_id)` for `use` movements backs up the idempotency check |
| `appointments_deduct_recipes` trigger | When an appointment becomes `completed` |
| `checkouts_deduct_recipes` trigger | When a checkout for an appointment becomes `paid` |

**Deduction.** `private.deduct_appointment_recipes` locks the appointment, then does nothing if it already has a recipe `use` movement, so completing **and** checking out deducts once, in either order. Otherwise it expands combos, adds up each product across the booked services and writes one `use` movement per product (note `Used for Full Color`), through the same `apply_stock_movement` as manual changes, so the [low-stock push](inventory.md#low-stock-push) fires. Archived products are skipped. Like retail sales, a deduction may take `on_hand` below zero, since the product was used; recount later. Audited as `stock.recipe_used`.

**Edge cases.** Moving a completed appointment back doesn't restock (use **Receive** or **Set count**), and completing it again doesn't deduct again. If an appointment is completed before its service has a recipe, paying it later deducts the new recipe once.

## Ask Chairside

Two tools in `packages/ai/src/assistant/tools` (registered via `npm run gen:tools`). The model only picks the product and the numbers the stylist said; the database does the stock math.

| Tool | What it does |
|---|---|
| `inventory_lookup` | `{ query?, lowStockOnly? }`. Products with on hand, reorder point and suggested reorder quantity (from `reorder_list`). `lowStockOnly` answers "what do I need to reorder?" |
| `adjust_stock` | `{ product, quantity, action: use \| receive \| remove, note? }`. Matches the product by name, brand, SKU or barcode and returns a **draft** card; nothing changes until the stylist taps **Apply**, which calls `adjust_stock` (reason `use`, `receive` or `adjust`). Ambiguous or unknown products, and using more than is on hand, come back as errors for the model to ask about. Drafting is audited as `assistant.stock_adjustment_drafted` |
