import { describe, expect, it } from 'vitest';

import {
  formatQuantity,
  groupBySupplier,
  isLowStock,
  matchesProduct,
  normalizeBarcode,
  parseQuantity,
  reorderCsv,
  reorderTotalCents,
  stockState,
  type ReorderRow,
} from './stock';

const row = (over: Partial<ReorderRow>): ReorderRow => ({
  name: 'Shampoo',
  brand: 'Redken',
  sku: null,
  barcode: null,
  unit: 'each',
  on_hand: 1,
  reorder_point: 3,
  suggested_quantity: 5,
  cost_cents: 1100,
  supplier: 'SalonCentric',
  ...over,
});

describe('formatQuantity', () => {
  it('drops trailing zeros and the "each" unit', () => {
    expect(formatQuantity(2, 'each')).toBe('2');
    expect(formatQuantity(2.5, 'tube')).toBe('2.5 tube');
    expect(formatQuantity(1.1 + 2.2, null)).toBe('3.3');
  });
});

describe('parseQuantity', () => {
  it('accepts up to 2 decimals', () => {
    expect(parseQuantity(' 3 ')).toBe(3);
    expect(parseQuantity('1.25')).toBe(1.25);
    expect(parseQuantity('1.255')).toBeNull();
    expect(parseQuantity('-2')).toBeNull();
    expect(parseQuantity('-2', { allowNegative: true })).toBe(-2);
    expect(parseQuantity('abc')).toBeNull();
  });
});

describe('stockState', () => {
  it('is low at or below the reorder point', () => {
    expect(stockState({ on_hand: 4, reorder_point: 3 })).toBe('ok');
    expect(stockState({ on_hand: 3, reorder_point: 3 })).toBe('low');
    expect(stockState({ on_hand: 0, reorder_point: 3 })).toBe('out');
    expect(stockState({ on_hand: -1, reorder_point: 0 })).toBe('out');
    expect(isLowStock({ on_hand: 0, reorder_point: 0, active: false })).toBe(false);
  });
});

describe('reorderCsv', () => {
  it('writes a header, quotes separators and neutralises formulas', () => {
    const csv = reorderCsv([
      row({ name: 'Shampoo, 300ml', sku: '=HYPERLINK("x")' }),
      row({ supplier: null, cost_cents: null, on_hand: -2 }),
    ]);
    const lines = csv.trimEnd().split('\r\n');
    expect(lines[0]).toBe(
      'Supplier,Brand,Product,SKU,Barcode,Unit,On hand,Reorder point,Order qty,Unit cost,Line cost',
    );
    expect(lines[1]).toBe(
      'SalonCentric,Redken,"Shampoo, 300ml","\'=HYPERLINK(""x"")",,each,1,3,5,11.00,55.00',
    );
    expect(lines[2]).toBe(',Redken,Shampoo,,,each,-2,3,5,,');
  });

  it('totals the order cost', () => {
    expect(reorderTotalCents([row({}), row({ cost_cents: null }), row({ cost_cents: 250 })])).toBe(
      5500 + 1250,
    );
  });
});

describe('groupBySupplier', () => {
  it('sorts suppliers and puts "none" last', () => {
    const groups = groupBySupplier([
      row({ supplier: 'Zed' }),
      row({ supplier: null }),
      row({ supplier: 'Acme' }),
      row({ supplier: 'Zed' }),
    ]);
    expect(groups.map((g) => [g.supplier, g.rows.length])).toEqual([
      ['Acme', 1],
      ['Zed', 2],
      [null, 1],
    ]);
  });
});

describe('normalizeBarcode / matchesProduct', () => {
  it('trims scanner output and rejects junk', () => {
    expect(normalizeBarcode(' 0884486456182\n')).toBe('0884486456182');
    expect(normalizeBarcode('')).toBeNull();
    expect(normalizeBarcode('has space')).toBeNull();
  });

  it('searches name, brand, category, SKU and barcode', () => {
    const p = { name: '6N', brand: 'Shades EQ', category: 'Color', sku: 'SEQ-6N', barcode: '123' };
    expect(matchesProduct(p, 'shades')).toBe(true);
    expect(matchesProduct(p, 'color')).toBe(true);
    expect(matchesProduct(p, '123')).toBe(true);
    expect(matchesProduct(p, 'toner')).toBe(false);
    expect(matchesProduct(p, ' ')).toBe(true);
  });
});
