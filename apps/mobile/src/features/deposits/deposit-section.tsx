import { depositStatusLabel, policySummary } from '@chairside/core/deposits';
import type { MemberDeposit } from '@chairside/db/deposits';
import { formatAmount } from '@chairside/payments';
import * as Linking from 'expo-linking';
import { View } from 'react-native';

import { Badge, Button, Text, type BadgeTone } from '@/components/ui';
import { errorMessage } from '@/features/appointments/api';
import { haptics } from '@/lib/haptics';
import { useCurrentSalon } from '@/providers/session-provider';

import {
  payLinkSms,
  payUrl,
  useCancellationQuote,
  useCancelWithPolicy,
  usePayToken,
  useRefundDeposit,
} from './api';

const TONE: Record<MemberDeposit['status'], BadgeTone> = {
  pending: 'warning',
  paid: 'success',
  refund_due: 'warning',
  refunded: 'neutral',
  kept: 'primary',
  canceled: 'neutral',
};

/** Appointment sheet → deposit status, the pay link for pending ones, and a pending refund. */
export function DepositSummary({
  deposit,
  clientPhone,
}: {
  deposit: MemberDeposit;
  clientPhone: string | null;
}) {
  const salon = useCurrentSalon();
  const token = usePayToken(deposit.appointment_id, deposit.status === 'pending');
  const refund = useRefundDeposit(deposit.appointment_id);
  const money = formatAmount(deposit.amount_cents, deposit.currency);
  const link = token.data ? payUrl(token.data) : null;

  return (
    <View className="gap-2 rounded-xl bg-card px-4 py-3" testID="appointment-deposit">
      <View className="flex-row items-center gap-2">
        <Text variant="headline" className="flex-1">
          Deposit {money}
        </Text>
        <Badge label={depositStatusLabel(deposit.status)} tone={TONE[deposit.status]} />
      </View>
      {deposit.status === 'paid' ? (
        <Text variant="footnote" tone="muted">
          Comes off the bill at checkout.
        </Text>
      ) : null}
      {deposit.refunded_cents > 0 ? (
        <Text variant="footnote" tone="muted">
          Refunded {formatAmount(deposit.refunded_cents, deposit.currency)}.
        </Text>
      ) : null}
      {link ? (
        <>
          <Text variant="footnote" tone="muted" selectable numberOfLines={1}>
            {link}
          </Text>
          <Button
            variant="secondary"
            label="Text pay link"
            icon="chatbubble-outline"
            fullWidth
            onPress={() =>
              void Linking.openURL(
                payLinkSms({
                  url: link,
                  salonName: salon.name ?? 'Your salon',
                  phone: clientPhone,
                }),
              )
            }
          />
        </>
      ) : null}
      {deposit.status === 'refund_due' ? (
        <Button
          variant="secondary"
          label={`Refund ${money}`}
          icon="return-up-back-outline"
          fullWidth
          loading={refund.isPending}
          onPress={() =>
            refund.mutate(deposit.id, {
              onSuccess: () => haptics.success(),
              onError: () => haptics.error(),
            })
          }
        />
      ) : null}
      {refund.error ? (
        <Text variant="footnote" tone="destructive">
          {errorMessage(refund.error)}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Cancel confirmation when the client has paid a deposit: shows what the policy says and lets the
 * salon refund or keep it.
 */
export function DepositCancel({
  appointmentId,
  onBack,
  onCancelled,
}: {
  appointmentId: string;
  onBack: () => void;
  onCancelled: (refundError: string | null) => void;
}) {
  const quote = useCancellationQuote(appointmentId, true);
  const cancel = useCancelWithPolicy(appointmentId);
  const q = quote.data;
  const money = q ? formatAmount(q.depositCents, q.currency ?? 'usd') : '';
  const run = (choice: 'refund' | 'keep') =>
    cancel.mutate(choice, {
      onSuccess: (r) => {
        haptics.warning();
        onCancelled(r.refundError);
      },
      onError: () => haptics.error(),
    });

  return (
    <View className="gap-2" testID="deposit-cancel">
      <Text variant="subhead" tone="muted">
        {!q
          ? 'Checking the cancellation policy…'
          : q.late
            ? `This is a late cancellation (${policySummary(q.windowHours).toLowerCase()}). By the policy, the ${money} deposit is kept.`
            : `This is within the free cancellation window, so by the policy the ${money} deposit is refunded.`}
      </Text>
      <View className="flex-row gap-3">
        <Button
          variant="secondary"
          label="Cancel & keep deposit"
          grow
          disabled={!q || cancel.isPending}
          onPress={() => run('keep')}
        />
        <Button
          variant="destructive"
          label="Cancel & refund"
          grow
          disabled={!q}
          loading={cancel.isPending}
          onPress={() => run('refund')}
        />
      </View>
      <Button variant="ghost" label="Don't cancel" fullWidth onPress={onBack} />
      {cancel.error || quote.error ? (
        <Text variant="footnote" tone="destructive">
          {errorMessage(cancel.error ?? quote.error)}
        </Text>
      ) : null}
    </View>
  );
}
