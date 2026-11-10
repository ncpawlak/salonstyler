import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { DetailScreen } from '@/components/shell/screen';
import {
  Button,
  Card,
  ListGroup,
  ListRow,
  SectionHeader,
  SegmentedControl,
  Text,
} from '@/components/ui';
import { errorMessage } from '@/features/appointments/api';
import { useChangeStock, useFindByBarcode } from '@/features/inventory/api';
import { BarcodeScanner } from '@/features/inventory/scanner';
import { formatQuantity } from '@/features/inventory/stock';
import { haptics } from '@/lib/haptics';

type Mode = 'receive' | 'use' | 'lookup';

const MODES = [
  { value: 'receive', label: 'Receive +1' },
  { value: 'use', label: 'Use −1' },
  { value: 'lookup', label: 'Look up' },
] as const;

type Scan = { key: number; productId: string; title: string; detail: string; tone: 'ok' | 'low' };

let scanSeq = 0;

/**
 * Scan barcodes to adjust stock: each scan in Receive / Use moves one unit; Look up opens the
 * product. An unknown barcode opens a new product with the barcode filled in.
 */
export default function ScanScreen() {
  const [mode, setMode] = useState<Mode>('receive');
  const [scans, setScans] = useState<Scan[]>([]);
  const [unknown, setUnknown] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const find = useFindByBarcode();
  const changeStock = useChangeStock();
  const busy = find.isPending || changeStock.isPending;

  const onScan = async (barcode: string) => {
    setError(null);
    setUnknown(null);
    try {
      const product = await find.mutateAsync(barcode);
      if (!product) {
        haptics.warning();
        setUnknown(barcode);
        return;
      }
      if (mode === 'lookup') {
        haptics.selection();
        router.push({ pathname: '/inventory/[id]', params: { id: product.id } });
        return;
      }
      const delta = mode === 'receive' ? 1 : -1;
      const movement = await changeStock.mutateAsync({
        productId: product.id,
        kind: 'adjust',
        delta,
        reason: mode,
      });
      const low = movement.on_hand_after <= product.reorder_point;
      if (low) haptics.warning();
      else haptics.success();
      const title = product.brand ? `${product.brand} ${product.name}` : product.name;
      setScans((prev) =>
        [
          {
            key: ++scanSeq,
            productId: product.id,
            title,
            detail: `${delta > 0 ? '+1' : '−1'} · ${formatQuantity(movement.on_hand_after, product.unit)} on hand${low ? ' · reorder' : ''}`,
            tone: low ? ('low' as const) : ('ok' as const),
          },
          ...prev,
        ].slice(0, 20),
      );
    } catch (e) {
      haptics.error();
      setError(errorMessage(e));
    }
  };

  return (
    <DetailScreen title="Scan products">
      <View className="gap-3">
        <SegmentedControl
          accessibilityLabel="What a scan does"
          options={MODES}
          value={mode}
          onChange={setMode}
        />
        <BarcodeScanner onScan={(code) => void onScan(code)} paused={busy} />

        {unknown ? (
          <Card className="gap-3" accessibilityLiveRegion="polite">
            <Text variant="body">No product has barcode {unknown}.</Text>
            <Button
              label="Add it as a new product"
              icon="add"
              onPress={() =>
                router.push({
                  pathname: '/inventory/[id]',
                  params: { id: 'new', barcode: unknown },
                })
              }
            />
          </Card>
        ) : null}
        {error ? (
          <Text variant="footnote" tone="destructive" accessibilityLiveRegion="polite">
            {error}
          </Text>
        ) : null}
      </View>

      {scans.length > 0 ? (
        <View>
          <SectionHeader title="This session" />
          <ListGroup>
            {scans.map((s, i) => (
              <ListRow
                key={s.key}
                title={s.title}
                subtitle={s.detail}
                trailing={
                  s.tone === 'low' ? (
                    <Text variant="footnote" tone="warning">
                      Low
                    </Text>
                  ) : undefined
                }
                onPress={() =>
                  router.push({ pathname: '/inventory/[id]', params: { id: s.productId } })
                }
                last={i === scans.length - 1}
              />
            ))}
          </ListGroup>
        </View>
      ) : null}
    </DetailScreen>
  );
}
