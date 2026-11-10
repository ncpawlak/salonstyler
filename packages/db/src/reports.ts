import type { ChairsideClient } from './index.ts';
import type { RebookStats } from './rebook.ts';

/** Reports dashboard (#43): one `sales_report` RPC that reconciles with checkouts and payments. */

export interface SalesReportTopService {
  name: string;
  count: number;
  cents: number;
}

export interface SalesReportDay {
  /** Salon-local date. */
  date: string;
  salesCents: number;
  tipsCents: number;
  checkouts: number;
}

export interface SalesReport {
  /** Salon-local dates, inclusive. */
  from: string;
  to: string;
  timeZone: string;
  currency: string;
  /** Paid checkouts whose `paid_at` falls in the range. */
  checkouts: number;
  /** Line items before tip (= services + retail + other). */
  salesCents: number;
  /** Service and add-on lines. */
  servicesCents: number;
  /** Retail lines rung up at checkout. */
  retailCents: number;
  retailItems: number;
  /** Custom lines. */
  otherSalesCents: number;
  tipsCents: number;
  /** Deposits credited against these checkouts (collected earlier). */
  depositsAppliedCents: number;
  /** Taken at checkout (`amount_due`), split by method below. */
  collectedCents: number;
  cardCents: number;
  cashCents: number;
  otherCents: number;
  /** Card refunds issued in the range (same rule as the daily payout summary). */
  refundedCents: number;
  /** No-show / late-cancel deposits kept. */
  keptDepositsCents: number;
  keptDeposits: number;
  /** salesCents / checkouts, rounded; null without checkouts. */
  avgTicketCents: number | null;
  /** Top 5 services by revenue. */
  topServices: SalesReportTopService[];
  /** Every day of the range, zero-filled. */
  daily: SalesReportDay[];
  clients: { served: number; new: number; returning: number };
  /** Appointments starting in the range, by outcome. */
  appointments: { booked: number; completed: number; noShows: number; cancelled: number };
  rebook: RebookStats;
}

/**
 * Sales, tips, clients and appointment outcomes over salon-local dates (default: the last 30
 * days; at most a year). Salon members only.
 */
export async function getSalesReport(
  client: ChairsideClient,
  salonId: string,
  range: { from?: string; to?: string } = {},
): Promise<SalesReport> {
  const { data, error } = await client.rpc('sales_report', {
    p_salon_id: salonId,
    ...(range.from ? { p_from: range.from } : {}),
    ...(range.to ? { p_to: range.to } : {}),
  });
  if (error) throw error;
  return data as unknown as SalesReport;
}
