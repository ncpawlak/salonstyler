import { utilizationLevel, type DayUtilization } from '@chairside/core';
import {
  bucketSeries,
  granularityFor,
  percentChange,
  share,
  type DateRange,
  type Granularity,
} from '@chairside/core/reports';
import type { SalesReport } from '@chairside/db/reports';
import { formatAmount } from '@chairside/payments';
import { View } from 'react-native';

import { Card, Donut, SectionHeader, Text } from '@/components/ui';
import { formatDate, formatMinutes, useUtilizationPalette } from '@/features/calendar/palette';
import { useTheme } from '@/theme/theme-provider';
import { serviceTags } from '@/theme/tokens';

import { BarChart, SplitBar, type Bar } from './charts';

const pct = (n: number | null) => (n == null ? '—' : `${Math.round(n * 100)}%`);

function bucketLabel(date: string, g: Granularity) {
  return g === 'month'
    ? formatDate(date, { month: 'short' })
    : formatDate(date, { month: 'short', day: 'numeric' });
}

function bucketName(date: string, g: Granularity) {
  return g === 'day'
    ? formatDate(date, { weekday: 'short', month: 'short', day: 'numeric' })
    : g === 'week'
      ? `Week of ${formatDate(date, { month: 'short', day: 'numeric' })}`
      : formatDate(date, { month: 'long', year: 'numeric' });
}

/** "+12%" / "−8%" against the previous period, colored by direction. */
function Delta({ current, previous }: { current: number; previous: number | undefined }) {
  const change = previous == null ? null : percentChange(current, previous);
  if (change == null) return null;
  const rounded = Math.round(change * 100);
  return (
    <Text
      variant="caption"
      tone={rounded > 0 ? 'success' : rounded < 0 ? 'destructive' : 'muted'}
      numeric
      accessibilityLabel={`${rounded >= 0 ? 'up' : 'down'} ${Math.abs(rounded)}% on the previous period`}
    >
      {rounded > 0 ? '+' : rounded < 0 ? '−' : '±'}
      {Math.abs(rounded)}%
    </Text>
  );
}

function Stat({
  label,
  value,
  current,
  previous,
}: {
  label: string;
  value: string;
  current?: number;
  previous?: number;
}) {
  return (
    <Card className="min-w-[45%] flex-1 gap-1">
      <Text variant="footnote" tone="muted">
        {label}
      </Text>
      <Text variant="title2" numeric maxFontSizeMultiplier={1.4}>
        {value}
      </Text>
      {current != null ? <Delta current={current} previous={previous} /> : null}
    </Card>
  );
}

/** Revenue, tips, average ticket and checkouts, each against the previous period. */
export function HeadlineStats({
  report,
  previous,
}: {
  report: SalesReport;
  previous?: SalesReport;
}) {
  const money = (c: number) => formatAmount(c, report.currency);
  return (
    <View className="flex-row flex-wrap gap-3">
      <Stat
        label="Revenue"
        value={money(report.salesCents)}
        current={report.salesCents}
        previous={previous?.salesCents}
      />
      <Stat
        label="Tips"
        value={money(report.tipsCents)}
        current={report.tipsCents}
        previous={previous?.tipsCents}
      />
      <Stat
        label="Avg ticket"
        value={report.avgTicketCents == null ? '—' : money(report.avgTicketCents)}
        current={report.avgTicketCents ?? undefined}
        previous={previous?.avgTicketCents ?? undefined}
      />
      <Stat
        label="Checkouts"
        value={String(report.checkouts)}
        current={report.checkouts}
        previous={previous?.checkouts}
      />
    </View>
  );
}

function Legend({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <View className="flex-row items-center justify-between">
      <View className="flex-row items-center gap-2">
        <View className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
        <Text variant="subhead" tone="muted">
          {label}
        </Text>
      </View>
      <Text variant="subhead" numeric>
        {value}
      </Text>
    </View>
  );
}

/** Sales over time (tips stacked on top), then services vs retail. */
export function RevenueCard({ report }: { report: SalesReport }) {
  const { colors, scheme } = useTheme();
  const accents = serviceTags[scheme];
  const money = (c: number) => formatAmount(c, report.currency);
  const g = granularityFor(report);
  const bars: Bar[] = bucketSeries(report.daily, g, ['salesCents', 'tipsCents']).map((b) => ({
    key: b.date,
    primary: b.salesCents,
    secondary: b.tipsCents,
    label: bucketLabel(b.date, g),
    accessibilityLabel: `${bucketName(b.date, g)}: ${money(b.salesCents)} sales, ${money(b.tipsCents)} tips`,
  }));
  const retailColor = accents.emerald.solid;
  const otherColor = accents.slate.solid;

  return (
    <>
      <SectionHeader title="Revenue" />
      <Card className="gap-3">
        <BarChart bars={bars} />
        <View className="flex-row items-center gap-4">
          <View className="flex-row items-center gap-1.5">
            <View className="h-2 w-2 rounded-full" style={{ backgroundColor: colors.primary }} />
            <Text variant="caption" tone="muted">
              Sales
            </Text>
          </View>
          <View className="flex-row items-center gap-1.5">
            <View className="h-2 w-2 rounded-full" style={{ backgroundColor: colors.warning }} />
            <Text variant="caption" tone="muted">
              Tips
            </Text>
          </View>
        </View>
        <SplitBar
          parts={[
            { key: 'services', value: report.servicesCents, color: colors.primary },
            { key: 'retail', value: report.retailCents, color: retailColor },
            { key: 'other', value: report.otherSalesCents, color: otherColor },
          ]}
        />
        <View className="gap-1.5">
          <Legend color={colors.primary} label="Services" value={money(report.servicesCents)} />
          <Legend
            color={retailColor}
            label={
              report.retailItems === 1 ? 'Retail · 1 item' : `Retail · ${report.retailItems} items`
            }
            value={money(report.retailCents)}
          />
          {report.otherSalesCents > 0 ? (
            <Legend color={otherColor} label="Other" value={money(report.otherSalesCents)} />
          ) : null}
        </View>
      </Card>
    </>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: 'destructive' }) {
  return (
    <View className="flex-row justify-between">
      <Text variant="subhead" tone="muted">
        {label}
      </Text>
      <Text variant="subhead" numeric tone={tone}>
        {value}
      </Text>
    </View>
  );
}

/** How the money came in: card / cash / other, deposits credited, refunds. */
export function TakingsCard({ report }: { report: SalesReport }) {
  const money = (c: number) => formatAmount(c, report.currency);
  return (
    <>
      <SectionHeader title="Takings" />
      <Card className="gap-2">
        <Row label="Card" value={money(report.cardCents)} />
        <Row label="Cash" value={money(report.cashCents)} />
        {report.otherCents > 0 ? <Row label="Other" value={money(report.otherCents)} /> : null}
        {report.depositsAppliedCents > 0 ? (
          <Row label="Deposits applied" value={money(report.depositsAppliedCents)} />
        ) : null}
        {report.keptDeposits > 0 ? (
          <Row
            label={
              report.keptDeposits === 1 ? 'Kept deposit' : `Kept deposits (${report.keptDeposits})`
            }
            value={money(report.keptDepositsCents)}
          />
        ) : null}
        {report.refundedCents > 0 ? (
          <Row label="Refunded" value={`−${money(report.refundedCents)}`} tone="destructive" />
        ) : null}
      </Card>
    </>
  );
}

/** Booked share of working time, bucketed like the revenue chart and tinted like the heatmap. */
export function UtilizationCard({
  range,
  days,
  utilization,
  bookedMinutes,
  capacityMinutes,
  busiestDate,
}: {
  range: DateRange;
  days: readonly DayUtilization[];
  utilization: number;
  bookedMinutes: number;
  capacityMinutes: number;
  busiestDate: string | null;
}) {
  const palette = useUtilizationPalette();
  const { colors } = useTheme();
  const g = granularityFor(range);
  const bars: Bar[] = bucketSeries(days, g, ['bookedMinutes', 'capacityMinutes']).map((b) => {
    const u = b.capacityMinutes > 0 ? b.bookedMinutes / b.capacityMinutes : 0;
    const level = utilizationLevel({ capacityMinutes: b.capacityMinutes, utilization: u });
    return {
      key: b.date,
      primary: Math.min(1, u),
      label: bucketLabel(b.date, g),
      color: level == null || level === 0 ? colors.muted : palette.heat[Math.max(3, level)],
      accessibilityLabel: `${bucketName(b.date, g)}: ${
        b.capacityMinutes > 0 ? `${Math.round(u * 100)}% booked` : 'closed'
      }`,
    };
  });

  return (
    <>
      <SectionHeader title="Utilization" />
      <Card className="gap-3">
        <View className="flex-row items-center gap-4">
          <Donut value={utilization} size={72} />
          <View className="flex-1 gap-0.5">
            <Text variant="headline" numeric>
              {formatMinutes(bookedMinutes)} booked
            </Text>
            <Text variant="footnote" tone="muted" numeric>
              of {formatMinutes(capacityMinutes)} working time
            </Text>
            {busiestDate ? (
              <Text variant="footnote" tone="muted">
                Busiest:{' '}
                {formatDate(busiestDate, { weekday: 'short', month: 'short', day: 'numeric' })}
              </Text>
            ) : null}
          </View>
        </View>
        <BarChart bars={bars} max={1} height={64} />
      </Card>
    </>
  );
}

export function TopServicesCard({ report }: { report: SalesReport }) {
  const { colors } = useTheme();
  if (report.topServices.length === 0) return null;
  const top = report.topServices[0]?.cents ?? 1;
  return (
    <>
      <SectionHeader title="Top services" />
      <Card className="gap-3">
        {report.topServices.map((s) => (
          <View key={s.name} className="gap-1">
            <View className="flex-row justify-between gap-3">
              <Text variant="subhead" numberOfLines={1} className="flex-1">
                {s.name}
                <Text variant="subhead" tone="muted">
                  {' '}
                  · {s.count}
                </Text>
              </Text>
              <Text variant="subhead" numeric>
                {formatAmount(s.cents, report.currency)}
              </Text>
            </View>
            <View
              className="h-1.5 overflow-hidden rounded-full"
              style={{ backgroundColor: colors.muted }}
            >
              <View
                className="h-full rounded-full"
                style={{
                  width: `${(s.cents / Math.max(1, top)) * 100}%`,
                  backgroundColor: colors.primary,
                }}
              />
            </View>
          </View>
        ))}
      </Card>
    </>
  );
}

/** New vs returning clients, rebook rate, and how appointments turned out. */
export function ClientsCard({ report }: { report: SalesReport }) {
  const { colors, scheme } = useTheme();
  const accents = serviceTags[scheme];
  const { clients, appointments, rebook } = report;
  return (
    <>
      <SectionHeader title="Clients" />
      <Card className="gap-3">
        <View className="flex-row gap-4">
          <View className="flex-1 gap-0.5">
            <Text variant="title3" numeric>
              {clients.new}
            </Text>
            <Text variant="footnote" tone="muted">
              New
            </Text>
          </View>
          <View className="flex-1 gap-0.5">
            <Text variant="title3" numeric>
              {clients.returning}
            </Text>
            <Text variant="footnote" tone="muted">
              Returning
            </Text>
          </View>
          <View className="flex-1 gap-0.5">
            <Text variant="title3" numeric>
              {pct(rebook.rate)}
            </Text>
            <Text variant="footnote" tone="muted">
              Rebooked
            </Text>
          </View>
        </View>
        <SplitBar
          parts={[
            { key: 'new', value: clients.new, color: accents.violet.solid },
            { key: 'returning', value: clients.returning, color: colors.primary },
          ]}
        />
        <Text variant="footnote" tone="muted">
          {rebook.checkouts > 0
            ? `${rebook.rebooked} of ${rebook.checkouts} checkouts booked their next visit before leaving.`
            : 'Rebook rate counts checkouts that booked their next visit.'}
        </Text>
      </Card>

      <SectionHeader title="Appointments" />
      <Card className="gap-2">
        <Row label="Booked" value={String(appointments.booked)} />
        <Row label="Completed" value={String(appointments.completed)} />
        <Row
          label="No-shows"
          value={`${appointments.noShows} · ${pct(share(appointments.noShows, appointments.booked))}`}
          tone={appointments.noShows > 0 ? 'destructive' : undefined}
        />
        <Row
          label="Cancelled"
          value={`${appointments.cancelled} · ${pct(share(appointments.cancelled, appointments.booked))}`}
        />
      </Card>
    </>
  );
}
