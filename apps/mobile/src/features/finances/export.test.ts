import type { ExpenseWithRestock, FinancePeriod, FinanceReport } from '@chairside/db/finances';
import { describe, expect, it } from 'vitest';

import { financeCsv, financeHtml, monthLabel } from './export';

function period(over: Partial<FinancePeriod> = {}): FinancePeriod {
  return {
    from: '2026-10-01',
    to: '2026-10-31',
    currency: 'usd',
    income: {
      servicesCents: 420000,
      retailCents: 18000,
      otherSalesCents: 0,
      tipsCents: 61000,
      keptDepositsCents: 2500,
      refundedCents: 1500,
      totalCents: 500000,
    },
    expenses: {
      totalCents: 120000,
      count: 2,
      byCategory: { booth_rent: 90000, products: 30000, tools: 0, education: 0, other: 0 },
    },
    profitCents: 380000,
    taxSetAsideCents: 95000,
    ...over,
  };
}

const report: FinanceReport = {
  ...period(),
  timeZone: 'America/Chicago',
  taxSetAsidePercent: 25,
  months: [{ ...period(), month: '2026-10' }],
};

const expense = (over: Partial<ExpenseWithRestock>): ExpenseWithRestock => ({
  id: 'e1',
  salon_id: 's1',
  spent_on: '2026-10-01',
  category: 'booth_rent',
  amount_cents: 90000,
  vendor: 'Studio Nine',
  note: null,
  receipt_path: null,
  stock_movement_id: null,
  recurring_expense_id: 'r1',
  created_by: null,
  created_at: '2026-10-01T14:00:00Z',
  updated_at: '2026-10-01T14:00:00Z',
  restock: null,
  ...over,
});

const expenses = [
  expense({
    id: 'e2',
    spent_on: '2026-10-14',
    category: 'products',
    amount_cents: 30000,
    vendor: '=HYPERLINK("x")',
    note: 'Color, "toner"',
    receipt_path: 's1/r.jpg',
    stock_movement_id: 'm1',
    restock: { id: 'm1', name: 'Shades EQ', brand: 'Redken', quantity: 6, unit: 'tube' },
  }),
  expense({}),
];

describe('financeCsv', () => {
  const csv = financeCsv({ salonName: 'Sam’s Chair', report, expenses });
  const lines = csv.split('\r\n');

  it('starts with the period and the not-tax-advice note', () => {
    expect(lines[0]).toBe('Chairside finances,Sam’s Chair');
    expect(lines[1]).toBe('Period,2026-10-01,2026-10-31');
    expect(lines[3]).toMatch(/^Tax set-aside,25%,.*not tax advice/);
  });

  it('has a row per month and a total with income, expenses and profit', () => {
    expect(lines[5]).toBe(
      'Month,Services,Retail,Other sales,Tips,Kept deposits,Refunds,Income,Booth rent,Products,Tools,Education,Other expenses,Expenses,Profit,Tax set-aside',
    );
    expect(lines[6]).toBe(
      '2026-10,4200.00,180.00,0.00,610.00,25.00,-15.00,5000.00,900.00,300.00,0.00,0.00,0.00,1200.00,3800.00,950.00',
    );
    expect(lines[7]).toMatch(/^Total,4200\.00,.*,3800\.00,950\.00$/);
  });

  it('lists expenses oldest first, quoting and neutralising cells', () => {
    expect(lines[10]).toBe('2026-10-01,Booth rent,Studio Nine,,900.00,,');
    expect(lines[11]).toBe(
      `2026-10-14,Products,"'=HYPERLINK(""x"")","Color, ""toner""",300.00,Redken Shades EQ,yes`,
    );
    expect(csv.endsWith('\r\n')).toBe(true);
  });
});

describe('financeHtml', () => {
  it('shows profit after expenses, escapes text and carries the disclaimer', () => {
    const html = financeHtml({ salonName: '<Sam>', report, expenses });
    expect(html).toContain('&#60;Sam&#62;');
    expect(html).not.toContain('<Sam>');
    expect(html).toContain('$3,800.00');
    expect(html).toContain('-$1,200.00');
    expect(html).toContain('Tax set-aside (25%)');
    expect(html).toContain('not tax advice');
    expect(html).toContain('Expenses (2)');
  });
});

describe('monthLabel', () => {
  it('formats YYYY-MM', () => {
    expect(monthLabel('2026-10')).toBe('Oct 2026');
  });
});
