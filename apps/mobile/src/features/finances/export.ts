import { EXPENSE_CATEGORIES, EXPENSE_CATEGORY_LABELS } from '@chairside/core/finances';
import type { ExpenseWithRestock, FinancePeriod, FinanceReport } from '@chairside/db/finances';
import { formatAmount } from '@chairside/payments';

/** What goes to the accountant: the period's summary by month plus every expense line. */
export interface FinanceExport {
  salonName: string;
  report: FinanceReport;
  expenses: ExpenseWithRestock[];
}

export const TAX_DISCLAIMER =
  'The tax set-aside is a rough savings estimate, not tax advice. Check with your accountant.';

function csvCell(value: string | number | null | undefined): string {
  const s = value === null || value === undefined ? '' : String(value);
  // Neutralise spreadsheet formulas (numbers like -2 are fine) and quote separators.
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

const row = (cells: (string | number | null | undefined)[]) => cells.map(csvCell).join(',');
const money = (cents: number) => (cents / 100).toFixed(2);

const restockLabel = (e: ExpenseWithRestock) =>
  e.restock ? [e.restock.brand, e.restock.name].filter(Boolean).join(' ') : '';

const SUMMARY_HEADER = [
  'Services',
  'Retail',
  'Other sales',
  'Tips',
  'Kept deposits',
  'Refunds',
  'Income',
  ...EXPENSE_CATEGORIES.map((c) => (c === 'other' ? 'Other expenses' : EXPENSE_CATEGORY_LABELS[c])),
  'Expenses',
  'Profit',
  'Tax set-aside',
];

function summaryCells(p: FinancePeriod): string[] {
  return [
    money(p.income.servicesCents),
    money(p.income.retailCents),
    money(p.income.otherSalesCents),
    money(p.income.tipsCents),
    money(p.income.keptDepositsCents),
    money(-p.income.refundedCents),
    money(p.income.totalCents),
    ...EXPENSE_CATEGORIES.map((c) => money(p.expenses.byCategory[c] ?? 0)),
    money(p.expenses.totalCents),
    money(p.profitCents),
    money(p.taxSetAsideCents),
  ];
}

/** One CSV a spreadsheet or accounting tool can open: summary, monthly rows, expense lines. */
export function financeCsv({ salonName, report, expenses }: FinanceExport): string {
  const lines = [
    row(['Chairside finances', salonName]),
    row(['Period', report.from, report.to]),
    row(['Currency', report.currency.toUpperCase()]),
    row(['Tax set-aside', `${report.taxSetAsidePercent}%`, TAX_DISCLAIMER]),
    '',
    row(['Month', ...SUMMARY_HEADER]),
    ...report.months.map((m) => row([m.month, ...summaryCells(m)])),
    row(['Total', ...summaryCells(report)]),
    '',
    row(['Date', 'Category', 'Vendor', 'Note', 'Amount', 'Restock', 'Receipt photo']),
    ...[...expenses]
      .sort((a, b) => a.spent_on.localeCompare(b.spent_on))
      .map((e) =>
        row([
          e.spent_on,
          EXPENSE_CATEGORY_LABELS[e.category],
          e.vendor,
          e.note,
          money(e.amount_cents),
          restockLabel(e),
          e.receipt_path ? 'yes' : '',
        ]),
      ),
  ];
  return lines.join('\r\n') + '\r\n';
}

export const exportFilename = (report: FinanceReport, ext: 'csv' | 'pdf') =>
  `finances-${report.from}-to-${report.to}.${ext}`;

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** "Oct 2026" for a `YYYY-MM` month. */
export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, 1)).toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** Printable HTML (Print → Save as PDF) with the same numbers as the CSV. */
export function financeHtml({ salonName, report, expenses }: FinanceExport): string {
  const fmt = (cents: number) => escape(formatAmount(cents, report.currency, 'en-US'));
  const title = `${salonName} finances, ${report.from} to ${report.to}`;
  const line = (label: string, cents: number, cls = '') =>
    `<tr class="${cls}"><td>${escape(label)}</td><td class="n">${fmt(cents)}</td></tr>`;
  const months =
    report.months.length > 1
      ? `<h2>By month</h2><table><tr><th>Month</th><th class="n">Income</th><th class="n">Expenses</th><th class="n">Profit</th><th class="n">Tax set-aside</th></tr>${report.months
          .map(
            (m) =>
              `<tr><td>${escape(monthLabel(m.month))}</td><td class="n">${fmt(m.income.totalCents)}</td><td class="n">${fmt(m.expenses.totalCents)}</td><td class="n">${fmt(m.profitCents)}</td><td class="n">${fmt(m.taxSetAsideCents)}</td></tr>`,
          )
          .join('')}</table>`
      : '';
  const expenseRows = [...expenses]
    .sort((a, b) => a.spent_on.localeCompare(b.spent_on))
    .map(
      (e) =>
        `<tr><td>${escape(e.spent_on)}</td><td>${escape(EXPENSE_CATEGORY_LABELS[e.category])}</td><td>${escape(
          [e.vendor, restockLabel(e), e.note].filter(Boolean).join(' · '),
        )}</td><td class="n">${fmt(e.amount_cents)}</td></tr>`,
    )
    .join('');
  const { income } = report;

  return `<!doctype html><html><head><meta charset="utf-8"><title>${escape(title)}</title>
<style>
body{font-family:-apple-system,system-ui,sans-serif;color:#111;margin:32px;font-size:12px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:14px;margin:24px 0 6px}
table{border-collapse:collapse;width:100%}td,th{padding:4px 6px;border-bottom:1px solid #ddd;text-align:left}
.n{text-align:right;font-variant-numeric:tabular-nums}.total td{font-weight:700;border-top:2px solid #111}
.muted{color:#666}
</style></head><body>
<h1>${escape(salonName)}</h1><p class="muted">Finances ${escape(report.from)} to ${escape(report.to)}</p>
<h2>Summary</h2><table>
${line('Services', income.servicesCents)}${line('Retail', income.retailCents)}${income.otherSalesCents ? line('Other sales', income.otherSalesCents) : ''}${line('Tips', income.tipsCents)}${income.keptDepositsCents ? line('Kept deposits', income.keptDepositsCents) : ''}${income.refundedCents ? line('Refunds', -income.refundedCents) : ''}
${line('Income', income.totalCents, 'total')}
${EXPENSE_CATEGORIES.filter((c) => report.expenses.byCategory[c])
  .map((c) => line(EXPENSE_CATEGORY_LABELS[c], -report.expenses.byCategory[c]))
  .join('')}
${line('Expenses', -report.expenses.totalCents, 'total')}
${line('Profit', report.profitCents, 'total')}
${line(`Tax set-aside (${report.taxSetAsidePercent}%)`, report.taxSetAsideCents)}
</table>
${months}
<h2>Expenses (${expenses.length})</h2>
${expenses.length ? `<table><tr><th>Date</th><th>Category</th><th>Details</th><th class="n">Amount</th></tr>${expenseRows}</table>` : '<p class="muted">No expenses in this period.</p>'}
<p class="muted">${escape(TAX_DISCLAIMER)} Income is card and recorded payments in Chairside, after refunds.</p>
</body></html>`;
}
