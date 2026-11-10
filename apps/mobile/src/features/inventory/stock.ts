/** Pure inventory helpers (no React / Supabase), unit-tested in stock.test.ts. */

export interface StockLevel {
  on_hand: number;
  reorder_point: number;
  active?: boolean;
}

/** "2", "2.5" with the unit unless it's "each": "2", "2.5 tubes". */
export function formatQuantity(quantity: number, unit?: string | null): string {
  const n = Number(quantity.toFixed(2)).toString();
  const u = unit?.trim();
  return !u || u.toLowerCase() === 'each' ? n : `${n} ${u}`;
}

/** Parses a typed quantity ("3", "1.5", "-2"); null when invalid. Up to 2 decimals. */
export function parseQuantity(input: string, { allowNegative = false } = {}): number | null {
  const s = input.trim();
  const re = allowNegative ? /^-?\d{1,8}(\.\d{1,2})?$/ : /^\d{1,8}(\.\d{1,2})?$/;
  if (!re.test(s)) return null;
  return Number(s);
}

export type StockState = 'ok' | 'low' | 'out';

/** Low = at or below the reorder point (what triggers the push); out = nothing left. */
export function stockState(p: StockLevel): StockState {
  if (p.on_hand <= 0) return 'out';
  if (p.on_hand <= p.reorder_point) return 'low';
  return 'ok';
}

export const isLowStock = (p: StockLevel) => p.active !== false && stockState(p) !== 'ok';

export interface ReorderRow {
  name: string | null;
  brand: string | null;
  sku: string | null;
  barcode: string | null;
  unit: string | null;
  on_hand: number | null;
  reorder_point: number | null;
  suggested_quantity: number | null;
  cost_cents: number | null;
  supplier: string | null;
}

function csvCell(value: string | number | null | undefined): string {
  const s = value === null || value === undefined ? '' : String(value);
  // Neutralise spreadsheet formulas (numbers like -2 are fine) and quote separators.
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

const money = (cents: number | null) => (cents === null ? '' : (cents / 100).toFixed(2));
const lineCents = (r: ReorderRow) =>
  r.cost_cents === null ? null : Math.round(r.cost_cents * (r.suggested_quantity ?? 0));

/** The reorder list as CSV for a supplier email or spreadsheet. */
export function reorderCsv(rows: ReorderRow[]): string {
  const header = [
    'Supplier',
    'Brand',
    'Product',
    'SKU',
    'Barcode',
    'Unit',
    'On hand',
    'Reorder point',
    'Order qty',
    'Unit cost',
    'Line cost',
  ];
  const lines = rows.map((r) =>
    [
      r.supplier,
      r.brand,
      r.name,
      r.sku,
      r.barcode,
      r.unit,
      r.on_hand,
      r.reorder_point,
      r.suggested_quantity ?? 0,
      money(r.cost_cents),
      money(lineCents(r)),
    ]
      .map(csvCell)
      .join(','),
  );
  return [header.join(','), ...lines].join('\r\n') + '\r\n';
}

/** Estimated cost of the whole order, in cents (lines without a cost are skipped). */
export function reorderTotalCents(rows: ReorderRow[]): number {
  return rows.reduce((sum, r) => sum + (lineCents(r) ?? 0), 0);
}

/** Groups rows by supplier, alphabetically, with "no supplier" last. */
export function groupBySupplier<T extends { supplier: string | null }>(
  rows: T[],
): { supplier: string | null; rows: T[] }[] {
  const groups = new Map<string | null, T[]>();
  for (const r of rows) {
    const key = r.supplier?.trim() || null;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)))
    .map(([supplier, list]) => ({ supplier, rows: list }));
}

/** Trims scanner output; null unless it's 1–64 printable ASCII characters. */
export function normalizeBarcode(raw: string): string | null {
  const s = raw.trim();
  return /^[!-~]{1,64}$/.test(s) ? s : null;
}

/** Case-insensitive match on name, brand, category, SKU or barcode. */
export function matchesProduct(
  p: {
    name: string;
    brand: string | null;
    category: string | null;
    sku: string | null;
    barcode: string | null;
  },
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [p.name, p.brand, p.category, p.sku, p.barcode].some((v) => v?.toLowerCase().includes(q));
}
