import type { Database } from './database.types.ts';
import type { ChairsideClient, Enums, Tables, TablesInsert } from './index.ts';

/**
 * Booth-renter finances (#44): expenses, booth rent and other recurring expenses, receipt
 * photos, restocks a product purchase can link to, and the `finance_report` RPC. Owners only.
 */

export type Expense = Tables<'expenses'>;
export type RecurringExpense = Tables<'recurring_expenses'>;
export type ExpenseCategory = Enums<'expense_category'>;
export type ExpenseFrequency = Enums<'expense_frequency'>;
export type RestockPurchase = Database['public']['Views']['restock_purchases']['Row'];

export type ExpenseFields = Pick<
  TablesInsert<'expenses'>,
  | 'spent_on'
  | 'category'
  | 'amount_cents'
  | 'vendor'
  | 'note'
  | 'receipt_path'
  | 'stock_movement_id'
>;

export type RecurringExpenseFields = Pick<
  TablesInsert<'recurring_expenses'>,
  | 'category'
  | 'label'
  | 'vendor'
  | 'amount_cents'
  | 'frequency'
  | 'starts_on'
  | 'remind'
  | 'remind_days_before'
  | 'active'
>;

/** An expense with the restock it paid for, if linked. */
export interface ExpenseWithRestock extends Expense {
  restock: Pick<RestockPurchase, 'id' | 'name' | 'brand' | 'quantity' | 'unit'> | null;
}

export interface FinanceIncome {
  /** Service and add-on lines. */
  servicesCents: number;
  retailCents: number;
  otherSalesCents: number;
  tipsCents: number;
  /** No-show / late-cancel deposits kept. */
  keptDepositsCents: number;
  /** Card refunds issued in the period (subtracted). */
  refundedCents: number;
  /** services + retail + other + tips + kept deposits - refunds. */
  totalCents: number;
}

export interface FinancePeriod {
  /** Salon-local dates, inclusive. */
  from: string;
  to: string;
  currency: string;
  income: FinanceIncome;
  expenses: { totalCents: number; count: number; byCategory: Record<ExpenseCategory, number> };
  profitCents: number;
  /** profit × taxSetAsidePercent, nothing on a loss. Not tax advice. */
  taxSetAsideCents: number;
}

export interface FinanceReport extends FinancePeriod {
  timeZone: string;
  taxSetAsidePercent: number;
  /** One entry per calendar month the range touches, clipped to the range. */
  months: (FinancePeriod & { month: string })[];
}

/** Income, expenses, profit and tax set-aside over salon-local dates (default: this month). */
export async function getFinanceReport(
  client: ChairsideClient,
  salonId: string,
  range: { from?: string; to?: string } = {},
): Promise<FinanceReport> {
  const { data, error } = await client.rpc('finance_report', {
    p_salon_id: salonId,
    ...(range.from ? { p_from: range.from } : {}),
    ...(range.to ? { p_to: range.to } : {}),
  });
  if (error) throw error;
  const report = data as unknown as FinanceReport;
  return { ...report, taxSetAsidePercent: Number(report.taxSetAsidePercent) };
}

const blank = (value: string | null | undefined) => {
  const v = value?.trim();
  return v ? v : null;
};

const clean = <T extends Partial<ExpenseFields>>(fields: T): T => ({
  ...fields,
  ...('vendor' in fields ? { vendor: blank(fields.vendor) } : {}),
  ...('note' in fields ? { note: blank(fields.note) } : {}),
});

/** Expenses in a salon-local date range, newest first. */
export async function listExpenses(
  client: ChairsideClient,
  salonId: string,
  range: { from: string; to: string },
): Promise<ExpenseWithRestock[]> {
  const { data, error } = await client
    .from('expenses')
    .select('*')
    .eq('salon_id', salonId)
    .gte('spent_on', range.from)
    .lte('spent_on', range.to)
    .order('spent_on', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) throw error;
  return attachRestocks(client, data);
}

export async function getExpense(
  client: ChairsideClient,
  expenseId: string,
): Promise<ExpenseWithRestock> {
  const { data, error } = await client.from('expenses').select('*').eq('id', expenseId).single();
  if (error) throw error;
  const [expense] = await attachRestocks(client, [data]);
  return expense as ExpenseWithRestock;
}

async function attachRestocks(
  client: ChairsideClient,
  expenses: Expense[],
): Promise<ExpenseWithRestock[]> {
  const ids = expenses.flatMap((e) => (e.stock_movement_id ? [e.stock_movement_id] : []));
  const restocks = new Map<string, ExpenseWithRestock['restock']>();
  if (ids.length > 0) {
    const { data, error } = await client
      .from('restock_purchases')
      .select('id, name, brand, quantity, unit')
      .in('id', ids);
    if (error) throw error;
    for (const r of data) if (r.id) restocks.set(r.id, r);
  }
  return expenses.map((e) => ({
    ...e,
    restock: e.stock_movement_id ? (restocks.get(e.stock_movement_id) ?? null) : null,
  }));
}

export async function createExpense(
  client: ChairsideClient,
  salonId: string,
  fields: ExpenseFields,
): Promise<Expense> {
  const { data, error } = await client
    .from('expenses')
    .insert({ ...clean(fields), salon_id: salonId })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function updateExpense(
  client: ChairsideClient,
  expenseId: string,
  fields: Partial<ExpenseFields>,
): Promise<Expense> {
  const { data, error } = await client
    .from('expenses')
    .update(clean(fields))
    .eq('id', expenseId)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

/** Deletes the expense and its receipt photo. */
export async function deleteExpense(client: ChairsideClient, expense: Expense): Promise<void> {
  const { error } = await client.from('expenses').delete().eq('id', expense.id);
  if (error) throw error;
  if (expense.receipt_path) {
    await client.storage.from(RECEIPTS_BUCKET).remove([expense.receipt_path]);
  }
}

// Receipts ---------------------------------------------------------------------------

export const RECEIPTS_BUCKET = 'receipts';

const RECEIPT_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

export function receiptPath(
  salonId: string,
  contentType: string,
  id: string = crypto.randomUUID(),
): string {
  const ext = RECEIPT_EXTENSIONS[contentType];
  if (!ext) throw new Error(`Unsupported receipt type: ${contentType}`);
  return `${salonId}/${id}.${ext}`;
}

/** Uploads a receipt photo and returns its path for `expenses.receipt_path`. */
export async function uploadReceipt(
  client: ChairsideClient,
  input: { salonId: string; body: Blob | ArrayBuffer; contentType: string },
): Promise<string> {
  const path = receiptPath(input.salonId, input.contentType);
  const { error } = await client.storage
    .from(RECEIPTS_BUCKET)
    .upload(path, input.body, { contentType: input.contentType, upsert: false });
  if (error) throw error;
  return path;
}

export async function removeReceipt(client: ChairsideClient, path: string): Promise<void> {
  const { error } = await client.storage.from(RECEIPTS_BUCKET).remove([path]);
  if (error) throw error;
}

export async function receiptUrl(
  client: ChairsideClient,
  path: string,
  expiresInSeconds = 3600,
): Promise<string> {
  const { data, error } = await client.storage
    .from(RECEIPTS_BUCKET)
    .createSignedUrl(path, expiresInSeconds);
  if (error) throw error;
  return data.signedUrl;
}

// Restocks ---------------------------------------------------------------------------

/** Recent inventory restocks, newest first, with the expense that paid for each (if any). */
export async function listRestockPurchases(
  client: ChairsideClient,
  salonId: string,
  limit = 30,
): Promise<RestockPurchase[]> {
  const { data, error } = await client
    .from('restock_purchases')
    .select('*')
    .eq('salon_id', salonId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
}

// Recurring expenses (booth rent) ----------------------------------------------------

export async function listRecurringExpenses(
  client: ChairsideClient,
  salonId: string,
): Promise<RecurringExpense[]> {
  const { data, error } = await client
    .from('recurring_expenses')
    .select('*')
    .eq('salon_id', salonId)
    .order('created_at');
  if (error) throw error;
  return data;
}

/**
 * Creates or updates a recurring expense. Saving posts every due date up to today into
 * expenses straight away (the cron tick does it from then on).
 */
export async function saveRecurringExpense(
  client: ChairsideClient,
  salonId: string,
  input: { id?: string; fields: RecurringExpenseFields },
): Promise<RecurringExpense> {
  const fields = { ...input.fields, vendor: blank(input.fields.vendor) };
  const query = input.id
    ? client.from('recurring_expenses').update(fields).eq('id', input.id)
    : client.from('recurring_expenses').insert({ ...fields, salon_id: salonId });
  const { data, error } = await query.select('*').single();
  if (error) throw error;
  return data;
}

/** Stops the schedule; expenses it already posted stay. */
export async function deleteRecurringExpense(client: ChairsideClient, id: string): Promise<void> {
  const { error } = await client.from('recurring_expenses').delete().eq('id', id);
  if (error) throw error;
}

// Tax set-aside ----------------------------------------------------------------------

export async function updateTaxSetAsidePercent(
  client: ChairsideClient,
  salonId: string,
  percent: number,
): Promise<void> {
  const { error } = await client
    .from('settings')
    .update({ tax_set_aside_percent: percent })
    .eq('salon_id', salonId);
  if (error) throw error;
}
