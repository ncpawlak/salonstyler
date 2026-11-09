import {
  MIN_DEPOSIT_CENTS,
  serviceDepositCents,
  validateServiceDeposit,
  type DepositKind,
} from '@chairside/core/deposits';
import { formatAmount } from '@chairside/payments';
import { useState } from 'react';

import { Button, Card, Input, SectionHeader, SegmentedControl, Text } from '@/components/ui';
import { errorMessage } from '@/features/appointments/api';

import { useServiceDeposit, useUpdateServiceDeposit } from './api';

const KINDS = [
  { value: 'none', label: 'None' },
  { value: 'flat', label: 'Amount' },
  { value: 'percent', label: 'Percent' },
] as const satisfies readonly { value: DepositKind; label: string }[];

/** Service editor → Deposit. Saved on its own, so it never touches the service menu save. */
export function ServiceDepositEditor({
  serviceId,
  priceCents,
  canEdit,
}: {
  serviceId: string;
  priceCents: number | null;
  canEdit: boolean;
}) {
  const saved = useServiceDeposit(serviceId);
  const update = useUpdateServiceDeposit(serviceId);
  const [kind, setKind] = useState<DepositKind>('none');
  const [text, setText] = useState('');
  const [loaded, setLoaded] = useState(saved.data);
  if (saved.data !== loaded) {
    setLoaded(saved.data);
    const k = saved.data?.deposit_kind ?? 'none';
    const v = saved.data?.deposit_value ?? 0;
    setKind(k);
    setText(k === 'flat' ? String(v / 100) : k === 'percent' ? String(v) : '');
  }

  const value =
    kind === 'none'
      ? 0
      : kind === 'flat'
        ? Math.round(Number(text || 'NaN') * 100)
        : Number(text || 'NaN');
  const invalid = validateServiceDeposit(kind, value);
  const cents = invalid
    ? 0
    : serviceDepositCents({ depositKind: kind, depositValue: value, priceCents });
  const changed =
    !!saved.data && (kind !== saved.data.deposit_kind || value !== saved.data.deposit_value);

  if (saved.isPending || !saved.data) return null;

  return (
    <>
      <SectionHeader title="Deposit" />
      <Card className="gap-3">
        <SegmentedControl
          accessibilityLabel="Deposit type"
          options={KINDS}
          value={kind}
          onChange={(k) => {
            setKind(k);
            setText('');
          }}
        />
        {kind !== 'none' ? (
          <Input
            accessibilityLabel={kind === 'flat' ? 'Deposit in dollars' : 'Deposit percent'}
            value={text}
            onChangeText={setText}
            keyboardType={kind === 'flat' ? 'decimal-pad' : 'number-pad'}
            icon={kind === 'flat' ? 'cash-outline' : undefined}
            placeholder={kind === 'flat' ? '25' : '20'}
            editable={canEdit}
            helper={
              text && invalid
                ? invalid
                : kind === 'percent' && priceCents == null
                  ? 'This service has no set price, so a percentage asks for nothing.'
                  : cents > 0 && cents < MIN_DEPOSIT_CENTS
                    ? 'Too small to charge by card; no deposit is asked for.'
                    : cents > 0
                      ? `Clients pay ${formatAmount(cents, 'usd')} to book. It comes off the bill at checkout.`
                      : undefined
            }
          />
        ) : (
          <Text variant="footnote" tone="muted">
            No deposit for this service. Turn deposits on in Settings → Deposits & cancellations.
          </Text>
        )}
        {canEdit && changed && !invalid ? (
          <Button
            variant="outline"
            label="Save deposit"
            fullWidth
            loading={update.isPending}
            onPress={() => update.mutate({ deposit_kind: kind, deposit_value: value })}
          />
        ) : null}
        {update.error ? (
          <Text variant="footnote" tone="destructive">
            {errorMessage(update.error)}
          </Text>
        ) : null}
      </Card>
    </>
  );
}
