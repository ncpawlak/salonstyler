# Inventory (#17)

Retail and back-bar products, barcode scanning, a stock ledger, retail sales at checkout, low-stock pushes and an exportable reorder list. Service recipes (auto-deducting color on completion) and AI inventory commands ("used 2 tubes of 6N") are in [service recipes](service-recipes.md) (#18).

## In the app

**Settings → Inventory** (`/inventory`) lists products with what's on hand and a **Low** / **Out** badge at or below the reorder point.

- **Scan** (`/inventory/scan`): pick **Receive +1**, **Use −1** or **Look up**, then scan. Each scan moves one unit and shows the new count. An unknown barcode offers **Add it as a new product** with the barcode filled in. Phones use the camera (`expo-camera`, EAN/UPC, Code 128/39/93, ITF-14 and QR). Web has no camera scanning, so the barcode is typed or entered with a USB / Bluetooth scanner, which types it like a keyboard.
- **Product** (`/inventory/[id]`, `new` to add): details, the reorder point and order quantity, cost and retail price. Leave the retail price empty for back-bar products. The stock card has **−1** / **+1**, **Receive**, **Use** and **Set count** (a shelf count), and the history shows every movement.
- **Reorder list** (`/inventory/reorder`): everything at or below its reorder point, grouped by supplier, with the estimated cost. **CSV** downloads the list on web and opens the share sheet on phones. Cells that look like spreadsheet formulas are prefixed with `'`.
- **Checkout**: when adding a **Retail** line, matching products appear under the name. Picking one fills in the name and price and links the line to the product. Linked lines take stock off the shelf when the checkout is paid. Unlinked retail lines don't touch stock.
- The **Low-stock alerts** switch on the Inventory screen (owners only) turns the push off.

App code is in `apps/mobile/src/features/inventory` and `apps/mobile/src/app/(app)/inventory`. Data access is in `@chairside/db/inventory`.

## Database

Migration `20261109420000_inventory.sql`. pgTAP tests are in `supabase/tests/database/25_inventory.test.sql`.

| Object | Purpose |
|---|---|
| `products` | Name, brand, category, SKU, barcode, unit, `on_hand`, `reorder_point`, `reorder_quantity`, `cost_cents`, `retail_price_cents` (null = back bar), supplier, active. Barcode and SKU (case-insensitive) are unique per salon. Quantities allow 2 decimals for partial tubes |
| `stock_movements` | Append-only ledger: `reason` (`receive`, `sale`, `adjust`, `count`, `use`, `return`), `delta`, `on_hand_after`, note, `checkout_id` / `checkout_item_id` for sales, `created_by` |
| `adjust_stock(product, delta, reason = 'adjust', note)` | Adds or removes stock. `receive` / `return` must be positive and `use` negative. Fails (`Only 2 on hand`) rather than going below zero. Audited as `stock.<reason>` |
| `count_stock(product, on_hand, note)` | Sets `on_hand` to a shelf count and records the difference. Audited as `stock.count` |
| `reorder_list` view | Active products at or below their reorder point. `suggested_quantity` is `reorder_quantity`, or enough to reach twice the reorder point (at least 1) |
| `settings.low_stock_alerts_enabled` | Default on |

**Access.** Members read both tables and add, edit and delete products. `on_hand` isn't writable directly (column grants), so every change goes through the ledger. The ledger has no write policies; only the functions above write it. Deleting a product deletes its history, so archive (switch off **Active**) products you no longer stock.

**Checkout.** The `checkouts_decrement_stock` trigger runs when a checkout becomes `paid` (card, cash or other). Each `retail` line whose `source_id` is one of the salon's products writes a `sale` movement for its quantity. A unique index on `checkout_item_id` makes this idempotent. Sales may take stock below zero, since the product was physically sold, and the shelf can be recounted later. Refunds don't restock automatically; use **Receive** or **Set count**.

## Low-stock push

When a movement takes `on_hand` from **above** the reorder point to **at or below** it, every salon owner gets a push (notification kind `low_stock`) through the existing outbox and `notifier` (see [push notifications](push-notifications.md)):

- Title: `Low stock · Redken Shampoo`, or `Out of stock · …` at zero or below.
- Body: `2 left (reorder at 3). Tap for your reorder list.`
- Data: `{ type: 'low_stock', salonId, productId }`. Tapping it opens `/inventory/reorder`.

It fires once per crossing. Further sales below the point stay quiet until stock is received above the point again. Nothing is sent when `settings.low_stock_alerts_enabled` is off.
