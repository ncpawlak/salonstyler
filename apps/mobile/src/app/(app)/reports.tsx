import { comparisonRange } from '@chairside/core/reports';
import { View } from 'react-native';

import { DetailScreen } from '@/components/shell/screen';
import { EmptyState, Skeleton, Text } from '@/components/ui';
import { errorMessage } from '@/features/appointments/api';
import { RangePicker, useReportRange } from '@/features/reports/range-picker';
import {
  ClientsCard,
  HeadlineStats,
  RevenueCard,
  TakingsCard,
  TopServicesCard,
  UtilizationCard,
} from '@/features/reports/report-sections';
import {
  useReportUtilization,
  useSalesReport,
  useSalonToday,
} from '@/features/reports/use-reports';

/** Reports (#43): how the salon did over a week, month, quarter, year or custom range. */
export default function ReportsScreen() {
  const today = useSalonToday();
  const picker = useReportRange(today);
  const { range, period } = picker;
  const report = useSalesReport(range);
  const previous = useSalesReport(range ? comparisonRange(period, range) : null);

  return (
    <DetailScreen title="Reports">
      <RangePicker state={picker} />
      {!range ? null : report.isPending ? (
        <View className="mt-4 gap-3">
          <Skeleton height={96} />
          <Skeleton height={160} />
          <Skeleton height={128} />
        </View>
      ) : report.error ? (
        <EmptyState
          icon="cloud-offline-outline"
          title="Couldn’t load the report"
          message={errorMessage(report.error)}
          actionLabel="Try again"
          onAction={() => void report.refetch()}
        />
      ) : (
        <View className="mt-4">
          {report.data.checkouts === 0 && report.data.appointments.booked === 0 ? (
            <Text variant="footnote" tone="muted" className="px-1 pb-2">
              Nothing in this period yet. Paid checkouts and appointments show up here.
            </Text>
          ) : null}
          <HeadlineStats report={report.data} previous={previous.data} />
          <RevenueCard report={report.data} />
          {range.from <= today ? (
            <ReportUtilization
              range={{ from: range.from, to: range.to < today ? range.to : today }}
            />
          ) : null}
          <TopServicesCard report={report.data} />
          <ClientsCard report={report.data} />
          <TakingsCard report={report.data} />
          <Text variant="caption" tone="muted" className="px-1 pt-4">
            Revenue counts paid checkouts by the day they were paid (before tips). Percentages
            compare with the previous {period === 'custom' ? 'same-length period' : period}.
          </Text>
        </View>
      )}
    </DetailScreen>
  );
}

/** Up to today: future open time isn't missed capacity yet. */
function ReportUtilization({ range }: { range: { from: string; to: string } }) {
  const { days, summary, isLoading, isError } = useReportUtilization(range);
  if (isError) return null;
  if (isLoading || !days || !summary) {
    return <Skeleton height={128} className="mt-6" />;
  }
  return (
    <UtilizationCard
      range={range}
      days={days}
      utilization={summary.utilization}
      bookedMinutes={summary.bookedMinutes}
      capacityMinutes={summary.capacityMinutes}
      busiestDate={summary.busiestDate}
    />
  );
}
