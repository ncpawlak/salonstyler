import {
  cardLabel,
  checkoutTotals,
  formatAmount,
  MIN_CARD_AMOUNT_CENTS,
  parseAmountInput,
  TIP_PERCENTS,
  tipForPercent,
} from '@chairside/payments';
import type { CheckoutItemKind, CheckoutWithItems } from '@chairside/db/checkout';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as Linking from 'expo-linking';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import Animated, { FadeIn, ZoomIn } from 'react-native-reanimated';

import { DetailScreen } from '@/components/shell/screen';
import {
  Button,
  Card,
  EmptyState,
  Icon,
  Input,
  ListGroup,
  ListRow,
  SectionHeader,
  SegmentedControl,
  SkeletonRow,
  Text,
} from '@/components/ui';
import {
  checkoutErrorMessage,
  checkoutKey,
  receiptShareLinks,
  receiptUrl,
  useCheckout,
  useInvalidateAfterPayment,
  usePayOffline,
  useSaveCheckout,
} from '@/features/checkout/api';
import { CardReaderProvider, useCardReader } from '@/features/checkout/terminal';
import { haptics } from '@/lib/haptics';
import { supabase } from '@/lib/supabase';
import { useCurrentSalon } from '@/providers/session-provider';

type Line = {
  key: string;
  kind: CheckoutItemKind;
  name: string;
  quantity: number;
  unitAmountCents: number;
  sourceId: string | null;
};

const TIP_OPTIONS = [
  { value: 'none', label: 'None' },
  ...TIP_PERCENTS.map((p) => ({ value: String(p), label: `${p}%` })),
  { value: 'custom', label: 'Custom' },
];

const KIND_LABEL: Record<CheckoutItemKind, string> = {
  service: 'Service',
  addon: 'Add-on',
  retail: 'Retail',
  custom: 'Other',
};

const NEW_KINDS = [
  { value: 'retail', label: 'Retail' },
  { value: 'custom', label: 'Other' },
] as const;

let lineSeq = 0;
const nextKey = () => `new-${++lineSeq}`;

function linesFrom(checkout: CheckoutWithItems): Line[] {
  return checkout.items.map((item) => ({
    key: item.id,
    kind: item.kind,
    name: item.name,
    quantity: item.quantity,
    unitAmountCents: item.unit_amount_cents,
    sourceId: item.source_id,
  }));
}

const centsText = (cents: number) => (cents / 100).toFixed(2);

export default function CheckoutScreen() {
  const { appointmentId } = useLocalSearchParams<{ appointmentId: string }>();
  const salon = useCurrentSalon();
  const checkout = useCheckout(appointmentId);

  return (
    <CardReaderProvider salonId={salon.id}>
      <DetailScreen title="Checkout" close>
        {checkout.isPending ? (
          <View className="gap-3">
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
          </View>
        ) : checkout.error ? (
          <EmptyState
            icon="card-outline"
            title="Can’t check out"
            message={checkoutErrorMessage(checkout.error)}
            actionLabel="Try again"
            onAction={() => void checkout.refetch()}
          />
        ) : checkout.data.status === 'paid' ? (
          <Paid checkout={checkout.data} />
        ) : (
          <CheckoutForm
            key={checkout.data.id}
            appointmentId={appointmentId}
            checkout={checkout.data}
          />
        )}
      </DetailScreen>
    </CardReaderProvider>
  );
}

function useClient(clientId: string | null) {
  return useQuery({
    queryKey: ['client', clientId],
    enabled: !!clientId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('clients')
        .select('name, phone, email')
        .eq('id', clientId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

function CheckoutForm({
  appointmentId,
  checkout,
}: {
  appointmentId: string;
  checkout: CheckoutWithItems;
}) {
  const queryClient = useQueryClient();
  const reader = useCardReader();
  const save = useSaveCheckout(appointmentId);
  const payOffline = usePayOffline(appointmentId);
  const invalidate = useInvalidateAfterPayment();
  const client = useClient(checkout.client_id);

  const [lines, setLines] = useState<Line[]>(() => linesFrom(checkout));
  const [tipChoice, setTipChoice] = useState(checkout.tip_cents > 0 ? 'custom' : 'none');
  const [customTip, setCustomTip] = useState(
    checkout.tip_cents > 0 ? centsText(checkout.tip_cents) : '',
  );
  const [editing, setEditing] = useState<{ key: string | null } | null>(null);
  const [charging, setCharging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Tips are on the work, not on products sold.
  const serviceCents = lines
    .filter((l) => l.kind === 'service' || l.kind === 'addon')
    .reduce((sum, l) => sum + l.quantity * l.unitAmountCents, 0);
  const customTipCents = parseAmountInput(customTip);
  const tipCents =
    tipChoice === 'none'
      ? 0
      : tipChoice === 'custom'
        ? (customTipCents ?? 0)
        : tipForPercent(serviceCents, Number(tipChoice));
  const totals = checkoutTotals(lines, tipCents, checkout.deposit_cents);
  const money = (cents: number) => formatAmount(cents, checkout.currency);

  const busy = charging || save.isPending || payOffline.isPending;
  const tipInvalid = tipChoice === 'custom' && customTip.trim() !== '' && customTipCents === null;
  const blocked = busy || tipInvalid || !!editing;
  const canCard = totals.amountDueCents >= MIN_CARD_AMOUNT_CENTS;

  function persist() {
    return save.mutateAsync({
      checkoutId: checkout.id,
      items: lines.map(({ kind, name, quantity, unitAmountCents, sourceId }) => ({
        kind,
        name,
        quantity,
        unitAmountCents,
        sourceId,
      })),
      tipCents,
    });
  }

  async function pay(method: 'card' | 'cash' | 'other') {
    setError(null);
    try {
      const saved = await persist();
      if (method === 'card') {
        setCharging(true);
        const paid = await reader.charge(saved.id);
        queryClient.setQueryData<CheckoutWithItems>(checkoutKey(appointmentId), {
          ...saved,
          ...paid,
        });
        void invalidate();
      } else {
        await payOffline.mutateAsync({ checkoutId: saved.id, method });
      }
      haptics.success();
    } catch (e) {
      haptics.error();
      setError(checkoutErrorMessage(e));
    } finally {
      setCharging(false);
    }
  }

  const editingLine = editing?.key ? lines.find((l) => l.key === editing.key) : undefined;

  return (
    <View className="gap-1">
      <Card className="flex-row items-center gap-3">
        <Icon name="person-circle-outline" color="primary" />
        <Text variant="headline" className="flex-1">
          {client.data?.name ?? 'Walk-in'}
        </Text>
      </Card>

      <SectionHeader
        title="Items"
        action={
          editing ? null : (
            <Button
              variant="ghost"
              size="sm"
              icon="add"
              label="Add item"
              disabled={busy}
              onPress={() => setEditing({ key: null })}
            />
          )
        }
      />
      {lines.length > 0 ? (
        <ListGroup>
          {lines.map((line, i) => (
            <ListRow
              key={line.key}
              title={line.quantity > 1 ? `${line.name} × ${line.quantity}` : line.name}
              subtitle={KIND_LABEL[line.kind]}
              chevron={false}
              trailing={
                <Text variant="body" numeric>
                  {money(line.quantity * line.unitAmountCents)}
                </Text>
              }
              accessibilityHint="Edit this item"
              onPress={busy ? undefined : () => setEditing({ key: line.key })}
              last={i === lines.length - 1}
            />
          ))}
        </ListGroup>
      ) : (
        <Text variant="footnote" tone="muted" className="px-1">
          No items. Add a product or another charge.
        </Text>
      )}

      {editing ? (
        <LineEditor
          key={editing.key ?? 'new'}
          line={editingLine}
          onCancel={() => setEditing(null)}
          onRemove={
            editingLine
              ? () => {
                  setLines((prev) => prev.filter((l) => l.key !== editingLine.key));
                  setEditing(null);
                }
              : undefined
          }
          onSave={(next) => {
            setLines((prev) =>
              editingLine
                ? prev.map((l) => (l.key === editingLine.key ? { ...l, ...next } : l))
                : [...prev, { key: nextKey(), sourceId: null, ...next }],
            );
            setEditing(null);
          }}
        />
      ) : null}

      <SectionHeader title="Tip" />
      <SegmentedControl
        accessibilityLabel="Tip"
        options={TIP_OPTIONS}
        value={tipChoice}
        onChange={setTipChoice}
      />
      {tipChoice === 'custom' ? (
        <Input
          className="mt-3"
          label="Tip amount"
          keyboardType="decimal-pad"
          placeholder="0.00"
          value={customTip}
          onChangeText={setCustomTip}
          error={tipInvalid ? 'Enter an amount like 12.50' : undefined}
        />
      ) : null}

      <Card className="mt-4 gap-2">
        <Row label="Subtotal" value={money(totals.subtotalCents)} />
        <Row label="Tip" value={money(totals.tipCents)} />
        {totals.depositCents > 0 ? (
          <Row label="Deposit paid" value={`−${money(totals.depositCents)}`} />
        ) : null}
        <View className="h-px bg-border" />
        <View className="flex-row items-end justify-between">
          <Text variant="headline" tone="muted">
            Due
          </Text>
          <Text variant="display" numeric>
            {money(totals.amountDueCents)}
          </Text>
        </View>
      </Card>

      {error ? (
        <Text
          variant="footnote"
          tone="destructive"
          className="px-1 pt-3"
          accessibilityLiveRegion="polite"
        >
          {error}
        </Text>
      ) : null}

      <View className="gap-3 pt-4">
        {totals.amountDueCents > 0 ? (
          <>
            <Button
              size="lg"
              fullWidth
              icon={reader.mode === 'tap_to_pay' ? 'phone-portrait-outline' : 'card-outline'}
              label={reader.chargeLabel}
              haptic="heavy"
              loading={charging}
              disabled={blocked || !canCard}
              onPress={() => void pay('card')}
            />
            {!canCard ? (
              <Text variant="footnote" tone="muted" className="px-1">
                Card payments must be at least {money(MIN_CARD_AMOUNT_CENTS)}.
              </Text>
            ) : null}
            <View className="flex-row gap-3">
              <Button
                variant="secondary"
                label="Cash"
                icon="cash-outline"
                grow
                loading={payOffline.isPending && payOffline.variables.method === 'cash'}
                disabled={blocked}
                onPress={() => void pay('cash')}
              />
              <Button
                variant="secondary"
                label="Other"
                icon="wallet-outline"
                grow
                loading={payOffline.isPending && payOffline.variables.method === 'other'}
                disabled={blocked}
                onPress={() => void pay('other')}
              />
            </View>
            {reader.mode === 'test_reader' ? (
              <Text variant="footnote" tone="muted" className="px-1 text-center">
                Card payments use Stripe’s test reader until Tap to Pay on iPhone is enabled.
              </Text>
            ) : null}
          </>
        ) : (
          <Button
            size="lg"
            fullWidth
            icon="checkmark-circle-outline"
            label="Close out · nothing due"
            loading={payOffline.isPending}
            disabled={blocked}
            onPress={() => void pay('other')}
          />
        )}
      </View>
    </View>
  );
}

function LineEditor({
  line,
  onSave,
  onCancel,
  onRemove,
}: {
  line?: Line;
  onSave: (line: Omit<Line, 'key' | 'sourceId'>) => void;
  onCancel: () => void;
  onRemove?: () => void;
}) {
  const [kind, setKind] = useState<CheckoutItemKind>(line?.kind ?? 'retail');
  const [name, setName] = useState(line?.name ?? '');
  const [price, setPrice] = useState(line ? centsText(line.unitAmountCents) : '');
  const [quantity, setQuantity] = useState(String(line?.quantity ?? 1));

  const priceCents = parseAmountInput(price);
  const qty = /^\d+$/.test(quantity.trim()) ? Number(quantity) : NaN;
  const nameOk = name.trim().length > 0 && name.trim().length <= 120;
  const qtyOk = Number.isInteger(qty) && qty >= 1 && qty <= 99;
  const valid = nameOk && priceCents !== null && qtyOk;

  return (
    <Card className="mt-3 gap-3">
      {line ? null : (
        <SegmentedControl
          accessibilityLabel="Item type"
          options={NEW_KINDS}
          value={kind === 'custom' ? 'custom' : 'retail'}
          onChange={setKind}
        />
      )}
      <Input
        label="Name"
        placeholder={kind === 'retail' ? 'e.g. Shampoo 250ml' : 'e.g. Extra time'}
        value={name}
        onChangeText={setName}
        autoFocus={!line}
      />
      <View className="flex-row gap-3">
        <Input
          className="flex-1"
          label="Price"
          keyboardType="decimal-pad"
          placeholder="0.00"
          value={price}
          onChangeText={setPrice}
          error={price.trim() !== '' && priceCents === null ? 'Enter an amount' : undefined}
        />
        <Input
          className="w-24"
          label="Qty"
          keyboardType="number-pad"
          value={quantity}
          onChangeText={setQuantity}
          error={quantity.trim() !== '' && !qtyOk ? '1–99' : undefined}
        />
      </View>
      <View className="flex-row gap-3">
        <Button variant="ghost" label="Cancel" grow onPress={onCancel} />
        {onRemove ? (
          <Button
            variant="destructive"
            label="Remove"
            icon="trash-outline"
            grow
            onPress={onRemove}
          />
        ) : null}
        <Button
          label={line ? 'Update' : 'Add'}
          grow
          disabled={!valid}
          onPress={() =>
            onSave({ kind, name: name.trim(), unitAmountCents: priceCents ?? 0, quantity: qty })
          }
        />
      </View>
    </Card>
  );
}

function Paid({ checkout }: { checkout: CheckoutWithItems }) {
  const salon = useCurrentSalon();
  const client = useClient(checkout.client_id);
  const amount = formatAmount(checkout.amount_due_cents, checkout.currency);
  const method =
    checkout.method === 'card'
      ? cardLabel(checkout.card_brand, checkout.card_last4)
      : checkout.method === 'cash'
        ? 'Cash'
        : 'Other payment';
  const links = receiptShareLinks({
    url: receiptUrl(checkout.receipt_token),
    salonName: salon.name,
    phone: client.data?.phone,
    email: client.data?.email,
  });

  return (
    <Animated.View entering={FadeIn}>
      <View className="items-center gap-3 py-10">
        <Animated.View entering={ZoomIn.springify()}>
          <View className="h-24 w-24 items-center justify-center rounded-full bg-success">
            <Icon name="checkmark" size={56} color="success-foreground" />
          </View>
        </Animated.View>
        <Text variant="title1" numeric accessibilityRole="header">
          {amount} paid
        </Text>
        <Text variant="subhead" tone="muted" className="text-center">
          {client.data?.name ? `${method} · ${client.data.name}` : method}
        </Text>
      </View>

      <SectionHeader title="Receipt" />
      <ListGroup>
        <ListRow
          title="Text receipt"
          subtitle={client.data?.phone ?? undefined}
          leading={<Icon name="chatbubble-outline" color="primary" />}
          onPress={() => void Linking.openURL(links.sms)}
        />
        <ListRow
          title="Email receipt"
          subtitle={client.data?.email ?? undefined}
          leading={<Icon name="mail-outline" color="primary" />}
          onPress={() => void Linking.openURL(links.email)}
        />
        <ListRow
          title="View receipt"
          leading={<Icon name="receipt-outline" color="primary" />}
          onPress={() => router.push(`/receipt/${checkout.receipt_token}`)}
          last
        />
      </ListGroup>

      <Button
        className="mt-6"
        label="Done"
        fullWidth
        onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
      />
    </Animated.View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row justify-between">
      <Text variant="subhead" tone="muted">
        {label}
      </Text>
      <Text variant="subhead" numeric>
        {value}
      </Text>
    </View>
  );
}
