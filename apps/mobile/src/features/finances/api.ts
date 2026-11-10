import type { AiRequest } from '@chairside/ai';
import type { AiReadReceiptResponse } from '@chairside/ai/finances';
import type { DateRange } from '@chairside/core/reports';
import type { ChairsideClient } from '@chairside/db';
import {
  createExpense,
  deleteExpense,
  deleteRecurringExpense,
  getExpense,
  getFinanceReport,
  listExpenses,
  listRecurringExpenses,
  listRestockPurchases,
  receiptUrl,
  saveRecurringExpense,
  updateExpense,
  updateTaxSetAsidePercent,
  uploadReceipt,
  type Expense,
  type ExpenseFields,
  type RecurringExpenseFields,
} from '@chairside/db/finances';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { AiRequestError } from '@/features/ai-settings/api';
import { supabase } from '@/lib/supabase';
import { useCurrentSalon } from '@/providers/session-provider';

const reportKey = (salonId: string) => ['finance-report', salonId] as const;
const expensesKey = (salonId: string) => ['expenses', salonId] as const;
const expenseKey = (id: string) => ['expense', id] as const;
const recurringKey = (salonId: string) => ['recurring-expenses', salonId] as const;
const restocksKey = (salonId: string) => ['restock-purchases', salonId] as const;

/** Income (from `sales_report`), expenses, profit and tax set-aside for a salon-local range. */
export function useFinanceReport(range: DateRange | null) {
  const salon = useCurrentSalon();
  return useQuery({
    queryKey: [...reportKey(salon.id), range?.from, range?.to],
    queryFn: () => getFinanceReport(supabase, salon.id, range ?? {}),
    enabled: range != null,
  });
}

export function useExpenses(range: DateRange | null) {
  const salon = useCurrentSalon();
  return useQuery({
    queryKey: [...expensesKey(salon.id), range?.from, range?.to],
    queryFn: () => listExpenses(supabase, salon.id, range!),
    enabled: range != null,
  });
}

export function useExpense(id: string | undefined) {
  return useQuery({
    queryKey: expenseKey(id ?? ''),
    enabled: !!id,
    queryFn: () => getExpense(supabase, id!),
  });
}

export function useReceiptUrl(path: string | null | undefined) {
  return useQuery({
    queryKey: ['receipt-url', path],
    enabled: !!path,
    staleTime: 30 * 60_000,
    queryFn: () => receiptUrl(supabase, path!),
  });
}

export function useRestockPurchases() {
  const salon = useCurrentSalon();
  return useQuery({
    queryKey: restocksKey(salon.id),
    queryFn: () => listRestockPurchases(supabase, salon.id),
  });
}

export function useRecurringExpenses() {
  const salon = useCurrentSalon();
  return useQuery({
    queryKey: recurringKey(salon.id),
    queryFn: () => listRecurringExpenses(supabase, salon.id),
  });
}

/** Refreshes the report, expense lists and restock links after anything money-related changes. */
function useInvalidateFinances() {
  const salon = useCurrentSalon();
  const queryClient = useQueryClient();
  return (expenseId?: string) =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: reportKey(salon.id) }),
      queryClient.invalidateQueries({ queryKey: expensesKey(salon.id) }),
      queryClient.invalidateQueries({ queryKey: restocksKey(salon.id) }),
      queryClient.invalidateQueries({ queryKey: recurringKey(salon.id) }),
      expenseId ? queryClient.invalidateQueries({ queryKey: expenseKey(expenseId) }) : null,
    ]);
}

export function useSaveExpense() {
  const salon = useCurrentSalon();
  const invalidate = useInvalidateFinances();
  return useMutation({
    mutationFn: ({ id, fields }: { id?: string; fields: ExpenseFields }) =>
      id ? updateExpense(supabase, id, fields) : createExpense(supabase, salon.id, fields),
    onSuccess: (saved) => invalidate(saved.id),
  });
}

export function useDeleteExpense() {
  const invalidate = useInvalidateFinances();
  return useMutation({
    mutationFn: (expense: Expense) => deleteExpense(supabase, expense),
    onSuccess: () => invalidate(),
  });
}

export function useSaveRecurringExpense() {
  const salon = useCurrentSalon();
  const invalidate = useInvalidateFinances();
  return useMutation({
    mutationFn: (input: { id?: string; fields: RecurringExpenseFields }) =>
      saveRecurringExpense(supabase, salon.id, input),
    onSuccess: () => invalidate(),
  });
}

export function useDeleteRecurringExpense() {
  const invalidate = useInvalidateFinances();
  return useMutation({
    mutationFn: (id: string) => deleteRecurringExpense(supabase, id),
    onSuccess: () => invalidate(),
  });
}

export function useUpdateTaxPercent() {
  const salon = useCurrentSalon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (percent: number) => updateTaxSetAsidePercent(supabase, salon.id, percent),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: reportKey(salon.id) }),
  });
}

/** A receipt photo as base64 JPEG/PNG/WebP, the shape the `ai` function and Storage take. */
export interface ReceiptImage {
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  data: string;
}

function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function useUploadReceipt() {
  const salon = useCurrentSalon();
  return useMutation({
    mutationFn: (image: ReceiptImage) =>
      uploadReceipt(supabase, {
        salonId: salon.id,
        body: base64ToBytes(image.data).buffer as ArrayBuffer,
        contentType: image.mimeType,
      }),
  });
}

async function readAiError(error: unknown): Promise<AiRequestError> {
  const context = (error as { context?: unknown }).context;
  if (context instanceof Response) {
    try {
      const body = (await context.json()) as { error?: { code: string; message: string } };
      if (body.error) return new AiRequestError(body.error.code, body.error.message);
    } catch {
      // fall through
    }
  }
  return new AiRequestError('network', error instanceof Error ? error.message : String(error));
}

/** Asks the `ai` function to read the total, vendor and date off a receipt photo. */
export async function readReceipt(
  client: ChairsideClient,
  salonId: string,
  image: ReceiptImage,
  today: string,
): Promise<AiReadReceiptResponse> {
  const body: Extract<AiRequest, { action: 'read_receipt' }> = {
    action: 'read_receipt',
    salonId,
    image: { type: 'image', ...image },
    today,
  };
  const { data, error } = await client.functions.invoke<AiReadReceiptResponse>('ai', { body });
  if (error) throw await readAiError(error);
  if (!data) throw new AiRequestError('invalid_response', 'Empty response from the AI service');
  return data;
}

export function useReadReceipt() {
  const salon = useCurrentSalon();
  return useMutation({
    mutationFn: ({ image, today }: { image: ReceiptImage; today: string }) =>
      readReceipt(supabase, salon.id, image, today),
  });
}
