import {
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
  monthlyCost,
  nextDueDate,
  parsePercent,
  TAX_PERCENT_MAX,
  taxQuarterFor,
} from '@chairside/core/finances';
import type { FinanceReport } from '@chairside/db/finances';
import { formatAmount } from '@chairside/payments';
import * as Print from 'expo-print';
import { router } from 'expo-router';
import { useState } from 'react';
import { Platform, Share, View } from 'react-native';

import { DetailScreen } from '@/components/shell/screen';
import {
  Button,
  Card,
  EmptyState,
  Input,
  ListGroup,
  ListRow,
  SectionHeader,
  SkeletonRow,
  Text,
} from '@/components/ui';
import { errorMessage } from '@/features/appointments/api';
import { formatDate } from '@/features/calendar/palette';
import {
  useExpenses,
  useFinanceReport,
  useRecurringExpenses,
  useUpdateTaxPercent,
} from '@/features/finances/api';
import {
  exportFilename,
  financeCsv,
  financeHtml,
  monthLabel,
  TAX_DISCLAIMER,
} from '@/features/finances/export';
import { RangePicker, useReportRange } from '@/features/reports/range-picker';
import { useSalonToday } from '@/features/reports/use-reports';
import { haptics } from '@/lib/haptics';
import { useCurrentSalon } from '@/providers/session-provider';

const shortDate = (date: string) => formatDate(date, { month: 'short', day: 'numeric' });
const longDate = (date: string) =>
  formatDate(date, { month: 'short', day: 'numeric', year: 'numeric' });

async function downloadCsv(csv: string, filename: string) {
  if (Platform.OS === 'web') {
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    return;
  }
  await Share.share({ title: filename, message: csv });
}

async function printPdf(html: string) {
  if (Platform.OS === 'web') {
    const w = window.open('', '_blank');
    if (!w) throw new Error('Allow pop-ups to save the PDF');
    w.document.write(html);
    w.document.close();
    w.focus();
    w.print();
    return;
  }
  await Print.printAsync({ html });
}

/**
 * Settings → Finances (#44): what came in (services, retail, tips), what went out (booth rent,
 * products, tools, education), profit, a tax set-aside, and a CSV / PDF for the accountant.
 */
export default function FinancesScreen() {
  const salon = useCurrentSalon();
  if (salon.role !== 'owner') {
    return (
      <DetailScreen title="Finances">
        <EmptyState
          icon="lock-closed-outline"
          title="Owners only"
          message="Only the salon owner can see income, expenses and profit."
        />
      </DetailScreen>
    );
  }
  return <OwnerFinances />;
}

function OwnerFinances() {
  const salon = useCurrentSalon();
  const today = useSalonToday();
  const picker = useReportRange(today);
  const report = useFinanceReport(picker.range);
  const expenses = useExpenses(picker.range);
  const [exportError, setExportError] = useState<string | null>(null);

  const ready = report.data && expenses.data;
  const runExport = async (kind: 'csv' | 'pdf') => {
    if (!report.data || !expenses.data) return;
    setExportError(null);
    const input = { salonName: salon.name, report: report.data, expenses: expenses.data };
    try {
      if (kind === 'csv') await downloadCsv(financeCsv(input), exportFilename(report.data, 'csv'));
      else await printPdf(financeHtml(input));
    } catch (e) {
      setExportError(errorMessage(e));
    }
  };

  return (
    <DetailScreen
      title="Finances"
      right={
        <Button
          size="sm"
          icon="add"
          label="Expense"
          accessibilityLabel="Add expense"
          onPress={() => router.push({ pathname: '/finances/[id]', params: { id: 'new' } })}
        />
      }
    >
      <RangePicker state={picker} />

      {report.isPending || expenses.isPending ? (
        <View className="gap-3 pt-4">
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </View>
      ) : report.error || expenses.error ? (
        <EmptyState
          icon="cloud-offline-outline"
          title="Couldn't load your finances"
          message={errorMessage(report.error ?? expenses.error)}
          actionLabel="Try again"
          onAction={() => void Promise.all([report.refetch(), expenses.refetch()])}
        />
      ) : ready ? (
        <View>
          <ProfitCard report={report.data} />
          <View className="flex-row gap-2 pt-3">
            <Button
              variant="secondary"
              icon="document-text-outline"
              label="Export CSV"
              grow
              testID="export-csv"
              onPress={() => void runExport('csv')}
            />
            <Button
              variant="secondary"
              icon="print-outline"
              label="Export PDF"
              grow
              testID="export-pdf"
              onPress={() => void runExport('pdf')}
            />
          </View>
          {exportError ? (
            <Text variant="footnote" tone="destructive" className="px-1 pt-2">
              {exportError}
            </Text>
          ) : null}

          <Income report={report.data} />
          <ExpenseBreakdown report={report.data} />
          <TaxCard report={report.data} today={today} />
          <BoothRent today={today} currency={report.data.currency} />
          {report.data.months.length > 1 ? <Months report={report.data} /> : null}
          <ExpenseList
            expenses={expenses.data}
            currency={report.data.currency}
            empty={`No expenses ${picker.period === 'custom' ? 'in this range' : `this ${picker.period}`} yet.`}
          />
        </View>
      ) : null}
    </DetailScreen>
  );
}

function ProfitCard({ report }: { report: FinanceReport }) {
  const fmt = (cents: number) => formatAmount(cents, report.currency);
  const loss = report.profitCents < 0;
  return (
    <Card className="mt-4 gap-1">
      <Text variant="footnote" tone="muted">
        Profit after booth rent and expenses
      </Text>
      <Text variant="display" numeric tone={loss ? 'destructive' : 'default'} testID="profit">
        {fmt(report.profitCents)}
      </Text>
      <Text variant="subhead" tone="muted" numeric>
        {fmt(report.income.totalCents)} in − {fmt(report.expenses.totalCents)} out
      </Text>
    </Card>
  );
}

function Income({ report }: { report: FinanceReport }) {
  const fmt = (cents: number) => formatAmount(cents, report.currency);
  const { income } = report;
  const rows: [string, number][] = [
    ['Services', income.servicesCents],
    ['Retail', income.retailCents],
    ['Tips', income.tipsCents],
    ...(income.otherSalesCents
      ? [['Other sales', income.otherSalesCents] as [string, number]]
      : []),
    ...(income.keptDepositsCents
      ? [['Kept deposits', income.keptDepositsCents] as [string, number]]
      : []),
    ...(income.refundedCents ? [['Refunds', -income.refundedCents] as [string, number]] : []),
  ];
  return (
    <View>
      <SectionHeader title="Income" />
      <ListGroup>
        {rows.map(([label, cents]) => (
          <ListRow
            key={label}
            title={label}
            trailing={
              <Text variant="body" numeric>
                {fmt(cents)}
              </Text>
            }
          />
        ))}
        <ListRow
          title="Total income"
          trailing={
            <Text variant="headline" numeric>
              {fmt(income.totalCents)}
            </Text>
          }
          last
        />
      </ListGroup>
      <Text variant="footnote" tone="muted" className="px-1 pt-2">
        From payments taken in Chairside, the same numbers as Reports.
      </Text>
    </View>
  );
}

function ExpenseBreakdown({ report }: { report: FinanceReport }) {
  const fmt = (cents: number) => formatAmount(cents, report.currency);
  const used = EXPENSE_CATEGORIES.filter((c) => report.expenses.byCategory[c]);
  return (
    <View>
      <SectionHeader title="Expenses" />
      <ListGroup>
        {used.map((c) => (
          <ListRow
            key={c}
            title={EXPENSE_CATEGORY_LABELS[c]}
            trailing={
              <Text variant="body" numeric>
                {fmt(report.expenses.byCategory[c])}
              </Text>
            }
          />
        ))}
        <ListRow
          title="Total expenses"
          subtitle={`${report.expenses.count} ${report.expenses.count === 1 ? 'expense' : 'expenses'}`}
          trailing={
            <Text variant="headline" numeric>
              {fmt(report.expenses.totalCents)}
            </Text>
          }
          last
        />
      </ListGroup>
    </View>
  );
}

function TaxCard({ report, today }: { report: FinanceReport; today: string }) {
  const update = useUpdateTaxPercent();
  const [percent, setPercent] = useState(String(report.taxSetAsidePercent));
  const parsed = parsePercent(percent);
  const quarter = taxQuarterFor(today);
  const quarterReport = useFinanceReport({ from: quarter.from, to: today });
  const fmt = (cents: number) => formatAmount(cents, report.currency);
  const changed = parsed !== null && parsed !== report.taxSetAsidePercent;

  return (
    <View>
      <SectionHeader title="Tax set-aside · not tax advice" />
      <Card className="gap-3">
        <View className="flex-row items-center gap-3">
          <View className="flex-1 gap-0.5">
            <Text variant="footnote" tone="muted">
              Put aside from this period’s profit
            </Text>
            <Text variant="title2" numeric testID="tax-set-aside">
              {fmt(report.taxSetAsideCents)}
            </Text>
          </View>
          <Input
            className="w-24"
            label="Percent"
            accessibilityLabel="Tax set-aside percent"
            keyboardType="decimal-pad"
            value={percent}
            onChangeText={setPercent}
            error={parsed === null ? `0–${TAX_PERCENT_MAX}` : undefined}
          />
        </View>
        {changed ? (
          <Button
            variant="secondary"
            label={`Use ${parsed}%`}
            loading={update.isPending}
            onPress={() => update.mutate(parsed, { onSuccess: () => haptics.success() })}
          />
        ) : null}
        {update.error ? (
          <Text variant="footnote" tone="destructive">
            {errorMessage(update.error)}
          </Text>
        ) : null}
        <Text variant="subhead">
          Estimated-tax period {shortDate(quarter.from)} – {longDate(quarter.to)}
          {quarterReport.data ? `: ${fmt(quarterReport.data.taxSetAsideCents)} so far` : ''}.
          Payment due {longDate(quarter.due)}.
        </Text>
        <Text variant="footnote" tone="muted" testID="tax-disclaimer">
          {TAX_DISCLAIMER} What you actually owe depends on your whole year, deductions and state.
        </Text>
      </Card>
    </View>
  );
}

function BoothRent({ today, currency }: { today: string; currency: string }) {
  const recurring = useRecurringExpenses();
  const list = recurring.data ?? [];
  const fmt = (cents: number) => formatAmount(cents, currency);
  return (
    <View>
      <SectionHeader
        title="Booth rent & recurring"
        action={
          list.length > 0 ? (
            <Button
              size="sm"
              variant="ghost"
              icon="add"
              label="Add"
              accessibilityLabel="Add recurring expense"
              onPress={() => router.push('/finances/booth-rent')}
            />
          ) : null
        }
      />
      {list.length === 0 ? (
        <Card className="gap-3">
          <Text variant="body">
            Add your booth rent once and it’s counted every week or month, with a reminder before
            it’s due.
          </Text>
          <Button
            label="Set up booth rent"
            icon="home-outline"
            onPress={() => router.push('/finances/booth-rent')}
          />
        </Card>
      ) : (
        <ListGroup>
          {list.map((r, i) => (
            <ListRow
              key={r.id}
              title={r.label}
              subtitle={
                r.active
                  ? `${fmt(r.amount_cents)} ${r.frequency === 'weekly' ? 'a week' : 'a month'} · next ${shortDate(nextDueDate(r.frequency, r.starts_on, today))}${r.frequency === 'weekly' ? ` · ≈ ${fmt(monthlyCost('weekly', r.amount_cents))}/mo` : ''}`
                  : 'Paused'
              }
              chevron
              onPress={() =>
                router.push({ pathname: '/finances/booth-rent', params: { id: r.id } })
              }
              last={i === list.length - 1}
            />
          ))}
        </ListGroup>
      )}
    </View>
  );
}

function Months({ report }: { report: FinanceReport }) {
  const fmt = (cents: number) => formatAmount(cents, report.currency);
  return (
    <View>
      <SectionHeader title="By month" />
      <ListGroup>
        {report.months.map((m, i) => (
          <ListRow
            key={m.month}
            title={monthLabel(m.month)}
            subtitle={`${fmt(m.income.totalCents)} in · ${fmt(m.expenses.totalCents)} out`}
            trailing={
              <Text variant="headline" numeric tone={m.profitCents < 0 ? 'destructive' : 'default'}>
                {fmt(m.profitCents)}
              </Text>
            }
            last={i === report.months.length - 1}
          />
        ))}
      </ListGroup>
    </View>
  );
}

function ExpenseList({
  expenses,
  currency,
  empty,
}: {
  expenses: NonNullable<ReturnType<typeof useExpenses>['data']>;
  currency: string;
  empty: string;
}) {
  return (
    <View>
      <SectionHeader title="Expense log" />
      {expenses.length === 0 ? (
        <Text variant="subhead" tone="muted" className="px-1">
          {empty}
        </Text>
      ) : (
        <ListGroup>
          {expenses.map((e, i) => (
            <ListRow
              key={e.id}
              title={e.vendor ?? EXPENSE_CATEGORY_LABELS[e.category]}
              subtitle={[
                shortDate(e.spent_on),
                EXPENSE_CATEGORY_LABELS[e.category],
                e.restock ? `${e.restock.name} restock` : null,
                e.receipt_path ? 'receipt' : null,
              ]
                .filter(Boolean)
                .join(' · ')}
              trailing={
                <Text variant="body" numeric>
                  {formatAmount(e.amount_cents, currency)}
                </Text>
              }
              onPress={() => router.push({ pathname: '/finances/[id]', params: { id: e.id } })}
              last={i === expenses.length - 1}
            />
          ))}
        </ListGroup>
      )}
    </View>
  );
}
