import type { Product, ProductFields } from '@chairside/db/inventory';
import { parseAmountInput } from '@chairside/payments';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Switch, View } from 'react-native';

import { DetailScreen } from '@/components/shell/screen';
import {
  Badge,
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
import {
  useChangeStock,
  useDeleteProduct,
  useProduct,
  useSaveProduct,
  useStockMovements,
} from '@/features/inventory/api';
import {
  formatQuantity,
  normalizeBarcode,
  parseQuantity,
  stockState,
} from '@/features/inventory/stock';
import { haptics } from '@/lib/haptics';

const REASON_LABEL: Record<string, string> = {
  receive: 'Received',
  sale: 'Sold',
  adjust: 'Adjusted',
  count: 'Counted',
  use: 'Used',
  return: 'Returned',
};

/** Create (`id` = "new", optionally with a scanned `barcode`) or edit a product and its stock. */
export default function ProductScreen() {
  const params = useLocalSearchParams<{ id: string; barcode?: string }>();
  const isNew = params.id === 'new';
  const product = useProduct(isNew ? undefined : params.id);

  if (isNew) return <ProductForm initialBarcode={params.barcode} />;
  return (
    <DetailScreen title={product.data?.name ?? 'Product'}>
      {product.isPending ? (
        <View className="gap-3">
          <SkeletonRow />
          <SkeletonRow />
        </View>
      ) : product.error || !product.data ? (
        <EmptyState
          icon="cloud-offline-outline"
          title="Couldn't load this product"
          message={product.error ? errorMessage(product.error) : undefined}
          actionLabel="Try again"
          onAction={() => void product.refetch()}
        />
      ) : (
        <View>
          <StockCard product={product.data} />
          <ProductForm key={product.data.id} product={product.data} embedded />
          <History productId={product.data.id} />
        </View>
      )}
    </DetailScreen>
  );
}

const centsText = (cents: number | null | undefined) =>
  cents === null || cents === undefined ? '' : (cents / 100).toFixed(2);
const qtyText = (n: number | null | undefined) =>
  n === null || n === undefined ? '' : Number(n.toFixed(2)).toString();

function ProductForm({
  product,
  initialBarcode,
  embedded,
}: {
  product?: Product;
  initialBarcode?: string;
  embedded?: boolean;
}) {
  const save = useSaveProduct();
  const remove = useDeleteProduct();
  const changeStock = useChangeStock();

  const [name, setName] = useState(product?.name ?? '');
  const [brand, setBrand] = useState(product?.brand ?? '');
  const [category, setCategory] = useState(product?.category ?? '');
  const [sku, setSku] = useState(product?.sku ?? '');
  const [barcode, setBarcode] = useState(product?.barcode ?? initialBarcode ?? '');
  const [unit, setUnit] = useState(product?.unit ?? 'each');
  const [supplier, setSupplier] = useState(product?.supplier ?? '');
  const [reorderPoint, setReorderPoint] = useState(qtyText(product?.reorder_point ?? 0));
  const [reorderQty, setReorderQty] = useState(qtyText(product?.reorder_quantity));
  const [cost, setCost] = useState(centsText(product?.cost_cents));
  const [retail, setRetail] = useState(centsText(product?.retail_price_cents));
  const [active, setActive] = useState(product?.active ?? true);
  const [startingStock, setStartingStock] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const rp = parseQuantity(reorderPoint);
  const rq = reorderQty.trim() === '' ? null : parseQuantity(reorderQty);
  const costCents = cost.trim() === '' ? null : parseAmountInput(cost);
  const retailCents = retail.trim() === '' ? null : parseAmountInput(retail);
  const start = startingStock.trim() === '' ? 0 : parseQuantity(startingStock);
  const code = barcode.trim() === '' ? null : normalizeBarcode(barcode);

  const errors = {
    name: name.trim() === '' ? 'Required' : undefined,
    barcode: barcode.trim() !== '' && !code ? 'Letters and numbers only' : undefined,
    unit: unit.trim() === '' ? 'Required' : undefined,
    reorderPoint: rp === null ? 'Enter a number' : undefined,
    reorderQty: reorderQty.trim() !== '' && (rq === null || rq <= 0) ? 'Enter a number' : undefined,
    cost: cost.trim() !== '' && costCents === null ? 'Enter an amount' : undefined,
    retail: retail.trim() !== '' && retailCents === null ? 'Enter an amount' : undefined,
    start: start === null ? 'Enter a number' : undefined,
  };
  const valid = Object.values(errors).every((e) => !e);

  const submit = () => {
    if (!valid) return;
    const fields: ProductFields = {
      name: name.trim(),
      brand: brand.trim() || null,
      category: category.trim() || null,
      sku: sku.trim() || null,
      barcode: code,
      unit: unit.trim(),
      supplier: supplier.trim() || null,
      reorder_point: rp ?? 0,
      reorder_quantity: rq,
      cost_cents: costCents,
      retail_price_cents: retailCents,
      active,
    };
    setNotice(null);
    save.mutate(
      { id: product?.id, fields },
      {
        onSuccess: async (saved) => {
          haptics.success();
          if (!product && start && start > 0) {
            await changeStock
              .mutateAsync({ productId: saved.id, kind: 'adjust', delta: start, reason: 'receive' })
              .catch(() => undefined);
          }
          if (product) setNotice('Saved.');
          else router.replace({ pathname: '/inventory/[id]', params: { id: saved.id } });
        },
      },
    );
  };

  const form = (
    <View>
      <SectionHeader title="Product" />
      <View className="gap-3">
        <Input label="Name" value={name} onChangeText={setName} error={errors.name} />
        <View className="flex-row gap-3">
          <Input className="flex-1" label="Brand" value={brand} onChangeText={setBrand} />
          <Input
            className="flex-1"
            label="Category"
            placeholder="e.g. Color"
            value={category}
            onChangeText={setCategory}
          />
        </View>
        <View className="flex-row gap-3">
          <Input
            className="flex-1"
            label="SKU"
            value={sku}
            onChangeText={setSku}
            autoCapitalize="characters"
            autoCorrect={false}
          />
          <Input
            className="flex-1"
            label="Barcode"
            testID="product-barcode"
            value={barcode}
            onChangeText={setBarcode}
            autoCapitalize="none"
            autoCorrect={false}
            error={errors.barcode}
          />
        </View>
        <Input
          label="Supplier"
          placeholder="Who you order from"
          value={supplier}
          onChangeText={setSupplier}
        />
      </View>

      <SectionHeader title="Stock" />
      <View className="gap-3">
        <View className="flex-row gap-3">
          <Input
            className="flex-1"
            label="Unit"
            placeholder="each, tube, bottle"
            value={unit}
            onChangeText={setUnit}
            autoCapitalize="none"
            error={errors.unit}
          />
          {product ? null : (
            <Input
              className="flex-1"
              label="On hand now"
              testID="starting-stock"
              keyboardType="decimal-pad"
              placeholder="0"
              value={startingStock}
              onChangeText={setStartingStock}
              error={errors.start}
            />
          )}
        </View>
        <View className="flex-row gap-3">
          <Input
            className="flex-1"
            label="Reorder at"
            testID="reorder-point"
            keyboardType="decimal-pad"
            value={reorderPoint}
            onChangeText={setReorderPoint}
            error={errors.reorderPoint}
          />
          <Input
            className="flex-1"
            label="Order qty"
            keyboardType="decimal-pad"
            placeholder="Auto"
            value={reorderQty}
            onChangeText={setReorderQty}
            error={errors.reorderQty}
          />
        </View>
        <Text variant="footnote" tone="muted" className="px-1">
          At or below “Reorder at”, the owner gets a push and it joins the reorder list.
        </Text>
      </View>

      <SectionHeader title="Pricing" />
      <View className="gap-3">
        <View className="flex-row gap-3">
          <Input
            className="flex-1"
            label="Cost"
            keyboardType="decimal-pad"
            placeholder="0.00"
            value={cost}
            onChangeText={setCost}
            error={errors.cost}
          />
          <Input
            className="flex-1"
            label="Retail price"
            keyboardType="decimal-pad"
            placeholder="Back bar"
            value={retail}
            onChangeText={setRetail}
            error={errors.retail}
          />
        </View>
        <Text variant="footnote" tone="muted" className="px-1">
          Leave the retail price empty for back-bar products you use but don’t sell.
        </Text>
      </View>

      {product ? (
        <Card className="mt-4 flex-row items-center gap-3">
          <Text variant="body" className="flex-1">
            Active
          </Text>
          <Switch accessibilityLabel="Active" value={active} onValueChange={setActive} />
        </Card>
      ) : null}

      {save.error ? (
        <Text
          variant="footnote"
          tone="destructive"
          className="px-1 pt-3"
          accessibilityLiveRegion="polite"
        >
          {saveErrorMessage(save.error)}
        </Text>
      ) : notice ? (
        <Text
          variant="footnote"
          tone="success"
          className="px-1 pt-3"
          accessibilityLiveRegion="polite"
        >
          {notice}
        </Text>
      ) : null}

      <View className="gap-3 pt-4">
        <Button
          label={product ? 'Save product' : 'Add product'}
          fullWidth
          disabled={!valid}
          loading={save.isPending || changeStock.isPending}
          onPress={submit}
        />
        {product ? (
          <Button
            variant={confirmDelete ? 'destructive' : 'ghost'}
            label={confirmDelete ? 'Delete product and its history' : 'Delete product'}
            icon="trash-outline"
            fullWidth
            loading={remove.isPending}
            onPress={() =>
              confirmDelete
                ? remove.mutate(product.id, { onSuccess: () => router.back() })
                : setConfirmDelete(true)
            }
          />
        ) : null}
        {confirmDelete && !remove.error ? (
          <Text variant="footnote" tone="muted" className="px-1">
            To keep the history, switch off Active instead.
          </Text>
        ) : null}
        {remove.error ? (
          <Text variant="footnote" tone="destructive" className="px-1">
            {errorMessage(remove.error)}
          </Text>
        ) : null}
      </View>
    </View>
  );

  return embedded ? form : <DetailScreen title="New product">{form}</DetailScreen>;
}

function saveErrorMessage(error: unknown): string {
  const message = errorMessage(error);
  if (/products_barcode_key/i.test(message)) return 'Another product already has this barcode.';
  if (/products_sku_key/i.test(message)) return 'Another product already has this SKU.';
  return message;
}

function StockCard({ product }: { product: Product }) {
  const changeStock = useChangeStock();
  const [amount, setAmount] = useState('');
  const n = parseQuantity(amount);
  const state = stockState(product);

  const change = (kind: 'receive' | 'remove' | 'count') => {
    if (n === null) return;
    const done = { onSuccess: () => (haptics.success(), setAmount('')) };
    if (kind === 'count') changeStock.mutate({ productId: product.id, kind, onHand: n }, done);
    else
      changeStock.mutate(
        {
          productId: product.id,
          kind: 'adjust',
          delta: kind === 'receive' ? n : -n,
          reason: kind === 'receive' ? 'receive' : 'use',
        },
        done,
      );
  };
  const step = (delta: number) => {
    haptics.selection();
    changeStock.mutate({ productId: product.id, kind: 'adjust', delta, reason: 'adjust' });
  };

  return (
    <Card className="gap-3">
      <View className="flex-row items-center gap-3">
        <Button
          variant="secondary"
          size="icon"
          icon="remove"
          accessibilityLabel="Remove one"
          disabled={changeStock.isPending || product.on_hand < 1}
          onPress={() => step(-1)}
        />
        <View className="flex-1 items-center">
          <Text variant="display" numeric testID="on-hand">
            {formatQuantity(product.on_hand)}
          </Text>
          <Text variant="footnote" tone="muted">
            {product.unit === 'each' ? 'on hand' : `${product.unit} on hand`} · reorder at{' '}
            {formatQuantity(product.reorder_point)}
          </Text>
        </View>
        <Button
          variant="secondary"
          size="icon"
          icon="add"
          accessibilityLabel="Add one"
          disabled={changeStock.isPending}
          onPress={() => step(1)}
        />
      </View>
      {state !== 'ok' && product.active ? (
        <View className="items-center">
          <Badge
            label={state === 'out' ? 'Out of stock' : 'Low stock'}
            tone={state === 'out' ? 'destructive' : 'warning'}
          />
        </View>
      ) : null}
      <Input
        label="Quantity"
        accessibilityLabel="Quantity to receive, remove or count"
        testID="stock-amount"
        keyboardType="decimal-pad"
        placeholder="e.g. 6"
        value={amount}
        onChangeText={setAmount}
      />
      <View className="flex-row gap-2">
        <Button
          variant="secondary"
          label="Receive"
          grow
          disabled={!n || changeStock.isPending}
          onPress={() => change('receive')}
        />
        <Button
          variant="secondary"
          label="Use"
          grow
          disabled={!n || changeStock.isPending}
          onPress={() => change('remove')}
        />
        <Button
          variant="secondary"
          label="Set count"
          grow
          disabled={n === null || changeStock.isPending}
          onPress={() => change('count')}
        />
      </View>
      {changeStock.error ? (
        <Text variant="footnote" tone="destructive" accessibilityLiveRegion="polite">
          {errorMessage(changeStock.error)}
        </Text>
      ) : null}
    </Card>
  );
}

function History({ productId }: { productId: string }) {
  const movements = useStockMovements(productId);
  const list = movements.data ?? [];
  if (list.length === 0) return null;
  return (
    <View>
      <SectionHeader title="History" />
      <ListGroup>
        {list.map((m, i) => (
          <ListRow
            key={m.id}
            title={`${REASON_LABEL[m.reason] ?? m.reason} ${m.delta > 0 ? '+' : ''}${formatQuantity(m.delta)}`}
            subtitle={[new Date(m.created_at).toLocaleString(), m.note].filter(Boolean).join(' · ')}
            trailing={
              <Text variant="subhead" tone="muted" numeric>
                {formatQuantity(m.on_hand_after)}
              </Text>
            }
            last={i === list.length - 1}
          />
        ))}
      </ListGroup>
    </View>
  );
}
