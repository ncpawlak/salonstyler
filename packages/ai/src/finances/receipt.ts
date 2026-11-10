/**
 * Receipt reading for booth-renter finances (#44). A vision model reads a photo of a receipt
 * into the amount, vendor and date an expense needs, plus a suggested category. The model only
 * extracts: the owner checks the numbers before anything is saved, and nothing here decides
 * what is deductible.
 */
import { z } from 'zod';

import { extractJson } from '../inbox/parse.ts';
import type { ChatMessage, ImagePart, LLMProvider, TokenUsage, ToolDefinition } from '../types.ts';

export const RECEIPT_CATEGORIES = [
  'products',
  'tools',
  'education',
  'booth_rent',
  'other',
] as const;
export type ReceiptCategory = (typeof RECEIPT_CATEGORIES)[number];

/** What a receipt says. */
export interface ReceiptReading {
  /** Total paid, in cents. */
  amountCents: number;
  /** ISO 4217, lower case, when printed on the receipt. */
  currency: string | null;
  vendor: string | null;
  /** `YYYY-MM-DD`, never in the future. */
  date: string | null;
  /** A guess the owner can change. */
  category: ReceiptCategory;
}

export interface ReceiptReadContext {
  /** Salon-local `YYYY-MM-DD`. */
  today: string;
}

export const READ_RECEIPT_TOOL: ToolDefinition = {
  name: 'read_receipt',
  description: 'Record what the receipt shows. Call exactly once.',
  parameters: {
    type: 'object',
    properties: {
      isReceipt: {
        type: 'boolean',
        description: 'False if the image is not a receipt or invoice.',
      },
      total: {
        type: ['number', 'null'],
        description:
          'The total actually paid, including tax, as a number in the receipt currency (e.g. 48.62). Null if it cannot be read.',
      },
      currency: {
        type: ['string', 'null'],
        description: 'ISO 4217 code if the receipt shows one (USD, CAD, EUR). Null otherwise.',
      },
      vendor: {
        type: ['string', 'null'],
        description: 'The store or business name at the top of the receipt. Null if not shown.',
      },
      date: {
        type: ['string', 'null'],
        description: 'The purchase date as YYYY-MM-DD. Null if not shown.',
      },
      category: {
        type: 'string',
        enum: [...RECEIPT_CATEGORIES],
        description:
          'products: hair color, shampoo, styling or back-bar supplies. tools: shears, dryers, irons, brushes, capes. education: classes, courses, certifications. booth_rent: chair or booth rent. other: anything else.',
      },
    },
    required: ['isReceipt', 'total', 'category'],
  },
};

export function receiptReadPrompt(ctx: ReceiptReadContext): string {
  return [
    'You read photos of receipts for a hairstylist who rents a booth, and record them by calling read_receipt.',
    `Today is ${ctx.today}.`,
    'Copy the total, store name and date exactly as printed. If several totals are shown, use the final amount paid.',
    'Do not guess numbers you cannot read, and do not give tax advice.',
  ].join('\n');
}

const receiptSchema = z.object({
  isReceipt: z.boolean().catch(true),
  total: z.union([z.number(), z.string()]).nullish().catch(null),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/)
    .nullish()
    .catch(null),
  vendor: z.string().trim().max(120).nullish().catch(null),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish()
    .catch(null),
  category: z.enum(RECEIPT_CATEGORIES).catch('other'),
});

const toCents = (value: number | string | null | undefined): number | null => {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value.replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n)) return null;
  const cents = Math.round(n * 100);
  return cents >= 1 && cents <= 10_000_000 ? cents : null;
};

/** Null when the answer is unusable, the image isn't a receipt, or the total can't be read. */
export function normalizeReceipt(raw: unknown, today: string): ReceiptReading | null {
  const parsed = receiptSchema.safeParse(raw);
  if (!parsed.success || !parsed.data.isReceipt) return null;
  const d = parsed.data;
  const amountCents = toCents(d.total);
  if (amountCents === null) return null;
  return {
    amountCents,
    currency: d.currency ? d.currency.toLowerCase() : null,
    vendor: d.vendor || null,
    // A future date is a misread (e.g. a day/month swap); drop it.
    date: d.date && d.date <= today ? d.date : null,
    category: d.category,
  };
}

export interface ReceiptReadResult {
  receipt: ReceiptReading | null;
  usage: TokenUsage;
  model: string;
}

/** One vision call with a single forced tool. */
export async function readReceipt(
  llm: LLMProvider,
  image: ImagePart,
  ctx: ReceiptReadContext,
): Promise<ReceiptReadResult> {
  const messages: ChatMessage[] = [
    { role: 'system', content: receiptReadPrompt(ctx) },
    { role: 'user', content: [{ type: 'text', text: 'Read this receipt.' }, image] },
  ];
  const result = await llm.chat(messages, [READ_RECEIPT_TOOL], {
    maxOutputTokens: 400,
    temperature: 0,
  });
  const call = result.toolCalls.find((c) => c.name === READ_RECEIPT_TOOL.name);
  return {
    receipt: normalizeReceipt(call ? call.arguments : extractJson(result.text), ctx.today),
    usage: result.usage,
    model: result.model,
  };
}

/**
 * Local development only (CHAIRSIDE_AI_DEMO): a fixed supply-store receipt instead of reading the
 * image, so the flow can be clicked through without an AI key.
 */
export const DEMO_RECEIPT: Omit<ReceiptReading, 'date'> = {
  amountCents: 4862,
  currency: 'usd',
  vendor: 'SalonCentric',
  category: 'products',
};
