import { EXPENSE_CATEGORIES, EXPENSE_CATEGORY_LABELS } from '@chairside/core/finances';
import { removeReceipt, type ExpenseFields, type ExpenseWithRestock } from '@chairside/db/finances';
import { getStripeAccount } from '@chairside/db/payments';
import { formatAmount, parseAmountInput } from '@chairside/payments';
import { useQuery } from '@tanstack/react-query';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Image, Platform, View } from 'react-native';

import { DetailScreen } from '@/components/shell/screen';
import {
  Button,
  Card,
  Chip,
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
  type ReceiptImage,
  useDeleteExpense,
  useExpense,
  useReadReceipt,
  useReceiptUrl,
  useRestockPurchases,
  useSaveExpense,
  useUploadReceipt,
} from '@/features/finances/api';
import { useSalonToday } from '@/features/reports/use-reports';
import { haptics } from '@/lib/haptics';
import { supabase } from '@/lib/supabase';
import { useCurrentSalon } from '@/providers/session-provider';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_WIDTH = 1600;

const isRealDate = (d: string) => {
  if (!DATE_RE.test(d)) return false;
  const t = Date.parse(`${d}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d;
};

/** A camera shot or picked photo (maybe HEIC, maybe huge) → a JPEG small enough to read and keep. */
async function toReceiptImage(asset: ImagePicker.ImagePickerAsset): Promise<ReceiptImage> {
  const context = ImageManipulator.manipulate(asset.uri);
  if (!asset.width || asset.width > MAX_WIDTH) context.resize({ width: MAX_WIDTH });
  const rendered = await context.renderAsync();
  const saved = await rendered.saveAsync({ base64: true, compress: 0.7, format: SaveFormat.JPEG });
  if (!saved.base64) throw new Error('Couldn’t read that photo. Try another one.');
  return { mimeType: 'image/jpeg', data: saved.base64 };
}

async function takeReceiptPhoto(source: 'camera' | 'library'): Promise<ReceiptImage | null> {
  if (source === 'camera') {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) throw new Error('Allow camera access in Settings to scan receipts.');
  }
  const options: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 0.8 };
  const result =
    source === 'camera'
      ? await ImagePicker.launchCameraAsync(options)
      : await ImagePicker.launchImageLibraryAsync(options);
  const asset = result.canceled ? null : result.assets[0];
  return asset ? toReceiptImage(asset) : null;
}

/** Add (`id` = "new") or edit an expense: amount, category, receipt photo, linked restock. */
export default function ExpenseScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const isNew = params.id === 'new';
  const expense = useExpense(isNew ? undefined : params.id);

  if (isNew) return <ExpenseForm />;
  if (expense.isPending || expense.error || !expense.data) {
    return (
      <DetailScreen title="Expense">
        {expense.isPending ? (
          <View className="gap-3">
            <SkeletonRow />
            <SkeletonRow />
          </View>
        ) : (
          <EmptyState
            icon="cloud-offline-outline"
            title="Couldn't load this expense"
            message={expense.error ? errorMessage(expense.error) : undefined}
            actionLabel="Try again"
            onAction={() => void expense.refetch()}
          />
        )}
      </DetailScreen>
    );
  }
  return <ExpenseForm key={expense.data.id} expense={expense.data} />;
}

const done = () => (router.canGoBack() ? router.back() : router.replace('/finances'));

function ExpenseForm({ expense }: { expense?: ExpenseWithRestock }) {
  const today = useSalonToday();
  const save = useSaveExpense();
  const remove = useDeleteExpense();
  const upload = useUploadReceipt();
  const read = useReadReceipt();
  const restocks = useRestockPurchases();
  const salon = useCurrentSalon();
  // Same currency source as the finance report: the Stripe account's, USD until one is connected.
  const account = useQuery({
    queryKey: ['stripe-account', salon.id],
    queryFn: () => getStripeAccount(supabase, salon.id),
  });
  const currency = account.data?.default_currency?.toLowerCase() ?? 'usd';

  const [amount, setAmount] = useState(expense ? (expense.amount_cents / 100).toFixed(2) : '');
  const [spentOn, setSpentOn] = useState(expense?.spent_on ?? today);
  const [category, setCategory] = useState(expense?.category ?? 'products');
  const [vendor, setVendor] = useState(expense?.vendor ?? '');
  const [note, setNote] = useState(expense?.note ?? '');
  const [restockId, setRestockId] = useState(expense?.stock_movement_id ?? null);
  const [receiptPath, setReceiptPath] = useState(expense?.receipt_path ?? null);
  const [preview, setPreview] = useState<string | null>(null);
  const [scanNote, setScanNote] = useState<{ text: string; tone: 'muted' | 'destructive' } | null>(
    null,
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const storedUrl = useReceiptUrl(preview ? null : receiptPath);

  const amountCents = parseAmountInput(amount);
  const errors = {
    amount: amountCents === null || amountCents <= 0 ? 'Enter an amount' : undefined,
    spentOn: isRealDate(spentOn) ? undefined : 'Use YYYY-MM-DD',
  };
  const valid = !errors.amount && !errors.spentOn;
  const scanning = upload.isPending || read.isPending;

  const scan = async (source: 'camera' | 'library') => {
    setScanNote(null);
    let image: ReceiptImage | null;
    try {
      image = await takeReceiptPhoto(source);
    } catch (e) {
      setScanNote({ text: errorMessage(e), tone: 'destructive' });
      return;
    }
    if (!image) return;
    setPreview(`data:${image.mimeType};base64,${image.data}`);
    const [uploaded, reading] = await Promise.allSettled([
      upload.mutateAsync(image),
      read.mutateAsync({ image, today }),
    ]);
    if (uploaded.status === 'fulfilled') setReceiptPath(uploaded.value);
    else {
      setPreview(null);
      setScanNote({
        text: `Couldn’t save the photo: ${errorMessage(uploaded.reason)}`,
        tone: 'destructive',
      });
      return;
    }
    if (reading.status === 'rejected') {
      setScanNote({
        text: `Photo attached. Couldn’t read it automatically (${errorMessage(reading.reason)}), so enter the total yourself.`,
        tone: 'muted',
      });
      return;
    }
    const { receipt, source: from } = reading.value;
    if (!receipt) {
      setScanNote({
        text: 'Photo attached. That doesn’t look like a receipt, so enter the total yourself.',
        tone: 'muted',
      });
      return;
    }
    haptics.success();
    setAmount((receipt.amountCents / 100).toFixed(2));
    if (receipt.vendor) setVendor(receipt.vendor);
    if (receipt.date) setSpentOn(receipt.date);
    if (receipt.category !== 'other' || !expense) setCategory(receipt.category);
    setScanNote({
      text:
        from === 'demo'
          ? 'Demo mode filled in a sample receipt. Check the numbers.'
          : 'Filled in from the photo. Check the numbers before saving.',
      tone: 'muted',
    });
  };

  const submit = () => {
    if (!valid || amountCents === null) return;
    const fields: ExpenseFields = {
      amount_cents: amountCents,
      spent_on: spentOn,
      category,
      vendor,
      note,
      receipt_path: receiptPath,
      stock_movement_id: category === 'products' ? restockId : null,
    };
    save.mutate(
      { id: expense?.id, fields },
      {
        onSuccess: () => {
          haptics.success();
          const old = expense?.receipt_path;
          if (old && old !== receiptPath) void removeReceipt(supabase, old).catch(() => undefined);
          done();
        },
      },
    );
  };

  const openRestocks = (restocks.data ?? []).filter(
    (r) => !r.expense_id || r.expense_id === expense?.id,
  );
  const pickRestock = (id: string | null) => {
    haptics.selection();
    setRestockId(id);
    const r = openRestocks.find((x) => x.id === id);
    if (r?.estimated_cents && amount.trim() === '') setAmount((r.estimated_cents / 100).toFixed(2));
    if (r?.supplier && vendor.trim() === '') setVendor(r.supplier);
  };
  const receiptSrc = preview ?? storedUrl.data ?? null;

  return (
    <DetailScreen title={expense ? 'Expense' : 'New expense'}>
      <Card className="gap-3">
        {receiptSrc ? (
          <Image
            source={{ uri: receiptSrc }}
            accessibilityLabel="Receipt photo"
            className="h-48 w-full rounded-lg"
            resizeMode="contain"
          />
        ) : (
          <Text variant="subhead" tone="muted">
            Snap the receipt and the total, store and date are filled in for you. The photo is kept
            with the expense.
          </Text>
        )}
        <View className="flex-row gap-2">
          {Platform.OS === 'web' ? null : (
            <Button
              variant="secondary"
              icon="camera-outline"
              label={receiptSrc ? 'Retake' : 'Scan receipt'}
              grow
              loading={scanning}
              onPress={() => void scan('camera')}
            />
          )}
          <Button
            variant="secondary"
            icon="image-outline"
            label={Platform.OS === 'web' ? 'Upload receipt' : 'Photos'}
            grow
            loading={Platform.OS === 'web' && scanning}
            disabled={scanning}
            onPress={() => void scan('library')}
          />
          {receiptPath ? (
            <Button
              variant="ghost"
              size="icon"
              icon="trash-outline"
              accessibilityLabel="Remove receipt photo"
              disabled={scanning}
              onPress={() => {
                setReceiptPath(null);
                setPreview(null);
              }}
            />
          ) : null}
        </View>
        {scanNote ? (
          <Text variant="footnote" tone={scanNote.tone} accessibilityLiveRegion="polite">
            {scanNote.text}
          </Text>
        ) : null}
      </Card>

      <SectionHeader title="Expense" />
      <View className="gap-3">
        <View className="flex-row gap-3">
          <Input
            className="flex-1"
            label="Amount"
            testID="expense-amount"
            keyboardType="decimal-pad"
            placeholder="0.00"
            value={amount}
            onChangeText={setAmount}
            error={amount.trim() === '' ? undefined : errors.amount}
          />
          <Input
            className="flex-1"
            label="Date"
            testID="expense-date"
            placeholder="YYYY-MM-DD"
            autoCapitalize="none"
            inputMode="numeric"
            value={spentOn}
            onChangeText={(v) => setSpentOn(v.trim())}
            error={errors.spentOn}
          />
        </View>
        <View className="flex-row flex-wrap gap-2" accessibilityRole="radiogroup">
          {EXPENSE_CATEGORIES.map((c) => (
            <Chip
              key={c}
              label={EXPENSE_CATEGORY_LABELS[c]}
              selected={category === c}
              onPress={() => setCategory(c)}
            />
          ))}
        </View>
        <Input
          label="Paid to"
          testID="expense-vendor"
          placeholder="Store, supplier or landlord"
          value={vendor}
          onChangeText={setVendor}
        />
        <Input
          label="Note"
          placeholder="Optional"
          value={note}
          onChangeText={setNote}
          maxLength={500}
        />
      </View>

      {category === 'products' && openRestocks.length > 0 ? (
        <View>
          <SectionHeader title="Restock this paid for" />
          <ListGroup>
            {openRestocks.slice(0, 8).map((r, i) => (
              <ListRow
                key={r.id}
                title={[r.brand, r.name].filter(Boolean).join(' ')}
                subtitle={[
                  `+${r.quantity} ${r.unit ?? ''}`.trim(),
                  r.created_at
                    ? formatDate(r.created_at.slice(0, 10), { month: 'short', day: 'numeric' })
                    : null,
                  r.estimated_cents
                    ? `≈ ${formatAmount(r.estimated_cents, currency)} at cost`
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
                trailing={
                  restockId === r.id ? (
                    <Text variant="headline" tone="primary">
                      ✓
                    </Text>
                  ) : undefined
                }
                onPress={() => pickRestock(restockId === r.id ? null : r.id)}
                last={i === Math.min(openRestocks.length, 8) - 1}
              />
            ))}
          </ListGroup>
          <Text variant="footnote" tone="muted" className="px-1 pt-2">
            Link the inventory restock this purchase stocked so product spend lines up with stock.
          </Text>
        </View>
      ) : null}

      {save.error ? (
        <Text variant="footnote" tone="destructive" className="px-1 pt-3">
          {errorMessage(save.error)}
        </Text>
      ) : null}

      <View className="gap-3 pt-4">
        <Button
          label={expense ? 'Save expense' : 'Add expense'}
          testID="save-expense"
          fullWidth
          disabled={!valid || scanning}
          loading={save.isPending}
          onPress={submit}
        />
        {expense ? (
          <Button
            variant={confirmDelete ? 'destructive' : 'ghost'}
            label={confirmDelete ? 'Delete expense and receipt' : 'Delete expense'}
            icon="trash-outline"
            fullWidth
            loading={remove.isPending}
            onPress={() =>
              confirmDelete ? remove.mutate(expense, { onSuccess: done }) : setConfirmDelete(true)
            }
          />
        ) : null}
        {expense?.recurring_expense_id ? (
          <Text variant="footnote" tone="muted" className="px-1">
            Posted by a recurring expense. Deleting it won’t stop future ones; edit the schedule
            under Booth rent for that.
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
