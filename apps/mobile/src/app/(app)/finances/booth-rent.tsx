import { EXPENSE_CATEGORIES, EXPENSE_CATEGORY_LABELS, nextDueDate } from '@chairside/core/finances';
import type { ExpenseFrequency, RecurringExpense } from '@chairside/db/finances';
import { parseAmountInput } from '@chairside/payments';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Switch, View } from 'react-native';

import { DetailScreen } from '@/components/shell/screen';
import {
  Button,
  Card,
  Chip,
  EmptyState,
  Input,
  SectionHeader,
  SegmentedControl,
  SkeletonRow,
  Text,
} from '@/components/ui';
import { errorMessage } from '@/features/appointments/api';
import { formatDate } from '@/features/calendar/palette';
import {
  useDeleteRecurringExpense,
  useRecurringExpenses,
  useSaveRecurringExpense,
} from '@/features/finances/api';
import { useSalonToday } from '@/features/reports/use-reports';
import { haptics } from '@/lib/haptics';

const FREQUENCIES = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'weekly', label: 'Weekly' },
] as const satisfies readonly { value: ExpenseFrequency; label: string }[];

const REMIND_DAYS = [
  { value: '0', label: 'Same day' },
  { value: '1', label: '1 day' },
  { value: '2', label: '2 days' },
  { value: '3', label: '3 days' },
] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isRealDate = (d: string) => {
  if (!DATE_RE.test(d)) return false;
  const t = Date.parse(`${d}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d;
};

/** Booth rent (or any other weekly / monthly expense), counted on each due date with a reminder. */
export default function BoothRentScreen() {
  const params = useLocalSearchParams<{ id?: string }>();
  const recurring = useRecurringExpenses();
  if (!params.id) return <RecurringForm />;
  const existing = recurring.data?.find((r) => r.id === params.id);
  if (existing) return <RecurringForm key={existing.id} recurring={existing} />;
  return (
    <DetailScreen title="Booth rent">
      {recurring.isPending ? (
        <View className="gap-3">
          <SkeletonRow />
          <SkeletonRow />
        </View>
      ) : (
        <EmptyState
          icon="cloud-offline-outline"
          title="Couldn't load this schedule"
          message={recurring.error ? errorMessage(recurring.error) : 'It may have been deleted.'}
          actionLabel="Try again"
          onAction={() => void recurring.refetch()}
        />
      )}
    </DetailScreen>
  );
}

const done = () => (router.canGoBack() ? router.back() : router.replace('/finances'));

function RecurringForm({ recurring }: { recurring?: RecurringExpense }) {
  const today = useSalonToday();
  const save = useSaveRecurringExpense();
  const remove = useDeleteRecurringExpense();

  const [label, setLabel] = useState(recurring?.label ?? 'Booth rent');
  const [category, setCategory] = useState(recurring?.category ?? 'booth_rent');
  const [vendor, setVendor] = useState(recurring?.vendor ?? '');
  const [amount, setAmount] = useState(recurring ? (recurring.amount_cents / 100).toFixed(2) : '');
  const [frequency, setFrequency] = useState<ExpenseFrequency>(recurring?.frequency ?? 'monthly');
  const [startsOn, setStartsOn] = useState(recurring?.starts_on ?? today);
  const [remind, setRemind] = useState(recurring?.remind ?? true);
  const [remindDays, setRemindDays] = useState(String(recurring?.remind_days_before ?? 1));
  const [active, setActive] = useState(recurring?.active ?? true);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const amountCents = parseAmountInput(amount);
  const errors = {
    label: label.trim() === '' ? 'Required' : undefined,
    amount: amountCents === null || amountCents <= 0 ? 'Enter an amount' : undefined,
    startsOn: isRealDate(startsOn) ? undefined : 'Use YYYY-MM-DD',
  };
  const valid = Object.values(errors).every((e) => !e);
  const next = valid ? nextDueDate(frequency, startsOn, today) : null;

  const submit = () => {
    if (!valid || amountCents === null) return;
    save.mutate(
      {
        id: recurring?.id,
        fields: {
          label: label.trim(),
          category,
          vendor,
          amount_cents: amountCents,
          frequency,
          starts_on: startsOn,
          remind,
          remind_days_before: Number(remindDays),
          active,
        },
      },
      {
        onSuccess: () => {
          haptics.success();
          done();
        },
      },
    );
  };

  return (
    <DetailScreen title={recurring ? recurring.label : 'Booth rent'}>
      <View className="gap-3">
        <Input label="Name" value={label} onChangeText={setLabel} error={errors.label} />
        <View className="flex-row gap-3">
          <Input
            className="flex-1"
            label="Amount"
            testID="rent-amount"
            keyboardType="decimal-pad"
            placeholder="0.00"
            value={amount}
            onChangeText={setAmount}
            error={amount.trim() === '' ? undefined : errors.amount}
          />
          <Input
            className="flex-1"
            label="Paid to"
            placeholder="Salon or landlord"
            value={vendor}
            onChangeText={setVendor}
          />
        </View>
        <SegmentedControl
          options={FREQUENCIES}
          value={frequency}
          onChange={setFrequency}
          accessibilityLabel="How often"
        />
        <Input
          label={
            frequency === 'weekly' ? 'First due date (repeats that weekday)' : 'First due date'
          }
          testID="rent-starts-on"
          placeholder="YYYY-MM-DD"
          autoCapitalize="none"
          inputMode="numeric"
          value={startsOn}
          onChangeText={(v) => setStartsOn(v.trim())}
          error={errors.startsOn}
        />
        {next ? (
          <Text variant="footnote" tone="muted" className="px-1">
            Next due {formatDate(next, { weekday: 'short', month: 'short', day: 'numeric' })}. Each
            due date is added to your expenses automatically, including past ones back to the first
            date.
          </Text>
        ) : null}
        <View className="flex-row flex-wrap gap-2">
          {EXPENSE_CATEGORIES.map((c) => (
            <Chip
              key={c}
              label={EXPENSE_CATEGORY_LABELS[c]}
              selected={category === c}
              onPress={() => setCategory(c)}
            />
          ))}
        </View>
      </View>

      <SectionHeader title="Reminder" />
      <Card className="gap-3">
        <View className="flex-row items-center gap-3">
          <Text variant="body" className="flex-1">
            Push a reminder before it’s due
          </Text>
          <Switch accessibilityLabel="Remind me" value={remind} onValueChange={setRemind} />
        </View>
        {remind ? (
          <SegmentedControl
            options={REMIND_DAYS}
            value={remindDays as (typeof REMIND_DAYS)[number]['value']}
            onChange={setRemindDays}
            accessibilityLabel="Days before"
          />
        ) : null}
      </Card>

      {recurring ? (
        <Card className="mt-4 flex-row items-center gap-3">
          <Text variant="body" className="flex-1">
            Active
          </Text>
          <Switch accessibilityLabel="Active" value={active} onValueChange={setActive} />
        </Card>
      ) : null}

      {save.error ? (
        <Text variant="footnote" tone="destructive" className="px-1 pt-3">
          {errorMessage(save.error)}
        </Text>
      ) : null}

      <View className="gap-3 pt-4">
        <Button
          label={recurring ? 'Save' : 'Add booth rent'}
          testID="save-rent"
          fullWidth
          disabled={!valid}
          loading={save.isPending}
          onPress={submit}
        />
        {recurring ? (
          <Button
            variant={confirmDelete ? 'destructive' : 'ghost'}
            label={confirmDelete ? 'Stop and delete schedule' : 'Delete schedule'}
            icon="trash-outline"
            fullWidth
            loading={remove.isPending}
            onPress={() =>
              confirmDelete
                ? remove.mutate(recurring.id, { onSuccess: done })
                : setConfirmDelete(true)
            }
          />
        ) : null}
        {confirmDelete ? (
          <Text variant="footnote" tone="muted" className="px-1">
            Expenses it already added stay in your log.
          </Text>
        ) : null}
        {remove.error ? (
          <Text variant="footnote" tone="destructive" className="px-1">
            {errorMessage(remove.error)}
          </Text>
        ) : null}
      </View>
    </DetailScreen>
  );
}
